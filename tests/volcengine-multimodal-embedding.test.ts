import { describe, expect, it, vi } from 'vitest';
import { VolcengineMultimodalEmbeddingClient } from '../src/vector/volcengine-multimodal-embedding';

function request(
  overrides: Partial<Parameters<VolcengineMultimodalEmbeddingClient['embed']>[0]> = {},
) {
  return {
    endpoint: 'https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal',
    model: 'doubao-embedding-vision-251215',
    apiKey: 'ark-secret',
    texts: ['第一条', '第二条'],
    timeoutMs: 1_000,
    ...overrides,
  };
}

describe('VolcengineMultimodalEmbeddingClient', () => {
  it('sends one text item per request through the SillyTavern proxy', async () => {
    const fetchMock = vi.fn<typeof fetch>(function (this: unknown, _url, init) {
      expect(this).toBe(globalThis);
      const body = JSON.parse(String(init?.body));
      const text = body.input[0].text as string;
      const embedding = text === '第一条' ? [0.1, 0.2] : [0.3, 0.4];
      return Promise.resolve(new Response(JSON.stringify({
        data: { object: 'embedding', embedding },
      }), { status: 200 }));
    });
    const client = new VolcengineMultimodalEmbeddingClient(
      fetchMock,
      async () => ({ 'X-CSRF-Token': 'csrf' }),
      2,
    );

    await expect(client.embed(request())).resolves.toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe('/proxy/https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal');
      expect(init?.headers).toMatchObject({
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'csrf',
        Authorization: 'Bearer ark-secret',
      });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'doubao-embedding-vision-251215',
        input: [{ type: 'text' }],
        encoding_format: 'float',
      });
    }
  });

  it('limits concurrent requests and preserves input order', async () => {
    let active = 0;
    let maxActive = 0;
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => globalThis.setTimeout(resolve, 1));
      active -= 1;
      const body = JSON.parse(String(init?.body));
      const text = body.input[0].text as string;
      return new Response(JSON.stringify({
        data: { embedding: [Number(text)] },
      }), { status: 200 });
    });
    const client = new VolcengineMultimodalEmbeddingClient(fetchMock, async () => ({}), 2);

    await expect(client.embed(request({ texts: ['0', '1', '2', '3', '4'] })))
      .resolves.toEqual([[0], [1], [2], [3], [4]]);
    expect(maxActive).toBe(2);
  });

  it('rejects malformed responses and inconsistent vector dimensions', async () => {
    const missingData = new VolcengineMultimodalEmbeddingClient(
      vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 })),
      async () => ({}),
    );
    await expect(missingData.embed(request({ texts: ['一条'] })))
      .rejects.toThrow('缺少data.embedding');

    const responses = [
      new Response(JSON.stringify({ data: { embedding: [0.1, 0.2] } }), { status: 200 }),
      new Response(JSON.stringify({ data: { embedding: [0.3] } }), { status: 200 }),
    ];
    const inconsistent = new VolcengineMultimodalEmbeddingClient(
      vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(responses.shift()!)),
      async () => ({}),
      1,
    );
    await expect(inconsistent.embed(request())).rejects.toThrow('向量维度不一致');
  });

  it('reports API errors without exposing the configured key', async () => {
    const client = new VolcengineMultimodalEmbeddingClient(
      vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
        error: { message: 'invalid ark-secret' },
      }), { status: 403 })),
      async () => ({}),
    );

    await expect(client.embed(request({ texts: ['一条'] })))
      .rejects.toThrow('火山方舟Embedding请求失败（HTTP 403）。 invalid [REDACTED]');
  });

  it('does not call the endpoint for an empty batch', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = new VolcengineMultimodalEmbeddingClient(fetchMock, async () => ({}));

    await expect(client.embed(request({ texts: [] }))).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
