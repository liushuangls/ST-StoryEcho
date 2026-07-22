import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const summaryManager = readFileSync(
  new URL('../src/ui/summary-manager.ts', import.meta.url),
  'utf8',
);
const memoryManager = readFileSync(
  new URL('../src/ui/memory-manager.ts', import.meta.url),
  'utf8',
);
const settingsPanel = readFileSync(
  new URL('../src/ui/settings-panel.ts', import.meta.url),
  'utf8',
);

function expectButtonCapturedBeforeConfirmation(source: string, selector: string): void {
  const handlerStart = source.indexOf(`'${selector}'`);
  expect(handlerStart).toBeGreaterThanOrEqual(0);
  const handlerPrefix = source.slice(handlerStart, handlerStart + 2_500);
  const capture = handlerPrefix.indexOf(
    'const button = event.currentTarget as HTMLButtonElement;',
  );
  const confirmation = handlerPrefix.indexOf('showConfirmation(');
  expect(capture).toBeGreaterThanOrEqual(0);
  expect(confirmation).toBeGreaterThan(capture);
}

describe('asynchronous confirmation handlers', () => {
  it('captures each action button before awaiting the SillyTavern popup', () => {
    for (const selector of [
      '#story-echo-skeleton-update',
      '#story-echo-skeleton-rebuild',
      '#story-echo-summary-rebuild-all',
      '#story-echo-summary-delete',
    ]) {
      expectButtonCapturedBeforeConfirmation(summaryManager, selector);
    }
    for (const selector of [
      '#story-echo-memory-rebuild',
      '#story-echo-memory-delete',
    ]) {
      expectButtonCapturedBeforeConfirmation(memoryManager, selector);
    }
    expectButtonCapturedBeforeConfirmation(settingsPanel, '#story-echo-reset-stats');
  });
});
