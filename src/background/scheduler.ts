import { logger } from '../core/logger';
import type { StoryEchoSettings, TavernChatMessage } from '../core/types';
import { emitDiagnosticsUpdated } from '../debug/events';
import { extractionService } from '../extraction/service';
import { isInternalGeneration } from '../llm/internal-generation';
import { MemoryRepository } from '../memory/repository';
import { getContext } from '../platform/sillytavern';
import { selectRecentWindow } from '../prompt/window';
import { SettingsRepository } from '../settings/repository';
import { stageSummaryService } from '../summary/service';

const BACKGROUND_DELAY_MS = 750;

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
  private historyRequiresReconcile = true;
  private historyRevision = 0;
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
    const eventName = context.event_types?.['MESSAGE_RECEIVED'];
    if (!eventSource || !eventName) {
      logger.warn('当前SillyTavern未提供回复完成事件，自动抽取仍会在生成前安全补齐。');
      return;
    }

    const handler = (): void => {
      if (isInternalGeneration()) {
        return;
      }
      this.schedule();
    };
    eventSource.on(eventName, handler);
    this.registeredEvents.push({ eventName, eventSource, handler });
    const markHistoryDirty = (): void => {
      this.historyRequiresReconcile = true;
      this.verifiedPrefix = undefined;
      this.historyRevision += 1;
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
      const mutationEventName = context.event_types?.[eventKey];
      if (!mutationEventName || registeredNames.has(mutationEventName)) {
        continue;
      }
      eventSource.on(mutationEventName, markHistoryDirty);
      this.registeredEvents.push({
        eventName: mutationEventName,
        eventSource,
        handler: markHistoryDirty,
      });
      registeredNames.add(mutationEventName);
    }
    logger.info('已启用回复后的后台剧情整理。');
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
    this.historyRevision += 1;
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
    this.rerunRequested = true;
    if (!this.operation) {
      this.operation = this.drain().finally(() => {
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
      try {
        await this.processCurrentChat();
      } catch (error) {
        // Extraction and summary services already record bounded diagnostics.
        // The event handler must never create an unhandled rejection or affect
        // the assistant reply the user has just received.
        logger.warn('回复后的后台剧情整理失败，将在下次回复后重试。', error);
      }
    }
  }

  private async processCurrentChat(): Promise<void> {
    const settings = this.settingsRepository.get();
    if (
      !settings.enabled ||
      isInternalGeneration() ||
      (!settings.extraction.automatic && !(settings.summary.enabled && settings.summary.automatic))
    ) {
      return;
    }

    const targetEndMessageId = backgroundTargetMessageId(getContext().chat, settings);
    if (targetEndMessageId < 0) {
      return;
    }

    let state = await this.memoryRepository.getOrCreate();
    if (!state) {
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

    if (settings.extraction.automatic && state.indexedThroughMessageId < targetEndMessageId) {
      const extractionRevision = this.historyRevision;
      state = await extractionService.processNextThroughVerifiedHistory(targetEndMessageId) ?? state;
      if (this.historyRevision !== extractionRevision) {
        // A delete/edit/swipe may occur while the extraction LLM is running.
        // Force the next reconciliation to compare unequal even if the
        // extraction just wrote a fresh hash for the already-mutated prefix.
        this.historyRequiresReconcile = true;
        this.verifiedPrefix = undefined;
        if (state.indexedThroughMessageId >= 0) {
          state.indexedPrefixHash = `dirty:${this.historyRevision}`;
          state = await extractionService.reconcileHistory(state) ?? state;
          this.historyRequiresReconcile = false;
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
    if (
      settings.summary.enabled &&
      settings.summary.automatic &&
      state.stageSummary.coveredThroughMessageId < targetEndMessageId
    ) {
      await stageSummaryService.processNextThrough(targetEndMessageId);
    }
    emitDiagnosticsUpdated();
  }
}

export const backgroundProcessingScheduler = new BackgroundProcessingScheduler();
