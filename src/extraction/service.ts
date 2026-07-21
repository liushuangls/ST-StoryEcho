import { logger } from '../core/logger';
import { sha256 } from '../core/hash';
import type { StoryEchoChatState, StoryEchoSettings, TavernChatMessage } from '../core/types';
import { storyMessages } from '../content/story-content';
import { applyConsolidationDecisions } from '../consolidation/apply';
import { decideConsolidation } from '../consolidation/service';
import { shortlistMemories } from '../consolidation/shortlist';
import { recordDebugTrace } from '../debug/metrics';
import { SourceRevisionCache } from '../history/source-revision-cache';
import { completeStructuredWithConfiguredProvider } from '../llm/complete';
import { recordAdaptiveExtractionSplit } from '../llm/structured-diagnostics';
import { MemoryRepository } from '../memory/repository';
import { getContext, getCurrentChatId } from '../platform/sillytavern';
import { buildExtractionReferenceContext } from '../reference/context';
import { SettingsRepository } from '../settings/repository';
import { isStoryEchoTaskCancelledError } from '../runtime/task-cancellation';
import { resolveVectorConfig, vectorConfigFingerprint } from '../vector/config';
import { SillyTavernVectorStore } from '../vector/sillytavern-vector-store';
import { countCompletedTurns, planNextChunk } from './chunk-planner';
import { normalizeCandidatesByType } from './atomicize';
import { classifyEvidenceRole } from './evidence';
import { parseExtractionResponse } from './parser';
import { buildExtractionPrompt, EXTRACTION_SYSTEM_PROMPT } from './prompts';
import {
  assessMemoryCandidates,
  directlyGroundedStoryMemoryNames,
  normalizedStoryEntityName,
} from './quality';
import { EXTRACTION_SCHEMA } from './schema';
import type { ExtractedMemoryCandidate } from './types';

export interface ExtractionProgress {
  startMessageId: number;
  endMessageId: number;
  targetEndMessageId: number;
  newMemoryCount: number;
  changedMemoryCount: number;
}

interface ExtractionRunOptions {
  maxChunks: number;
  reconcileHistory: boolean;
  onProgress?: (progress: ExtractionProgress) => void;
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

async function prefixHash(messages: TavernChatMessage[], endMessageId: number): Promise<string> {
  if (endMessageId < 0) {
    return '';
  }
  return sha256(sourcePayload(messages.slice(0, endMessageId + 1), 0));
}

function turnAlignedSplitIndex(messages: TavernChatMessage[]): number | null {
  const boundaries: number[] = [];
  let waitingForAssistant = false;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.is_system) {
      continue;
    }
    if (message?.is_user) {
      waitingForAssistant = true;
      continue;
    }
    if (waitingForAssistant) {
      waitingForAssistant = false;
      if (index + 1 < messages.length) {
        boundaries.push(index + 1);
      }
    }
  }
  if (boundaries.length === 0) {
    return null;
  }
  const midpoint = messages.length / 2;
  return boundaries.sort((left, right) => (
    Math.abs(left - midpoint) - Math.abs(right - midpoint)
  ))[0] ?? null;
}

export async function extractCandidatesAdaptive(
  settings: StoryEchoSettings,
  messages: TavernChatMessage[],
  sourceStartMessageId: number,
  referenceContext = '',
  onSplit?: (leftTurns: number, rightTurns: number) => void,
): Promise<ExtractedMemoryCandidate[]> {
  const promptMessages = storyMessages(messages);
  try {
    return await completeStructuredWithConfiguredProvider(settings, {
      system: EXTRACTION_SYSTEM_PROMPT,
      prompt: buildExtractionPrompt(
        promptMessages,
        0,
        promptMessages.length - 1,
        sourceStartMessageId,
        referenceContext,
      ),
      jsonSchema: EXTRACTION_SCHEMA,
      jsonExample: {
        episodes: [],
        stateFacts: [],
        relationships: [],
        commitments: [],
        revelations: [],
        clues: [],
      },
      // A dense multi-turn chunk can contain several independent facts. The
      // JSON must finish or the entire attempt is rejected and split below.
      maxTokens: 8_192,
    }, parseExtractionResponse);
  } catch (error) {
    if (isStoryEchoTaskCancelledError(error)) {
      throw error;
    }
    const splitIndex = turnAlignedSplitIndex(messages);
    if (splitIndex === null) {
      throw error;
    }
    const left = messages.slice(0, splitIndex);
    const right = messages.slice(splitIndex);
    recordAdaptiveExtractionSplit();
    onSplit?.(countCompletedTurns(left), countCompletedTurns(right));
    const leftCandidates = await extractCandidatesAdaptive(
      settings,
      left,
      sourceStartMessageId,
      referenceContext,
      onSplit,
    );
    const rightCandidates = await extractCandidatesAdaptive(
      settings,
      right,
      sourceStartMessageId + splitIndex,
      referenceContext,
      onSplit,
    );
    return [...leftCandidates, ...rightCandidates];
  }
}

export class ExtractionService {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly settingsRepository = new SettingsRepository();
  private readonly memoryRepository = new MemoryRepository();
  private readonly vectorStore = new SillyTavernVectorStore();
  private readonly sourceRevisionCache = new SourceRevisionCache();

  processThrough(
    targetEndMessageId: number,
    onProgress?: (progress: ExtractionProgress) => void,
  ): Promise<StoryEchoChatState | null> {
    return this.enqueue(targetEndMessageId, {
      maxChunks: Number.MAX_SAFE_INTEGER,
      reconcileHistory: true,
      ...(onProgress ? { onProgress } : {}),
    });
  }

  processNextThrough(
    targetEndMessageId: number,
    onProgress?: (progress: ExtractionProgress) => void,
  ): Promise<StoryEchoChatState | null> {
    return this.enqueue(targetEndMessageId, {
      maxChunks: 1,
      reconcileHistory: true,
      ...(onProgress ? { onProgress } : {}),
    });
  }

  /** Use only after the caller has verified that the indexed prefix is unchanged. */
  processNextThroughVerifiedHistory(
    targetEndMessageId: number,
    onProgress?: (progress: ExtractionProgress) => void,
  ): Promise<StoryEchoChatState | null> {
    return this.enqueue(targetEndMessageId, {
      maxChunks: 1,
      reconcileHistory: false,
      ...(onProgress ? { onProgress } : {}),
    });
  }

  /**
   * Re-extract all currently eligible history after prompt/model changes while
   * preserving memories the user explicitly edited in the metadata manager.
   */
  rebuildThrough(
    targetEndMessageId: number,
    onProgress?: (progress: ExtractionProgress) => void,
  ): Promise<StoryEchoChatState | null> {
    const requestedChatId = getCurrentChatId();
    const operation = this.queue.then(
      () => this.rebuildThroughNow(targetEndMessageId, requestedChatId, onProgress),
      () => this.rebuildThroughNow(targetEndMessageId, requestedChatId, onProgress),
    );
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private enqueue(
    targetEndMessageId: number,
    options: ExtractionRunOptions,
  ): Promise<StoryEchoChatState | null> {
    const requestedChatId = getCurrentChatId();
    const operation = this.queue.then(
      () => this.processThroughNow(targetEndMessageId, requestedChatId, options),
      () => this.processThroughNow(targetEndMessageId, requestedChatId, options),
    );
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async rebuildThroughNow(
    targetEndMessageId: number,
    requestedChatId: string | null,
    onProgress?: (progress: ExtractionProgress) => void,
  ): Promise<StoryEchoChatState | null> {
    if (!requestedChatId || getCurrentChatId() !== requestedChatId) {
      throw new Error('等待重建期间聊天发生切换，已取消任务。');
    }
    const state = await this.memoryRepository.getOrCreate();
    if (!state) {
      return null;
    }
    assertChatOwner(state);

    const settings = this.settingsRepository.get();
    const fingerprint = await vectorConfigFingerprint(resolveVectorConfig(settings));
    // Purge first. If configuration validation or the server request fails,
    // keep the authoritative chat metadata untouched instead of leaving a
    // half-reset memory state.
    await this.vectorStore.purge(state.vectorCollectionId);
    const preserved = state.memories.filter((memory) => memory.manuallyEdited);
    const removedAutomaticMemories = state.memories.length - preserved.length;
    state.memories = preserved;
    state.indexedThroughMessageId = -1;
    state.indexedThroughHash = '';
    state.indexedPrefixHash = '';
    state.pendingRanges = [];
    state.pendingVectorHashes = preserved
      .filter((memory) => memory.status !== 'invalid' && memory.status !== 'superseded')
      .map((memory) => memory.vectorHash);
    state.pendingVectorDeleteHashes = [];
    state.vectorFingerprint = fingerprint;
    delete state.lastInspection;
    recordDebugTrace(state, settings.debug, 'extraction', '用户要求重建自动剧情元数据。', {
      removedAutomaticMemories,
      preservedManualMemories: preserved.length,
      targetEndMessageId,
    });
    await this.memoryRepository.save(state);

    return this.processThroughNow(targetEndMessageId, requestedChatId, {
      maxChunks: Number.MAX_SAFE_INTEGER,
      reconcileHistory: false,
      ...(onProgress ? { onProgress } : {}),
    });
  }

  /**
   * Detect edits, deleted floors, and branches that truncate already indexed
   * history. Derived memories are conservatively rebuilt so facts from a
   * removed branch can never leak into the current prompt.
   */
  async reconcileHistory(
    state?: StoryEchoChatState,
    options: { purgeVectors?: boolean } = {},
  ): Promise<StoryEchoChatState | null> {
    const current = state ?? await this.memoryRepository.getOrCreate();
    if (!current || current.indexedThroughMessageId < 0) {
      return current;
    }
    assertChatOwner(current);
    const context = getContext();
    const settings = this.settingsRepository.get();
    const indexedPastCurrentEnd = current.indexedThroughMessageId >= context.chat.length;
    const sourceSignature = `${current.indexedThroughMessageId}:${current.indexedPrefixHash}`;
    if (!indexedPastCurrentEnd && this.sourceRevisionCache.matches(
      current.ownerChatId,
      sourceSignature,
      context.chat,
      current.indexedThroughMessageId,
    )) {
      return current;
    }
    const actualPrefixHash = indexedPastCurrentEnd
      ? ''
      : await prefixHash(context.chat, current.indexedThroughMessageId);

    // Existing chats created before prefix fingerprints were introduced get a
    // baseline without discarding their memories. A shortened chat is already
    // definitive evidence of a branch/delete and must be rebuilt immediately.
    if (!current.indexedPrefixHash && !indexedPastCurrentEnd) {
      current.indexedPrefixHash = actualPrefixHash;
      await this.memoryRepository.save(current);
      this.sourceRevisionCache.remember(
        current.ownerChatId,
        `${current.indexedThroughMessageId}:${current.indexedPrefixHash}`,
        context.chat,
        current.indexedThroughMessageId,
      );
      return current;
    }
    if (!indexedPastCurrentEnd && actualPrefixHash === current.indexedPrefixHash) {
      this.sourceRevisionCache.remember(
        current.ownerChatId,
        sourceSignature,
        context.chat,
        current.indexedThroughMessageId,
      );
      return current;
    }

    const previousIndexedThrough = current.indexedThroughMessageId;
    const previousMemoryCount = current.memories.length;
    const previousVectorHashes = [...new Set(current.memories.map((memory) => memory.vectorHash))];
    let purgeFailed = false;
    const purgeDeferred = options.purgeVectors === false;
    if (!purgeDeferred) {
      try {
        await this.vectorStore.purge(current.vectorCollectionId);
      } catch (error) {
        purgeFailed = true;
        logger.warn('聊天历史变化后清理旧向量失败，后续同步将重试。', error);
      }
    }

    current.indexedThroughMessageId = -1;
    current.indexedThroughHash = '';
    current.indexedPrefixHash = '';
    current.stageSummary = {
      entries: [],
      coveredThroughMessageId: -1,
      coveredThroughHash: '',
    };
    if (current.storySkeleton.text) {
      current.storySkeleton.stale = true;
    }
    current.memories = [];
    current.pendingRanges = [];
    current.pendingVectorHashes = [];
    current.pendingVectorDeleteHashes = purgeDeferred ? previousVectorHashes : [];
    current.vectorFingerprint = '';
    delete current.lastInspection;
    recordDebugTrace(current, settings.debug, 'extraction', '检测到聊天分支、编辑或删楼层，已重置剧情索引。', {
      previousIndexedThrough,
      currentMessageCount: context.chat.length,
      removedMemories: previousMemoryCount,
      purgeFailed,
      purgeDeferred,
    });
    await this.memoryRepository.save(current);
    this.sourceRevisionCache.clear();
    return current;
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
    const configurationChanged = current.vectorFingerprint !== fingerprint;
    if (
      !configurationChanged &&
      current.pendingVectorHashes.length === 0 &&
      current.pendingVectorDeleteHashes.length === 0
    ) {
      return current;
    }
    const eligible = current.memories.filter(
      (memory) => memory.status !== 'invalid' && memory.status !== 'superseded',
    );
    const eligibleHashes = new Set(eligible.map((memory) => memory.vectorHash));

    if (configurationChanged) {
      const isRebuild = current.vectorFingerprint.length > 0;
      current.pendingVectorHashes = [...eligibleHashes];
      current.metrics.vectorRebuilds += isRebuild ? 1 : 0;
      recordDebugTrace(current, settings.debug, 'vector', isRebuild
        ? 'Embedding配置变化，重建当前聊天向量集合。'
        : '初始化当前聊天向量集合。', {
        eligibleMemories: eligible.length,
      });
      await this.memoryRepository.save(current);
      await this.vectorStore.purge(current.vectorCollectionId);
      // Keep the deletion queue intact until purge succeeds. If the request
      // fails, the reply-complete scheduler can see it and retry later.
      current.pendingVectorDeleteHashes = [];
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
    options: ExtractionRunOptions,
  ): Promise<StoryEchoChatState | null> {
    if (!requestedChatId || getCurrentChatId() !== requestedChatId) {
      throw new Error('等待抽取期间聊天发生切换，已取消任务。');
    }
    const context = getContext();
    const settings = this.settingsRepository.get();
    let state = await this.memoryRepository.getOrCreate();
    if (!state) {
      return null;
    }
    if (options.reconcileHistory) {
      state = await this.reconcileHistory(state);
      if (!state) {
        return null;
      }
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
      let processedChunks = 0;
      while (start <= maximumEnd && processedChunks < options.maxChunks) {
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
        const promptSnapshot = storyMessages(snapshot);
        const fullTurnBatch = countCompletedTurns(snapshot) >=
          Math.max(1, Math.floor(settings.extraction.targetTurnsPerChunk));
        // A normal tail waits until the configured number of complete
        // user+assistant turns has accumulated. The sole early exception is a
        // chunk cut by the hard character limit, otherwise an unusually long
        // reply could block indexing forever.
        const stoppedBeforeRequestedEnd = chunk.endMessageId < maximumEnd;
        if (!fullTurnBatch && !stoppedBeforeRequestedEnd) {
          recordDebugTrace(state, settings.debug, 'extraction', '剧情抽取等待凑满配置批次。', {
            startMessageId: chunk.startMessageId,
            availableEndMessageId: chunk.endMessageId,
            completedTurns: countCompletedTurns(snapshot),
            targetTurns: settings.extraction.targetTurnsPerChunk,
          });
          break;
        }
        const chunkSourceHash = await sha256(sourcePayload(snapshot, chunk.startMessageId));

        let referenceContext = '';
        try {
          const reference = await buildExtractionReferenceContext(
            promptSnapshot,
            settings.extraction.reference,
            context,
          );
          referenceContext = reference.text;
          if (reference.text) {
            state.metrics.referenceContextBuilds += 1;
            state.metrics.referenceContextTokens += reference.tokenCount;
            state.metrics.referenceWorldInfoEntries += reference.worldInfoEntries.length;
          }
          if (reference.warnings.length > 0) {
            state.metrics.referenceContextPartialFailures += 1;
          }
          recordDebugTrace(state, settings.debug, 'extraction', '抽取参考上下文已构建。', {
            range: `${chunk.startMessageId}-${chunk.endMessageId}`,
            mode: settings.extraction.reference.mode,
            tokens: reference.tokenCount,
            characterFields: reference.characterFields.join(',') || '-',
            worldInfoEntries: reference.worldInfoEntries.join(',') || '-',
            truncated: reference.truncated,
            warnings: reference.warnings.join(' | ') || '-',
            referencePreview: reference.text.slice(0, 4_000) || '-',
          });
        } catch (error) {
          state.metrics.referenceContextPartialFailures += 1;
          recordDebugTrace(state, settings.debug, 'error', '抽取参考上下文构建失败，继续仅使用聊天正文。', {
            range: `${chunk.startMessageId}-${chunk.endMessageId}`,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        let parsedCandidates;
        try {
          parsedCandidates = await extractCandidatesAdaptive(
            settings,
            snapshot,
            chunk.startMessageId,
            referenceContext,
            (leftTurns, rightTurns) => {
              recordDebugTrace(state, settings.debug, 'extraction', '结构化抽取失败，按完整轮次拆分重试。', {
                range: `${chunk.startMessageId}-${chunk.endMessageId}`,
                leftTurns,
                rightTurns,
              });
            },
          );
        } catch (error) {
          recordDebugTrace(state, settings.debug, 'extraction', '剧情候选解析失败。', {
            range: `${chunk.startMessageId}-${chunk.endMessageId}`,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        // A dense three-turn batch can legitimately contain more than nine
        // independent facts. Classify evidence before prioritization and use
        // the consolidation schema's full safe capacity instead of dropping
        // the tail solely because the user configured a smaller batch size.
        const candidateLimit = 20;
        const localAssessmentLimit = 60;
        const classifiedCandidates = parsedCandidates.map((candidate) => ({
          ...candidate,
          evidenceRole: classifyEvidenceRole(
            candidate.sourceMessageIds,
            snapshot,
            chunk.startMessageId,
          ),
        }));
        const atomicCandidates = normalizeCandidatesByType(
          classifiedCandidates,
          localAssessmentLimit,
        );
        const establishedNames = new Set(state.memories.flatMap((memory) => (
          directlyGroundedStoryMemoryNames(memory, context.chat).map(normalizedStoryEntityName)
        )));
        const assessment = assessMemoryCandidates(
          atomicCandidates,
          promptSnapshot.map((message) => message.mes).join('\n'),
          snapshot.flatMap((message, offset) => (
            message.is_system ? [] : [chunk.startMessageId + offset]
          )),
          snapshot,
          chunk.startMessageId,
          establishedNames,
        );
        // Apply the provider-facing limit only after rejecting unsupported or
        // low-value candidates, otherwise a rejected high-priority item could
        // consume a slot and silently drop a valid lower-ranked fact.
        const candidates = normalizeCandidatesByType(assessment.accepted, candidateLimit);
        recordDebugTrace(state, settings.debug, 'extraction', '剧情候选抽取完成。', {
          range: `${chunk.startMessageId}-${chunk.endMessageId}`,
          candidates: candidates.length,
          parsedCandidates: parsedCandidates.length,
          atomicCandidates: atomicCandidates.length,
          acceptedBeforeLimit: assessment.accepted.length,
          candidateLimit,
          rejectedCandidates: assessment.rejected.length,
          ...(assessment.rejected.length > 0
            ? { rejectedReasons: assessment.rejected.map((item) => item.reason).join(' | ') }
            : {}),
          ...(assessment.removedUnsupportedThreads.length > 0
            ? { removedUnsupportedThreads: assessment.removedUnsupportedThreads.join(' | ') }
            : {}),
          ...(parsedCandidates.length === 0 ? { emptyResponse: '合法空memories数组' } : {}),
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
        state.indexedPrefixHash = await prefixHash(context.chat, chunk.endMessageId);
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
              [
                decision.targetMemoryId,
                ...(decision.additionalTargetMemoryIds ?? []),
              ].filter(Boolean).join(',') || '-',
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

        options.onProgress?.({
          startMessageId: chunk.startMessageId,
          endMessageId: chunk.endMessageId,
          targetEndMessageId: maximumEnd,
          newMemoryCount: applied.created.length,
          changedMemoryCount: applied.changed.length,
        });
        processedChunks += 1;
        start = chunk.endMessageId + 1;
      }
    } catch (error) {
      if (isStoryEchoTaskCancelledError(error)) {
        throw error;
      }
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
