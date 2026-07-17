import { describe, expect, it } from 'vitest';
import { allocateVectorHash, stableNumericHash } from '../src/core/hash';

describe('stableNumericHash', () => {
  it('is deterministic', () => {
    expect(stableNumericHash('memory-1')).toBe(stableNumericHash('memory-1'));
  });

  it('allocates a salted hash when the first value is occupied', () => {
    const initial = stableNumericHash('memory-1');
    const allocated = allocateVectorHash('memory-1', new Set([initial]));
    expect(allocated).not.toBe(initial);
  });
});
