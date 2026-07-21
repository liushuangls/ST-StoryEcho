import { logger } from '../core/logger';
import type {
  StageSummaryEntry,
  StoryEchoChatState,
  StoryEchoSettings,
  StorySkeleton,
  TavernChatMessage,
} from '../core/types';
import { recordDebugTrace } from '../debug/metrics';
import { completeWithConfiguredProvider } from '../llm/complete';
import { MemoryRepository } from '../memory/repository';
import { getCurrentChatId } from '../platform/sillytavern';
import { buildStorySkeletonWorldInfoReferenceContext } from '../reference/context';
import { SettingsRepository } from '../settings/repository';
import {
  buildStorySkeletonPrompt,
  STORY_SKELETON_SYSTEM_PROMPT,
  type StorySkeletonPromptMode,
} from './skeleton-prompts';
import {
  activeStageSummaryEntries,
  archivedStageSummaryEntries,
  normalizeStorySkeletonText,
  pendingArchivedStageSummaryEntries,
  skeletonSourceBatches,
  skeletonSourceEntryCharacters,
  storySkeletonIsUsable,
  storySkeletonSourceHash,
  storySkeletonUpdateDue,
} from './skeleton-state';

export interface StorySkeletonProgress {
  sourceStartMessageId: number;
  sourceEndMessageId: number;
  pendingEntries: number;
}

export interface StorySkeletonRunResult {
  state: StoryEchoChatState | null;
  updatedChunks: number;
  pendingEntries: number;
}

interface StorySkeletonRunOptions {
  force: boolean;
  maxChunks: number;
  rebuild: boolean;
  onProgress?: (progress: StorySkeletonProgress) => void;
}

interface SkeletonSourceSnapshot {
  sourceStartMessageId: number;
  sourceEndMessageId: number;
  sourceHash: string;
  text: string;
  deleted: boolean;
}

interface SkeletonRevisionSnapshot {
  ownerChatId: string;
  coverage: number;
  sourceHash: string;
  skeletonText: string;
  stale: boolean;
  maxTokens: number;
  entries: SkeletonSourceSnapshot[];
}

function sourceRangeKey(entry: StageSummaryEntry): string {
  return `${entry.sourceStartMessageId}:${entry.sourceEndMessageId}`;
}

function sameStageSummaryEntries(
  left: readonly StageSummaryEntry[],
  right: readonly StageSummaryEntry[],
): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index];
    return Boolean(
      other &&
      sourceRangeKey(entry) === sourceRangeKey(other) &&
      entry.sourceHash === other.sourceHash &&
      entry.text === other.text &&
      Boolean(entry.deleted) === Boolean(other.deleted)
    );
  });
}

function sameSkeletonRevision(left: StorySkeleton, right: StorySkeleton): boolean {
  return left.text === right.text &&
    left.coveredThroughMessageId === right.coveredThroughMessageId &&
    left.sourceHash === right.sourceHash &&
    left.updatedAt === right.updatedAt &&
    Boolean(left.manuallyEdited) === Boolean(right.manuallyEdited) &&
    Boolean(left.stale) === Boolean(right.stale);
}

function orderedActiveEntries(state: StoryEchoChatState): StageSummaryEntry[] {
  return activeStageSummaryEntries(state).sort((left, right) => (
    left.sourceStartMessageId - right.sourceStartMessageId ||
    left.sourceEndMessageId - right.sourceEndMessageId
  ));
}

function cleanBuildPromptMode(
  rebuild: boolean,
  stale: boolean,
  continuation: boolean,
): StorySkeletonPromptMode {
  if (rebuild) {
    return continuation ? 'full-rebuild-continue' : 'full-rebuild';
  }
  if (stale) {
    return continuation ? 'stale-rebuild-continue' : 'stale-rebuild';
  }
  return continuation ? 'initial-build-continue' : 'initial-build';
}

/** Avoid serializing and hashing the same archived summaries before every reply. */
class StorySkeletonRevisionCache {
  private snapshot: SkeletonRevisionSnapshot | null = null;

  matches(state: StoryEchoChatState, maxTokens: number): boolean {
    const snapshot = this.snapshot;
    const skeleton = state.storySkeleton;
    if (
      !snapshot ||
      snapshot.ownerChatId !== state.ownerChatId ||
      snapshot.coverage !== skeleton.coveredThroughMessageId ||
      snapshot.sourceHash !== skeleton.sourceHash ||
      snapshot.skeletonText !== skeleton.text ||
      snapshot.stale !== Boolean(skeleton.stale) ||
      snapshot.maxTokens !== maxTokens
    ) {
      return false;
    }

    let sourceIndex = 0;
    for (const entry of state.stageSummary.entries) {
      if (entry.sourceEndMessageId > snapshot.coverage) {
        continue;
      }
      const source = snapshot.entries[sourceIndex];
      if (
        !source ||
        source.sourceStartMessageId !== entry.sourceStartMessageId ||
        source.sourceEndMessageId !== entry.sourceEndMessageId ||
        source.sourceHash !== entry.sourceHash ||
        source.text !== (entry.deleted ? '' : entry.text) ||
        source.deleted !== Boolean(entry.deleted)
      ) {
        return false;
      }
      sourceIndex += 1;
    }
    return sourceIndex === snapshot.entries.length;
  }

  remember(state: StoryEchoChatState, maxTokens: number): void {
    const skeleton = state.storySkeleton;
    this.snapshot = {
      ownerChatId: state.ownerChatId,
      coverage: skeleton.coveredThroughMessageId,
      sourceHash: skeleton.sourceHash,
      skeletonText: skeleton.text,
      stale: Boolean(skeleton.stale),
      maxTokens,
      entries: state.stageSummary.entries
        .filter((entry) => entry.sourceEndMessageId <= skeleton.coveredThroughMessageId)
        .map((entry) => ({
          sourceStartMessageId: entry.sourceStartMessageId,
          sourceEndMessageId: entry.sourceEndMessageId,
          sourceHash: entry.sourceHash,
          text: entry.deleted ? '' : entry.text,
          deleted: Boolean(entry.deleted),
        })),
    };
  }
}

function assertChatOwner(state: StoryEchoChatState): void {
  if (getCurrentChatId() !== state.ownerChatId) {
    throw new Error('全局剧情骨架处理期间聊天发生切换，已取消写入。');
  }
}

export class StorySkeletonService {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly settingsRepository = new SettingsRepository();
  private readonly memoryRepository = new MemoryRepository();
  private readonly revisionCache = new StorySkeletonRevisionCache();

  async reconcile(
    state?: StoryEchoChatState,
  ): Promise<StoryEchoChatState | null> {
    const current = state ?? await this.memoryRepository.getOrCreate();
    if (!current || !current.storySkeleton.text.trim()) {
      return current;
    }
    assertChatOwner(current);
    const settings = this.settingsRepository.get();
    if (this.revisionCache.matches(current, settings.summary.skeletonMaxTokens)) {
      return current;
    }
    const coverage = current.storySkeleton.coveredThroughMessageId;
    const latestStored = current.stageSummary.entries
      .filter((entry) => entry.sourceEndMessageId <= coverage)
      .at(-1);
    const actualHash = coverage >= 0 && latestStored?.sourceEndMessageId === coverage
      ? await storySkeletonSourceHash(current.stageSummary.entries, coverage)
      : '';
    let withinConfiguredLimit = true;
    try {
      normalizeStorySkeletonText(current.storySkeleton.text, settings.summary.skeletonMaxTokens);
    } catch {
      withinConfiguredLimit = false;
    }
    const stale = !withinConfiguredLimit || !actualHash || actualHash !== current.storySkeleton.sourceHash;
    if (Boolean(current.storySkeleton.stale) === stale) {
      this.revisionCache.remember(current, settings.summary.skeletonMaxTokens);
      return current;
    }
    current.storySkeleton = {
      ...current.storySkeleton,
      ...(stale ? { stale: true } : {}),
    };
    if (!stale) {
      delete current.storySkeleton.stale;
    }
    delete current.lastInspection;
    recordDebugTrace(
      current,
      settings.debug,
      'summary',
      stale
        ? '阶段总结来源变化后，全局剧情骨架已标记为待重建。'
        : '全局剧情骨架来源校验通过。',
      {
        coveredThroughMessageId: coverage,
        withinConfiguredLimit,
        skeletonMaxTokens: settings.summary.skeletonMaxTokens,
      },
    );
    await this.memoryRepository.save(current);
    this.revisionCache.remember(current, settings.summary.skeletonMaxTokens);
    return current;
  }

  processNextIfNeeded(
    onProgress?: (progress: StorySkeletonProgress) => void,
  ): Promise<StorySkeletonRunResult> {
    return this.enqueue({
      force: false,
      maxChunks: 1,
      rebuild: false,
      ...(onProgress ? { onProgress } : {}),
    });
  }

  processAllPending(
    onProgress?: (progress: StorySkeletonProgress) => void,
  ): Promise<StorySkeletonRunResult> {
    return this.enqueue({
      force: true,
      maxChunks: Number.MAX_SAFE_INTEGER,
      rebuild: false,
      ...(onProgress ? { onProgress } : {}),
    });
  }

  rebuildAll(
    onProgress?: (progress: StorySkeletonProgress) => void,
  ): Promise<StorySkeletonRunResult> {
    return this.enqueue({
      force: true,
      maxChunks: Number.MAX_SAFE_INTEGER,
      rebuild: true,
      ...(onProgress ? { onProgress } : {}),
    });
  }

  private enqueue(options: StorySkeletonRunOptions): Promise<StorySkeletonRunResult> {
    const requestedChatId = getCurrentChatId();
    const operation = this.queue.then(
      () => this.processNow(requestedChatId, options),
      () => this.processNow(requestedChatId, options),
    );
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async buildWorldBackground(
    state: StoryEchoChatState,
    entries: readonly StageSummaryEntry[],
    settings: StoryEchoSettings,
  ): Promise<string> {
    const first = entries[0];
    const last = entries.at(-1);
    if (!first || !last) {
      return '';
    }
    const referenceMessages: TavernChatMessage[] = entries.map((entry) => ({
      is_user: false,
      is_system: false,
      mes: entry.text,
    }));
    try {
      const reference = await buildStorySkeletonWorldInfoReferenceContext(
        referenceMessages,
        settings.extraction.reference,
      );
      recordDebugTrace(state, settings.debug, 'summary', '全局剧情骨架世界书背景已构建。', {
        sourceRange: `${first.sourceStartMessageId}-${last.sourceEndMessageId}`,
        tokens: reference.tokenCount,
        worldInfoEntries: reference.worldInfoEntries.join(',') || '-',
        truncated: reference.truncated,
        warnings: reference.warnings.join(' | ') || '-',
        referencePreview: reference.text.slice(0, 4_000) || '-',
      });
      return reference.text;
    } catch (error) {
      recordDebugTrace(
        state,
        settings.debug,
        'error',
        '全局剧情骨架世界书背景构建失败，继续仅使用骨架与阶段总结。',
        {
          sourceRange: `${first.sourceStartMessageId}-${last.sourceEndMessageId}`,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return '';
    }
  }

  private validateCleanBuildSources(
    state: StoryEchoChatState,
    sourceSnapshot: readonly StageSummaryEntry[],
    skeletonSnapshot: StorySkeleton,
  ): StoryEchoChatState {
    const live = this.memoryRepository.getExisting();
    if (!live || live.ownerChatId !== state.ownerChatId) {
      throw new Error('全局剧情骨架生成期间聊天发生切换，已丢弃本次结果。');
    }
    if (!sameStageSummaryEntries(live.stageSummary.entries, sourceSnapshot)) {
      throw new Error('全局剧情骨架生成期间阶段总结发生变化，已丢弃本次结果。');
    }
    if (!sameSkeletonRevision(live.storySkeleton, skeletonSnapshot)) {
      throw new Error('全局剧情骨架生成期间骨架被人工编辑，已丢弃本次结果。');
    }
    return live;
  }

  private async runCleanBuild(
    state: StoryEchoChatState,
    settings: StoryEchoSettings,
    options: StorySkeletonRunOptions,
  ): Promise<StorySkeletonRunResult> {
    const sourceEntries = orderedActiveEntries(state);
    if (sourceEntries.length === 0) {
      return { state, updatedChunks: 0, pendingEntries: 0 };
    }
    const batches = skeletonSourceBatches(sourceEntries);
    const sourceSnapshot = state.stageSummary.entries.map((entry) => ({ ...entry }));
    const skeletonSnapshot = { ...state.storySkeleton };
    const staleAtStart = Boolean(state.storySkeleton.stale);
    const startedAt = performance.now();
    const coveredThroughMessageId = sourceEntries.at(-1)!.sourceEndMessageId;
    const sourceHash = await storySkeletonSourceHash(
      sourceSnapshot,
      coveredThroughMessageId,
    );
    this.validateCleanBuildSources(state, sourceSnapshot, skeletonSnapshot);
    let draft = '';
    let processedEntries = 0;

    for (const [index, batch] of batches.entries()) {
      assertChatOwner(state);
      const first = batch[0]!;
      const last = batch.at(-1)!;
      const worldBackground = await this.buildWorldBackground(state, batch, settings);
      const mode = cleanBuildPromptMode(options.rebuild, staleAtStart, index > 0);
      const raw = await completeWithConfiguredProvider(settings, {
        system: STORY_SKELETON_SYSTEM_PROMPT,
        prompt: buildStorySkeletonPrompt({
          existingSkeleton: draft,
          sourceEntries: batch,
          maxTokens: settings.summary.skeletonMaxTokens,
          mode,
          worldBackground,
        }),
        maxTokens: settings.summary.skeletonMaxTokens,
      });
      draft = normalizeStorySkeletonText(raw, settings.summary.skeletonMaxTokens);
      processedEntries += batch.length;
      this.validateCleanBuildSources(state, sourceSnapshot, skeletonSnapshot);
      options.onProgress?.({
        sourceStartMessageId: first.sourceStartMessageId,
        sourceEndMessageId: last.sourceEndMessageId,
        pendingEntries: sourceEntries.length - processedEntries,
      });
    }

    const live = this.validateCleanBuildSources(state, sourceSnapshot, skeletonSnapshot);
    const updatedAt = new Date().toISOString();
    live.storySkeleton = {
      text: draft,
      coveredThroughMessageId,
      sourceHash,
      updatedAt,
    };
    live.metrics.skeletonUpdates += batches.length;
    live.metrics.totalSkeletonMs += Math.round(performance.now() - startedAt);
    live.metrics.lastSkeletonAt = updatedAt;
    delete live.lastInspection;
    recordDebugTrace(live, settings.debug, 'summary', '全局剧情骨架已从阶段总结干净重建。', {
      coveredThroughMessageId,
      sourceEntries: sourceEntries.length,
      sourceBatches: batches.length,
      sourceCharacters: sourceEntries.reduce(
        (total, entry) => total + skeletonSourceEntryCharacters(entry),
        0,
      ),
      skeletonCharacters: draft.length,
      skeletonMaxTokens: settings.summary.skeletonMaxTokens,
      mode: options.rebuild ? 'full-rebuild' : staleAtStart ? 'stale-rebuild' : 'initial-build',
    });
    await this.memoryRepository.save(live);
    this.revisionCache.remember(live, settings.summary.skeletonMaxTokens);
    return {
      state: live,
      updatedChunks: batches.length,
      pendingEntries: pendingArchivedStageSummaryEntries(
        live,
        settings.summary.windowSize,
      ).length,
    };
  }

  private async runIncrementalUpdates(
    state: StoryEchoChatState,
    settings: StoryEchoSettings,
    options: StorySkeletonRunOptions,
  ): Promise<StorySkeletonRunResult> {
    let updatedChunks = 0;

    while (updatedChunks < options.maxChunks) {
      assertChatOwner(state);
      const pending = pendingArchivedStageSummaryEntries(state, settings.summary.windowSize);
      if (!storySkeletonUpdateDue(state, pending, options.force)) {
        return { state, updatedChunks, pendingEntries: pending.length };
      }
      const sourceEntry = pending[0];
      if (!sourceEntry) {
        break;
      }
      // Incremental maintenance deliberately absorbs exactly the oldest newly
      // archived, not-yet-covered summary together with the saved old skeleton.
      skeletonSourceBatches([sourceEntry]);
      const startedAt = performance.now();
      const priorSkeleton = { ...state.storySkeleton };
      const coveredThroughMessageId = sourceEntry.sourceEndMessageId;
      const sourceSnapshot = state.stageSummary.entries
        .filter((entry) => entry.sourceEndMessageId <= coveredThroughMessageId)
        .map((entry) => ({ ...entry }));
      const sourceHash = await storySkeletonSourceHash(
        sourceSnapshot,
        coveredThroughMessageId,
      );
      const worldBackground = await this.buildWorldBackground(state, [sourceEntry], settings);
      const raw = await completeWithConfiguredProvider(settings, {
        system: STORY_SKELETON_SYSTEM_PROMPT,
        prompt: buildStorySkeletonPrompt({
          existingSkeleton: priorSkeleton.text,
          sourceEntries: [sourceEntry],
          maxTokens: settings.summary.skeletonMaxTokens,
          mode: 'incremental-update',
          worldBackground,
        }),
        maxTokens: settings.summary.skeletonMaxTokens,
      });

      const live = this.memoryRepository.getExisting();
      if (!live || live.ownerChatId !== state.ownerChatId) {
        throw new Error('全局剧情骨架生成期间聊天发生切换，已丢弃本次结果。');
      }
      const liveArchived = archivedStageSummaryEntries(live, settings.summary.windowSize);
      const liveEntry = liveArchived.find((entry) => sourceRangeKey(entry) === sourceRangeKey(sourceEntry));
      if (!liveEntry || !sameStageSummaryEntries([liveEntry], [sourceEntry])) {
        throw new Error('全局剧情骨架生成期间归档总结发生变化，已丢弃本次结果。');
      }
      if (!sameSkeletonRevision(live.storySkeleton, priorSkeleton)) {
        throw new Error('全局剧情骨架生成期间骨架被人工编辑，已丢弃本次结果。');
      }
      const livePrefix = live.stageSummary.entries.filter(
        (entry) => entry.sourceEndMessageId <= coveredThroughMessageId,
      );
      if (!sameStageSummaryEntries(livePrefix, sourceSnapshot)) {
        throw new Error('全局剧情骨架生成期间历史来源发生变化，已丢弃本次结果。');
      }

      const text = normalizeStorySkeletonText(raw, settings.summary.skeletonMaxTokens);
      const updatedAt = new Date().toISOString();
      state = live;
      state.storySkeleton = {
        text,
        coveredThroughMessageId,
        sourceHash,
        updatedAt,
        ...(priorSkeleton.manuallyEdited ? { manuallyEdited: true } : {}),
      };
      state.metrics.skeletonUpdates += 1;
      state.metrics.totalSkeletonMs += Math.round(performance.now() - startedAt);
      state.metrics.lastSkeletonAt = updatedAt;
      delete state.lastInspection;
      recordDebugTrace(state, settings.debug, 'summary', '全局剧情骨架已吸收一条首次归档总结。', {
        sourceRange: `${sourceEntry.sourceStartMessageId}-${sourceEntry.sourceEndMessageId}`,
        coveredThroughMessageId,
        sourceCharacters: skeletonSourceEntryCharacters(sourceEntry),
        skeletonCharacters: text.length,
        skeletonMaxTokens: settings.summary.skeletonMaxTokens,
        mode: 'incremental-update',
      });
      await this.memoryRepository.save(state);
      this.revisionCache.remember(state, settings.summary.skeletonMaxTokens);
      updatedChunks += 1;
      const remaining = pendingArchivedStageSummaryEntries(state, settings.summary.windowSize);
      options.onProgress?.({
        sourceStartMessageId: sourceEntry.sourceStartMessageId,
        sourceEndMessageId: coveredThroughMessageId,
        pendingEntries: remaining.length,
      });
    }

    const pending = pendingArchivedStageSummaryEntries(state, settings.summary.windowSize);
    return { state, updatedChunks, pendingEntries: pending.length };
  }

  private async processNow(
    requestedChatId: string | null,
    options: StorySkeletonRunOptions,
  ): Promise<StorySkeletonRunResult> {
    if (!requestedChatId || getCurrentChatId() !== requestedChatId) {
      throw new Error('等待全局剧情骨架任务期间聊天发生切换，已取消任务。');
    }
    const settings = this.settingsRepository.get();
    let state = await this.memoryRepository.getOrCreate();
    if (!state) {
      return { state, updatedChunks: 0, pendingEntries: 0 };
    }
    state = await this.reconcile(state) ?? state;

    try {
      const pending = pendingArchivedStageSummaryEntries(state, settings.summary.windowSize);
      const cleanBuild = options.rebuild ||
        !state.storySkeleton.text.trim() ||
        Boolean(state.storySkeleton.stale);
      if (cleanBuild) {
        if (!options.rebuild && !storySkeletonUpdateDue(state, pending, options.force)) {
          return { state, updatedChunks: 0, pendingEntries: pending.length };
        }
        return await this.runCleanBuild(state, settings, options);
      }
      return await this.runIncrementalUpdates(state, settings, options);
    } catch (error) {
      state.metrics.skeletonFailures += 1;
      recordDebugTrace(state, settings.debug, 'error', '全局剧情骨架生成失败。', {
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        assertChatOwner(state);
        await this.memoryRepository.save(state);
      } catch (saveError) {
        logger.warn('保存全局剧情骨架失败统计时聊天已切换或元数据不可用。', saveError);
      }
      throw error;
    }
  }
}

export const storySkeletonService = new StorySkeletonService();
