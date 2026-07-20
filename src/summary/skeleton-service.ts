import { logger } from '../core/logger';
import type { StoryEchoChatState } from '../core/types';
import { recordDebugTrace } from '../debug/metrics';
import { completeWithConfiguredProvider } from '../llm/complete';
import { MemoryRepository } from '../memory/repository';
import { getCurrentChatId } from '../platform/sillytavern';
import { SettingsRepository } from '../settings/repository';
import {
  buildStorySkeletonPrompt,
  STORY_SKELETON_SYSTEM_PROMPT,
} from './skeleton-prompts';
import {
  archivedStageSummaryEntries,
  boundedSkeletonSourceEntries,
  normalizeStorySkeletonText,
  pendingArchivedStageSummaryEntries,
  repairGeneratedStorySkeletonSections,
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
  onProgress?: (progress: StorySkeletonProgress) => void;
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

  async reconcile(
    state?: StoryEchoChatState,
  ): Promise<StoryEchoChatState | null> {
    const current = state ?? await this.memoryRepository.getOrCreate();
    if (!current || !current.storySkeleton.text.trim()) {
      return current;
    }
    assertChatOwner(current);
    const settings = this.settingsRepository.get();
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
    return current;
  }

  processNextIfNeeded(
    onProgress?: (progress: StorySkeletonProgress) => void,
  ): Promise<StorySkeletonRunResult> {
    return this.enqueue({
      force: false,
      maxChunks: 1,
      ...(onProgress ? { onProgress } : {}),
    });
  }

  processAllPending(
    onProgress?: (progress: StorySkeletonProgress) => void,
  ): Promise<StorySkeletonRunResult> {
    return this.enqueue({
      force: true,
      maxChunks: Number.MAX_SAFE_INTEGER,
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
    let updatedChunks = 0;

    try {
      while (updatedChunks < options.maxChunks) {
        assertChatOwner(state);
        const pending = pendingArchivedStageSummaryEntries(state, settings.summary.windowSize);
        if (!storySkeletonUpdateDue(state, pending, options.force)) {
          return { state, updatedChunks, pendingEntries: pending.length };
        }
        const sourceEntries = boundedSkeletonSourceEntries(pending);
        const first = sourceEntries[0];
        const last = sourceEntries.at(-1);
        if (!first || !last) {
          break;
        }

        const startedAt = performance.now();
        const priorSkeleton = state.storySkeleton;
        const sourceHash = await storySkeletonSourceHash(
          state.stageSummary.entries,
          last.sourceEndMessageId,
        );
        const raw = await completeWithConfiguredProvider(settings, {
          system: STORY_SKELETON_SYSTEM_PROMPT,
          prompt: buildStorySkeletonPrompt(
            priorSkeleton.text,
            sourceEntries,
            settings.summary.skeletonMaxTokens,
            Boolean(priorSkeleton.stale),
          ),
          maxTokens: settings.summary.skeletonMaxTokens,
        });

        const live = this.memoryRepository.getExisting();
        if (!live || live.ownerChatId !== state.ownerChatId) {
          throw new Error('全局剧情骨架生成期间聊天发生切换，已丢弃本次结果。');
        }
        const liveArchived = archivedStageSummaryEntries(live, settings.summary.windowSize);
        if (!liveArchived.some((entry) => entry.sourceEndMessageId === last.sourceEndMessageId)) {
          throw new Error('全局剧情骨架生成期间总结窗口发生变化，已丢弃本次结果。');
        }
        const liveHash = await storySkeletonSourceHash(
          live.stageSummary.entries,
          last.sourceEndMessageId,
        );
        if (liveHash !== sourceHash || live.storySkeleton.updatedAt !== priorSkeleton.updatedAt) {
          throw new Error('全局剧情骨架生成期间来源或人工编辑发生变化，已丢弃本次结果。');
        }

        const repaired = repairGeneratedStorySkeletonSections(raw);
        const text = normalizeStorySkeletonText(repaired, settings.summary.skeletonMaxTokens);
        const updatedAt = new Date().toISOString();
        state = live;
        state.storySkeleton = {
          text,
          coveredThroughMessageId: last.sourceEndMessageId,
          sourceHash,
          updatedAt,
          ...(priorSkeleton.manuallyEdited ? { manuallyEdited: true } : {}),
        };
        state.metrics.skeletonUpdates += 1;
        state.metrics.totalSkeletonMs += Math.round(performance.now() - startedAt);
        state.metrics.lastSkeletonAt = updatedAt;
        delete state.lastInspection;
        recordDebugTrace(state, settings.debug, 'summary', '全局剧情骨架已生成或增量更新。', {
          sourceRange: `${first.sourceStartMessageId}-${last.sourceEndMessageId}`,
          coveredThroughMessageId: last.sourceEndMessageId,
          sourceEntries: sourceEntries.length,
          skeletonCharacters: text.length,
          skeletonMaxTokens: settings.summary.skeletonMaxTokens,
          sectionRepaired: repaired !== raw,
        });
        await this.memoryRepository.save(state);
        updatedChunks += 1;
        const remaining = pendingArchivedStageSummaryEntries(state, settings.summary.windowSize);
        options.onProgress?.({
          sourceStartMessageId: first.sourceStartMessageId,
          sourceEndMessageId: last.sourceEndMessageId,
          pendingEntries: remaining.length,
        });
      }
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

    const pending = pendingArchivedStageSummaryEntries(state, settings.summary.windowSize);
    return { state, updatedChunks, pendingEntries: pending.length };
  }
}

export const storySkeletonService = new StorySkeletonService();
