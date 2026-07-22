import { sha256 } from '../core/hash';
import { logger } from '../core/logger';
import type {
  StageSummaryEntry,
  StoryEchoChatState,
  StoryEchoSettings,
  StorySkeleton,
  TavernChatMessage,
} from '../core/types';
import { storyContent } from '../content/story-content';
import { recordDebugTrace } from '../debug/metrics';
import { countCompletedTurns, planNextChunk } from '../extraction/chunk-planner';
import { SourceRevisionCache } from '../history/source-revision-cache';
import { completeWithConfiguredProvider } from '../llm/complete';
import { MemoryRepository } from '../memory/repository';
import { getContext, getCurrentChatId, type SillyTavernContext } from '../platform/sillytavern';
import { estimateTokens } from '../prompt/render';
import { buildSummaryWorldInfoReferenceContext } from '../reference/context';
import { firstStoryPhaseBoundary } from '../retrieval/story-phase';
import { SettingsRepository } from '../settings/repository';
import { isStoryEchoTaskCancelledError } from '../runtime/task-cancellation';
import {
  boundedPreviousStageSummary,
  buildStageSummaryGrounding,
  buildStageSummaryPrompt,
  STAGE_SUMMARY_SYSTEM_PROMPT,
} from './prompts';

export const MAX_SUMMARY_SOURCE_CHARACTERS = 100_000;
const MAX_STORED_SUMMARY_CHARACTERS = 64_000;

export interface StageSummaryProgress {
  startMessageId: number;
  endMessageId: number;
  targetEndMessageId: number;
}

export interface StageSummaryRunResult {
  state: StoryEchoChatState | null;
  updatedChunks: number;
}

interface StageSummaryRunOptions {
  maxChunks: number;
  onProgress?: (progress: StageSummaryProgress) => void;
}

interface PreparedStageSummaryChunk {
  startMessageId: number;
  endMessageId: number;
  snapshot: TavernChatMessage[];
  sourceCharacters: number;
}

interface GeneratedStageSummaryEntry {
  entry: StageSummaryEntry;
  durationMs: number;
  sourceMessageCount: number;
  personaLabelSanitized: boolean;
  authoritativeFactCharacters: number;
  previousSummaryCharacters: number;
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

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function summaryIdentity(context: SillyTavernContext): {
  userUiPersona: string;
  assistantCharacter: string;
} {
  const character = Number.isInteger(context.characterId)
    ? context.characters?.[context.characterId!]
    : undefined;
  return {
    userUiPersona: context.name1?.trim() ?? '',
    assistantCharacter: context.name2?.trim() || character?.name?.trim() || '',
  };
}

export function normalizeSummary(
  raw: string,
  sourceMessages: TavernChatMessage[] = [],
  userUiPersona = '',
): string {
  const withoutFence = raw
    .trim()
    .replace(/^```(?:text|markdown|md)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const withoutWrapper = withoutFence
    .replace(/^<story_echo_summary>\s*/i, '')
    .replace(/\s*<\/story_echo_summary>$/i, '')
    .replace(/<\/?story_echo_(?:summary|recall)>/gi, '')
    .trim();
  if (!withoutWrapper) {
    throw new Error('阶段总结模型返回了空内容。');
  }
  const sourceText = sourceMessages.map((message) => storyContent(message)).join('\n');
  const persona = userUiPersona.trim();
  const identitySafe = persona.length >= 2 && !sourceText.includes(persona)
    ? withoutWrapper.replace(new RegExp(escapedRegExp(persona), 'gu'), '用户角色')
    : withoutWrapper;
  if (identitySafe.length > MAX_STORED_SUMMARY_CHARACTERS) {
    throw new Error('阶段总结模型返回内容过长。');
  }
  return identitySafe;
}

function assertChatOwner(state: StoryEchoChatState): void {
  if (getCurrentChatId() !== state.ownerChatId) {
    throw new Error('阶段总结期间聊天发生切换，已取消写入。');
  }
}

function summarySourceSignature(entries: readonly StageSummaryEntry[]): string {
  return entries
    .map((entry) => `${entry.sourceStartMessageId}:${entry.sourceEndMessageId}:${entry.sourceHash}`)
    .join('|');
}

function sameStageSummaryEntries(
  left: readonly StageSummaryEntry[],
  right: readonly StageSummaryEntry[],
): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index];
    return Boolean(
      other &&
      entry.text === other.text &&
      entry.sourceStartMessageId === other.sourceStartMessageId &&
      entry.sourceEndMessageId === other.sourceEndMessageId &&
      entry.sourceHash === other.sourceHash &&
      entry.updatedAt === other.updatedAt &&
      Boolean(entry.manuallyEdited) === Boolean(other.manuallyEdited) &&
      Boolean(entry.deleted) === Boolean(other.deleted)
    );
  });
}

function sameStorySkeletonRevision(left: StorySkeleton, right: StorySkeleton): boolean {
  return left.text === right.text &&
    left.coveredThroughMessageId === right.coveredThroughMessageId &&
    left.sourceHash === right.sourceHash &&
    left.updatedAt === right.updatedAt &&
    Boolean(left.manuallyEdited) === Boolean(right.manuallyEdited) &&
    Boolean(left.stale) === Boolean(right.stale);
}

function latestActiveSummaryText(entries: readonly StageSummaryEntry[]): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry && !entry.deleted) {
      return entry.text;
    }
  }
  return '';
}

export class StageSummaryService {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly settingsRepository = new SettingsRepository();
  private readonly memoryRepository = new MemoryRepository();
  private readonly sourceRevisionCache = new SourceRevisionCache();

  /**
   * Validate summary entries independently from the structured-memory index.
   * This is required by the LLM-only mode, where indexedThroughMessageId is
   * intentionally left untouched because extraction and vectors are disabled.
   */
  async reconcileHistory(
    state?: StoryEchoChatState,
  ): Promise<StoryEchoChatState | null> {
    const current = state ?? await this.memoryRepository.getOrCreate();
    if (!current || current.stageSummary.entries.length === 0) {
      return current;
    }
    if (getCurrentChatId() !== current.ownerChatId) {
      throw new Error('校验阶段总结期间聊天发生切换，已取消任务。');
    }

    const context = getContext();
    const initialCoverage = current.stageSummary.entries.at(-1)?.sourceEndMessageId ?? -1;
    if (this.sourceRevisionCache.matches(
      current.ownerChatId,
      summarySourceSignature(current.stageSummary.entries),
      context.chat,
      initialCoverage,
    )) {
      return current;
    }
    let validEntries = 0;
    let initializedHashes = 0;
    for (const entry of current.stageSummary.entries) {
      if (
        entry.sourceStartMessageId < 0 ||
        entry.sourceEndMessageId < entry.sourceStartMessageId ||
        entry.sourceEndMessageId >= context.chat.length
      ) {
        break;
      }
      const actualHash = await sha256(sourcePayload(
        context.chat.slice(entry.sourceStartMessageId, entry.sourceEndMessageId + 1),
        entry.sourceStartMessageId,
      ));
      if (entry.sourceHash && entry.sourceHash !== actualHash) {
        break;
      }
      if (!entry.sourceHash) {
        entry.sourceHash = actualHash;
        initializedHashes += 1;
      }
      validEntries += 1;
    }

    if (validEntries === current.stageSummary.entries.length) {
      if (initializedHashes > 0) {
        const latest = current.stageSummary.entries.at(-1)!;
        current.stageSummary.coveredThroughHash = latest.sourceHash;
        await this.memoryRepository.save(current);
      }
      this.sourceRevisionCache.remember(
        current.ownerChatId,
        summarySourceSignature(current.stageSummary.entries),
        context.chat,
        current.stageSummary.entries.at(-1)?.sourceEndMessageId ?? -1,
      );
      return current;
    }

    const removedEntries = current.stageSummary.entries.length - validEntries;
    const entries = current.stageSummary.entries.slice(0, validEntries);
    const latest = entries.at(-1);
    current.stageSummary = {
      entries,
      coveredThroughMessageId: latest?.sourceEndMessageId ?? -1,
      coveredThroughHash: latest?.sourceHash ?? '',
      ...(latest ? { updatedAt: latest.updatedAt } : {}),
    };
    delete current.lastInspection;
    recordDebugTrace(current, this.settingsRepository.get().debug, 'summary', '聊天历史变化后已截断失效阶段总结。', {
      removedEntries,
      coveredThroughMessageId: current.stageSummary.coveredThroughMessageId,
    });
    await this.memoryRepository.save(current);
    this.sourceRevisionCache.remember(
      current.ownerChatId,
      summarySourceSignature(entries),
      context.chat,
      latest?.sourceEndMessageId ?? -1,
    );
    return current;
  }

  processNextThrough(
    targetEndMessageId: number,
    onProgress?: (progress: StageSummaryProgress) => void,
  ): Promise<StageSummaryRunResult> {
    return this.enqueue(targetEndMessageId, {
      maxChunks: 1,
      ...(onProgress ? { onProgress } : {}),
    });
  }

  processAllThrough(
    targetEndMessageId: number,
    onProgress?: (progress: StageSummaryProgress) => void,
  ): Promise<StageSummaryRunResult> {
    return this.enqueue(targetEndMessageId, {
      maxChunks: Number.MAX_SAFE_INTEGER,
      ...(onProgress ? { onProgress } : {}),
    });
  }

  rebuildAllThrough(
    targetEndMessageId: number,
    onProgress?: (progress: StageSummaryProgress) => void,
  ): Promise<StageSummaryRunResult> {
    const requestedChatId = getCurrentChatId();
    const operation = this.queue.then(
      () => this.rebuildNow(targetEndMessageId, requestedChatId, onProgress),
      () => this.rebuildNow(targetEndMessageId, requestedChatId, onProgress),
    );
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private enqueue(
    targetEndMessageId: number,
    options: StageSummaryRunOptions,
  ): Promise<StageSummaryRunResult> {
    const requestedChatId = getCurrentChatId();
    const operation = this.queue.then(
      () => this.processNow(targetEndMessageId, requestedChatId, options),
      () => this.processNow(targetEndMessageId, requestedChatId, options),
    );
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private prepareNextChunk(
    state: StoryEchoChatState,
    settings: StoryEchoSettings,
    chat: TavernChatMessage[],
    startMessageId: number,
    maximumEndMessageId: number,
  ): PreparedStageSummaryChunk | null {
    const plannedChunk = planNextChunk(
      chat,
      startMessageId,
      maximumEndMessageId,
      settings.summary.targetTurnsPerUpdate,
      MAX_SUMMARY_SOURCE_CHARACTERS,
    );
    if (!plannedChunk) {
      return null;
    }
    const boundaryMessageId = firstStoryPhaseBoundary(
      chat,
      plannedChunk.startMessageId + 1,
      plannedChunk.endMessageId,
    );
    const splitBeforeBoundary = boundaryMessageId !== null &&
      boundaryMessageId > plannedChunk.startMessageId;
    const chunk = splitBeforeBoundary
      ? { ...plannedChunk, endMessageId: boundaryMessageId - 1 }
      : plannedChunk;
    const snapshot = chat
      .slice(chunk.startMessageId, chunk.endMessageId + 1)
      .map((message) => ({
        is_user: message.is_user,
        is_system: Boolean(message.is_system),
        ...(message.name ? { name: message.name } : {}),
        mes: message.mes,
      }));
    const sourceCharacters = snapshot.reduce(
      (total, message) => total + message.mes.length,
      0,
    );
    // An explicit story-phase transition closes the preceding summary even
    // when it contains fewer than N turns. This prevents one immutable
    // summary entry from mixing facts from two otherwise isolated phases.
    const completedTurns = countCompletedTurns(snapshot);
    const hasFullTurnBatch = completedTurns >= settings.summary.targetTurnsPerUpdate;
    // A normal tail waits until N complete turns accumulate. If the shared
    // planner stopped before the requested end, however, the hard source
    // character cap closed this chunk at the latest complete turn. Treat
    // that bounded chunk as ready or one unusually long reply can block
    // every later stage summary forever.
    const stoppedBeforeRequestedEnd = plannedChunk.endMessageId < maximumEndMessageId;
    const closedByStoryPhase = splitBeforeBoundary && snapshot.some((message) => (
      !message.is_system && storyContent(message).length > 0
    ));
    const oversizedCompleteChunk = completedTurns > 0 &&
      sourceCharacters > MAX_SUMMARY_SOURCE_CHARACTERS;
    if (
      !hasFullTurnBatch &&
      !stoppedBeforeRequestedEnd &&
      !closedByStoryPhase &&
      !oversizedCompleteChunk
    ) {
      recordDebugTrace(state, settings.debug, 'summary', '阶段总结等待凑满配置批次。', {
        startMessageId: chunk.startMessageId,
        availableEndMessageId: chunk.endMessageId,
        completedTurns,
        targetTurns: settings.summary.targetTurnsPerUpdate,
      });
      return null;
    }
    if (sourceCharacters > MAX_SUMMARY_SOURCE_CHARACTERS) {
      recordDebugTrace(
        state,
        settings.debug,
        'summary',
        '单个完整剧情回合超过阶段总结原文字符上限，已保持回合完整并单独处理。',
        {
          range: `${chunk.startMessageId}-${chunk.endMessageId}`,
          sourceCharacters,
          sourceCharacterLimit: MAX_SUMMARY_SOURCE_CHARACTERS,
        },
      );
    }
    return {
      startMessageId: chunk.startMessageId,
      endMessageId: chunk.endMessageId,
      snapshot,
      sourceCharacters,
    };
  }

  private async generateEntry(
    context: SillyTavernContext,
    settings: StoryEchoSettings,
    state: StoryEchoChatState,
    chunk: PreparedStageSummaryChunk,
    previousSummary: string,
  ): Promise<GeneratedStageSummaryEntry> {
    const startedAt = performance.now();
    const snapshotHash = await sha256(sourcePayload(chunk.snapshot, chunk.startMessageId));
    const identity = summaryIdentity(context);
    const authoritativeFacts = settings.memory.enabled
      ? buildStageSummaryGrounding(
          state.memories,
          chunk.startMessageId,
          chunk.endMessageId,
        )
      : '';
    let worldBackground = '';
    try {
      const reference = await buildSummaryWorldInfoReferenceContext(
        chunk.snapshot,
        settings.extraction.reference,
        context,
      );
      worldBackground = reference.text;
      recordDebugTrace(state, settings.debug, 'summary', '阶段总结世界书背景已构建。', {
        range: `${chunk.startMessageId}-${chunk.endMessageId}`,
        tokens: reference.tokenCount,
        worldInfoEntries: reference.worldInfoEntries.join(',') || '-',
        constantWorldInfoEntries: reference.constantWorldInfoEntries?.length ?? 0,
        constantWorldInfoCharacters: reference.constantWorldInfoCharacters ?? 0,
        matchedWorldInfoEntries: reference.matchedWorldInfoEntries?.length ?? 0,
        matchedWorldInfoCharacters: reference.matchedWorldInfoCharacters ?? 0,
        truncated: reference.truncated,
        warnings: reference.warnings.join(' | ') || '-',
        referencePreview: reference.text.slice(0, 4_000) || '-',
      });
    } catch (error) {
      recordDebugTrace(state, settings.debug, 'error', '阶段总结世界书背景构建失败，继续仅使用聊天正文。', {
        range: `${chunk.startMessageId}-${chunk.endMessageId}`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const boundedPrevious = boundedPreviousStageSummary(previousSummary);
    const prompt = buildStageSummaryPrompt(
      chunk.snapshot,
      chunk.startMessageId,
      identity,
      authoritativeFacts,
      worldBackground,
      boundedPrevious,
      settings.summary.maxTokens,
    );
    if (settings.debug) {
      const requestInput = `${STAGE_SUMMARY_SYSTEM_PROMPT}\n${prompt}`;
      recordDebugTrace(state, true, 'summary', '阶段总结请求已构建。', {
        range: `${chunk.startMessageId}-${chunk.endMessageId}`,
        sourceCharacters: chunk.sourceCharacters,
        sourceCharacterLimit: MAX_SUMMARY_SOURCE_CHARACTERS,
        previousSummaryCharacters: Array.from(boundedPrevious).length,
        requestCharacters: requestInput.length,
        estimatedRequestTokens: estimateTokens(requestInput),
      });
    }
    const raw = await completeWithConfiguredProvider(settings, {
      system: STAGE_SUMMARY_SYSTEM_PROMPT,
      prompt,
      maxTokens: settings.summary.maxTokens,
    });
    // Detect a branch/edit before accepting even the summary format, so a
    // stale request is always reported and discarded for the right cause.
    const currentChat = getContext().chat;
    const currentHash = await sha256(sourcePayload(
      currentChat.slice(chunk.startMessageId, chunk.endMessageId + 1),
      chunk.startMessageId,
    ));
    if (currentHash !== snapshotHash) {
      throw new Error('阶段总结期间源消息发生变化，已丢弃本次结果。');
    }
    const text = normalizeSummary(raw, chunk.snapshot, identity.userUiPersona);
    const withoutPersonaSanitization = normalizeSummary(raw, chunk.snapshot, '');
    // Read the live chat again instead of trusting the context object
    // captured before the LLM call. SillyTavern can replace the chat array
    // when a message is edited or a branch is switched while generation is
    // in flight.
    const commitChat = getContext().chat;
    const commitHash = await sha256(sourcePayload(
      commitChat.slice(chunk.startMessageId, chunk.endMessageId + 1),
      chunk.startMessageId,
    ));
    if (commitHash !== snapshotHash) {
      throw new Error('阶段总结期间源消息发生变化，已丢弃本次结果。');
    }
    const updatedAt = new Date().toISOString();
    return {
      entry: {
        text,
        sourceStartMessageId: chunk.startMessageId,
        sourceEndMessageId: chunk.endMessageId,
        sourceHash: snapshotHash,
        updatedAt,
      },
      durationMs: Math.round(performance.now() - startedAt),
      sourceMessageCount: chunk.snapshot.length,
      personaLabelSanitized: text !== withoutPersonaSanitization,
      authoritativeFactCharacters: authoritativeFacts.length,
      previousSummaryCharacters: Array.from(boundedPrevious).length,
    };
  }

  private async rebuildNow(
    targetEndMessageId: number,
    requestedChatId: string | null,
    onProgress?: (progress: StageSummaryProgress) => void,
  ): Promise<StageSummaryRunResult> {
    if (!requestedChatId || getCurrentChatId() !== requestedChatId) {
      throw new Error('等待阶段总结重建期间聊天发生切换，已取消任务。');
    }
    const context = getContext();
    const settings = this.settingsRepository.get();
    let state = await this.memoryRepository.getOrCreate();
    if (!state) {
      return { state, updatedChunks: 0 };
    }
    assertChatOwner(state);
    const memoryCoverageLimit = settings.memory.enabled
      ? state.indexedThroughMessageId
      : Math.floor(targetEndMessageId);
    const maximumEnd = Math.min(
      Math.floor(targetEndMessageId),
      memoryCoverageLimit,
      context.chat.length - 1,
    );
    if (maximumEnd < 0) {
      return { state, updatedChunks: 0 };
    }

    // Rebuild against one immutable view of the source. A later batch may be
    // unaffected by an edit to an earlier batch, so per-batch hashing alone
    // cannot prove that the complete replacement still represents one chat
    // revision when the final commit happens.
    const chatSnapshot = context.chat
      .slice(0, maximumEnd + 1)
      .map((message) => ({
        is_user: message.is_user,
        is_system: Boolean(message.is_system),
        ...(message.name ? { name: message.name } : {}),
        mes: message.mes,
      }));
    const sourceSnapshot = state.stageSummary.entries.map((entry) => ({ ...entry }));
    const skeletonSnapshot = { ...state.storySkeleton };
    const rebuiltEntries: StageSummaryEntry[] = [];
    let start = 0;
    let totalDurationMs = 0;
    let totalMessagesCovered = 0;

    try {
      while (start <= maximumEnd) {
        const chunk = this.prepareNextChunk(
          state,
          settings,
          chatSnapshot,
          start,
          maximumEnd,
        );
        if (!chunk) {
          break;
        }
        const generated = await this.generateEntry(
          context,
          settings,
          state,
          chunk,
          latestActiveSummaryText(rebuiltEntries),
        );
        rebuiltEntries.push(generated.entry);
        totalDurationMs += generated.durationMs;
        totalMessagesCovered += generated.sourceMessageCount;
        recordDebugTrace(state, settings.debug, 'summary', '阶段总结重建条目已生成，等待原子替换。', {
          range: `${chunk.startMessageId}-${chunk.endMessageId}`,
          summaryCharacters: generated.entry.text.length,
          rebuiltEntries: rebuiltEntries.length,
          personaLabelSanitized: generated.personaLabelSanitized,
          authoritativeFactCharacters: generated.authoritativeFactCharacters,
          previousSummaryCharacters: generated.previousSummaryCharacters,
        });
        onProgress?.({
          startMessageId: chunk.startMessageId,
          endMessageId: chunk.endMessageId,
          targetEndMessageId: maximumEnd,
        });
        start = chunk.endMessageId + 1;
      }

      if (rebuiltEntries.length === 0) {
        return { state, updatedChunks: 0 };
      }
      const live = this.memoryRepository.getExisting();
      if (!live || live.ownerChatId !== state.ownerChatId) {
        throw new Error('阶段总结重建期间聊天发生切换，已丢弃本次结果。');
      }
      if (!sameStageSummaryEntries(live.stageSummary.entries, sourceSnapshot)) {
        throw new Error('阶段总结重建期间已有总结发生变化，已丢弃本次结果。');
      }
      if (!sameStorySkeletonRevision(live.storySkeleton, skeletonSnapshot)) {
        throw new Error('阶段总结重建期间全局骨架发生变化，已丢弃本次结果。');
      }
      const latest = rebuiltEntries.at(-1)!;
      const rebuiltSourceHash = await sha256(sourcePayload(
        chatSnapshot.slice(0, latest.sourceEndMessageId + 1),
        0,
      ));
      const liveSourceHash = await sha256(sourcePayload(
        getContext().chat.slice(0, latest.sourceEndMessageId + 1),
        0,
      ));
      if (rebuiltSourceHash !== liveSourceHash) {
        throw new Error('阶段总结重建期间历史原文发生变化，已丢弃本次结果。');
      }
      live.stageSummary = {
        entries: rebuiltEntries,
        coveredThroughMessageId: latest.sourceEndMessageId,
        coveredThroughHash: latest.sourceHash,
        updatedAt: latest.updatedAt,
      };
      if (live.storySkeleton.text.trim()) {
        live.storySkeleton = { ...live.storySkeleton, stale: true };
      }
      live.metrics.summaryUpdates += rebuiltEntries.length;
      live.metrics.summaryMessagesCovered += totalMessagesCovered;
      live.metrics.totalSummaryMs += totalDurationMs;
      live.metrics.lastSummaryAt = latest.updatedAt;
      delete live.lastInspection;
      recordDebugTrace(live, settings.debug, 'summary', '全部阶段总结已原子重建。', {
        rebuiltEntries: rebuiltEntries.length,
        coveredThroughMessageId: latest.sourceEndMessageId,
        targetEndMessageId: maximumEnd,
        priorEntries: sourceSnapshot.length,
        skeletonMarkedStale: Boolean(live.storySkeleton.stale),
      });
      await this.memoryRepository.save(live);
      state = live;
      return { state, updatedChunks: rebuiltEntries.length };
    } catch (error) {
      if (isStoryEchoTaskCancelledError(error)) {
        throw error;
      }
      state.metrics.summaryFailures += 1;
      recordDebugTrace(state, settings.debug, 'error', '全部阶段总结重建失败，已保留原有结果。', {
        error: error instanceof Error ? error.message : String(error),
        startMessageId: start,
        targetEndMessageId: maximumEnd,
        completedDraftEntries: rebuiltEntries.length,
      });
      try {
        assertChatOwner(state);
        await this.memoryRepository.save(state);
      } catch (saveError) {
        logger.warn('保存阶段总结重建失败统计时聊天已切换或元数据不可用。', saveError);
      }
      throw error;
    }
  }

  private async processNow(
    targetEndMessageId: number,
    requestedChatId: string | null,
    options: StageSummaryRunOptions,
  ): Promise<StageSummaryRunResult> {
    if (!requestedChatId || getCurrentChatId() !== requestedChatId) {
      throw new Error('等待阶段总结期间聊天发生切换，已取消任务。');
    }
    const context = getContext();
    const settings = this.settingsRepository.get();
    let state = await this.memoryRepository.getOrCreate();
    if (!state) {
      return { state, updatedChunks: 0 };
    }
    assertChatOwner(state);

    // Full memory mode waits for structured extraction so the summary can use
    // its authoritative correction ledger. LLM-only mode owns an independent
    // source hash and can advance without touching the extraction cursor.
    const memoryCoverageLimit = settings.memory.enabled
      ? state.indexedThroughMessageId
      : Math.floor(targetEndMessageId);
    const maximumEnd = Math.min(
      Math.floor(targetEndMessageId),
      memoryCoverageLimit,
      context.chat.length - 1,
    );
    let start = state.stageSummary.coveredThroughMessageId + 1;
    let updatedChunks = 0;
    if (start > maximumEnd) {
      return { state, updatedChunks };
    }

    try {
      while (start <= maximumEnd && updatedChunks < options.maxChunks) {
        const chunk = this.prepareNextChunk(
          state,
          settings,
          context.chat,
          start,
          maximumEnd,
        );
        if (!chunk) {
          break;
        }
        const entriesBeforeRequest = state.stageSummary.entries.map((entry) => ({ ...entry }));
        const generated = await this.generateEntry(
          context,
          settings,
          state,
          chunk,
          latestActiveSummaryText(entriesBeforeRequest),
        );
        const live = this.memoryRepository.getExisting();
        if (!live || live.ownerChatId !== state.ownerChatId) {
          throw new Error('阶段总结生成期间聊天发生切换，已丢弃本次结果。');
        }
        if (!sameStageSummaryEntries(live.stageSummary.entries, entriesBeforeRequest)) {
          throw new Error('阶段总结生成期间已有总结发生变化，已丢弃本次结果。');
        }
        state = live;
        assertChatOwner(state);
        state.stageSummary.entries.push(generated.entry);
        state.stageSummary = {
          entries: state.stageSummary.entries,
          coveredThroughMessageId: generated.entry.sourceEndMessageId,
          coveredThroughHash: generated.entry.sourceHash,
          updatedAt: generated.entry.updatedAt,
        };
        state.metrics.summaryUpdates += 1;
        state.metrics.summaryMessagesCovered += generated.sourceMessageCount;
        state.metrics.totalSummaryMs += generated.durationMs;
        state.metrics.lastSummaryAt = generated.entry.updatedAt;
        recordDebugTrace(state, settings.debug, 'summary', '阶段总结条目已生成。', {
          range: `${chunk.startMessageId}-${chunk.endMessageId}`,
          summaryCharacters: generated.entry.text.length,
          summaryEntries: state.stageSummary.entries.length,
          personaLabelSanitized: generated.personaLabelSanitized,
          authoritativeFactCharacters: generated.authoritativeFactCharacters,
          previousSummaryCharacters: generated.previousSummaryCharacters,
        });
        await this.memoryRepository.save(state);
        updatedChunks += 1;
        options.onProgress?.({
          startMessageId: chunk.startMessageId,
          endMessageId: chunk.endMessageId,
          targetEndMessageId: maximumEnd,
        });
        start = chunk.endMessageId + 1;
      }
    } catch (error) {
      if (isStoryEchoTaskCancelledError(error)) {
        throw error;
      }
      state.metrics.summaryFailures += 1;
      recordDebugTrace(state, settings.debug, 'error', '阶段总结条目生成失败。', {
        error: error instanceof Error ? error.message : String(error),
        startMessageId: start,
        targetEndMessageId: maximumEnd,
      });
      try {
        assertChatOwner(state);
        await this.memoryRepository.save(state);
      } catch (saveError) {
        logger.warn('保存阶段总结失败统计时聊天已切换或元数据不可用。', saveError);
      }
      throw error;
    }

    return { state, updatedChunks };
  }
}

export const stageSummaryService = new StageSummaryService();
