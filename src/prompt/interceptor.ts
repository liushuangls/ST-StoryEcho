import { DISPLAY_NAME } from '../core/constants';
import { logger } from '../core/logger';
import type { InspectionRecord, StoryMemory, TavernChatMessage } from '../core/types';
import { planNextChunk } from '../extraction/chunk-planner';
import { extractionService } from '../extraction/service';
import { isInternalGeneration } from '../llm/internal-generation';
import { MemoryRepository } from '../memory/repository';
import { getContext } from '../platform/sillytavern';
import { buildRetrievalQuery } from '../retrieval/query-builder';
import { rankMemories } from '../retrieval/ranker';
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
      );
      await memoryRepository.save(state);
      logger.warn('索引未覆盖裁剪边界，本次保留完整聊天。', warnings[0]);
      return;
    }

    try {
      state = await extractionService.syncPendingVectors(state);
    } catch (error) {
      warnings.push('部分剧情记忆尚未完成向量化，将使用可用索引和关键词召回。');
      logger.warn('同步待处理向量失败。', error);
    }
    if (!state) {
      return;
    }

    const query = buildRetrievalQuery(chat, window.currentInputIndex);
    const eligibleMemories = state.memories.filter(
      (memory) =>
        !memory.excluded &&
        memory.status !== 'invalid' &&
        memory.status !== 'superseded' &&
        memory.source.endMessageId < sourceWindow.retainedStartIndex,
    );

    let vectorResults: VectorQueryResult[] = [];
    if (eligibleMemories.length > 0 && query.trim()) {
      try {
        vectorResults = await vectorStore.query(
          state.vectorCollectionId,
          query,
          Math.max(settings.recall.maxEvents * 3, settings.recall.maxEvents),
          settings.recall.scoreThreshold,
          resolveVectorConfig(settings),
        );
      } catch (error) {
        warnings.push('Vector Storage检索失败，本次只使用固定记忆。');
        logger.warn('Vector Storage检索失败。', error);
      }
    }

    const ranked = rankMemories(query, eligibleMemories, vectorResults);
    const selected = selectWithinBudget(
      ranked,
      settings.recall.maxEvents,
      settings.recall.maxTokens,
    );
    const memoryBlock = selected.length > 0 ? renderMemoryBlock(selected) : '';

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
    );
    try {
      await memoryRepository.save(state);
    } catch (error) {
      logger.warn('保存上下文检查记录失败。', error);
    }
  } catch (error) {
    logger.error('生成拦截失败，已放行原始生成。', error);
  }
}
