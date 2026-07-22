import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  completeWithConfiguredProvider,
  MAX_LLM_TIMEOUT_RETRIES,
} from '../src/llm/complete';
import { LlmRequestTimeoutError } from '../src/llm/errors';
import { isInternalGeneration } from '../src/llm/internal-generation';
import { storyEchoTaskCoordinator } from '../src/runtime/task-coordinator';
import { StoryEchoTaskCancelledError } from '../src/runtime/task-cancellation';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';

afterEach(() => {
  storyEchoTaskCoordinator.resetForTests();
  vi.unstubAllGlobals();
});

describe('completeWithConfiguredProvider', () => {
  it('releases a hanging main-provider background request for foreground generation', async () => {
    const generateRaw = vi.fn(() => new Promise<string>(() => undefined));
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ generateRaw }),
    });

    const background = storyEchoTaskCoordinator.enqueueBackground(
      'hanging summary',
      () => completeWithConfiguredProvider(DEFAULT_SETTINGS, {
        system: 'system',
        prompt: 'prompt',
      }),
    );
    const backgroundOutcome = background.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(generateRaw).toHaveBeenCalledOnce());

    const foreground = storyEchoTaskCoordinator.enqueueForeground(
      'new branch generation',
      async () => false,
      { holdForegroundLease: (prepared) => prepared },
    );

    expect(await backgroundOutcome).toBeInstanceOf(StoryEchoTaskCancelledError);
    await foreground;
    expect(isInternalGeneration()).toBe(false);
    expect(storyEchoTaskCoordinator.snapshot().runningKind).toBeNull();
  });

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
    expect(generateRaw).toHaveBeenLastCalledWith(expect.objectContaining({ responseLength: 10_000 }));
  });

  it('retries only the current LLM request after a timeout', async () => {
    const generateRaw = vi.fn()
      .mockRejectedValueOnce(new LlmRequestTimeoutError(300_000))
      .mockResolvedValueOnce('当前批次重试成功');
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ generateRaw }),
    });

    await expect(completeWithConfiguredProvider(DEFAULT_SETTINGS, {
      system: 'same-system',
      prompt: 'same-current-batch',
      maxTokens: 1_600,
    })).resolves.toBe('当前批次重试成功');

    expect(MAX_LLM_TIMEOUT_RETRIES).toBe(1);
    expect(generateRaw).toHaveBeenCalledTimes(2);
    for (const [options] of generateRaw.mock.calls) {
      expect(options).toMatchObject({ responseLength: 1_600 });
      expect(options.systemPrompt).toContain('same-system');
      expect(options.prompt).toContain('same-current-batch');
    }
  });

  it('stops the current operation after its bounded timeout retry also fails', async () => {
    const generateRaw = vi.fn().mockRejectedValue(new LlmRequestTimeoutError(300_000));
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ generateRaw }),
    });

    await expect(completeWithConfiguredProvider(DEFAULT_SETTINGS, {
      system: 'system',
      prompt: 'current-batch',
    })).rejects.toThrow(/300000ms/);
    expect(generateRaw).toHaveBeenCalledTimes(2);
  });
});
