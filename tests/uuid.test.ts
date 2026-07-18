import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUuid } from '../src/core/uuid';

describe('createUuid', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('prefers crypto.randomUUID when the secure-context API is available', () => {
    const randomUUID = vi.fn(() => '123e4567-e89b-42d3-a456-426614174000');
    const getRandomValues = vi.fn();
    vi.stubGlobal('crypto', { randomUUID, getRandomValues });

    expect(createUuid()).toBe('123e4567-e89b-42d3-a456-426614174000');
    expect(randomUUID).toHaveBeenCalledOnce();
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it('builds a valid UUID v4 with getRandomValues when randomUUID is unavailable', () => {
    const source = Uint8Array.from({ length: 16 }, (_, index) => index);
    const getRandomValues = vi.fn((target: Uint8Array) => {
      target.set(source);
      return target;
    });
    vi.stubGlobal('crypto', { getRandomValues });

    expect(createUuid()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
    expect(getRandomValues).toHaveBeenCalledOnce();
  });

  it('keeps the UUID format when Web Crypto is missing entirely', () => {
    vi.stubGlobal('crypto', undefined);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    expect(createUuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
