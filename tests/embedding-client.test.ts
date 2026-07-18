import { afterEach, describe, expect, it, vi } from 'vitest';
import { embeddingSecretVault } from '../src/llm/secret-vault';
import { OpenAiCompatibleEmbeddingClient } from '../src/vector/openai-compatible-embedding';

afterEach(() => {
  embeddingSecretVault.clear();
});

describe('OpenAiCompatibleEmbeddingClient', () => {
  it('calls CORS-enabled endpoints directly and validates vectors', async () => {
    embeddingSecretVault.setSessionKey('test-token');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: [
        { index: 1, embedding: [0.3, 0.4] },
        { index: 0, embedding: [0.1, 0.2] },
      ],
    }), { status: 200 }));
    const client = new OpenAiCompatibleEmbeddingClient(fetchMock, async () => ({
      'Content-Type': 'application/json',
      'X-CSRF-Token': 'test-csrf',
    }));

    const vectors = await client.embed({
      endpoint: 'https://ark.cn-beijing.volces.com/api/v3/embeddings',
      model: 'embedding-model',
      texts: ['第一条', '第二条'],
      timeoutMs: 1_000,
    });

    expect(vectors).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://ark.cn-beijing.volces.com/api/v3/embeddings');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-token' });
    expect(init?.redirect).toBe('error');
    expect(JSON.parse(String(init?.body))).toEqual({
      input: ['第一条', '第二条'],
      model: 'embedding-model',
      encoding_format: 'float',
    });
  });

  it('falls back to the SillyTavern proxy after a browser CORS failure', async () => {
    embeddingSecretVault.setSessionKey('test-token');
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ index: 0, embedding: [0.1, 0.2] }],
      }), { status: 200 }));
    const client = new OpenAiCompatibleEmbeddingClient(fetchMock, async () => ({
      'X-CSRF-Token': 'test-csrf',
    }));

    await expect(client.embed({
      endpoint: 'https://example.com/v1/embeddings',
      model: 'embedding-model',
      texts: ['测试'],
      timeoutMs: 1_000,
    })).resolves.toEqual([[0.1, 0.2]]);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://example.com/v1/embeddings');
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      '/proxy/https%3A%2F%2Fexample.com%2Fv1%2Fembeddings',
    );
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      'X-CSRF-Token': 'test-csrf',
      Authorization: 'Bearer test-token',
    });
  });

  it('reports a disabled CORS proxy clearly', async () => {
    embeddingSecretVault.setSessionKey('test-token');
    const client = new OpenAiCompatibleEmbeddingClient(
      vi.fn<typeof fetch>()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(new Response(
        'CORS proxy is disabled. Enable it in config.yaml or use the --corsProxy flag.',
        { status: 404 },
      )),
      async () => ({ 'X-CSRF-Token': 'test-csrf' }),
    );

    await expect(client.embed({
      endpoint: 'https://example.com/v1/embeddings',
      model: 'embedding-model',
      texts: ['测试'],
      timeoutMs: 1_000,
    })).rejects.toThrow('enableCorsProxy: true');
  });

  it('requires an in-memory key without sending a request', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = new OpenAiCompatibleEmbeddingClient(fetchMock, async () => ({}));

    await expect(client.embed({
      endpoint: 'https://example.com/v1/embeddings',
      model: 'embedding-model',
      texts: ['测试'],
      timeoutMs: 1_000,
    })).rejects.toThrow('Embedding API Key');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
