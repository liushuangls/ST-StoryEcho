import { describe, expect, it, vi } from 'vitest';
import { OpenAiCompatibleEmbeddingClient } from '../src/vector/openai-compatible-embedding';

function request(overrides: Partial<Parameters<OpenAiCompatibleEmbeddingClient['embed']>[0]> = {}) {
  return {
    endpoint: 'https://ark.cn-beijing.volces.com/api/v3/embeddings',
    model: 'embedding-model',
    apiKey: 'embedding-secret',
    texts: ['第一条', '第二条'],
    timeoutMs: 1_000,
    ...overrides,
  };
}

describe('OpenAiCompatibleEmbeddingClient', () => {
  it('calls the embedding endpoint from the browser and normalizes vectors by index', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: [
        { index: 1, embedding: [0.3, 0.4] },
        { index: 0, embedding: [0.1, 0.2] },
      ],
    }), { status: 200 }));
    const client = new OpenAiCompatibleEmbeddingClient(fetchMock);

    await expect(client.embed(request())).resolves.toEqual([[0.1, 0.2], [0.3, 0.4]]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://ark.cn-beijing.volces.com/api/v3/embeddings');
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer embedding-secret',
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'embedding-model',
      input: ['第一条', '第二条'],
    });
  });

  it('validates vectors returned by the endpoint', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: [
        { index: 0, embedding: [0.1, 0.2] },
        { index: 1, embedding: [Number.NaN, 0.4] },
      ],
    }), { status: 200 }));
    const client = new OpenAiCompatibleEmbeddingClient(fetchMock);

    await expect(client.embed(request())).rejects.toThrow('无效向量数值');
  });

  it('reports browser networking and CORS failures clearly', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'));
    const client = new OpenAiCompatibleEmbeddingClient(fetchMock);

    await expect(client.embed(request())).rejects.toThrow('CORS');
  });

  it('does not call the endpoint for an empty batch', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = new OpenAiCompatibleEmbeddingClient(fetchMock);

    await expect(client.embed(request({ texts: [] }))).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
