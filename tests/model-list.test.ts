import { describe, expect, it, vi } from 'vitest';
import type { StoryEchoSettings } from '../src/core/types';
import { fetchCustomLlmModels, parseCustomModelList } from '../src/llm/model-list';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';

function customConfig(): StoryEchoSettings['llm']['custom'] {
  return structuredClone(DEFAULT_SETTINGS.llm.custom);
}

describe('custom LLM model list', () => {
  it('parses, deduplicates and sorts common model response shapes', () => {
    expect(parseCustomModelList({
      data: [
        { id: 'z-model' },
        { model: 'a-model' },
        { name: 'm-model' },
        'a-model',
        { id: '' },
      ],
    })).toEqual(['a-model', 'm-model', 'z-model']);
  });

  it('asks the SillyTavern backend to fetch models with the custom credentials', async () => {
    const fetchMock = vi.fn<typeof fetch>(function (this: unknown) {
      expect(this).toBe(globalThis);
      return Promise.resolve(new Response(JSON.stringify({
        models: [{ id: 'gpt-5.6-luna' }, { id: 'deepseek-v4-flash' }],
      }), { status: 200 }));
    });
    const config = customConfig();
    config.baseUrl = 'https://example.com/v1/chat/completions';
    config.apiKey = 'llm-secret';

    await expect(fetchCustomLlmModels(
      config,
      fetchMock,
      async () => ({ 'X-CSRF-Token': 'csrf' }),
    )).resolves.toEqual(['deepseek-v4-flash', 'gpt-5.6-luna']);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/backends/chat-completions/status');
    expect(init?.headers).toMatchObject({
      'X-CSRF-Token': 'csrf',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      reverse_proxy: 'https://example.com/v1',
      proxy_password: '',
      chat_completion_source: 'custom',
      custom_url: 'https://example.com/v1',
      custom_include_headers: 'Authorization: Bearer llm-secret',
    });
  });

  it('supports trusted HTTP endpoints only when the advanced option is enabled', async () => {
    const config = customConfig();
    config.baseUrl = 'http://sub2api:8080/v1';
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'local-model' }],
    }), { status: 200 }));

    await expect(fetchCustomLlmModels(config, fetchMock, async () => ({})))
      .rejects.toThrow(/禁止不安全的HTTP/);
    config.allowInsecureHttp = true;
    await expect(fetchCustomLlmModels(config, fetchMock, async () => ({})))
      .resolves.toEqual(['local-model']);
  });

  it('redacts the configured key from model-list errors', async () => {
    const config = customConfig();
    config.baseUrl = 'https://example.com/v1';
    config.apiKey = 'llm-secret';
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'credential llm-secret was rejected' },
    }), { status: 401 }));

    const error = await fetchCustomLlmModels(config, fetchMock, async () => ({}))
      .catch((value) => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('[REDACTED]');
    expect((error as Error).message).not.toContain('llm-secret');
  });
});
