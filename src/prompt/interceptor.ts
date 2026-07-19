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
import { isInternalGeneration } from '../llm/internal-generation';
import { MemoryRepository } from '../memory/repository';
import { getContext } from '../platform/sillytavern';
import {
  buildRetrievalQueryPlan,
  withRewrittenRetrievalQuery,
} from '../retrieval/query-builder';
import { hasSourceOutsideWindow } from '../retrieval/eligibility';
import { isShadowedByRecentUserFact } from '../retrieval/recent-shadow';
import { queryRewriteService } from '../retrieval/query-rewriter';
import { rankMemories, type RetrievalVectorResults } from '../retrieval/ranker';
import { SettingsRepository } from '../settings/repository';
import { stageSummaryService } from '../summary/service';
import type { VectorQueryResult } from '../vector/adapter';
import { resolveVectorConfig } from '../vector/config';
import { SillyTavernVectorStore } from '../vector/sillytavern-vector-store';
import {
  buildEntityDisambiguationConstraints,
  estimateMessageTokens,
  estimateMemoryTokens,
  estimateTokens,
  renderCurrentStateCoordinationBlock,
  renderMemoryBlock,
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
  summaryEnabled: boolean,
  unit: 'turns' | 'messages',
): number {
  const extractionBoundary = Math.max(0, state.indexedThroughMessageId + 1);
  const summaryBoundary = summaryEnabled && state.stageSummary.entries.length > 0
    ? Math.max(0, state.stageSummary.coveredThroughMessageId + 1)
    : summaryEnabled ? 0 : minimumRetainedStart;
  const proposed = Math.min(minimumRetainedStart, extractionBoundary, summaryBoundary);
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

export async function storyEchoGenerateInterceptor(
  chat: TavernChatMessage[],
  _contextSize: number,
  _abort: () => void,
  type?: string,
): Promise<void> {
  const settings = settingsRepository.get();
  if (!settings.enabled || isInternalGeneration() || !isSupportedGenerationType(type)) {
    return;
  }

  try {
    const startedAt = performance.now();
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
    state = await extractionService.reconcileHistory(state);
    if (!state) {
      return;
    }

    const warnings: string[] = [];
    const desiredCoveredThrough = minimumSourceWindow.retainedStartIndex - 1;
    if (state.indexedThroughMessageId < desiredCoveredThrough && settings.extraction.automatic) {
      try {
        state = await extractionService.processNextThrough(desiredCoveredThrough);
      } catch (error) {
        warnings.push('生成前补充剧情索引失败，未覆盖原文将继续保留。');
        logger.warn('生成前补充剧情索引失败。', error);
        state = memoryRepository.getExisting() ?? state;
      }
    }
    if (!state) {
      return;
    }

    if (
      settings.summary.enabled &&
      settings.summary.automatic &&
      state.stageSummary.coveredThroughMessageId < desiredCoveredThrough
    ) {
      try {
        const result = await stageSummaryService.processNextThrough(desiredCoveredThrough);
        state = result.state ?? state;
      } catch (error) {
        warnings.push('生成前更新阶段总结失败，未总结原文将继续保留。');
        logger.warn('生成前更新阶段总结失败。', error);
        state = memoryRepository.getExisting() ?? state;
      }
    }

    // Automatic background work reloads chat metadata. Count the generation
    // only after both hand-offs so the increment cannot be overwritten.
    state.metrics.generationAttempts += 1;

    if (state.indexedThroughMessageId < desiredCoveredThrough) {
      warnings.push(
        `剧情索引只覆盖到消息 ${state.indexedThroughMessageId}，索引后的原文暂不裁剪。`,
      );
    }
    if (
      settings.summary.enabled &&
      state.stageSummary.coveredThroughMessageId < desiredCoveredThrough
    ) {
      warnings.push(
        `阶段总结只覆盖到消息 ${state.stageSummary.coveredThroughMessageId}，未总结原文暂不裁剪。`,
      );
    }

    const retainedSourceStart = safeSourceRetainedStart(
      sourceChat,
      minimumSourceWindow.retainedStartIndex,
      state,
      settings.summary.enabled,
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

    try {
      const synchronized = await extractionService.syncPendingVectors(state);
      if (synchronized) {
        state = synchronized;
      }
    } catch (error) {
      state.metrics.vectorSyncFailures += 1;
      recordDebugTrace(state, settings.debug, 'vector', '生成前同步向量失败。', {
        error: error instanceof Error ? error.message : String(error),
      });
      warnings.push('部分剧情记忆尚未完成向量化，将使用可用索引和关键词召回。');
      logger.warn('同步待处理向量失败。', error);
    }

    const windowExternalMemories = state.memories.filter(
      (memory) =>
        !memory.excluded &&
        memory.status !== 'invalid' &&
        memory.status !== 'superseded' &&
        hasSourceOutsideWindow(memory, retainedSourceStart),
    );
    const shadowedMemories = windowExternalMemories.filter((memory) => (
      isShadowedByRecentUserFact(
        memory,
        sourceChat,
        retainedSourceStart,
        minimumSourceWindow.currentInputIndex,
      )
    ));
    const shadowedIds = new Set(shadowedMemories.map((memory) => memory.id));
    const eligibleMemories = windowExternalMemories.filter((memory) => !shadowedIds.has(memory.id));
    const recallEnabled = settings.recall.maxEvents > 0 && settings.recall.maxTokens > 0;
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
    const query = queryPlan.strategy === 'llm'
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
    const currentInput = chat[window.currentInputIndex];
    const selected = selectWithinBudget(
      ranked,
      settings.recall.maxEvents,
      settings.recall.maxTokens,
      `${queryPlan.intentQuery}\n${currentInput?.mes ?? ''}`,
    );
    const entityConstraints = recallEnabled
      ? buildEntityDisambiguationConstraints(
        state.memories.filter((memory) => (
          !memory.excluded && memory.status !== 'invalid' && memory.status !== 'superseded'
        )),
        currentInput?.mes ?? '',
      )
      : [];
    const recallBlock = selected.length > 0 || entityConstraints.length > 0
      ? renderMemoryBlock(selected, entityConstraints)
      : '';
    const summaryWindowSize = Math.max(1, Math.floor(settings.summary.windowSize));
    const summaryEntries = settings.summary.enabled
      ? state.stageSummary.entries.slice(-summaryWindowSize)
      : [];
    const summaryBlocks = summaryEntries.map((entry) => renderStageSummaryBlock(
      entry.text,
      entry.sourceStartMessageId,
      entry.sourceEndMessageId,
    ));
    const currentStateBlock = summaryBlocks.length > 0
      ? renderCurrentStateCoordinationBlock(state.memories)
      : '';
    const estimatedRemovedTokens = estimateMessageTokens(chat, window.removableIndices);
    const estimatedSummaryTokens = summaryBlocks.reduce(
      (total, block) => total + estimateTokens(block),
      0,
    ) + (currentStateBlock ? estimateTokens(currentStateBlock) : 0);
    const estimatedInjectedTokens = estimatedSummaryTokens + (
      recallBlock ? estimateTokens(recallBlock) : 0
    );

    const retainedAnchor = chat[window.retainedStartIndex];
    removeMessagesAtIndices(chat, window.removableIndices);

    if (summaryBlocks.length > 0) {
      const anchorIndex = retainedAnchor ? chat.indexOf(retainedAnchor) : 0;
      chat.splice(
        Math.max(0, anchorIndex),
        0,
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
      summaryEntriesStored: state.stageSummary.entries.length,
      summaryEntriesInjected: summaryBlocks.length,
      intentVectorResults: vectorResults.intent.length,
      sceneVectorResults: vectorResults.scene.length,
      uniqueVectorResults: uniqueVectorResultCount,
      queryStrategy: queryPlan.strategy,
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
