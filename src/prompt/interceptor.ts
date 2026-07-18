import { DISPLAY_NAME } from '../core/constants';
import { logger } from '../core/logger';
import type { InspectionRecord, StoryMemory, TavernChatMessage } from '../core/types';
import { emitDiagnosticsUpdated } from '../debug/events';
import { recordDebugTrace } from '../debug/metrics';
import { planNextChunk } from '../extraction/chunk-planner';
import { extractionService } from '../extraction/service';
import { isInternalGeneration } from '../llm/internal-generation';
import { MemoryRepository } from '../memory/repository';
import { getContext } from '../platform/sillytavern';
import {
  buildRetrievalQueryPlan,
  withRewrittenRetrievalQuery,
} from '../retrieval/query-builder';
import { queryRewriteService } from '../retrieval/query-rewriter';
import { rankMemories, type RetrievalVectorResults } from '../retrieval/ranker';
import { SettingsRepository } from '../settings/repository';
import { resolveVectorConfig } from '../vector/config';
import type { VectorQueryResult } from '../vector/adapter';
import { SillyTavernVectorStore } from '../vector/sillytavern-vector-store';
import { estimateTokens, renderMemoryBlock, selectWithinBudget } from './render';
import { selectRecentWindow } from './window';

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
    estimatedRecallTokens: selected.reduce(
      (total, memory) => total + estimateTokens(memory.injectionText),
      0,
    ),
    estimatedRemovedTokens,
    estimatedInjectedTokens,
    estimatedNetSavedTokens: Math.max(0, estimatedRemovedTokens - estimatedInjectedTokens),
    vectorResultCount,
    durationMs,
    warnings,
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
    const window = selectRecentWindow(chat, settings.recentWindow.size, settings.recentWindow.unit);
    const sourceChat = getContext().chat;
    const sourceWindow = selectRecentWindow(
      sourceChat,
      settings.recentWindow.size,
      settings.recentWindow.unit,
    );
    if (!window || !sourceWindow || window.removableIndices.length === 0) {
      return;
    }

    let state = await memoryRepository.getOrCreate();
    if (!state) {
      return;
    }
    state.metrics.generationAttempts += 1;

    const warnings: string[] = [];
    const requiredIndexedThrough = sourceWindow.retainedStartIndex - 1;
    if (state.indexedThroughMessageId < requiredIndexedThrough) {
      if (settings.extraction.automatic) {
        try {
          const chunk = planNextChunk(
            sourceChat,
            state.indexedThroughMessageId + 1,
            requiredIndexedThrough,
            settings.extraction.targetTurnsPerChunk,
          );
          if (chunk) {
            state = await extractionService.processThrough(chunk.endMessageId);
          }
        } catch (error) {
          warnings.push('生成前补充剧情索引失败。');
          logger.warn('生成前补充剧情索引失败。', error);
        }
      }

      if (!state) {
        return;
      }
    }

    if (state.indexedThroughMessageId < requiredIndexedThrough) {
      warnings.push(
        `剧情索引只覆盖到消息 ${state.indexedThroughMessageId}，尚不能安全裁剪到 ${requiredIndexedThrough}。`,
      );
      state.lastInspection = createInspection(
        type,
        0,
        chat.length - 1,
        0,
        '',
        [],
        [],
        warnings,
        0,
        Math.round(performance.now() - startedAt),
      );
      state.metrics.generationsDeferred += 1;
      state.metrics.lastGenerationAt = new Date().toISOString();
      recordDebugTrace(state, settings.debug, 'interceptor', '索引未覆盖窗口边界，本次保留完整聊天。', {
        indexedThrough: state.indexedThroughMessageId,
        requiredIndexedThrough,
      });
      await memoryRepository.save(state);
      emitDiagnosticsUpdated();
      logger.warn('索引未覆盖裁剪边界，本次保留完整聊天。', warnings[0]);
      return;
    }

    try {
      state = await extractionService.syncPendingVectors(state);
    } catch (error) {
      if (state) {
        state.metrics.vectorSyncFailures += 1;
        recordDebugTrace(state, settings.debug, 'vector', '生成前同步向量失败。', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      warnings.push('部分剧情记忆尚未完成向量化，将使用可用索引和关键词召回。');
      logger.warn('同步待处理向量失败。', error);
    }
    if (!state) {
      return;
    }

    const eligibleMemories = state.memories.filter(
      (memory) =>
        !memory.excluded &&
        memory.status !== 'invalid' &&
        memory.status !== 'superseded' &&
        memory.source.endMessageId < sourceWindow.retainedStartIndex,
    );
    let queryPlan = buildRetrievalQueryPlan(chat, window.currentInputIndex);
    if (
      settings.recall.queryMode === 'llm' &&
      settings.recall.maxEvents > 0 &&
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
        const message = error instanceof Error ? error.message : String(error);
        warnings.push('LLM查询改写失败，已回退到本地双路查询。');
        recordDebugTrace(state, settings.debug, 'retrieval', 'LLM检索查询改写失败，使用本地回退。', {
          error: message,
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
      settings.recall.maxEvents > 0 &&
      (queryPlan.intentQuery || queryPlan.sceneQuery)
    ) {
      const queryStartedAt = performance.now();
      const topK = Math.max(settings.recall.maxEvents * 3, settings.recall.maxEvents);
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

    const ranked = rankMemories(queryPlan, eligibleMemories, vectorResults);
    const uniqueVectorResultCount = new Set([
      ...vectorResults.intent.map((result) => result.hash),
      ...vectorResults.scene.map((result) => result.hash),
    ]).size;
    const selected = selectWithinBudget(
      ranked,
      settings.recall.maxEvents,
      settings.recall.maxTokens,
    );
    const memoryBlock = selected.length > 0 ? renderMemoryBlock(selected) : '';
    const estimatedRemovedTokens = window.removableIndices.reduce(
      (total, index) => total + estimateTokens(chat[index]?.mes ?? ''),
      0,
    );
    const estimatedInjectedTokens = memoryBlock ? estimateTokens(memoryBlock) : 0;

    const anchor = chat[window.retainedStartIndex];
    const removable = new Set(window.removableIndices);
    for (let index = chat.length - 1; index >= 0; index -= 1) {
      if (removable.has(index)) {
        chat.splice(index, 1);
      }
    }

    if (memoryBlock) {
      const anchorIndex = anchor ? chat.indexOf(anchor) : 0;
      chat.splice(Math.max(0, anchorIndex), 0, {
        is_user: false,
        is_system: true,
        name: DISPLAY_NAME,
        send_date: Date.now(),
        mes: memoryBlock,
        extra: { story_echo_injection: true },
      });
    }

    state.lastInspection = createInspection(
      type,
      window.retainedStartIndex,
      window.currentInputIndex,
      window.removableIndices.length,
      query,
      ranked,
      selected,
      warnings,
      uniqueVectorResultCount,
      Math.round(performance.now() - startedAt),
      estimatedRemovedTokens,
      estimatedInjectedTokens,
    );
    state.metrics.generationsTrimmed += 1;
    state.metrics.messagesRemoved += window.removableIndices.length;
    state.metrics.memoriesInjected += selected.length;
    state.metrics.estimatedRemovedTokens += estimatedRemovedTokens;
    state.metrics.estimatedInjectedTokens += estimatedInjectedTokens;
    state.metrics.lastGenerationAt = new Date().toISOString();
    recordDebugTrace(state, settings.debug, 'interceptor', '上下文裁剪与剧情召回完成。', {
      removedMessages: window.removableIndices.length,
      intentVectorResults: vectorResults.intent.length,
      sceneVectorResults: vectorResults.scene.length,
      uniqueVectorResults: uniqueVectorResultCount,
      queryStrategy: queryPlan.strategy,
      weakIntent: queryPlan.weakIntent,
      intentWeight: queryPlan.intentWeight,
      sceneWeight: queryPlan.sceneWeight,
      rankedMemories: ranked.length,
      injectedMemories: selected.length,
      estimatedRemovedTokens,
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
