import { logger } from '../core/logger';
import type { StoryEchoSettings, TavernChatMessage } from '../core/types';
import { emitDiagnosticsUpdated } from '../debug/events';
import { recordDebugTrace } from '../debug/metrics';
import { extractionService } from '../extraction/service';
import { recordExtractionCooldownSkip } from '../llm/structured-diagnostics';
import { MemoryRepository } from '../memory/repository';
import { getContext, getCurrentChatId } from '../platform/sillytavern';
import { selectRecentWindow } from '../prompt/window';
import {
  isBackgroundYieldForForegroundError,
  storyEchoTaskCoordinator,
} from '../runtime/task-coordinator';
import { isStoryEchoTaskCancelledError } from '../runtime/task-cancellation';
import { SettingsRepository } from '../settings/repository';
import { stageSummaryService } from '../summary/service';
import { storySkeletonService } from '../summary/skeleton-service';
import {
  pendingArchivedStageSummaryEntries,
  storySkeletonUpdateDue,
} from '../summary/skeleton-state';

const BACKGROUND_DELAY_MS = 3_000;
const EXTRACTION_BACKOFF_BASE_MS = 30_000;
const EXTRACTION_BACKOFF_MAX_MS = 15 * 60_000;

export interface BackgroundProcessingSnapshot {
  extractionCooldownActive: boolean;
  extractionCooldownRemainingMs: number;
  extractionCooldownFailures: number;
}

/**
 * Background work only covers history that the configured minimum raw window
 * is already allowed to remove. This avoids summarizing and reinjecting the
 * same recent dialogue while still preparing the next generation in advance.
 */
export function backgroundTargetMessageId(
  messages: TavernChatMessage[],
  settings: Pick<StoryEchoSettings, 'recentWindow'>,
): number {
  let lastNonSystem: TavernChatMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (!messages[index]?.is_system) {
      lastNonSystem = messages[index];
      break;
    }
  }
  if (!lastNonSystem || lastNonSystem.is_user) {
    return -1;
  }
  // During generation the latest User is intentionally outside W. After the
  // reply has completed, that User+Assistant pair is a historical turn and
  // must count toward W. A synthetic next User lets the exact same window
  // selector express that transition without maintaining a second algorithm.
  const afterCompletedReply = [
    ...messages,
    { is_user: true, is_system: false, mes: '' } satisfies TavernChatMessage,
  ];
  const window = selectRecentWindow(
    afterCompletedReply,
    settings.recentWindow.size,
    settings.recentWindow.unit,
  );
  if (!window || window.removableIndices.length === 0) {
    return -1;
  }
  return window.retainedStartIndex - 1;
}

export class BackgroundProcessingScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private operation: Promise<void> | undefined;
  private rerunRequested = false;
  private requestedChatId: string | null = null;
  private historyRequiresReconcile = true;
  private historyRevision = 0;
  private extractionCooldown:
    | {
        ownerChatId: string;
        startMessageId: number;
        failures: number;
        nextRetryAt: number;
      }
    | undefined;
  private verifiedPrefix:
    | {
        ownerChatId: string;
        indexedThroughMessageId: number;
        indexedPrefixHash: string;
      }
    | undefined;
  private registeredEvents: Array<{
    eventName: string;
    eventSource: NonNullable<ReturnType<typeof getContext>['eventSource']>;
    handler: (...args: unknown[]) => void;
  }> = [];
  private readonly settingsRepository = new SettingsRepository();
  private readonly memoryRepository = new MemoryRepository();

  register(): void {
    if (this.registeredEvents.length > 0) {
      return;
    }

    let context: ReturnType<typeof getContext>;
    try {
      context = getContext();
    } catch (error) {
      logger.warn('SillyTavern上下文尚未就绪，暂未注册后台剧情整理。', error);
      return;
    }
    const eventSource = context.eventSource;
    // MESSAGE_RECEIVED is emitted after the assistant reply has entered the
    // chat. Unlike the broader generation events it is not normally emitted
    // by generateRaw(), so internal extraction calls cannot recursively queue
    // more extraction work.
    const eventTypes = {
      ...(context.event_types ?? {}),
      ...(context.eventTypes ?? {}),
    };
    const eventName = eventTypes?.['MESSAGE_RECEIVED'];
    if (!eventSource || !eventName) {
      logger.warn('当前SillyTavern未提供回复完成事件；自动整理无法调度，请使用“处理窗口外历史”。');
      return;
    }

    const handler = (): void => {
      storyEchoTaskCoordinator.releaseForegroundLease('assistant-message-received');
      this.schedule();
    };
    eventSource.on(eventName, handler);
    this.registeredEvents.push({ eventName, eventSource, handler });
    const markHistoryDirty = (reason: string): void => {
      this.historyRequiresReconcile = true;
      this.verifiedPrefix = undefined;
      this.extractionCooldown = undefined;
      this.historyRevision += 1;
      storyEchoTaskCoordinator.cancelRunningBackground(reason);
    };
    const mutationEvents = [
      'CHAT_CHANGED',
      'MESSAGE_DELETED',
      'MESSAGE_EDITED',
      'MESSAGE_UPDATED',
      'MESSAGE_SWIPED',
    ];
    const registeredNames = new Set([eventName]);
    for (const eventKey of mutationEvents) {
      const mutationEventName = eventTypes?.[eventKey];
      if (!mutationEventName || registeredNames.has(mutationEventName)) {
        continue;
      }
      const mutationHandler = eventKey === 'CHAT_CHANGED'
        ? (): void => {
            markHistoryDirty('聊天分支已经切换');
            storyEchoTaskCoordinator.releaseForegroundLease('chat-changed');
            this.schedule();
          }
        : (): void => markHistoryDirty(`聊天历史事件：${eventKey}`);
      eventSource.on(mutationEventName, mutationHandler);
      this.registeredEvents.push({
        eventName: mutationEventName,
        eventSource,
        handler: mutationHandler,
      });
      registeredNames.add(mutationEventName);
    }
    const releaseEvents = ['GENERATION_STOPPED', 'GENERATION_ABORTED'];
    const releaseForeground = (): void => {
      storyEchoTaskCoordinator.releaseForegroundLease('generation-stopped');
    };
    for (const eventKey of releaseEvents) {
      const releaseEventName = eventTypes?.[eventKey];
      if (!releaseEventName || registeredNames.has(releaseEventName)) {
        continue;
      }
      eventSource.on(releaseEventName, releaseForeground);
      this.registeredEvents.push({
        eventName: releaseEventName,
        eventSource,
        handler: releaseForeground,
      });
      registeredNames.add(releaseEventName);
    }
    logger.info('已启用回复后的后台剧情整理。');
    // Bootstrap an already-open long chat after the same quiet period used for
    // reply-complete work. This creates the first skeleton without requiring a
    // new role-play turn.
    this.schedule();
  }

  unregister(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const registered of this.registeredEvents) {
      const remove = registered.eventSource.off ?? registered.eventSource.removeListener;
      remove?.call(registered.eventSource, registered.eventName, registered.handler);
    }
    this.registeredEvents = [];
    this.historyRequiresReconcile = true;
    this.verifiedPrefix = undefined;
    this.extractionCooldown = undefined;
    this.requestedChatId = null;
    this.historyRevision += 1;
  }

  snapshot(now = Date.now()): BackgroundProcessingSnapshot {
    const remaining = this.extractionCooldown
      ? Math.max(0, this.extractionCooldown.nextRetryAt - now)
      : 0;
    return {
      extractionCooldownActive: remaining > 0,
      extractionCooldownRemainingMs: remaining,
      extractionCooldownFailures: this.extractionCooldown?.failures ?? 0,
    };
  }

  schedule(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runNow();
    }, BACKGROUND_DELAY_MS);
  }

  runNow(): Promise<void> {
    this.requestedChatId = getCurrentChatId(getContext());
    this.rerunRequested = true;
    if (!this.operation) {
      this.operation = storyEchoTaskCoordinator.enqueueBackground(
        '回复后整理历史',
        () => this.drain(),
      ).finally(() => {
        this.operation = undefined;
        if (this.rerunRequested) {
          void this.runNow();
        }
      });
    }
    return this.operation;
  }

  private async drain(): Promise<void> {
    while (this.rerunRequested) {
      this.rerunRequested = false;
      const requestedChatId = this.requestedChatId;
      try {
        if (!requestedChatId || getCurrentChatId(getContext()) !== requestedChatId) {
          logger.debug('后台剧情整理排队期间聊天已切换，已丢弃过期任务。');
          continue;
        }
        await this.processCurrentChat();
      } catch (error) {
        if (isStoryEchoTaskCancelledError(error)) {
          this.rerunRequested = true;
          logger.info('失效的后台剧情整理已取消，将在当前角色回复结束后重试。');
          return;
        }
        if (isBackgroundYieldForForegroundError(error)) {
          // End this coordinator task so the already-queued foreground task
          // can run. The same uncommitted history block is requeued after the
          // real reply lease is released; no cursor has advanced.
          this.rerunRequested = true;
          logger.info('后台剧情整理已在LLM重试边界让行，稍后从未提交分块重试。');
          return;
        }
        // Extraction and summary services already record bounded diagnostics.
        // The event handler must never create an unhandled rejection or affect
        // the assistant reply the user has just received.
        logger.warn('回复后的后台剧情整理失败，将在下次回复后重试。', error);
      }
    }
  }

  private async processCurrentChat(): Promise<void> {
    const settings = this.settingsRepository.get();
    if (!settings.enabled) {
      return;
    }

    let state = await this.memoryRepository.getOrCreate();
    if (!state) {
      return;
    }
    const targetEndMessageId = backgroundTargetMessageId(getContext().chat, settings);
    if (!settings.memory.enabled) {
      this.extractionCooldown = undefined;
      this.verifiedPrefix = undefined;
      if (this.historyRequiresReconcile) {
        state = await stageSummaryService.reconcileHistory(state) ?? state;
        this.historyRequiresReconcile = false;
      }
      if (targetEndMessageId >= 0 && state.stageSummary.coveredThroughMessageId < targetEndMessageId) {
        state = (await stageSummaryService.processNextThrough(targetEndMessageId)).state ?? state;
      }
      state = await storySkeletonService.reconcile(state) ?? state;
      const skeletonResult = await storySkeletonService.processNextIfNeeded();
      state = skeletonResult.state ?? state;
      const remaining = pendingArchivedStageSummaryEntries(state, settings.summary.windowSize);
      if (storySkeletonUpdateDue(state, remaining)) {
        this.schedule();
      }
      emitDiagnosticsUpdated();
      return;
    }
    if (
      !this.verifiedPrefix ||
      this.verifiedPrefix.ownerChatId !== state.ownerChatId ||
      this.verifiedPrefix.indexedThroughMessageId !== state.indexedThroughMessageId ||
      this.verifiedPrefix.indexedPrefixHash !== state.indexedPrefixHash
    ) {
      this.historyRequiresReconcile = true;
    }
    if (this.historyRequiresReconcile) {
      state = await extractionService.reconcileHistory(state);
      if (!state) {
        return;
      }
      this.historyRequiresReconcile = false;
      this.verifiedPrefix = {
        ownerChatId: state.ownerChatId,
        indexedThroughMessageId: state.indexedThroughMessageId,
        indexedPrefixHash: state.indexedPrefixHash,
      };
    }

    if (targetEndMessageId >= 0 && state.indexedThroughMessageId < targetEndMessageId) {
      const extractionRevision = this.historyRevision;
      const extractionStart = state.indexedThroughMessageId + 1;
      const cooldown = this.extractionCooldown;
      const sameFailedBlock = cooldown?.ownerChatId === state.ownerChatId
        && cooldown.startMessageId === extractionStart;
      if (sameFailedBlock && cooldown.nextRetryAt > Date.now()) {
        recordExtractionCooldownSkip();
        logger.debug(`自动抽取处于退避期，${cooldown.nextRetryAt - Date.now()}ms后可重试。`);
      } else {
        try {
          state = await extractionService.processNextThroughVerifiedHistory(targetEndMessageId) ?? state;
          this.extractionCooldown = undefined;
        } catch (error) {
          if (isStoryEchoTaskCancelledError(error)) {
            throw error;
          }
          if (isBackgroundYieldForForegroundError(error)) {
            throw error;
          }
          if (this.historyRevision === extractionRevision) {
            const failures = sameFailedBlock ? cooldown.failures + 1 : 1;
            const delayMs = Math.min(
              EXTRACTION_BACKOFF_MAX_MS,
              EXTRACTION_BACKOFF_BASE_MS * (2 ** Math.min(5, failures - 1)),
            );
            this.extractionCooldown = {
              ownerChatId: state.ownerChatId,
              startMessageId: extractionStart,
              failures,
              nextRetryAt: Date.now() + delayMs,
            };
            logger.warn(`自动抽取失败，已退避 ${delayMs}ms；手动处理不受影响。`, error);
          }
        }
        if (this.historyRevision !== extractionRevision) {
          // A delete/edit/swipe may occur while the extraction LLM is running.
          // Force the next reconciliation to compare unequal even if the
          // extraction just wrote a fresh hash for the already-mutated prefix.
          this.historyRequiresReconcile = true;
          this.verifiedPrefix = undefined;
          this.extractionCooldown = undefined;
          if (state.indexedThroughMessageId >= 0) {
            state.indexedPrefixHash = `dirty:${this.historyRevision}`;
            state = await extractionService.reconcileHistory(state) ?? state;
            this.historyRequiresReconcile = false;
          }
        }
      }
      if (!this.historyRequiresReconcile) {
        this.verifiedPrefix = {
          ownerChatId: state.ownerChatId,
          indexedThroughMessageId: state.indexedThroughMessageId,
          indexedPrefixHash: state.indexedPrefixHash,
        };
      }
    }
    if (state.pendingVectorHashes.length > 0 || state.pendingVectorDeleteHashes.length > 0) {
      try {
        state = await extractionService.syncPendingVectors(state) ?? state;
      } catch (error) {
        state.metrics.vectorSyncFailures += 1;
        recordDebugTrace(state, settings.debug, 'vector', '后台同步待处理向量失败，将在后续回复重试。', {
          error: error instanceof Error ? error.message : String(error),
        });
        await this.memoryRepository.save(state);
        logger.warn('后台同步待处理向量失败，将在后续回复重试。', error);
      }
    }
    if (targetEndMessageId >= 0 && state.stageSummary.coveredThroughMessageId < targetEndMessageId) {
      state = (await stageSummaryService.processNextThrough(targetEndMessageId)).state ?? state;
    }
    state = await storySkeletonService.reconcile(state) ?? state;
    const skeletonResult = await storySkeletonService.processNextIfNeeded();
    state = skeletonResult.state ?? state;
    const remaining = pendingArchivedStageSummaryEntries(state, settings.summary.windowSize);
    if (storySkeletonUpdateDue(state, remaining)) {
      this.schedule();
    }
    emitDiagnosticsUpdated();
  }
}

export const backgroundProcessingScheduler = new BackgroundProcessingScheduler();
