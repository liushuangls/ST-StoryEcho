import { logger } from '../core/logger';
import { sha256 } from '../core/hash';
import type { StoryEchoChatState, TavernChatMessage } from '../core/types';
import { applyConsolidationDecisions } from '../consolidation/apply';
import { decideConsolidation } from '../consolidation/service';
import { shortlistMemories } from '../consolidation/shortlist';
import { recordDebugTrace } from '../debug/metrics';
import { completeWithConfiguredProvider } from '../llm/complete';
import { MemoryRepository } from '../memory/repository';
import { getContext, getCurrentChatId } from '../platform/sillytavern';
import { SettingsRepository } from '../settings/repository';
import { resolveVectorConfig, vectorConfigFingerprint } from '../vector/config';
import { SillyTavernVectorStore } from '../vector/sillytavern-vector-store';
import { planNextChunk } from './chunk-planner';
import { parseExtractionResponse } from './parser';
import { buildExtractionPrompt, EXTRACTION_SYSTEM_PROMPT } from './prompts';
import { assessMemoryCandidates } from './quality';
import { EXTRACTION_SCHEMA } from './schema';

export interface ExtractionProgress {
  startMessageId: number;
  endMessageId: number;
  targetEndMessageId: number;
  newMemoryCount: number;
  changedMemoryCount: number;
}

function sourcePayload(messages: TavernChatMessage[], sourceStartMessageId: number): string {
  return JSON.stringify(messages.map((message, offset) => ({
    messageId: sourceStartMessageId + offset,
    isUser: message.is_user,
    isSystem: Boolean(message.is_system),
    name: message.name || '',
    content: message.mes,
  })));
}

function assertChatOwner(state: StoryEchoChatState): void {
  if (getCurrentChatId() !== state.ownerChatId) {
    throw new Error('抽取期间聊天发生切换，已取消写入。');
  }
}

export class ExtractionService {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly settingsRepository = new SettingsRepository();
  private readonly memoryRepository = new MemoryRepository();
  private readonly vectorStore = new SillyTavernVectorStore();

  processThrough(
    targetEndMessageId: number,
    onProgress?: (progress: ExtractionProgress) => void,
  ): Promise<StoryEchoChatState | null> {
    const requestedChatId = getCurrentChatId();
    const operation = this.queue.then(
      () => this.processThroughNow(targetEndMessageId, requestedChatId, onProgress),
      () => this.processThroughNow(targetEndMessageId, requestedChatId, onProgress),
    );
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async syncPendingVectors(state?: StoryEchoChatState): Promise<StoryEchoChatState | null> {
    const current = state ?? await this.memoryRepository.getOrCreate();
    if (!current) {
      return current;
    }

    assertChatOwner(current);
    const settings = this.settingsRepository.get();
    const config = resolveVectorConfig(settings);
    const fingerprint = await vectorConfigFingerprint(config);
    const eligible = current.memories.filter(
      (memory) => memory.status !== 'invalid' && memory.status !== 'superseded',
    );
    const eligibleHashes = new Set(eligible.map((memory) => memory.vectorHash));
    const configurationChanged = current.vectorFingerprint !== fingerprint;

    if (configurationChanged) {
      const isRebuild = current.vectorFingerprint.length > 0;
      current.pendingVectorHashes = [...eligibleHashes];
      current.pendingVectorDeleteHashes = [];
      current.metrics.vectorRebuilds += isRebuild ? 1 : 0;
      recordDebugTrace(current, settings.debug, 'vector', isRebuild
        ? 'Embedding配置变化，重建当前聊天向量集合。'
        : '初始化当前聊天向量集合。', {
        eligibleMemories: eligible.length,
      });
      await this.memoryRepository.save(current);
      await this.vectorStore.purge(current.vectorCollectionId);
    } else {
      current.pendingVectorHashes = current.pendingVectorHashes.filter((hash) => eligibleHashes.has(hash));
    }

    const deleteHashes = configurationChanged
      ? []
      : [...new Set(current.pendingVectorDeleteHashes)].filter((hash) => !eligibleHashes.has(hash));
    if (!configurationChanged && current.pendingVectorHashes.length === 0 && deleteHashes.length === 0) {
      return current;
    }

    if (deleteHashes.length > 0) {
      await this.vectorStore.delete(current.vectorCollectionId, deleteHashes, config);
      current.metrics.vectorItemsDeleted += deleteHashes.length;
      current.pendingVectorDeleteHashes = current.pendingVectorDeleteHashes.filter(
        (hash) => !deleteHashes.includes(hash),
      );
    }

    const savedHashes = configurationChanged
      ? new Set<number>()
      : new Set(await this.vectorStore.list(current.vectorCollectionId, config));
    const pendingSet = new Set(current.pendingVectorHashes);
    const items = eligible
      .filter((memory) => pendingSet.has(memory.vectorHash) && !savedHashes.has(memory.vectorHash))
      .map((memory) => ({
        hash: memory.vectorHash,
        text: memory.retrievalText,
        index: memory.source.endMessageId,
      }));

    if (items.length > 0) {
      await this.vectorStore.insert(current.vectorCollectionId, items, config);
      current.metrics.vectorItemsInserted += items.length;
    }

    const synchronized = new Set([...savedHashes, ...items.map((item) => item.hash)]);
    current.pendingVectorHashes = current.pendingVectorHashes.filter(
      (hash) => eligibleHashes.has(hash) && !synchronized.has(hash),
    );
    current.vectorFingerprint = fingerprint;
    assertChatOwner(current);
    await this.memoryRepository.save(current);
    return current;
  }

  private async processThroughNow(
    targetEndMessageId: number,
    requestedChatId: string | null,
    onProgress?: (progress: ExtractionProgress) => void,
  ): Promise<StoryEchoChatState | null> {
    if (!requestedChatId || getCurrentChatId() !== requestedChatId) {
      throw new Error('等待抽取期间聊天发生切换，已取消任务。');
    }
    const context = getContext();
    const settings = this.settingsRepository.get();
    const state = await this.memoryRepository.getOrCreate();
    if (!state) {
      return null;
    }

    const maximumEnd = Math.min(Math.floor(targetEndMessageId), context.chat.length - 1);
    let start = state.indexedThroughMessageId + 1;
    if (start > maximumEnd) {
      try {
        return await this.syncPendingVectors(state);
      } catch (error) {
        logger.warn('同步待处理向量失败。', error);
        return state;
      }
    }

    try {
      while (start <= maximumEnd) {
        const chunkStartedAt = performance.now();
        const chunk = planNextChunk(
          context.chat,
          start,
          maximumEnd,
          settings.extraction.targetTurnsPerChunk,
        );
        if (!chunk) {
          break;
        }

        const snapshot = context.chat
          .slice(chunk.startMessageId, chunk.endMessageId + 1)
          .map((message) => ({
            is_user: message.is_user,
            is_system: Boolean(message.is_system),
            ...(message.name ? { name: message.name } : {}),
            mes: message.mes,
          }));
        const chunkSourceHash = await sha256(sourcePayload(snapshot, chunk.startMessageId));

        const raw = await completeWithConfiguredProvider(settings, {
          system: EXTRACTION_SYSTEM_PROMPT,
          prompt: buildExtractionPrompt(snapshot, 0, snapshot.length - 1, chunk.startMessageId),
          jsonSchema: EXTRACTION_SCHEMA,
          maxTokens: 3_072,
        });
        let parsedCandidates;
        try {
          parsedCandidates = parseExtractionResponse(raw);
        } catch (error) {
          recordDebugTrace(state, settings.debug, 'extraction', '剧情候选解析失败。', {
            range: `${chunk.startMessageId}-${chunk.endMessageId}`,
            error: error instanceof Error ? error.message : String(error),
            rawResponse: raw.slice(0, 4_000),
          });
          throw error;
        }
        const assessment = assessMemoryCandidates(
          parsedCandidates,
          snapshot.map((message) => message.mes).join('\n'),
        );
        const candidates = assessment.accepted;
        recordDebugTrace(state, settings.debug, 'extraction', '剧情候选抽取完成。', {
          range: `${chunk.startMessageId}-${chunk.endMessageId}`,
          candidates: candidates.length,
          parsedCandidates: parsedCandidates.length,
          rejectedCandidates: assessment.rejected.length,
          ...(assessment.rejected.length > 0
            ? { rejectedReasons: assessment.rejected.map((item) => item.reason).join(' | ') }
            : {}),
          ...(assessment.removedUnsupportedThreads.length > 0
            ? { removedUnsupportedThreads: assessment.removedUnsupportedThreads.join(' | ') }
            : {}),
          ...(parsedCandidates.length === 0 ? { emptyResponse: raw.slice(0, 4_000) } : {}),
        });
        const currentSourceHash = await sha256(sourcePayload(
          context.chat.slice(chunk.startMessageId, chunk.endMessageId + 1),
          chunk.startMessageId,
        ));
        if (currentSourceHash !== chunkSourceHash) {
          throw new Error('抽取期间源消息发生变化，已丢弃本次结果。');
        }

        let vectorHashes = new Set<number>();
        if (candidates.length > 0 && state.memories.length > 0) {
          const queryStartedAt = performance.now();
          state.metrics.vectorQueries += 1;
          try {
            const results = await this.vectorStore.query(
              state.vectorCollectionId,
              candidates.map((candidate) => candidate.retrievalText).join('\n').slice(0, 12_000),
              24,
              settings.recall.scoreThreshold,
              resolveVectorConfig(settings),
            );
            vectorHashes = new Set(results.map((result) => result.hash));
          } catch (error) {
            state.metrics.vectorQueryFailures += 1;
            recordDebugTrace(state, settings.debug, 'vector', '整理前相似记忆查询失败，使用结构化匹配。', {
              error: error instanceof Error ? error.message : String(error),
            });
            logger.warn('整理前相似记忆查询失败，使用结构化匹配。', error);
          }
          state.metrics.totalRetrievalMs += Math.round(performance.now() - queryStartedAt);
        }

        const shortlist = shortlistMemories(candidates, state.memories, vectorHashes);
        const consolidation = await decideConsolidation(settings, candidates, shortlist);
        if (consolidation.usedLlm) {
          state.metrics.consolidationCalls += 1;
          state.metrics.totalConsolidationMs += consolidation.durationMs;
        }
        if (consolidation.error) {
          state.metrics.consolidationFailures += 1;
          recordDebugTrace(state, settings.debug, 'consolidation', 'LLM整理失败，已使用保守规则。', {
            error: consolidation.error,
          });
        }

        const source = {
          startMessageId: chunk.startMessageId,
          endMessageId: chunk.endMessageId,
          sourceHash: chunkSourceHash,
        };
        const applied = await applyConsolidationDecisions(state, consolidation.decisions, source);

        assertChatOwner(state);
        state.indexedThroughMessageId = chunk.endMessageId;
        state.indexedThroughHash = chunkSourceHash;
        state.metrics.extractionChunks += 1;
        state.metrics.candidatesExtracted += candidates.length;
        state.metrics.totalExtractionMs += Math.round(performance.now() - chunkStartedAt);
        state.metrics.lastExtractionAt = new Date().toISOString();
        recordDebugTrace(state, settings.debug, 'consolidation', '剧情分块整理完成。', {
          range: `${chunk.startMessageId}-${chunk.endMessageId}`,
          candidates: candidates.length,
          shortlist: shortlist.length,
          actions: applied.decisions.map((decision) => decision.operation).join(','),
          decisions: applied.decisions
            .map((decision) => [
              decision.candidateIndex,
              decision.operation,
              decision.targetMemoryId ?? '-',
              decision.reason,
            ].join(':'))
            .join(' | ')
            .slice(0, 2_000),
          llm: consolidation.usedLlm,
        });
        await this.memoryRepository.save(state);

        try {
          await this.syncPendingVectors(state);
        } catch (error) {
          state.metrics.vectorSyncFailures += 1;
          recordDebugTrace(state, settings.debug, 'vector', '剧情记忆已保存，但向量同步失败。', {
            error: error instanceof Error ? error.message : String(error),
          });
          try {
            await this.memoryRepository.save(state);
          } catch (saveError) {
            logger.warn('保存向量同步失败统计时元数据不可用。', saveError);
          }
          logger.warn('剧情记忆已保存，但向量同步失败，稍后将重试。', error);
        }

        onProgress?.({
          startMessageId: chunk.startMessageId,
          endMessageId: chunk.endMessageId,
          targetEndMessageId: maximumEnd,
          newMemoryCount: applied.created.length,
          changedMemoryCount: applied.changed.length,
        });
        start = chunk.endMessageId + 1;
      }
    } catch (error) {
      state.metrics.extractionFailures += 1;
      recordDebugTrace(state, settings.debug, 'error', '剧情抽取分块失败。', {
        error: error instanceof Error ? error.message : String(error),
        startMessageId: start,
        targetEndMessageId: maximumEnd,
      });
      try {
        assertChatOwner(state);
        await this.memoryRepository.save(state);
      } catch (saveError) {
        logger.warn('保存抽取失败统计时聊天已切换或元数据不可用。', saveError);
      }
      throw error;
    }

    return state;
  }
}

export const extractionService = new ExtractionService();
