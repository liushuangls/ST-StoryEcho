import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmRequestTimeoutError } from '../src/llm/errors';
import { MainLlmProvider, tuneInternalGenerationSettings } from '../src/llm/main-provider';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('MainLlmProvider', () => {
  it('uses a bounded response length and internal request marker', async () => {
    const generateRaw = vi.fn().mockResolvedValue('OK');
    vi.stubGlobal('SillyTavern', { getContext: () => ({ generateRaw }) });

    await new MainLlmProvider().complete({
      system: 'system',
      prompt: 'prompt',
      maxTokens: 20_000,
    });

    expect(generateRaw).toHaveBeenCalledWith({
      systemPrompt: expect.stringMatching(/^\[story_echo_internal_.+\]\nsystem$/),
      prompt: expect.stringMatching(/^prompt\n\[story_echo_internal_.+\]$/),
      responseLength: 10_000,
    });
  });

  it('honors the request deadline and removes abort listeners', async () => {
    vi.useFakeTimers();
    const generateRaw = vi.fn(() => new Promise<string>(() => undefined));
    vi.stubGlobal('SillyTavern', { getContext: () => ({ generateRaw }) });
    const signal = new AbortController().signal;
    const removeEventListener = vi.spyOn(signal, 'removeEventListener');
    const outcome = new MainLlmProvider().complete({
      system: 'system',
      prompt: 'prompt',
      timeoutMs: 600_000,
      signal,
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(600_000);
    expect(await outcome).toBeInstanceOf(LlmRequestTimeoutError);
    expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('propagates an already-aborted task signal', async () => {
    const generateRaw = vi.fn(() => new Promise<string>(() => undefined));
    vi.stubGlobal('SillyTavern', { getContext: () => ({ generateRaw }) });
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(new MainLlmProvider().complete({
      system: 'system',
      prompt: 'prompt',
      timeoutMs: 10_000,
      signal: controller.signal,
    })).rejects.toThrow('cancelled');
  });

  it('removes an echoed request marker and gives connection tests enough output room', async () => {
    const generateRaw = vi.fn(async (options: { prompt: string }) => {
      const marker = options.prompt.match(/\[story_echo_internal_.+\]$/)?.[0] ?? '';
      return `阶段总结正文\n${marker}`;
    });
    vi.stubGlobal('SillyTavern', { getContext: () => ({ generateRaw }) });
    const provider = new MainLlmProvider();
    await expect(provider.complete({ system: 'system', prompt: 'prompt' }))
      .resolves.toBe('阶段总结正文');
    await provider.testConnection();
    expect(generateRaw).toHaveBeenLastCalledWith(expect.objectContaining({ responseLength: 128 }));
  });

  it('temporarily lowers reasoning settings and removes the request-scoped hook', async () => {
    let handler: ((settings: unknown) => void) | undefined;
    const eventSource = {
      on: vi.fn((_event: string, next: (settings: unknown) => void) => {
        handler = next;
      }),
      off: vi.fn(),
    };
    const generateRaw = vi.fn(async () => {
      const settings = {
        reasoning_effort: 'max',
        thinking: { type: 'enabled', budget_tokens: 8_000 },
        enable_thinking: true,
        temperature: 1.1,
        top_p: 0.85,
      };
      handler?.(settings);
      expect(settings).toEqual({
        reasoning_effort: 'low',
        thinking: { type: 'disabled', budget_tokens: 8_000 },
        enable_thinking: false,
        temperature: 0,
        top_p: 1,
      });
      return 'OK';
    });
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({
        generateRaw,
        eventSource,
        event_types: { CHAT_COMPLETION_SETTINGS_READY: 'settings-ready' },
      }),
    });

    await new MainLlmProvider().complete({ system: 'system', prompt: 'prompt' });
    expect(eventSource.off).toHaveBeenCalledWith('settings-ready', expect.any(Function));
  });

  it('ignores unsupported settings shapes', () => {
    expect(() => tuneInternalGenerationSettings(null)).not.toThrow();
    const settings = { temperature: 0.4 };
    tuneInternalGenerationSettings(settings);
    expect(settings).toEqual({ temperature: 0 });
  });
});
