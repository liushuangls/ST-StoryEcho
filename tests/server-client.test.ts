import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverEndpointFingerprint, StoryEchoServerClient } from '../src/server/client';

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('StoryEchoServerClient', () => {
  it('saves a credential profile through the SillyTavern server', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      configured: true,
      endpointFingerprint: 'fingerprint',
      hasApiKey: true,
    }));
    const client = new StoryEchoServerClient(fetchMock, async () => ({
      'Content-Type': 'application/json',
      'X-CSRF-Token': 'csrf',
    }));

    await client.saveProfile('llm', 'https://example.com/v1/chat/completions', 'server-secret', false);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/plugins/story-echo/profiles/llm');
    expect(init?.method).toBe('PUT');
    expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf' });
    expect(JSON.parse(String(init?.body))).toEqual({
      endpoint: 'https://example.com/v1/chat/completions',
      apiKey: 'server-secret',
      allowInsecureHttp: false,
    });
  });

  it('sends LLM work to the plugin without putting the API key or endpoint in the request', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ content: 'OK' }));
    const client = new StoryEchoServerClient(fetchMock, async () => ({ 'Content-Type': 'application/json' }));

    await expect(client.complete({
      endpoint: 'https://example.com/v1/chat/completions',
      model: 'model-name',
      timeoutMs: 1_000,
      strictJsonSchema: false,
      system: 'system',
      prompt: 'prompt',
    })).resolves.toBe('OK');

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body));
    expect(url).toBe('/api/plugins/story-echo/llm/chat-completions');
    expect(body).not.toHaveProperty('apiKey');
    expect(body).not.toHaveProperty('endpoint');
    expect(body.endpointFingerprint).toBe(
      await serverEndpointFingerprint('https://example.com/v1/chat/completions'),
    );
  });

  it('reports a missing server plugin clearly', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('Not found', { status: 404 }));
    const client = new StoryEchoServerClient(fetchMock, async () => ({}));

    await expect(client.getStatus()).rejects.toThrow('服务端插件未安装或未启用');
  });
});
