import { describe, expect, it, vi } from 'vitest';
import { StoryEchoTaskCoordinator } from '../src/runtime/task-coordinator';
import { StoryEchoTaskCancelledError } from '../src/runtime/task-cancellation';

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function flushQueue(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('StoryEchoTaskCoordinator', () => {
  it('cancels an active background task when foreground generation arrives', async () => {
    const coordinator = new StoryEchoTaskCoordinator(60_000);
    const started = deferred();
    const order: string[] = [];
    const background = coordinator.enqueueBackground('background', async (signal) => {
      order.push('background');
      started.resolve(undefined);
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const backgroundOutcome = background.then(
      () => null,
      (error: unknown) => error,
    );
    await started.promise;

    const foreground = coordinator.enqueueForeground(
      'foreground',
      async () => {
        order.push('foreground');
        return false;
      },
      { holdForegroundLease: (prepared) => prepared },
    );

    expect(await backgroundOutcome).toBeInstanceOf(StoryEchoTaskCancelledError);
    await foreground;
    expect(order).toEqual(['background', 'foreground']);
    expect(coordinator.snapshot()).toMatchObject({
      runningKind: null,
      queuedForeground: 0,
      foregroundLeaseActive: false,
    });
  });

  it('waits for a non-cooperative background operation, then runs foreground and holds later work', async () => {
    const coordinator = new StoryEchoTaskCoordinator(60_000);
    const backgroundGate = deferred();
    const order: string[] = [];
    const firstBackground = coordinator.enqueueBackground('background-1', async () => {
      order.push('background-1');
      await backgroundGate.promise;
    });
    await flushQueue();

    const secondBackground = coordinator.enqueueBackground('background-2', async () => {
      order.push('background-2');
    });
    const manual = coordinator.enqueueManual('manual', async () => {
      order.push('manual');
    });
    const foreground = coordinator.enqueueForeground('foreground', async () => {
      order.push('foreground');
      return true;
    });
    await flushQueue();
    expect(order).toEqual(['background-1']);
    expect(coordinator.snapshot()).toMatchObject({
      runningKind: 'background',
      queuedForeground: 1,
      queuedManual: 1,
      queuedBackground: 1,
    });

    backgroundGate.resolve(undefined);
    await firstBackground;
    await foreground;
    await flushQueue();
    expect(order).toEqual(['background-1', 'foreground']);
    expect(coordinator.snapshot().foregroundLeaseActive).toBe(true);

    coordinator.releaseForegroundLease('test-reply');
    await Promise.all([manual, secondBackground]);
    expect(order).toEqual(['background-1', 'foreground', 'manual', 'background-2']);
  });

  it('does not acquire a lease for an obsolete foreground task', async () => {
    const coordinator = new StoryEchoTaskCoordinator(60_000);
    await coordinator.enqueueForeground(
      'obsolete',
      async () => false,
      { holdForegroundLease: (prepared) => prepared },
    );

    expect(coordinator.snapshot().foregroundLeaseActive).toBe(false);
  });

  it('releases a stale reply lease when a new foreground generation arrives', async () => {
    const coordinator = new StoryEchoTaskCoordinator(60_000);
    const order: string[] = [];

    await coordinator.enqueueForeground('first', async () => {
      order.push('first');
      return true;
    });
    expect(coordinator.snapshot().foregroundLeaseActive).toBe(true);

    await coordinator.enqueueForeground(
      'retry',
      async () => {
        order.push('retry');
        return false;
      },
      { holdForegroundLease: (prepared) => prepared },
    );

    expect(order).toEqual(['first', 'retry']);
    expect(coordinator.snapshot()).toMatchObject({
      runningKind: null,
      queuedForeground: 0,
      foregroundLeaseActive: false,
    });
  });

  it('does not let an older foreground task reacquire the lease after a retry is queued', async () => {
    const coordinator = new StoryEchoTaskCoordinator(60_000);
    const firstStarted = deferred();
    const firstGate = deferred();
    const order: string[] = [];

    const first = coordinator.enqueueForeground('first', async () => {
      order.push('first');
      firstStarted.resolve(undefined);
      await firstGate.promise;
      return true;
    });
    await firstStarted.promise;

    const retry = coordinator.enqueueForeground('retry', async () => {
      order.push('retry');
      return true;
    });
    firstGate.resolve(undefined);

    await Promise.all([first, retry]);
    expect(order).toEqual(['first', 'retry']);
    expect(coordinator.snapshot()).toMatchObject({
      runningKind: null,
      queuedForeground: 0,
      foregroundLeaseActive: true,
    });
    coordinator.releaseForegroundLease('test-cleanup');
  });

  it('continues draining after a task rejects', async () => {
    const coordinator = new StoryEchoTaskCoordinator(60_000);
    const failure = coordinator.enqueueManual('failure', async () => {
      throw new Error('boom');
    });
    const next = vi.fn(async () => undefined);
    const success = coordinator.enqueueBackground('success', next);

    await expect(failure).rejects.toThrow('boom');
    await success;
    expect(next).toHaveBeenCalledOnce();
  });
});
