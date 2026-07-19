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

  it('treats superseded ancestry as history rather than effective old evidence', () => {
    const replacement = memory({
      source: { startMessageId: 8, endMessageId: 9, sourceHash: 'replacement' },
      sourceHistory: [
        { startMessageId: 1, endMessageId: 2, sourceHash: 'old-state' },
        { startMessageId: 8, endMessageId: 9, sourceHash: 'replacement' },
      ],
      lastOperation: 'SUPERSEDE',
    });

    expect(hasSourceOutsideWindow(replacement, 8)).toBe(false);
  });

  it('uses exact cited floors when a replacement batch straddles the window boundary', () => {
    const replacement = memory({
      source: { startMessageId: 8, endMessageId: 13, sourceHash: 'replacement-batch' },
      sourceMessageIds: [9],
      sourceHistory: [
        { startMessageId: 1, endMessageId: 2, sourceHash: 'old' },
        { startMessageId: 8, endMessageId: 13, sourceHash: 'replacement-batch' },
      ],
      lastOperation: 'SUPERSEDE',
    });

    expect(hasSourceOutsideWindow(replacement, 10)).toBe(true);
  });
});
