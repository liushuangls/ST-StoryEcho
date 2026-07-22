import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoryEchoSettings } from '../src/core/types';
import { LlmRequestTimeoutError } from '../src/llm/errors';
import { OpenAiCompatibleProvider } from '../src/llm/openai-compatible-provider';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';

function customConfig(): StoryEchoSettings['llm']['custom'] {
  return structuredClone(DEFAULT_SETTINGS.llm.custom);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('OpenAiCompatibleProvider', () => {
  it('uses the SillyTavern custom backend so the server sends the LLM request', async () => {
    const fetchMock = vi.fn<typeof fetch>(function (this: unknown) {
      expect(this).toBe(globalThis);
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: 'OK' } }],
      }), { status: 200 }));
    });
    const config = customConfig();
    config.baseUrl = 'https://example.com/v1/chat/completions';
    config.model = 'model-name';
    config.apiKey = 'llm-secret';
    const provider = new OpenAiCompatibleProvider(
      config,
      fetchMock,
      async () => ({ 'X-CSRF-Token': 'csrf' }),
    );

    await expect(provider.complete({ system: 'system', prompt: 'prompt', maxTokens: 123 })).resolves.toBe('OK');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/backends/chat-completions/generate');
    expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf', 'Content-Type': 'application/json' });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: 'model-name',
      chat_completion_source: 'custom',
      custom_url: 'https://example.com/v1',
      reverse_proxy: 'https://example.com/v1',
      custom_include_headers: 'Authorization: Bearer llm-secret',
      stream: false,
      max_tokens: 123,
      include_reasoning: false,
      reasoning_effort: 'low',
      temperature: 0,
      top_p: 1,
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'prompt' },
      ],
    });
  });

  it('allows a 10000-token skeleton budget but clamps larger custom requests', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'OK' } }],
    }), { status: 200 }));
    const config = customConfig();
    config.baseUrl = 'https://example.com/v1';
    config.model = 'model-name';
    const provider = new OpenAiCompatibleProvider(config, fetchMock, async () => ({}));

    await provider.complete({ system: 'system', prompt: 'prompt', maxTokens: 20_000 });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.max_tokens).toBe(10_000);
  });

  it('passes a strict schema in the format expected by SillyTavern', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{}' } }],
    }), { status: 200 }));
    const config = customConfig();
    config.baseUrl = 'https://example.com/v1';
    config.model = 'model-name';
    config.strictJsonSchema = true;
    const provider = new OpenAiCompatibleProvider(config, fetchMock, async () => ({}));
    const schema = { type: 'object', properties: {} };

    await provider.complete({ system: 'system', prompt: 'prompt', jsonSchema: schema });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.json_schema).toEqual({
      name: 'story_echo_response',
      strict: true,
      value: schema,
    });
  });

  it('passes DeepSeek-compatible json_object through SillyTavern custom_include_body', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{}' } }],
    }), { status: 200 }));
    const config = customConfig();
    config.baseUrl = 'https://api.deepseek.com/v1';
    config.model = 'deepseek-v4-pro';
    const provider = new OpenAiCompatibleProvider(config, fetchMock, async () => ({}));

    await provider.complete({
      system: 'system',
      prompt: 'prompt',
      structuredOutput: 'json-object',
      jsonSchema: { type: 'object' },
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.custom_include_body).toBe('response_format:\n  type: json_object');
    expect(body.json_schema).toBeUndefined();
  });

  it('gives reasoning models enough room to finish the connection test', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'OK' } }],
    }), { status: 200 }));
    const config = customConfig();
    config.baseUrl = 'https://example.com/v1';
    config.model = 'model-name';
    const provider = new OpenAiCompatibleProvider(config, fetchMock, async () => ({}));

    await provider.testConnection();

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.max_tokens).toBe(128);
  });

  it('redacts the configured key from backend errors', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'credential llm-secret was rejected' },
    }), { status: 500 }));
    const config = customConfig();
    config.baseUrl = 'https://example.com/v1';
    config.model = 'model-name';
    config.apiKey = 'llm-secret';
    const provider = new OpenAiCompatibleProvider(config, fetchMock, async () => ({}));

    const error = await provider.complete({ system: 'system', prompt: 'prompt' }).catch((value) => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('llm-secret');
  });

  it('marks a local request deadline as a retriable LLM timeout', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }));
    const config = customConfig();
    config.baseUrl = 'https://example.com/v1';
    config.model = 'model-name';
    config.timeoutMs = 1_000;
    const provider = new OpenAiCompatibleProvider(config, fetchMock, async () => ({}));

    const outcome = provider.complete({ system: 'system', prompt: 'prompt' })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);

    const error = await outcome;
    expect(error).toBeInstanceOf(LlmRequestTimeoutError);
    expect(error).toMatchObject({ timeoutMs: 1_000 });
  });

  it('lets a stage-summary request override the provider default with 600 seconds', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }));
    const config = customConfig();
    config.baseUrl = 'https://example.com/v1';
    config.model = 'model-name';
    config.timeoutMs = 1_000;
    const provider = new OpenAiCompatibleProvider(config, fetchMock, async () => ({}));

    let settled = false;
    const outcome = provider.complete({
      system: 'system',
      prompt: 'prompt',
      timeoutMs: 600_000,
    }).catch((error: unknown) => error);
    void outcome.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(599_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const error = await outcome;
    expect(error).toBeInstanceOf(LlmRequestTimeoutError);
    expect(error).toMatchObject({ timeoutMs: 600_000 });
  });

  it('marks a SillyTavern-wrapped upstream 524 as the same retriable timeout', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'Got response status 524' },
    }), { status: 500 }));
    const config = customConfig();
    config.baseUrl = 'https://example.com/v1';
    config.model = 'model-name';
    const provider = new OpenAiCompatibleProvider(config, fetchMock, async () => ({}));

    const error = await provider.complete({ system: 'system', prompt: 'prompt' })
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(LlmRequestTimeoutError);
    expect(error).toMatchObject({ timeoutMs: 300_000, upstreamStatus: 524 });
  });
});
