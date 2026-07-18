import { describe, expect, it } from 'vitest';
import { hasSourceOutsideWindow } from '../src/retrieval/eligibility';
import { memory } from './fixtures';

describe('hasSourceOutsideWindow', () => {
  it('keeps a merged memory eligible when an older contributing fact left the window', () => {
    const merged = memory({
      source: { startMessageId: 8, endMessageId: 8, sourceHash: 'latest' },
      sourceHistory: [
        { startMessageId: 2, endMessageId: 7, sourceHash: 'location-update' },
        { startMessageId: 8, endMessageId: 8, sourceHash: 'confirmation' },
      ],
    });

    expect(hasSourceOutsideWindow(merged, 8)).toBe(true);
  });

  it('does not inject a fact whose complete source history is still visible', () => {
    const recent = memory({
      source: { startMessageId: 8, endMessageId: 9, sourceHash: 'recent' },
      sourceHistory: [{ startMessageId: 8, endMessageId: 9, sourceHash: 'recent' }],
    });

    expect(hasSourceOutsideWindow(recent, 8)).toBe(false);
  });
});
