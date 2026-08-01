import { afterEach, describe, expect, it, vi } from 'vitest';
import { isElementRendered, observeElementVisibility } from '../src/ui/visibility';

interface FakeElementOptions {
  connected?: boolean;
  display?: string;
  parent?: HTMLElement | null;
  rectangles?: number;
}

function fakeElement(options: FakeElementOptions = {}): HTMLElement {
  const element = {
    isConnected: options.connected ?? true,
    hidden: false,
    parentElement: options.parent ?? null,
    offsetParent: options.rectangles === 0 ? null : {},
    getAttribute: () => null,
    getClientRects: () => Array.from(
      { length: options.rectangles ?? 1 },
      () => ({ width: 100, height: 100 }),
    ),
  } as unknown as HTMLElement;
  Object.defineProperty(element, 'ownerDocument', {
    value: {
      defaultView: {
        getComputedStyle: (target: HTMLElement) => ({
          display: target === element ? options.display ?? 'block' : 'block',
          visibility: 'visible',
          contentVisibility: 'visible',
        }),
      },
    },
  });
  return element;
}

describe('settings-panel visibility', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects disconnected or display-none sections', () => {
    expect(isElementRendered(fakeElement({ connected: false }))).toBe(false);
    expect(isElementRendered(fakeElement({ display: 'none' }))).toBe(false);
  });

  it('accepts a connected section with layout geometry', () => {
    expect(isElementRendered(fakeElement())).toBe(true);
  });

  it('rejects a zero-layout section while its drawer is closing', () => {
    expect(isElementRendered(fakeElement({ rectangles: 0 }))).toBe(false);
  });

  it('notifies when a hidden panel enters the viewport and disconnects cleanly', () => {
    let callback: IntersectionObserverCallback = () => undefined;
    let observed: Element | undefined;
    let disconnected = false;
    class FakeIntersectionObserver {
      constructor(next: IntersectionObserverCallback) {
        callback = next;
      }

      observe(target: Element): void {
        observed = target;
      }

      disconnect(): void {
        disconnected = true;
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    const element = fakeElement();
    const onVisible = vi.fn();
    const observer = observeElementVisibility(element, onVisible);

    expect(observed).toBe(element);
    callback(
      [{ target: element, isIntersecting: false } as unknown as IntersectionObserverEntry],
      observer as IntersectionObserver,
    );
    expect(onVisible).not.toHaveBeenCalled();
    callback(
      [{ target: element, isIntersecting: true } as unknown as IntersectionObserverEntry],
      observer as IntersectionObserver,
    );
    expect(onVisible).toHaveBeenCalledOnce();

    observer?.disconnect();
    expect(disconnected).toBe(true);
  });
});
