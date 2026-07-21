import { describe, expect, it } from 'vitest';
import { isElementRendered } from '../src/ui/visibility';

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
});
