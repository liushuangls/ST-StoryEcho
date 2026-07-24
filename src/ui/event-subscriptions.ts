export interface RemovableEventSource {
  on(event: string, handler: (...args: unknown[]) => void | Promise<void>): void;
  off?(event: string, handler: (...args: unknown[]) => void | Promise<void>): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void | Promise<void>): void;
}

/**
 * Owns listeners that outlive a settings-panel DOM subtree. Disposing the
 * scope is idempotent so disable/reload hooks can safely call it more than once.
 */
export class EventSubscriptionScope {
  private cleanups: Array<() => void> = [];
  private disposed = false;

  listen(
    target: EventTarget,
    eventName: string,
    handler: EventListenerOrEventListenerObject,
  ): void {
    if (this.disposed) {
      return;
    }
    target.addEventListener(eventName, handler);
    this.cleanups.push(() => target.removeEventListener(eventName, handler));
  }

  subscribe(
    eventSource: RemovableEventSource,
    eventName: string,
    handler: (...args: unknown[]) => void | Promise<void>,
  ): void {
    if (this.disposed) {
      return;
    }
    eventSource.on(eventName, handler);
    this.cleanups.push(() => {
      const remove = eventSource.off ?? eventSource.removeListener;
      remove?.call(eventSource, eventName, handler);
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const cleanup of this.cleanups.reverse()) {
      try {
        cleanup();
      } catch {
        // Continue removing the remaining listeners even if a third-party
        // event source rejects one removal.
      }
    }
    this.cleanups = [];
  }
}
