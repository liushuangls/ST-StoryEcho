import { afterEach, describe, expect, it, vi } from 'vitest';
import { MainLlmProvider, tuneInternalGenerationSettings } from '../src/llm/main-provider';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MainLlmProvider', () => {
  it('uses a bounded SillyTavern response length for internal tasks', async () => {
    const generateRaw = vi.fn().mockResolvedValue('{"query":"银钥匙位置"}');
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ generateRaw }),
    });

    await new MainLlmProvider().complete({
      system: 'system',
      prompt: 'prompt',
      jsonSchema: { type: 'object' },
      maxTokens: 320,
    });

    expect(generateRaw).toHaveBeenCalledWith({
      systemPrompt: expect.stringMatching(/^\[story_echo_internal_.+\]\nsystem$/),
      prompt: expect.stringMatching(/^prompt\n\[story_echo_internal_.+\]$/),
      responseLength: 320,
    });
  });

  it('removes an echoed internal request marker from the returned content', async () => {
    const generateRaw = vi.fn(async (options: { prompt: string }) => {
      const marker = options.prompt.match(/\[story_echo_internal_.+\]$/)?.[0] ?? '';
      return `阶段总结正文\n${marker}`;
    });
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ generateRaw }),
    });

    await expect(new MainLlmProvider().complete({
      system: 'system',
      prompt: 'prompt',
    })).resolves.toBe('阶段总结正文');
  });

  it('gives reasoning models enough room to finish the connection test', async () => {
    const generateRaw = vi.fn().mockResolvedValue('OK');
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ generateRaw }),
    });

    await new MainLlmProvider().testConnection();

    expect(generateRaw).toHaveBeenCalledWith(expect.objectContaining({ responseLength: 128 }));
  });

  it('passes jsonSchema only for the explicit schema stage', async () => {
    const generateRaw = vi.fn().mockResolvedValue('{}');
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ generateRaw }),
    });
    const schema = { type: 'object', properties: {} };

    await new MainLlmProvider().complete({
      system: 'system',
      prompt: 'prompt',
      jsonSchema: schema,
      structuredOutput: 'json-schema',
    });

    expect(generateRaw).toHaveBeenCalledWith(expect.objectContaining({ jsonSchema: schema }));
  });

  it('detects the exact main-connection model and prioritizes JSON Object for DeepSeek', () => {
    const eventSource = {
      on: vi.fn(),
      off: vi.fn(),
    };
    const getChatCompletionModel = vi.fn(() => 'deepseek-v4-flash');
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({
        mainApi: 'openai',
        chatCompletionSettings: {
          chat_completion_source: 'deepseek',
          deepseek_model: 'deepseek-v4-flash',
        },
        getChatCompletionModel,
        eventSource,
        eventTypes: { CHAT_COMPLETION_SETTINGS_READY: 'settings-ready' },
      }),
    });

    const provider = new MainLlmProvider();
    expect(provider.structuredOutputOrder()).toEqual(['json-object', 'json-schema', 'text']);
    expect(provider.supportsStructuredOutput('json-object')).toBe(true);
    // SillyTavern maps the native DeepSeek schema hook to JSON Object, so there
    // is no distinct strict-schema retry for this source.
    expect(provider.supportsStructuredOutput('json-schema')).toBe(false);
    expect(getChatCompletionModel).toHaveBeenCalled();
  });

  it('injects JSON Object mode into a custom DeepSeek main connection only for the request', async () => {
    let handler: ((settings: unknown) => void) | undefined;
    const eventSource = {
      on: vi.fn((_event: string, next: (settings: unknown) => void) => {
        handler = next;
      }),
      off: vi.fn(),
    };
    const generateRaw = vi.fn(async () => {
      const outbound = {
        chat_completion_source: 'custom',
        custom_include_body: 'seed: 7',
        temperature: 0.8,
      };
      handler?.(outbound);
      expect(outbound).toEqual({
        chat_completion_source: 'custom',
        custom_include_body: 'seed: 7\nresponse_format:\n  type: json_object',
        temperature: 0,
      });
      return '{}';
    });
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({
        mainApi: 'openai',
        chatCompletionSettings: {
          chat_completion_source: 'custom',
          custom_model: 'deepseek-v4-pro',
        },
        getChatCompletionModel: () => 'deepseek-v4-pro',
        generateRaw,
        eventSource,
        event_types: { CHAT_COMPLETION_SETTINGS_READY: 'settings-ready' },
      }),
    });

    const schema = { type: 'object', properties: {} };
    await new MainLlmProvider().complete({
      system: 'system',
      prompt: 'prompt',
      jsonSchema: schema,
      structuredOutput: 'json-object',
    });

    expect(generateRaw).toHaveBeenCalledWith(expect.not.objectContaining({ jsonSchema: schema }));
    expect(eventSource.off).toHaveBeenCalledWith('settings-ready', expect.any(Function));
  });

  it('uses the native DeepSeek schema bridge to request JSON Object mode', async () => {
    let handler: ((settings: unknown) => void) | undefined;
    const eventSource = {
      on: vi.fn((_event: string, next: (settings: unknown) => void) => {
        handler = next;
      }),
      off: vi.fn(),
    };
    const schema = { type: 'object', required: ['query'] };
    const generateRaw = vi.fn(async () => {
      const outbound: Record<string, unknown> = {
        chat_completion_source: 'deepseek',
      };
      handler?.(outbound);
      expect(outbound['json_schema']).toEqual({
        name: 'story_echo_response',
        strict: false,
        value: { type: 'object' },
      });
      return '{}';
    });
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({
        mainApi: 'openai',
        chatCompletionSettings: {
          chat_completion_source: 'deepseek',
          deepseek_model: 'deepseek-v4-flash',
        },
        getChatCompletionModel: () => 'deepseek-v4-flash',
        generateRaw,
        eventSource,
        eventTypes: { CHAT_COMPLETION_SETTINGS_READY: 'settings-ready' },
      }),
    });

    await new MainLlmProvider().complete({
      system: 'system',
      prompt: 'prompt',
      jsonSchema: schema,
      structuredOutput: 'json-object',
    });

    // The bridge is request-scoped, so generateRaw itself remains in ordinary
    // content mode and does not invoke a second schema extraction pass.
    expect(generateRaw).toHaveBeenCalledWith(expect.not.objectContaining({ jsonSchema: schema }));
  });

  it('temporarily lowers main-connection reasoning for background work', async () => {
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
      return '{"memories":[]}';
    });
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({
        generateRaw,
        eventSource,
        event_types: { CHAT_COMPLETION_SETTINGS_READY: 'settings-ready' },
      }),
    });

    await new MainLlmProvider().complete({ system: 'system', prompt: 'prompt' });

    expect(eventSource.on).toHaveBeenCalledWith('settings-ready', expect.any(Function));
    expect(eventSource.off).toHaveBeenCalledWith('settings-ready', expect.any(Function));
  });

  it('uses deterministic sampling even when reasoning controls are absent', () => {
    const settings = { temperature: 0.4 };
    tuneInternalGenerationSettings(settings);
    expect(settings).toEqual({ temperature: 0 });
  });
});
