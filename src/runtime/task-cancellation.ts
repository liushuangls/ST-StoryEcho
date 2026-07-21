export class StoryEchoTaskCancelledError extends Error {
  constructor(reason: string) {
    super(`StoryEcho后台任务已取消：${reason}。`);
    this.name = 'StoryEchoTaskCancelledError';
  }
}

export function isStoryEchoTaskCancelledError(
  error: unknown,
): error is StoryEchoTaskCancelledError {
  return error instanceof StoryEchoTaskCancelledError;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new StoryEchoTaskCancelledError('请求已失效');
}

export function throwIfStoryEchoTaskCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}

/**
 * SillyTavern's generateRaw() does not currently accept an AbortSignal. Race
 * its result against the StoryEcho task signal so a stale internal request can
 * release the coordinator even when SillyTavern never settles the old promise
 * after a branch switch. The detached promise keeps explicit handlers, so a
 * later provider rejection cannot become an unhandled rejection.
 */
export function runStoryEchoTaskAbortable<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) {
    return operation();
  }
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });

    let pending: Promise<T>;
    try {
      pending = operation();
    } catch (error) {
      signal.removeEventListener('abort', onAbort);
      reject(error);
      return;
    }
    pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
