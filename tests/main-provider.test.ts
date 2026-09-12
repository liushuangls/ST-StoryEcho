import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmRequestTimeoutError } from '../src/llm/errors';
import { MainLlmProvider, tuneInternalGenerationSettings } from '../src/llm/main-provider';
import { STAGE_SUMMARY_SYSTEM_PROMPT } from '../src/summary/prompts';
import { GEMINI_L1_DELIVERY_GUIDANCE } from '../src/summary/model-prompts';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('MainLlmProvider', () => {
  it('adapts Gemini L1 in the raw-host path without changing the saved preset', async () => {
    const preset = { chat_completion_source: 'makersuite', google_model: 'gemini-3.8-flash', temperature: 0.7, top_p: 0.8 };
    let handler: ((settings: unknown) => void) | undefined;
    const off = vi.fn();
    const generateRaw = vi.fn(async (_options: { systemPrompt: string; prompt: string; responseLength?: number }) => {
      const body = { model: 'gemini-3.8-flash', temperature: 0.7, top_p: 0.8, top_k: 1, max_tokens: 3_000 };
      handler?.(body);
      expect(body).toEqual({ model: 'gemini-3.8-flash', max_tokens: 3_000 });
      return '双方约定次日归还钥匙，使用范围仅限档案室。';
    });
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({
        mainApi: 'openai', chatCompletionSettings: preset, generateRaw,
        getChatCompletionModel: () => 'gemini-3.8-flash',
        eventSource: { on: (_name: string, callback: typeof handler) => { handler = callback; }, off },
        eventTypes: { CHAT_COMPLETION_SETTINGS_READY: 'settings-ready' },
      }),
    });

    await new MainLlmProvider().complete({
      system: STAGE_SUMMARY_SYSTEM_PROMPT, prompt: '原始剧情', summaryLevel: 1, maxTokens: 3_000,
    });
    expect(generateRaw).toHaveBeenCalledWith(expect.objectContaining({
      responseLength: 3_000,
      systemPrompt: expect.stringContaining('优先完整覆盖独有重要事实'),
      prompt: expect.stringContaining(GEMINI_L1_DELIVERY_GUIDANCE),
    }));
    expect(generateRaw.mock.calls[0]?.[0]).not.toHaveProperty('summaryLevel');
    expect(preset).toMatchObject({ temperature: 0.7, top_p: 0.8 });
    expect(off).toHaveBeenCalledWith('settings-ready', expect.any(Function));
  });

  it('uses model defaults only for Gemini 3 sampling while retaining low reasoning', () => {
    const settings = {
      model: 'google/gemini-3.8-flash', temperature: 0.2, top_p: 0.5, top_k: 1,
      reasoning_effort: 'high', include_reasoning: true,
    };
    tuneInternalGenerationSettings(settings);
    expect(settings).toEqual({
      model: 'google/gemini-3.8-flash', reasoning_effort: 'low', include_reasoning: false,
    });
    const other = { model: 'gemini-2.5-pro', temperature: 0.5, top_p: 0.9 };
    tuneInternalGenerationSettings(other);
    expect(other).toEqual({ model: 'gemini-2.5-pro', temperature: 0, top_p: 1 });
  });

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
      responseLength: 16_000,
    });
  });

  it('retains finish and token metadata from SillyTavern 1.18 raw responses', async () => {
    const payload = {
      model: 'gpt-test',
      choices: [{
        finish_reason: 'length',
        message: { content: '阶段总结被截断到这里' },
      }],
      usage: {
        prompt_tokens: 900,
        completion_tokens: 128,
        total_tokens: 1_028,
        completion_tokens_details: { reasoning_tokens: 32 },
      },
    };
    const generateRaw = vi.fn();
    const generateRawData = vi.fn().mockResolvedValue(payload);
    const extractMessageFromData = vi.fn((data: typeof payload) => (
      data.choices[0]!.message.content
    ));
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({
        generateRaw,
        generateRawData,
        extractMessageFromData,
        mainApi: 'openai',
        chatCompletionSettings: {
          chat_completion_source: 'custom',
          custom_model: 'gpt-test',
        },
      }),
    });

    const result = await new MainLlmProvider().completeDetailed({
      system: 'system',
      prompt: 'prompt',
      maxTokens: 3_000,
    });

    expect(generateRaw).not.toHaveBeenCalled();
    expect(generateRawData).toHaveBeenCalledWith(expect.objectContaining({
      responseLength: 3_000,
    }));
    expect(extractMessageFromData).toHaveBeenCalledWith(payload, 'openai');
    expect(result).toEqual({
      text: '阶段总结被截断到这里',
      metadata: {
        provider: 'main',
        requestedMaxTokens: 3_000,
        finishReason: 'length',
        promptTokens: 900,
        completionTokens: 128,
        reasoningTokens: 32,
        totalTokens: 1_028,
        responseCharacters: 10,
        source: 'custom',
        model: 'gpt-test',
      },
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
        include_reasoning: true,
        thinking: { type: 'enabled', budget_tokens: 8_000 },
        enable_thinking: true,
        temperature: 1.1,
        top_p: 0.85,
      };
      handler?.(settings);
      expect(settings).toEqual({
        reasoning_effort: 'low',
        include_reasoning: false,
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
