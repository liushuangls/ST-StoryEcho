import { logger } from '../core/logger';
import { emitDiagnosticsUpdated } from '../debug/events';

export type StoryEchoTaskKind = 'foreground' | 'manual' | 'background';

export interface StoryEchoTaskSnapshot {
  runningKind: StoryEchoTaskKind | null;
  runningName: string;
  queuedForeground: number;
  queuedManual: number;
  queuedBackground: number;
  foregroundLeaseActive: boolean;
  foregroundLeaseAgeMs: number;
  lastQueueWaitMs: number;
  maximumQueueWaitMs: number;
}

interface EnqueueOptions<T> {
  holdForegroundLease?: (result: T) => boolean;
}

interface QueuedTask<T> {
  id: number;
  kind: StoryEchoTaskKind;
  name: string;
  enqueuedAt: number;
  operation: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  holdForegroundLease?: (result: T) => boolean;
}

const DEFAULT_FOREGROUND_LEASE_TIMEOUT_MS = 10 * 60 * 1_000;

/**
 * Serializes all StoryEcho work that can call an LLM or mutate chat memory.
 * A foreground prompt-preparation task keeps a lease after the interceptor
 * returns so queued background work cannot start during the actual role-play
 * generation that follows.
 */
export class StoryEchoTaskCoordinator {
  private readonly queues: Record<StoryEchoTaskKind, Array<QueuedTask<unknown>>> = {
    foreground: [],
    manual: [],
    background: [],
  };
  private nextTaskId = 1;
  private running: Pick<QueuedTask<unknown>, 'id' | 'kind' | 'name' | 'enqueuedAt'> | undefined;
  private foregroundLease:
    | {
        taskId: number;
        acquiredAt: number;
        timeout: ReturnType<typeof setTimeout>;
      }
    | undefined;
  private pumpScheduled = false;
  private lastQueueWaitMs = 0;
  private maximumQueueWaitMs = 0;

  constructor(
    private readonly foregroundLeaseTimeoutMs = DEFAULT_FOREGROUND_LEASE_TIMEOUT_MS,
  ) {}

  enqueueForeground<T>(
    name: string,
    operation: () => Promise<T>,
    options: EnqueueOptions<T> = {},
  ): Promise<T> {
    return this.enqueue('foreground', name, operation, options);
  }

  enqueueManual<T>(name: string, operation: () => Promise<T>): Promise<T> {
    return this.enqueue('manual', name, operation);
  }

  enqueueBackground<T>(name: string, operation: () => Promise<T>): Promise<T> {
    return this.enqueue('background', name, operation);
  }

  releaseForegroundLease(reason: string): boolean {
    const lease = this.foregroundLease;
    if (!lease) {
      return false;
    }
    clearTimeout(lease.timeout);
    this.foregroundLease = undefined;
    logger.debug(`前台生成租约已释放：${reason}。`);
    emitDiagnosticsUpdated();
    this.schedulePump();
    return true;
  }

  snapshot(): StoryEchoTaskSnapshot {
    return {
      runningKind: this.running?.kind ?? null,
      runningName: this.running?.name ?? '',
      queuedForeground: this.queues.foreground.length,
      queuedManual: this.queues.manual.length,
      queuedBackground: this.queues.background.length,
      foregroundLeaseActive: Boolean(this.foregroundLease),
      foregroundLeaseAgeMs: this.foregroundLease
        ? Math.max(0, Date.now() - this.foregroundLease.acquiredAt)
        : 0,
      lastQueueWaitMs: this.lastQueueWaitMs,
      maximumQueueWaitMs: this.maximumQueueWaitMs,
    };
  }

  /** Test-only cleanup for the singleton between isolated Vitest cases. */
  resetForTests(): void {
    if (this.foregroundLease) {
      clearTimeout(this.foregroundLease.timeout);
      this.foregroundLease = undefined;
    }
    for (const queue of Object.values(this.queues)) {
      queue.splice(0, queue.length);
    }
    this.running = undefined;
    this.pumpScheduled = false;
    this.lastQueueWaitMs = 0;
    this.maximumQueueWaitMs = 0;
  }

  private enqueue<T>(
    kind: StoryEchoTaskKind,
    name: string,
    operation: () => Promise<T>,
    options: EnqueueOptions<T> = {},
  ): Promise<T> {
    const promise = new Promise<T>((resolve, reject) => {
      const task: QueuedTask<T> = {
        id: this.nextTaskId,
        kind,
        name,
        enqueuedAt: Date.now(),
        operation,
        resolve,
        reject,
      };
      if (options.holdForegroundLease) {
        task.holdForegroundLease = options.holdForegroundLease;
      }
      this.nextTaskId += 1;
      this.queues[kind].push(task as QueuedTask<unknown>);
    });
    emitDiagnosticsUpdated();
    this.schedulePump();
    return promise;
  }

  private schedulePump(): void {
    if (this.pumpScheduled) {
      return;
    }
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      void this.runNext();
    });
  }

  private takeNext(): QueuedTask<unknown> | undefined {
    return this.queues.foreground.shift()
      ?? this.queues.manual.shift()
      ?? this.queues.background.shift();
  }

  private async runNext(): Promise<void> {
    if (this.running || this.foregroundLease) {
      return;
    }
    const task = this.takeNext();
    if (!task) {
      return;
    }
    const waitMs = Math.max(0, Date.now() - task.enqueuedAt);
    this.lastQueueWaitMs = waitMs;
    this.maximumQueueWaitMs = Math.max(this.maximumQueueWaitMs, waitMs);
    this.running = {
      id: task.id,
      kind: task.kind,
      name: task.name,
      enqueuedAt: task.enqueuedAt,
    };
    emitDiagnosticsUpdated();

    try {
      const result = await task.operation();
      const shouldHoldLease = task.kind === 'foreground'
        && (task.holdForegroundLease?.(result) ?? true);
      if (shouldHoldLease) {
        this.acquireForegroundLease(task.id);
      }
      task.resolve(result);
    } catch (error) {
      task.reject(error);
    } finally {
      this.running = undefined;
      emitDiagnosticsUpdated();
      this.schedulePump();
    }
  }

  private acquireForegroundLease(taskId: number): void {
    if (this.foregroundLease) {
      clearTimeout(this.foregroundLease.timeout);
    }
    const acquiredAt = Date.now();
    const timeout = setTimeout(() => {
      if (this.foregroundLease?.taskId !== taskId) {
        return;
      }
      logger.warn('等待角色回复完成超时，已释放StoryEcho前台生成租约。');
      this.releaseForegroundLease('watchdog-timeout');
    }, this.foregroundLeaseTimeoutMs);
    this.foregroundLease = { taskId, acquiredAt, timeout };
    logger.debug('前台上下文准备完成，等待角色回复结束。');
  }
}

export const storyEchoTaskCoordinator = new StoryEchoTaskCoordinator();
