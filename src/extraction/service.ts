import { logger } from '../core/logger';
import { sha256 } from '../core/hash';
import type { StoryEchoChatState, StoryMemory, TavernChatMessage } from '../core/types';
import { completeWithConfiguredProvider } from '../llm/complete';
import { MemoryRepository } from '../memory/repository';
import { getContext, getCurrentChatId } from '../platform/sillytavern';
import { SettingsRepository } from '../settings/repository';
import { resolveVectorConfig, vectorConfigFingerprint } from '../vector/config';
import { SillyTavernVectorStore } from '../vector/sillytavern-vector-store';
import { planNextChunk } from './chunk-planner';
import { createStoryMemory } from './memory-factory';
import { parseExtractionResponse } from './parser';
import { buildExtractionPrompt, EXTRACTION_SYSTEM_PROMPT } from './prompts';
import { EXTRACTION_SCHEMA } from './schema';

export interface ExtractionProgress {
  startMessageId: number;
  endMessageId: number;
  targetEndMessageId: number;
  newMemoryCount: number;
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
      current.pendingVectorHashes = [...eligibleHashes];
      await this.memoryRepository.save(current);
      await this.vectorStore.purge(current.vectorCollectionId);
    } else {
      current.pendingVectorHashes = current.pendingVectorHashes.filter((hash) => eligibleHashes.has(hash));
    }

    if (!configurationChanged && current.pendingVectorHashes.length === 0) {
      return current;
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

    while (start <= maximumEnd) {
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
      });
      const candidates = parseExtractionResponse(raw);
      const currentSourceHash = await sha256(sourcePayload(
        context.chat.slice(chunk.startMessageId, chunk.endMessageId + 1),
        chunk.startMessageId,
      ));
      if (currentSourceHash !== chunkSourceHash) {
        throw new Error('抽取期间源消息发生变化，已丢弃本次结果。');
      }
      const occupiedHashes = new Set(state.memories.map((memory) => memory.vectorHash));
      const existingRetrievalHashes = new Set(state.memories.map((memory) => memory.retrievalHash));
      const created: StoryMemory[] = [];

      for (const candidate of candidates) {
        const candidateRetrievalHash = await sha256(candidate.retrievalText);
        if (existingRetrievalHashes.has(candidateRetrievalHash)) {
          continue;
        }
        const memory = await createStoryMemory(candidate, {
          startMessageId: chunk.startMessageId,
          endMessageId: chunk.endMessageId,
          sourceHash: chunkSourceHash,
        }, occupiedHashes);
        occupiedHashes.add(memory.vectorHash);
        existingRetrievalHashes.add(memory.retrievalHash);
        created.push(memory);
      }

      assertChatOwner(state);
      state.memories.push(...created);
      state.pendingVectorHashes.push(...created.map((memory) => memory.vectorHash));
      state.pendingVectorHashes = [...new Set(state.pendingVectorHashes)];
      state.indexedThroughMessageId = chunk.endMessageId;
      state.indexedThroughHash = chunkSourceHash;
      await this.memoryRepository.save(state);

      try {
        await this.syncPendingVectors(state);
      } catch (error) {
        logger.warn('剧情记忆已保存，但向量同步失败，稍后将重试。', error);
      }

      onProgress?.({
        startMessageId: chunk.startMessageId,
        endMessageId: chunk.endMessageId,
        targetEndMessageId: maximumEnd,
        newMemoryCount: created.length,
      });
      start = chunk.endMessageId + 1;
    }

    return state;
  }
}

export const extractionService = new ExtractionService();
