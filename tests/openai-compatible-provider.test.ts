import { describe, expect, it, vi } from 'vitest';
import type { StoryEchoSettings } from '../src/core/types';
import { OpenAiCompatibleProvider } from '../src/llm/openai-compatible-provider';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';

function customConfig(): StoryEchoSettings['llm']['custom'] {
  return structuredClone(DEFAULT_SETTINGS.llm.custom);
}

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
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'prompt' },
      ],
    });
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
});
