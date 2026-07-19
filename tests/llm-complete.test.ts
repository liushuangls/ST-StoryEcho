import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeWithConfiguredProvider } from '../src/llm/complete';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('completeWithConfiguredProvider', () => {
  it('retries one empty internal response with a larger bounded budget', async () => {
    const generateRaw = vi.fn()
      .mockResolvedValueOnce('  ')
      .mockResolvedValueOnce('{"query":"银钥匙位置"}');
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ generateRaw }),
    });

    const response = await completeWithConfiguredProvider(DEFAULT_SETTINGS, {
      system: 'system',
      prompt: 'prompt',
      maxTokens: 320,
    });

    expect(response).toBe('{"query":"银钥匙位置"}');
    expect(generateRaw).toHaveBeenNthCalledWith(1, expect.objectContaining({ responseLength: 320 }));
    expect(generateRaw).toHaveBeenNthCalledWith(2, expect.objectContaining({ responseLength: 640 }));
  });

  it('stops after one retry when the provider remains empty', async () => {
    const generateRaw = vi.fn().mockResolvedValue('');
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ generateRaw }),
    });

    await expect(completeWithConfiguredProvider(DEFAULT_SETTINGS, {
      system: 'system',
      prompt: 'prompt',
      maxTokens: 8_192,
    })).rejects.toThrow(/连续两次返回空内容/);
    expect(generateRaw).toHaveBeenCalledTimes(2);
    expect(generateRaw).toHaveBeenLastCalledWith(expect.objectContaining({ responseLength: 8_192 }));
  });
});
