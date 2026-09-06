import { describe, expect, it } from 'vitest';
import { normalizeTruncatedSourceRanges, summaryTruncationRanges } from '../src/summary/truncation';

describe('summary truncation ranges', () => {
  it('rejects malformed/out-of-scope markers and merges overlapping/adjacent ranges', () => {
    expect(normalizeTruncatedSourceRanges([
      null, 'bad', {},
      { sourceStartMessageId: '0', sourceEndMessageId: 3 },
      { sourceStartMessageId: 0, sourceEndMessageId: 999 },
      { sourceStartMessageId: -1, sourceEndMessageId: 3 },
      { sourceStartMessageId: 5, sourceEndMessageId: 4 },
      { sourceStartMessageId: 4, sourceEndMessageId: 5 },
      { sourceStartMessageId: 0, sourceEndMessageId: 3 },
      { sourceStartMessageId: 2, sourceEndMessageId: 4 },
    ], 0, 9)).toEqual([{ sourceStartMessageId: 0, sourceEndMessageId: 5 }]);
  });

  it('bounds recursive metadata without losing any potentially affected message', () => {
    const sources = Array.from({ length: 100 }, (_, index) => ({ sourceStartMessageId: index * 2, sourceEndMessageId: index * 2 }));
    const normalized = normalizeTruncatedSourceRanges(sources, 0, 200);
    expect(normalized).toHaveLength(32);
    expect(normalizeTruncatedSourceRanges(normalized, 0, 200)).toEqual(normalized);
    for (const source of sources) {
      expect(normalized.some((range) => range.sourceStartMessageId <= source.sourceStartMessageId && range.sourceEndMessageId >= source.sourceEndMessageId)).toBe(true);
    }
  });

  it('does not propagate risk from deliberately deleted or manually repaired leaf summaries', () => {
    const entry = { text: '总结', level: 1, sourceStartMessageId: 0, sourceEndMessageId: 9, sourceHash: '', updatedAt: '', generation: {
      provider: 'main' as const, requestedMaxTokens: 3000, responseCharacters: 2, finishReason: 'length',
    } };
    expect(summaryTruncationRanges(entry)).toHaveLength(1);
    expect(summaryTruncationRanges({ ...entry, deleted: true })).toEqual([]);
    expect(summaryTruncationRanges({ ...entry, manuallyEdited: true })).toEqual([]);
  });
});
