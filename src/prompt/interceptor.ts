import { DISPLAY_NAME } from '../core/constants';
import { logger } from '../core/logger';
import type {
  InspectionRecord,
  StoryEchoChatState,
  StoryMemory,
  TavernChatMessage,
} from '../core/types';
import { emitDiagnosticsUpdated } from '../debug/events';
import { recordDebugTrace } from '../debug/metrics';
import { extractionService } from '../extraction/service';
import {
  directlyGroundedStoryMemoryNames,
  normalizedStoryEntityName,
  unsupportedStoryMemoryNames,
} from '../extraction/quality';
import { isInternalGenerationRequest } from '../llm/internal-generation';
import { MemoryRepository } from '../memory/repository';
import { getContext, getCurrentChatId } from '../platform/sillytavern';
import {
  buildRetrievalQueryPlan,
  withRewrittenRetrievalQuery,
} from '../retrieval/query-builder';
import { hasSourceOutsideWindow } from '../retrieval/eligibility';
import { scopeMemoriesToCurrentStoryPhase } from '../retrieval/story-phase';
import { isFactVerificationQuery } from '../retrieval/intent';
import { isShadowedByRecentUserFact } from '../retrieval/recent-shadow';
import { queryRewriteService } from '../retrieval/query-rewriter';
import {
  rankMemories,
  suppressStaleAtomicStates,
  type RetrievalVectorResults,
} from '../retrieval/ranker';
import { SettingsRepository } from '../settings/repository';
import { storyEchoTaskCoordinator } from '../runtime/task-coordinator';
import { stageSummaryService } from '../summary/service';
import { storySkeletonService } from '../summary/skeleton-service';
import {
  archivedStageSummaryEntries,
  pendingArchivedStageSummaryEntries,
  storySkeletonIsUsable,
} from '../summary/skeleton-state';
import type { VectorQueryResult } from '../vector/adapter';
import { resolveVectorConfig } from '../vector/config';
import {
  FOREGROUND_VECTOR_QUERY_TIMEOUT_MS,
  SillyTavernVectorStore,
} from '../vector/sillytavern-vector-store';
import {
  buildEntityDisambiguationConstraints,
  estimateMessageTokens,
  estimateMemoryTokens,
  estimateTokens,
  renderCurrentStateCoordinationBlock,
  renderMemoryBlock,
  renderStorySkeletonBlock,
  renderStageSummaryBlock,
  selectWithinBudget,
} from './render';
import {
  alignRetainedStartToTurn,
  countNonSystemMessages,
  removeMessagesAtIndices,
  selectRecentWindow,
} from './window';

const settingsRepository = new SettingsRepository();
const memoryRepository = new MemoryRepository();
const vectorStore = new SillyTavernVectorStore();

function isSupportedGenerationType(type: string | undefined): boolean {
  if (!type || type === 'normal') {
    return true;
  }
  return type === 'regenerate' || type === 'swipe';
}

function createInspection(
  type: string | undefined,
  retainedStartIndex: number,
  endIndex: number,
  removedMessageCount: number,
  query: string,
  candidates: StoryMemory[],
  selected: StoryMemory[],
  warnings: string[],
  vectorResultCount = 0,
  durationMs = 0,
  estimatedRemovedTokens = 0,
  estimatedInjectedTokens = 0,
  estimatedSummaryTokens = 0,
  summaryCoveredThroughMessageId = -1,
): InspectionRecord {
  return {
    createdAt: new Date().toISOString(),
    generationType: type || 'normal',
    retainedStartIndex,
    retainedEndIndex: endIndex,
    removedMessageCount,
    query,
    candidateMemoryIds: candidates.map((memory) => memory.id),
    selectedMemoryIds: selected.map((memory) => memory.id),
    estimatedRecallTokens: selected.reduce((total, memory) => total + estimateMemoryTokens(memory), 0),
    estimatedRemovedTokens,
    estimatedInjectedTokens,
    estimatedNetSavedTokens: Math.max(0, estimatedRemovedTokens - estimatedInjectedTokens),
    estimatedSummaryTokens,
    summaryCoveredThroughMessageId,
    vectorResultCount,
    durationMs,
    warnings,
  };
}

function safeSourceRetainedStart(
  sourceChat: TavernChatMessage[],
  minimumRetainedStart: number,
  state: StoryEchoChatState,
  memoryEnabled: boolean,
  unit: 'turns' | 'messages',
): number {
  const summaryBoundary = state.stageSummary.entries.length > 0
    ? Math.max(0, state.stageSummary.coveredThroughMessageId + 1)
    : 0;
  const proposed = memoryEnabled
    ? Math.min(
        minimumRetainedStart,
        Math.max(0, state.indexedThroughMessageId + 1),
        summaryBoundary,
      )
    : Math.min(minimumRetainedStart, summaryBoundary);
  return unit === 'turns'
    ? alignRetainedStartToTurn(sourceChat, proposed)
    : proposed;
}

function requestSystemMessage(
  mes: string,
  kind: 'summary' | 'state' | 'recall',
): TavernChatMessage {
  return {
    is_user: false,
    is_system: true,
    name: DISPLAY_NAME,
    send_date: Date.now(),
    mes,
    // SillyTavern's Chat Completion conversion recognizes narrator as a true
    // request-level system message. is_system alone can be mapped as assistant
    // after generate_interceptor has already received coreChat.
    extra: {
      type: 'narrator',
      story_echo_injection: true,
      story_echo_injection_kind: kind,
    },
  };
}

async function prepareStoryEchoPrompt(
  chat: TavernChatMessage[],
  _contextSize: number,
  _abort: () => void,
  type?: string,
): Promise<void> {
  const settings = settingsRepository.get();
  if (!settings.enabled || !isSupportedGenerationType(type)) {
    return;
  }

  try {
    const startedAt = performance.now();
    const memoryEnabled = settings.memory.enabled;
    const sourceChat = getContext().chat;
    const minimumSourceWindow = selectRecentWindow(
      sourceChat,
      settings.recentWindow.size,
      settings.recentWindow.unit,
    );
    if (!minimumSourceWindow || minimumSourceWindow.removableIndices.length === 0) {
      return;
    }

    let state = await memoryRepository.getOrCreate();
    if (!state) {
      return;
    }
    state = memoryEnabled
      ? await extractionService.reconcileHistory(state, { purgeVectors: false })
      : await stageSummaryService.reconcileHistory(state);
    if (!state) {
      return;
    }
    state = await storySkeletonService.reconcile(state) ?? state;

    const warnings: string[] = [];
    const desiredCoveredThrough = minimumSourceWindow.retainedStartIndex - 1;
    // Extraction, summarization and vector writes are intentionally never run
    // here. If their cursors lag, safeSourceRetainedStart keeps every uncovered
    // raw message. The reply-complete scheduler catches up in the background.
    state.metrics.generationAttempts += 1;

    if (memoryEnabled && state.indexedThroughMessageId < desiredCoveredThrough) {
      warnings.push(
        `剧情索引只覆盖到消息 ${state.indexedThroughMessageId}，索引后的原文暂不裁剪。`,
      );
    }
    if (state.stageSummary.coveredThroughMessageId < desiredCoveredThrough) {
      warnings.push(
        `阶段总结只覆盖到消息 ${state.stageSummary.coveredThroughMessageId}，未总结原文暂不裁剪。`,
      );
    }

    const retainedSourceStart = safeSourceRetainedStart(
      sourceChat,
      minimumSourceWindow.retainedStartIndex,
      state,
      memoryEnabled,
      settings.recentWindow.unit,
    );
    const retainedHistoricalMessageCount = countNonSystemMessages(
      sourceChat,
      retainedSourceStart,
      minimumSourceWindow.currentInputIndex,
    );
    const window = selectRecentWindow(chat, retainedHistoricalMessageCount, 'messages');
    if (!window) {
      return;
    }

    if (window.removableIndices.length === 0) {
      state.lastInspection = createInspection(
        type,
        retainedSourceStart,
        minimumSourceWindow.currentInputIndex,
        0,
        '',
        [],
        [],
        warnings,
        0,
        Math.round(performance.now() - startedAt),
        0,
        0,
        0,
        state.stageSummary.coveredThroughMessageId,
      );
      state.metrics.generationsDeferred += 1;
      state.metrics.lastGenerationAt = new Date().toISOString();
      recordDebugTrace(state, settings.debug, 'interceptor', '派生上下文尚未覆盖裁剪边界，本次保留完整聊天。', {
        indexedThrough: state.indexedThroughMessageId,
        summaryCoveredThrough: state.stageSummary.coveredThroughMessageId,
        desiredCoveredThrough,
      });
      await memoryRepository.save(state);
      emitDiagnosticsUpdated();
      return;
    }

    if (
      memoryEnabled &&
      (state.pendingVectorHashes.length > 0 || state.pendingVectorDeleteHashes.length > 0)
    ) {
      warnings.push('部分剧情记忆尚未完成向量化，将使用可用索引和关键词召回。');
    }

    const currentInput = chat[window.currentInputIndex];
    const factVerification = isFactVerificationQuery(currentInput?.mes ?? '');
    const establishedNames = new Set((memoryEnabled ? state.memories : []).flatMap((memory) => (
      directlyGroundedStoryMemoryNames(memory, sourceChat).map(normalizedStoryEntityName)
    )));
    const ungroundedMemoryNames = new Map<string, string[]>();
    const groundedMemories = (memoryEnabled ? state.memories : []).filter((memory) => {
      const names = unsupportedStoryMemoryNames(memory, sourceChat, establishedNames);
      if (names.length > 0) {
        ungroundedMemoryNames.set(memory.id, names);
        return false;
      }
      return true;
    });
    const storyPhaseScope = scopeMemoriesToCurrentStoryPhase(
      groundedMemories,
      sourceChat,
      minimumSourceWindow.currentInputIndex,
    );
    if (storyPhaseScope.excludedMemoryIds.length > 0) {
      recordDebugTrace(state, settings.debug, 'retrieval', '当前剧情阶段已隔离较早阶段记忆。', {
        boundaryMessageId: storyPhaseScope.boundaryMessageId ?? -1,
        excludedMemories: storyPhaseScope.excludedMemoryIds.length,
      });
    }
    const activeScopedMemories = storyPhaseScope.memories.filter((memory) => (
      !memory.excluded &&
      memory.status !== 'invalid' &&
      memory.status !== 'superseded'
    ));
    const shadowedMemories = activeScopedMemories.filter((memory) => (
      isShadowedByRecentUserFact(
        memory,
        sourceChat,
        retainedSourceStart,
        minimumSourceWindow.currentInputIndex,
      )
    ));
    const shadowedIds = new Set(shadowedMemories.map((memory) => memory.id));
    const windowExternalMemories = suppressStaleAtomicStates(activeScopedMemories.filter(
      (memory) =>
        !shadowedIds.has(memory.id) &&
        hasSourceOutsideWindow(memory, retainedSourceStart),
    ));
    if (ungroundedMemoryNames.size > 0) {
      recordDebugTrace(state, settings.debug, 'retrieval', '已隔离缺少源楼层证据的旧版记忆。', {
        memories: [...ungroundedMemoryNames.entries()]
          .map(([id, names]) => `${id}:${names.join('、')}`)
          .join(' | '),
        count: ungroundedMemoryNames.size,
      });
    }
    const eligibleMemories = windowExternalMemories.filter((memory) => (
      (!factVerification || memory.truthStatus === 'confirmed')
    ));
    const recallEnabled = memoryEnabled &&
      settings.recall.maxEvents > 0 && settings.recall.maxTokens > 0;
    if (shadowedMemories.length > 0) {
      recordDebugTrace(state, settings.debug, 'retrieval', '近期用户事实已遮蔽冲突的较早记忆。', {
        memoryIds: shadowedMemories.map((memory) => memory.id).join(','),
        count: shadowedMemories.length,
      });
    }
    let queryPlan = buildRetrievalQueryPlan(chat, window.currentInputIndex);
    if (
      settings.recall.queryMode === 'llm' &&
      recallEnabled &&
      eligibleMemories.length > 0
    ) {
      state.metrics.queryRewriteRequests += 1;
      try {
        const rewrite = await queryRewriteService.rewrite(
          settings,
          chat,
          window.currentInputIndex,
          state.chatUuid,
        );
        if (rewrite.cacheHit) {
          state.metrics.queryRewriteCacheHits += 1;
        } else {
          state.metrics.totalQueryRewriteMs += rewrite.durationMs;
        }
        queryPlan = withRewrittenRetrievalQuery(queryPlan, rewrite.query);
        recordDebugTrace(state, settings.debug, 'retrieval', 'LLM检索查询改写完成。', {
          query: rewrite.query,
          cacheHit: rewrite.cacheHit,
          durationMs: rewrite.durationMs,
        });
      } catch (error) {
        state.metrics.queryRewriteFailures += 1;
        warnings.push('LLM查询改写失败，已回退到本地双路查询。');
        recordDebugTrace(state, settings.debug, 'retrieval', 'LLM检索查询改写失败，使用本地回退。', {
          error: error instanceof Error ? error.message : String(error),
        });
        logger.warn('LLM检索查询改写失败，使用本地回退。', error);
      }
    }
    const query = !memoryEnabled
      ? ''
      : queryPlan.strategy === 'llm'
      ? [
          '策略：LLM上下文改写',
          `改写查询：${queryPlan.intentQuery}`,
          `原始用户：${queryPlan.keywordIntentQuery || '（空）'}`,
          `场景尾部：${queryPlan.keywordSceneQuery || '（空）'}`,
        ].join('\n')
      : [
          `策略：${settings.recall.queryMode === 'llm' ? '本地回退' : '本地快速模式'}`,
          `用户意图（权重 ${queryPlan.intentWeight}${queryPlan.weakIntent ? '，弱语义' : ''}）：${queryPlan.intentQuery || '（空）'}`,
          `场景补充（权重 ${queryPlan.sceneWeight}）：${queryPlan.sceneQuery || '（空）'}`,
        ].join('\n');

    const vectorResults: RetrievalVectorResults = { intent: [], scene: [] };
    if (
      eligibleMemories.length > 0 &&
      recallEnabled &&
      (queryPlan.intentQuery || queryPlan.sceneQuery)
    ) {
      const queryStartedAt = performance.now();
      const topK = Math.max(settings.recall.maxEvents * 3, 24);
      const vectorConfig = resolveVectorConfig(settings);
      const queryVectorChannel = async (
        channel: string,
        searchText: string,
      ): Promise<VectorQueryResult[]> => {
        if (!searchText) {
          return [];
        }
        state.metrics.vectorQueries += 1;
        try {
          return await vectorStore.query(
            state.vectorCollectionId,
            searchText,
            topK,
            settings.recall.scoreThreshold,
            vectorConfig,
            { timeoutMs: FOREGROUND_VECTOR_QUERY_TIMEOUT_MS },
          );
        } catch (error) {
          state.metrics.vectorQueryFailures += 1;
          warnings.push(`${channel}向量检索失败，该通道将使用实体关键词降级。`);
          logger.warn(`${channel}向量检索失败。`, error);
          return [];
        }
      };
      [vectorResults.intent, vectorResults.scene] = await Promise.all([
        queryVectorChannel(queryPlan.strategy === 'llm' ? 'LLM改写' : '用户意图', queryPlan.intentQuery),
        queryVectorChannel('场景补充', queryPlan.sceneQuery),
      ]);
      state.metrics.totalRetrievalMs += Math.round(performance.now() - queryStartedAt);
    }

    const ranked = recallEnabled
      ? rankMemories(queryPlan, eligibleMemories, vectorResults)
      : [];
    const uniqueVectorResultCount = new Set([
      ...vectorResults.intent.map((result) => result.hash),
      ...vectorResults.scene.map((result) => result.hash),
    ]).size;
    const selected = selectWithinBudget(
      ranked,
      settings.recall.maxEvents,
      settings.recall.maxTokens,
      `${queryPlan.intentQuery}\n${currentInput?.mes ?? ''}`,
      eligibleMemories,
    );
    const entityConstraints = recallEnabled
      ? buildEntityDisambiguationConstraints(
        activeScopedMemories.filter((memory) => (
          !shadowedIds.has(memory.id) &&
          (!factVerification || memory.truthStatus === 'confirmed')
        )),
        currentInput?.mes ?? '',
      )
      : [];
    const recallBlock = selected.length > 0 || entityConstraints.length > 0
      ? renderMemoryBlock(selected, entityConstraints, factVerification)
      : '';
    const summaryWindowSize = Math.max(1, Math.floor(settings.summary.windowSize));
    const activeStageSummaries = state.stageSummary.entries.filter((entry) => !entry.deleted);
    const archivedSummaries = archivedStageSummaryEntries(state, summaryWindowSize);
    const pendingArchivedSummaries = pendingArchivedStageSummaryEntries(state, summaryWindowSize);
    const recentSummaryPool = activeStageSummaries.slice(-summaryWindowSize);
    const summaryPool = storyPhaseScope.boundaryMessageId !== null &&
      !storyPhaseScope.earlierPhaseQuery
      ? recentSummaryPool.filter((entry) => (
          entry.sourceStartMessageId >= storyPhaseScope.boundaryMessageId!
        ))
      : recentSummaryPool;
    if (summaryPool.length < recentSummaryPool.length) {
      recordDebugTrace(state, settings.debug, 'retrieval', '当前剧情阶段已省略较早阶段总结。', {
        boundaryMessageId: storyPhaseScope.boundaryMessageId ?? -1,
        excludedSummaries: recentSummaryPool.length - summaryPool.length,
      });
    }
    const summaryEntries = [...pendingArchivedSummaries, ...summaryPool];
    const skeletonBlock = storySkeletonIsUsable(state)
      ? renderStorySkeletonBlock(
          state.storySkeleton.text,
          state.storySkeleton.coveredThroughMessageId,
          factVerification,
        )
      : '';
    if (state.storySkeleton.text && state.storySkeleton.stale) {
      warnings.push('全局剧情骨架来源已失效，重建成功前改为携带尚未合并的阶段总结。');
    }
    const summaryBlocks = summaryEntries.map((entry) => renderStageSummaryBlock(
      entry.text,
      entry.sourceStartMessageId,
      entry.sourceEndMessageId,
      factVerification,
    )).filter(Boolean);
    const currentStateBlock = memoryEnabled && (summaryEntries.length > 0 || skeletonBlock)
      ? renderCurrentStateCoordinationBlock(
          activeScopedMemories.filter((memory) => !shadowedIds.has(memory.id)),
          600,
          factVerification,
        )
      : '';
    const estimatedRemovedTokens = estimateMessageTokens(chat, window.removableIndices);
    const estimatedSummaryTokens = (skeletonBlock ? estimateTokens(skeletonBlock) : 0) + summaryBlocks.reduce(
      (total, block) => total + estimateTokens(block),
      0,
    ) + (currentStateBlock ? estimateTokens(currentStateBlock) : 0);
    const estimatedInjectedTokens = estimatedSummaryTokens + (
      recallBlock ? estimateTokens(recallBlock) : 0
    );

    const retainedAnchor = chat[window.retainedStartIndex];
    removeMessagesAtIndices(chat, window.removableIndices);

    if (skeletonBlock || summaryBlocks.length > 0 || currentStateBlock) {
      const anchorIndex = retainedAnchor ? chat.indexOf(retainedAnchor) : 0;
      chat.splice(
        Math.max(0, anchorIndex),
        0,
        ...(skeletonBlock ? [requestSystemMessage(skeletonBlock, 'summary')] : []),
        ...summaryBlocks.map((block) => requestSystemMessage(block, 'summary')),
        ...(currentStateBlock ? [requestSystemMessage(currentStateBlock, 'state')] : []),
      );
    }
    if (recallBlock && currentInput) {
      const currentInputIndex = chat.indexOf(currentInput);
      if (currentInputIndex >= 0) {
        chat.splice(currentInputIndex, 0, requestSystemMessage(recallBlock, 'recall'));
      } else {
        warnings.push('找不到当前用户消息，已跳过动态召回注入。');
      }
    }

    state.lastInspection = createInspection(
      type,
      retainedSourceStart,
      minimumSourceWindow.currentInputIndex,
      window.removableIndices.length,
      query,
      ranked,
      selected,
      warnings,
      uniqueVectorResultCount,
      Math.round(performance.now() - startedAt),
      estimatedRemovedTokens,
      estimatedInjectedTokens,
      estimatedSummaryTokens,
      state.stageSummary.coveredThroughMessageId,
    );
    state.metrics.generationsTrimmed += 1;
    state.metrics.messagesRemoved += window.removableIndices.length;
    state.metrics.memoriesInjected += selected.length;
    state.metrics.estimatedRemovedTokens += estimatedRemovedTokens;
    state.metrics.estimatedInjectedTokens += estimatedInjectedTokens;
    state.metrics.lastGenerationAt = new Date().toISOString();
    recordDebugTrace(state, settings.debug, 'interceptor', '上下文裁剪、阶段总结与剧情召回完成。', {
      retainedSourceStart,
      removedMessages: window.removableIndices.length,
      summaryCoveredThrough: state.stageSummary.coveredThroughMessageId,
      summaryEntriesStored: activeStageSummaries.length,
      summaryEntriesDeleted: state.stageSummary.entries.length - activeStageSummaries.length,
      summaryEntriesInjected: summaryBlocks.length,
      summaryEntriesArchived: archivedSummaries.length,
      skeletonInjected: Boolean(skeletonBlock),
      skeletonCoveredThrough: state.storySkeleton.coveredThroughMessageId,
      skeletonPendingEntries: pendingArchivedSummaries.length,
      intentVectorResults: vectorResults.intent.length,
      sceneVectorResults: vectorResults.scene.length,
      uniqueVectorResults: uniqueVectorResultCount,
      queryStrategy: queryPlan.strategy,
      factVerification,
      weakIntent: queryPlan.weakIntent,
      intentWeight: queryPlan.intentWeight,
      sceneWeight: queryPlan.sceneWeight,
      rankedMemories: ranked.length,
      injectedMemories: selected.length,
      eligibleMemoryIds: eligibleMemories.map((memory) => memory.id).join(','),
      intentVectorMatches: vectorResults.intent
        .map((result) => `${result.hash}@${result.rank}`)
        .join(','),
      sceneVectorMatches: vectorResults.scene
        .map((result) => `${result.hash}@${result.rank}`)
        .join(','),
      selectedMemoryIds: selected.map((memory) => memory.id).join(','),
      exactEntityRescues: selected
        .filter((memory) => !ranked.some((rankedMemory) => rankedMemory.id === memory.id))
        .map((memory) => memory.id)
        .join(','),
      estimatedRemovedTokens,
      estimatedSummaryTokens,
      estimatedInjectedTokens,
      durationMs: Math.round(performance.now() - startedAt),
    });
    try {
      await memoryRepository.save(state);
      emitDiagnosticsUpdated();
    } catch (error) {
      logger.warn('保存上下文检查记录失败。', error);
    }
  } catch (error) {
    logger.error('生成拦截失败，已放行原始生成。', error);
  }
}

export async function storyEchoGenerateInterceptor(
  chat: TavernChatMessage[],
  contextSize: number,
  abort: () => void,
  type?: string,
): Promise<void> {
  const settings = settingsRepository.get();
  if (
    !settings.enabled
    || !isSupportedGenerationType(type)
    || isInternalGenerationRequest(chat)
  ) {
    return;
  }

  const requestedContext = getContext();
  const requestedChatId = getCurrentChatId(requestedContext);
  const requestedSourceChat = requestedContext.chat;
  await storyEchoTaskCoordinator.enqueueForeground(
    '生成前上下文准备',
    async () => {
      const currentContext = getContext();
      const currentChatId = getCurrentChatId(currentContext);
      const sameChat = requestedChatId
        ? currentChatId === requestedChatId
        : currentContext.chat === requestedSourceChat;
      if (!sameChat) {
        logger.info('等待队列期间聊天已切换，已取消过期的上下文准备任务。');
        return false;
      }
      await prepareStoryEchoPrompt(chat, contextSize, abort, type);
      return true;
    },
    { holdForegroundLease: (prepared) => prepared },
  );
}
