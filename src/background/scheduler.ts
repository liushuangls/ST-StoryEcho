import { logger } from '../core/logger';
import type { StoryEchoSettings, TavernChatMessage } from '../core/types';
import { emitDiagnosticsUpdated } from '../debug/events';
import { getContext, getCurrentChatId } from '../platform/sillytavern';
import { selectRecentWindow } from '../prompt/window';
import {
  isBackgroundYieldForForegroundError,
  storyEchoTaskCoordinator,
} from '../runtime/task-coordinator';
import { isStoryEchoTaskCancelledError } from '../runtime/task-cancellation';
import { SettingsRepository } from '../settings/repository';
import { StoryStateRepository } from '../state/repository';
import { stageSummaryService } from '../summary/service';
import { storySkeletonService } from '../summary/skeleton-service';
import {
  pendingArchivedStageSummaryEntries,
  storySkeletonUpdateDue,
} from '../summary/skeleton-state';

const BACKGROUND_DELAY_MS = 3_000;

export interface BackgroundProcessingRegistrationOptions {
  silent?: boolean;
}

/**
 * Background work only covers history that the configured minimum raw window
 * is already allowed to remove.
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
  private stopped = false;
  private rerunRequested = false;
  private requestedChatId: string | null = null;
  private historyRequiresReconcile = true;
  private registeredEvents: Array<{
    eventName: string;
    eventSource: NonNullable<ReturnType<typeof getContext>['eventSource']>;
    handler: (...args: unknown[]) => void;
  }> = [];
  private readonly settingsRepository = new SettingsRepository();
  private readonly stateRepository = new StoryStateRepository();

  register(options: BackgroundProcessingRegistrationOptions = {}): boolean {
    if (this.registeredEvents.length > 0) {
      return true;
    }
    let context: ReturnType<typeof getContext>;
    try {
      context = getContext();
    } catch (error) {
      if (!options.silent) {
        logger.warn('SillyTavern上下文尚未就绪，暂未注册后台剧情整理。', error);
      }
      return false;
    }
    const eventSource = context.eventSource;
    const eventTypes = {
      ...(context.event_types ?? {}),
      ...(context.eventTypes ?? {}),
    };
    const replyEventName = eventTypes['MESSAGE_RECEIVED'];
    if (!eventSource || !replyEventName) {
      if (!options.silent) {
        logger.warn('当前SillyTavern未提供回复完成事件；自动整理无法调度，请使用“处理窗口外历史”。');
      }
      return false;
    }

    const replyHandler = (): void => {
      storyEchoTaskCoordinator.releaseForegroundLease('assistant-message-received');
      this.schedule();
    };
    eventSource.on(replyEventName, replyHandler);
    this.registeredEvents.push({
      eventName: replyEventName,
      eventSource,
      handler: replyHandler,
    });
    const registeredNames = new Set([replyEventName]);
    const mutationEvents = [
      'CHAT_CHANGED',
      'MESSAGE_DELETED',
      'MESSAGE_EDITED',
      'MESSAGE_UPDATED',
      'MESSAGE_SWIPED',
      'MESSAGE_SWIPE_DELETED',
    ];
    const branchEvents = new Set(['CHAT_CHANGED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED']);
    for (const eventKey of mutationEvents) {
      const eventName = eventTypes[eventKey];
      if (!eventName || registeredNames.has(eventName)) {
        continue;
      }
      const handler = (): void => {
        this.historyRequiresReconcile = true;
        storyEchoTaskCoordinator.cancelRunningBackground(`聊天历史事件：${eventKey}`);
        if (branchEvents.has(eventKey)) {
          storyEchoTaskCoordinator.releaseForegroundLease(
            eventKey === 'CHAT_CHANGED' ? 'chat-changed' : 'message-swiped',
          );
        }
        this.schedule();
      };
      eventSource.on(eventName, handler);
      this.registeredEvents.push({ eventName, eventSource, handler });
      registeredNames.add(eventName);
    }

    const renamedEventName = eventTypes['CHAT_RENAMED'];
    if (renamedEventName && !registeredNames.has(renamedEventName)) {
      const handler = async (value: unknown): Promise<void> => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          return;
        }
        const event = value as Record<string, unknown>;
        const oldOwnerChatId = event['oldFileName'];
        const newOwnerChatId = event['newFileName'];
        if (
          typeof oldOwnerChatId !== 'string' ||
          typeof newOwnerChatId !== 'string' ||
          !oldOwnerChatId ||
          !newOwnerChatId
        ) {
          return;
        }
        try {
          await this.stateRepository.adoptRenamedChat(oldOwnerChatId, newOwnerChatId);
        } catch (error) {
          logger.warn(`聊天重命名后迁移StoryEcho状态失败：${oldOwnerChatId} → ${newOwnerChatId}`, error);
        }
      };
      eventSource.on(renamedEventName, handler);
      this.registeredEvents.push({
        eventName: renamedEventName,
        eventSource,
        handler,
      });
      registeredNames.add(renamedEventName);
    }

    for (const eventKey of ['GENERATION_STOPPED', 'GENERATION_ABORTED']) {
      const eventName = eventTypes[eventKey];
      if (!eventName || registeredNames.has(eventName)) {
        continue;
      }
      const handler = (): void => {
        storyEchoTaskCoordinator.releaseForegroundLease('generation-stopped');
      };
      eventSource.on(eventName, handler);
      this.registeredEvents.push({ eventName, eventSource, handler });
      registeredNames.add(eventName);
    }

    logger.info('已启用回复后的后台历史总结。');
    this.stopped = false;
    this.schedule();
    return true;
  }

  unregister(): void {
    this.stopped = true;
    this.rerunRequested = false;
    storyEchoTaskCoordinator.cancelRunningBackground('StoryEcho扩展已停用');
    storyEchoTaskCoordinator.releaseForegroundLease('extension-disabled');
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
    this.requestedChatId = null;
  }

  schedule(): void {
    if (this.stopped) {
      return;
    }
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runNow();
    }, BACKGROUND_DELAY_MS);
  }

  runNow(): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    this.requestedChatId = getCurrentChatId(getContext());
    this.rerunRequested = true;
    if (!this.operation) {
      this.operation = storyEchoTaskCoordinator.enqueueBackground(
        '回复后整理历史',
        () => this.drain(),
      ).finally(() => {
        this.operation = undefined;
        if (this.rerunRequested && !this.stopped) {
          void this.runNow();
        }
      });
    }
    return this.operation;
  }

  private async drain(): Promise<void> {
    while (this.rerunRequested && !this.stopped) {
      this.rerunRequested = false;
      const requestedChatId = this.requestedChatId;
      try {
        if (!requestedChatId || getCurrentChatId(getContext()) !== requestedChatId) {
          logger.debug('后台历史整理排队期间聊天已切换，已丢弃过期任务。');
          continue;
        }
        await this.processCurrentChat();
      } catch (error) {
        if (isStoryEchoTaskCancelledError(error)) {
          this.rerunRequested = !this.stopped;
          if (!this.stopped) {
            logger.info('失效的后台历史整理已取消，将在当前角色回复结束后重试。');
          }
          return;
        }
        if (isBackgroundYieldForForegroundError(error)) {
          this.rerunRequested = true;
          logger.info('后台历史整理已在LLM重试边界让行，稍后从未提交分块重试。');
          return;
        }
        logger.warn('回复后的后台历史整理失败，将在下次回复后重试。', error);
      }
    }
  }

  private async processCurrentChat(): Promise<void> {
    const settings = this.settingsRepository.get();
    if (!settings.enabled) {
      return;
    }
    let state = await this.stateRepository.getOrCreate();
    if (!state) {
      return;
    }
    if (this.historyRequiresReconcile) {
      state = await stageSummaryService.reconcileHistory(state) ?? state;
      this.historyRequiresReconcile = false;
    }
    const targetEndMessageId = backgroundTargetMessageId(getContext().chat, settings);
    if (
      targetEndMessageId >= 0 &&
      state.stageSummary.coveredThroughMessageId < targetEndMessageId
    ) {
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
