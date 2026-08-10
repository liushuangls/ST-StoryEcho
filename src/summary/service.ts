import { sha256 } from '../core/hash';
import { logger } from '../core/logger';
import type {
  StageSummaryEntry,
  StageSummaryRebuildCheckpoint,
  StoryEchoChatState,
  StoryEchoSettings,
  TavernChatMessage,
} from '../core/types';
import { storyContent } from '../content/story-content';
import { mergeInternalLlmAttempts } from '../debug/internal-llm-attempts';
import { mergeDebugTraces, recordDebugTrace } from '../debug/metrics';
import { countCompletedTurns, planNextChunk } from '../history/chunk-planner';
import { SourceRevisionCache } from '../history/source-revision-cache';
import { firstStoryPhaseBoundary } from '../history/story-phase';
import { completeObservedInternalRequest } from '../llm/observed-completion';
import {
  getContext,
  getCurrentChatId,
  getMainConnectionIdentity,
  type SillyTavernContext,
} from '../platform/sillytavern';
import { estimateTokens } from '../prompt/render';
import { buildSummaryWorldInfoReferenceContext } from '../reference/context';
import { SettingsRepository } from '../settings/repository';
import { StoryStateRepository } from '../state/repository';
import { isStoryEchoTaskCancelledError } from '../runtime/task-cancellation';
import { SUMMARY_LLM_TIMEOUT_MS } from './constants';
import { sameSummaryEntries } from './compaction-state';
import {
  boundedPreviousStageSummary,
  buildStageSummaryPrompt,
  STAGE_SUMMARY_SYSTEM_PROMPT,
} from './prompts';
import { summarySourcePayload } from './source';

export const MAX_SUMMARY_SOURCE_CHARACTERS = 100_000;
const MAX_STORED_SUMMARY_CHARACTERS = 64_000;

export interface StageSummaryProgress {
  startMessageId: number;
  endMessageId: number;
  targetEndMessageId: number;
  resumed?: boolean;
  completedChunks?: number;
}

export interface StageSummaryRunResult {
  state: StoryEchoChatState | null;
  updatedChunks: number;
}

export interface StageSummaryRegenerationResult {
  state: StoryEchoChatState;
  entry: StageSummaryEntry;
  previousCharacterCount: number;
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
  previousSummaryCharacters: number;
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
    .replace(/<\/?story_echo_summary>/gi, '')
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
    .map((entry) => `${entry.level}:${entry.sourceStartMessageId}:${entry.sourceEndMessageId}:${entry.sourceHash}`)
    .join('|');
}

function sourceMessageSnapshot(
  chat: readonly TavernChatMessage[],
  endMessageId: number,
): TavernChatMessage[] {
  return chat.slice(0, endMessageId + 1).map((message) => ({
    is_user: message.is_user,
    is_system: Boolean(message.is_system),
    ...(message.name ? { name: message.name } : {}),
    mes: message.mes,
  }));
}

function sourceMessageSnapshotMatches(
  snapshot: readonly TavernChatMessage[],
  chat: readonly TavernChatMessage[],
): boolean {
  if (chat.length < snapshot.length) {
    return false;
  }
  return snapshot.every((message, index) => {
    const current = chat[index];
    return Boolean(
      current &&
      message.is_user === current.is_user &&
      Boolean(message.is_system) === Boolean(current.is_system) &&
      (message.name || '') === (current.name || '') &&
      message.mes === current.mes
    );
  });
}

function assertSourceMessageSnapshotCurrent(
  state: StoryEchoChatState,
  snapshot: readonly TavernChatMessage[],
): void {
  assertChatOwner(state);
  if (!sourceMessageSnapshotMatches(snapshot, getContext().chat)) {
    throw new Error('校验阶段总结期间聊天历史发生变化，本次保留完整原文。');
  }
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

async function rebuildGenerationSignature(
  context: SillyTavernContext,
  settings: StoryEchoSettings,
): Promise<string> {
  return sha256(JSON.stringify({
    checkpointProtocolVersion: 1,
    systemPrompt: STAGE_SUMMARY_SYSTEM_PROMPT,
    identity: summaryIdentity(context),
    targetTurnsPerUpdate: settings.summary.targetTurnsPerUpdate,
    maxTokens: settings.summary.level1MaxTokens,
    reference: settings.summary.reference,
    maximumSourceCharacters: MAX_SUMMARY_SOURCE_CHARACTERS,
    model: settings.llm.provider === 'main'
      ? { provider: 'main', ...getMainConnectionIdentity(context) }
      : {
          provider: settings.llm.provider,
          baseUrl: settings.llm.custom.baseUrl.trim(),
          model: settings.llm.custom.model.trim(),
          fallbackToMain: settings.llm.custom.fallbackToMain,
        },
  }));
}

async function rebuildCheckpointMatches(
  checkpoint: StageSummaryRebuildCheckpoint,
  targetEndMessageId: number,
  targetSourceHash: string,
  generationSignature: string,
  chatSnapshot: readonly TavernChatMessage[],
): Promise<boolean> {
  if (
    checkpoint.targetEndMessageId !== targetEndMessageId ||
    checkpoint.targetSourceHash !== targetSourceHash ||
    checkpoint.generationSignature !== generationSignature ||
    checkpoint.entries.length === 0
  ) {
    return false;
  }
  let expectedStartMessageId = 0;
  for (const entry of checkpoint.entries) {
    if (
      entry.deleted ||
      entry.sourceStartMessageId !== expectedStartMessageId ||
      entry.sourceEndMessageId > targetEndMessageId
    ) {
      return false;
    }
    const actualHash = await sha256(summarySourcePayload(
      chatSnapshot.slice(entry.sourceStartMessageId, entry.sourceEndMessageId + 1),
      entry.sourceStartMessageId,
    ));
    if (!entry.sourceHash || actualHash !== entry.sourceHash) {
      return false;
    }
    expectedStartMessageId = entry.sourceEndMessageId + 1;
  }
  return true;
}

export class StageSummaryService {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly settingsRepository = new SettingsRepository();
  private readonly stateRepository = new StoryStateRepository();
  private readonly sourceRevisionCache = new SourceRevisionCache();

  async reconcileHistory(
    state?: StoryEchoChatState,
  ): Promise<StoryEchoChatState | null> {
    const current = state ?? await this.stateRepository.getOrCreate();
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
    const verifiedChatSnapshot = sourceMessageSnapshot(context.chat, initialCoverage);
    let validEntries = 0;
    let initializedHashes = 0;
    for (const entry of current.stageSummary.entries) {
      if (
        entry.sourceStartMessageId < 0 ||
        entry.sourceEndMessageId < entry.sourceStartMessageId ||
        entry.sourceEndMessageId >= verifiedChatSnapshot.length
      ) {
        break;
      }
      const actualHash = await sha256(summarySourcePayload(
        verifiedChatSnapshot.slice(entry.sourceStartMessageId, entry.sourceEndMessageId + 1),
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
    assertSourceMessageSnapshotCurrent(current, verifiedChatSnapshot);

    if (validEntries === current.stageSummary.entries.length) {
      if (initializedHashes > 0) {
        const latest = current.stageSummary.entries.at(-1)!;
        current.stageSummary.coveredThroughHash = latest.sourceHash;
        await this.stateRepository.save(current);
        assertSourceMessageSnapshotCurrent(current, verifiedChatSnapshot);
      }
      this.sourceRevisionCache.remember(
        current.ownerChatId,
        summarySourceSignature(current.stageSummary.entries),
        verifiedChatSnapshot,
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
    await this.stateRepository.save(current);
    assertSourceMessageSnapshotCurrent(current, verifiedChatSnapshot);
    this.sourceRevisionCache.remember(
      current.ownerChatId,
      summarySourceSignature(entries),
      verifiedChatSnapshot,
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
    const snapshotHash = await sha256(summarySourcePayload(chunk.snapshot, chunk.startMessageId));
    const identity = summaryIdentity(context);
    let worldBackground = '';
    try {
      const reference = await buildSummaryWorldInfoReferenceContext(
        chunk.snapshot,
        settings.summary.reference,
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
      worldBackground,
      boundedPrevious,
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
        requestTimeoutSeconds: SUMMARY_LLM_TIMEOUT_MS / 1_000,
      });
    }
    const completion = await completeObservedInternalRequest(state, settings, {
      system: STAGE_SUMMARY_SYSTEM_PROMPT,
      prompt,
      maxTokens: settings.summary.level1MaxTokens,
      timeoutMs: SUMMARY_LLM_TIMEOUT_MS,
    }, {
      task: 'stage-summary',
      sourceStartMessageId: chunk.startMessageId,
      sourceEndMessageId: chunk.endMessageId,
    });
    const raw = completion.text;
    // Detect a branch/edit before accepting even the summary format, so a
    // stale request is always reported and discarded for the right cause.
    const currentChat = getContext().chat;
    const currentHash = await sha256(summarySourcePayload(
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
    const commitHash = await sha256(summarySourcePayload(
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
        level: 1,
        characterCount: Array.from(text).length,
        generation: completion.metadata,
        sourceStartMessageId: chunk.startMessageId,
        sourceEndMessageId: chunk.endMessageId,
        sourceHash: snapshotHash,
        updatedAt,
      },
      durationMs: Math.round(performance.now() - startedAt),
      sourceMessageCount: chunk.snapshot.length,
      personaLabelSanitized: text !== withoutPersonaSanitization,
      previousSummaryCharacters: Array.from(boundedPrevious).length,
    };
  }

  regenerateEntry(
    sourceStartMessageId: number,
    expectedUpdatedAt?: string,
  ): Promise<StageSummaryRegenerationResult> {
    const requestedChatId = getCurrentChatId();
    const operation = this.queue.then(
      () => this.regenerateNow(
        sourceStartMessageId,
        requestedChatId,
        expectedUpdatedAt,
      ),
      () => this.regenerateNow(
        sourceStartMessageId,
        requestedChatId,
        expectedUpdatedAt,
      ),
    );
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async regenerateNow(
    sourceStartMessageId: number,
    requestedChatId: string | null,
    expectedUpdatedAt?: string,
  ): Promise<StageSummaryRegenerationResult> {
    if (
      !requestedChatId ||
      getCurrentChatId() !== requestedChatId ||
      !Number.isInteger(sourceStartMessageId) ||
      sourceStartMessageId < 0
    ) {
      throw new Error('等待重新生成阶段总结期间聊天发生切换或目标无效，已取消任务。');
    }
    const settings = this.settingsRepository.get();
    let state = await this.stateRepository.getOrCreate();
    if (!state) {
      throw new Error('当前没有可用聊天。');
    }
    state = await this.reconcileHistory(state) ?? state;
    assertChatOwner(state);
    const index = state.stageSummary.entries.findIndex(
      (entry) => entry.sourceStartMessageId === sourceStartMessageId && !entry.deleted,
    );
    const current = index >= 0 ? state.stageSummary.entries[index] : undefined;
    if (!current) {
      throw new Error('要重新生成的阶段总结不存在，可能已被删除或因历史变化而失效。');
    }
    if (current.level !== 1) {
      throw new Error('该条目是高层总结，请使用高层总结重新生成功能。');
    }
    if (expectedUpdatedAt && current.updatedAt !== expectedUpdatedAt) {
      throw new Error('阶段总结已在其他操作中发生变化，请刷新后重试。');
    }

    const context = getContext();
    if (current.sourceEndMessageId >= context.chat.length) {
      throw new Error('阶段总结来源范围已超出当前聊天，请先刷新状态。');
    }
    const snapshot = context.chat
      .slice(current.sourceStartMessageId, current.sourceEndMessageId + 1)
      .map((message) => ({
        is_user: message.is_user,
        is_system: Boolean(message.is_system),
        ...(message.name ? { name: message.name } : {}),
        mes: message.mes,
      }));
    const sourceHash = await sha256(summarySourcePayload(snapshot, current.sourceStartMessageId));
    if (current.sourceHash && current.sourceHash !== sourceHash) {
      throw new Error('阶段总结来源消息已经变化，请先刷新并重新处理历史。');
    }
    const chunk: PreparedStageSummaryChunk = {
      startMessageId: current.sourceStartMessageId,
      endMessageId: current.sourceEndMessageId,
      snapshot,
      sourceCharacters: snapshot.reduce((total, message) => total + message.mes.length, 0),
    };
    const entriesSnapshot = structuredClone(state.stageSummary.entries);
    const priorAttemptId = state.recentInternalLlmAttempts.at(-1)?.id;
    const previousSummary = latestActiveSummaryText(entriesSnapshot.slice(0, index));

    try {
      const generated = await this.generateEntry(
        context,
        settings,
        state,
        chunk,
        previousSummary,
      );
      const live = this.stateRepository.getExisting();
      if (!live || live.ownerChatId !== state.ownerChatId) {
        throw new Error('重新生成阶段总结期间聊天发生切换，已丢弃本次结果。');
      }
      if (!sameSummaryEntries(live.stageSummary.entries, entriesSnapshot)) {
        throw new Error('重新生成阶段总结期间已有总结发生变化，已丢弃本次结果。');
      }
      mergeInternalLlmAttempts(live, state);
      live.debugTraces = mergeDebugTraces(live.debugTraces, state.debugTraces);
      const replacementIndex = live.stageSummary.entries.findIndex(
        (entry) => entry.sourceStartMessageId === sourceStartMessageId && !entry.deleted,
      );
      if (replacementIndex < 0) {
        throw new Error('要重新生成的阶段总结已失效，已保留原有结果。');
      }
      const previousCharacterCount = Array.from(
        live.stageSummary.entries[replacementIndex]!.text,
      ).length;
      live.stageSummary.entries[replacementIndex] = generated.entry;
      const latest = live.stageSummary.entries.at(-1);
      live.stageSummary = {
        entries: live.stageSummary.entries,
        coveredThroughMessageId: latest?.sourceEndMessageId ?? -1,
        coveredThroughHash: latest?.sourceHash ?? '',
        ...(latest ? { updatedAt: latest.updatedAt } : {}),
        ...(live.stageSummary.rebuildCheckpoint
          ? { rebuildCheckpoint: live.stageSummary.rebuildCheckpoint }
          : {}),
      };
      live.metrics.summaryUpdates += 1;
      live.metrics.totalSummaryMs += generated.durationMs;
      live.metrics.lastSummaryAt = generated.entry.updatedAt;
      delete live.lastInspection;
      recordDebugTrace(live, settings.debug, 'summary', '单条阶段总结已原子重新生成。', {
        range: `${generated.entry.sourceStartMessageId}-${generated.entry.sourceEndMessageId}`,
        previousCharacters: previousCharacterCount,
        summaryCharacters: generated.entry.characterCount ?? generated.entry.text.length,
        finishReason: generated.entry.generation?.finishReason ?? 'unknown',
        completionTokens: generated.entry.generation?.completionTokens ?? -1,
        reasoningTokens: generated.entry.generation?.reasoningTokens ?? -1,
      });
      await this.stateRepository.save(live);
      return {
        state: live,
        entry: generated.entry,
        previousCharacterCount,
      };
    } catch (error) {
      const attemptRecorded = state.recentInternalLlmAttempts.at(-1)?.id !== priorAttemptId;
      if (attemptRecorded) {
        const live = this.stateRepository.getExisting();
        if (live?.ownerChatId === state.ownerChatId) {
          mergeInternalLlmAttempts(live, state);
          live.debugTraces = mergeDebugTraces(live.debugTraces, state.debugTraces);
          if (!isStoryEchoTaskCancelledError(error)) {
            live.metrics.summaryFailures += 1;
            recordDebugTrace(live, settings.debug, 'error', '重新生成单条阶段总结失败，已保留原有结果。', {
              range: `${current.sourceStartMessageId}-${current.sourceEndMessageId}`,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          try {
            await this.stateRepository.save(live);
          } catch (saveError) {
            logger.warn('保存单条阶段总结重新生成诊断时聊天已切换或元数据不可用。', saveError);
          }
        }
      }
      throw error;
    }
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
    let state = await this.stateRepository.getOrCreate();
    if (!state) {
      return { state, updatedChunks: 0 };
    }
    assertChatOwner(state);
    const maximumEnd = Math.min(
      Math.floor(targetEndMessageId),
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
    const sourceSnapshot = structuredClone(state.stageSummary.entries);
    const targetSourceHash = await sha256(summarySourcePayload(chatSnapshot, 0));
    const generationSignature = await rebuildGenerationSignature(context, settings);
    const storedCheckpoint = state.stageSummary.rebuildCheckpoint;
    const resumeCheckpoint = storedCheckpoint && await rebuildCheckpointMatches(
      storedCheckpoint,
      maximumEnd,
      targetSourceHash,
      generationSignature,
      chatSnapshot,
    )
      ? storedCheckpoint
      : undefined;
    let rebuiltEntries: StageSummaryEntry[] = resumeCheckpoint
      ? structuredClone(resumeCheckpoint.entries)
      : [];
    let start = rebuiltEntries.at(-1)?.sourceEndMessageId !== undefined
      ? rebuiltEntries.at(-1)!.sourceEndMessageId + 1
      : 0;
    let totalDurationMs = resumeCheckpoint?.totalDurationMs ?? 0;
    let totalMessagesCovered = rebuiltEntries.reduce(
      (total, entry) => total + entry.sourceEndMessageId - entry.sourceStartMessageId + 1,
      0,
    );

    if (storedCheckpoint && !resumeCheckpoint) {
      delete state.stageSummary.rebuildCheckpoint;
      recordDebugTrace(state, settings.debug, 'summary', '全量重建草稿与当前原文或设置不匹配，已从头开始。', {
        storedDraftEntries: storedCheckpoint.entries.length,
        storedTargetEndMessageId: storedCheckpoint.targetEndMessageId,
        currentTargetEndMessageId: maximumEnd,
      });
      await this.stateRepository.save(state);
    }
    if (resumeCheckpoint) {
      const latestDraft = rebuiltEntries.at(-1)!;
      recordDebugTrace(state, settings.debug, 'summary', '已验证并恢复全量重建草稿。', {
        draftEntries: rebuiltEntries.length,
        coveredThroughMessageId: latestDraft.sourceEndMessageId,
        resumeFromMessageId: start,
      });
      onProgress?.({
        startMessageId: latestDraft.sourceStartMessageId,
        endMessageId: latestDraft.sourceEndMessageId,
        targetEndMessageId: maximumEnd,
        resumed: true,
        completedChunks: rebuiltEntries.length,
      });
    }

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
          previousSummaryCharacters: generated.previousSummaryCharacters,
        });
        const live = this.stateRepository.getExisting();
        if (!live || live.ownerChatId !== state.ownerChatId) {
          throw new Error('保存阶段总结重建草稿期间聊天发生切换，已取消任务。');
        }
        if (!sameSummaryEntries(live.stageSummary.entries, sourceSnapshot)) {
          throw new Error('保存阶段总结重建草稿期间已有总结发生变化，已取消任务。');
        }
        const liveTargetSourceHash = await sha256(summarySourcePayload(
          getContext().chat.slice(0, maximumEnd + 1),
          0,
        ));
        if (liveTargetSourceHash !== targetSourceHash) {
          throw new Error('保存阶段总结重建草稿期间历史原文发生变化，已取消任务。');
        }
        mergeInternalLlmAttempts(live, state);
        live.debugTraces = mergeDebugTraces(live.debugTraces, state.debugTraces);
        live.stageSummary.rebuildCheckpoint = {
          targetEndMessageId: maximumEnd,
          targetSourceHash,
          generationSignature,
          entries: structuredClone(rebuiltEntries),
          totalDurationMs,
          totalMessagesCovered,
          updatedAt: new Date().toISOString(),
        };
        await this.stateRepository.save(live);
        state = live;
        onProgress?.({
          startMessageId: chunk.startMessageId,
          endMessageId: chunk.endMessageId,
          targetEndMessageId: maximumEnd,
          completedChunks: rebuiltEntries.length,
        });
        start = chunk.endMessageId + 1;
      }

      if (rebuiltEntries.length === 0) {
        return { state, updatedChunks: 0 };
      }
      const live = this.stateRepository.getExisting();
      if (!live || live.ownerChatId !== state.ownerChatId) {
        throw new Error('阶段总结重建期间聊天发生切换，已丢弃本次结果。');
      }
      if (!sameSummaryEntries(live.stageSummary.entries, sourceSnapshot)) {
        throw new Error('阶段总结重建期间已有总结发生变化，已丢弃本次结果。');
      }
      mergeInternalLlmAttempts(live, state);
      live.debugTraces = mergeDebugTraces(live.debugTraces, state.debugTraces);
      const latest = rebuiltEntries.at(-1)!;
      const rebuiltSourceHash = await sha256(summarySourcePayload(
        chatSnapshot.slice(0, latest.sourceEndMessageId + 1),
        0,
      ));
      const liveSourceHash = await sha256(summarySourcePayload(
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
      });
      await this.stateRepository.save(live);
      state = live;
      return { state, updatedChunks: rebuiltEntries.length };
    } catch (error) {
      if (isStoryEchoTaskCancelledError(error)) {
        try {
          const live = this.stateRepository.getExisting();
          if (!live || live.ownerChatId !== state.ownerChatId) {
            throw new Error('保存阶段总结重建取消诊断时聊天已切换。');
          }
          mergeInternalLlmAttempts(live, state);
          live.debugTraces = mergeDebugTraces(live.debugTraces, state.debugTraces);
          await this.stateRepository.save(live);
        } catch (saveError) {
          logger.warn('保存阶段总结重建取消诊断时聊天已切换或元数据不可用。', saveError);
        }
        throw error;
      }
      const live = this.stateRepository.getExisting();
      if (live?.ownerChatId === state.ownerChatId) {
        mergeInternalLlmAttempts(live, state);
        live.debugTraces = mergeDebugTraces(live.debugTraces, state.debugTraces);
        live.metrics.summaryFailures += 1;
        recordDebugTrace(live, settings.debug, 'error', '全部阶段总结重建失败，已保留原有结果。', {
          error: error instanceof Error ? error.message : String(error),
          startMessageId: start,
          targetEndMessageId: maximumEnd,
          completedDraftEntries: rebuiltEntries.length,
          resumeFromMessageId: rebuiltEntries.at(-1)?.sourceEndMessageId !== undefined
            ? rebuiltEntries.at(-1)!.sourceEndMessageId + 1
            : 0,
        });
        try {
          await this.stateRepository.save(live);
          state = live;
        } catch (saveError) {
          logger.warn('保存阶段总结重建失败统计时聊天已切换或元数据不可用。', saveError);
        }
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
    let state = await this.stateRepository.getOrCreate();
    if (!state) {
      return { state, updatedChunks: 0 };
    }
    assertChatOwner(state);

    const maximumEnd = Math.min(
      Math.floor(targetEndMessageId),
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
        const entriesBeforeRequest = structuredClone(state.stageSummary.entries);
        const generated = await this.generateEntry(
          context,
          settings,
          state,
          chunk,
          latestActiveSummaryText(entriesBeforeRequest),
        );
        const live = this.stateRepository.getExisting();
        if (!live || live.ownerChatId !== state.ownerChatId) {
          throw new Error('阶段总结生成期间聊天发生切换，已丢弃本次结果。');
        }
        if (!sameSummaryEntries(live.stageSummary.entries, entriesBeforeRequest)) {
          throw new Error('阶段总结生成期间已有总结发生变化，已丢弃本次结果。');
        }
        mergeInternalLlmAttempts(live, state);
        live.debugTraces = mergeDebugTraces(live.debugTraces, state.debugTraces);
        state = live;
        assertChatOwner(state);
        state.stageSummary.entries.push(generated.entry);
        state.stageSummary = {
          entries: state.stageSummary.entries,
          coveredThroughMessageId: generated.entry.sourceEndMessageId,
          coveredThroughHash: generated.entry.sourceHash,
          updatedAt: generated.entry.updatedAt,
          ...(state.stageSummary.rebuildCheckpoint
            ? { rebuildCheckpoint: state.stageSummary.rebuildCheckpoint }
            : {}),
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
          previousSummaryCharacters: generated.previousSummaryCharacters,
        });
        await this.stateRepository.save(state);
        updatedChunks += 1;
        options.onProgress?.({
          startMessageId: chunk.startMessageId,
          endMessageId: chunk.endMessageId,
          targetEndMessageId: maximumEnd,
        });
        start = chunk.endMessageId + 1;
      }
    } catch (error) {
      const live = this.stateRepository.getExisting();
      if (live?.ownerChatId === state.ownerChatId) {
        mergeInternalLlmAttempts(live, state);
        live.debugTraces = mergeDebugTraces(live.debugTraces, state.debugTraces);
        if (!isStoryEchoTaskCancelledError(error)) {
          live.metrics.summaryFailures += 1;
          recordDebugTrace(live, settings.debug, 'error', '阶段总结条目生成失败。', {
            error: error instanceof Error ? error.message : String(error),
            startMessageId: start,
            targetEndMessageId: maximumEnd,
          });
        }
        try {
          await this.stateRepository.save(live);
        } catch (saveError) {
          logger.warn('保存阶段总结失败统计时聊天已切换或元数据不可用。', saveError);
        }
      }
      throw error;
    }

    return { state, updatedChunks };
  }
}

export const stageSummaryService = new StageSummaryService();
