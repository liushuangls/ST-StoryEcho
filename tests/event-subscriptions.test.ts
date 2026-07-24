import { describe, expect, it, vi } from 'vitest';
import { EventSubscriptionScope } from '../src/ui/event-subscriptions';

describe('EventSubscriptionScope', () => {
  it('removes DOM and SillyTavern listeners exactly once', () => {
    const target = new EventTarget();
    const domHandler = vi.fn();
    const eventHandler = vi.fn();
    const eventSource = {
      on: vi.fn(),
      off: vi.fn(),
    };
    const scope = new EventSubscriptionScope();

    scope.listen(target, 'updated', domHandler);
    scope.subscribe(eventSource, 'chat-changed', eventHandler);
    target.dispatchEvent(new Event('updated'));

    expect(domHandler).toHaveBeenCalledOnce();
    expect(eventSource.on).toHaveBeenCalledWith('chat-changed', eventHandler);

    scope.dispose();
    scope.dispose();
    target.dispatchEvent(new Event('updated'));

    expect(domHandler).toHaveBeenCalledOnce();
    expect(eventSource.off).toHaveBeenCalledOnce();
    expect(eventSource.off).toHaveBeenCalledWith('chat-changed', eventHandler);
  });

  it('continues cleanup when one third-party listener removal throws', () => {
    const target = new EventTarget();
    const domHandler = vi.fn();
    const eventSource = {
      on: vi.fn(),
      removeListener: vi.fn(() => {
        throw new Error('already removed');
      }),
    };
    const scope = new EventSubscriptionScope();

    scope.listen(target, 'updated', domHandler);
    scope.subscribe(eventSource, 'chat-changed', vi.fn());
    scope.dispose();
    target.dispatchEvent(new Event('updated'));

    expect(domHandler).not.toHaveBeenCalled();
    expect(eventSource.removeListener).toHaveBeenCalledOnce();
  });
});
