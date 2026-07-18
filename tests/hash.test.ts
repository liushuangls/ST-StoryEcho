import { afterEach, describe, expect, it, vi } from 'vitest';
import { allocateVectorHash, sha256, stableNumericHash } from '../src/core/hash';

afterEach(() => {
  vi.unstubAllGlobals();
});

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

describe('sha256', () => {
  it('uses the Web Crypto digest when it is available', async () => {
    const digest = vi.fn(async () => Uint8Array.from({ length: 32 }, (_, index) => index).buffer);
    vi.stubGlobal('crypto', { subtle: { digest } });

    expect(await sha256('StoryEcho')).toBe(
      '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    );
    expect(digest).toHaveBeenCalledOnce();
  });

  it('computes the standard digest without crypto.subtle', async () => {
    vi.stubGlobal('crypto', {});

    expect(await sha256('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(await sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
