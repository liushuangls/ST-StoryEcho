import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingClient } from '../src/vector/openai-compatible-embedding';
import { SillyTavernVectorStore } from '../src/vector/sillytavern-vector-store';

afterEach(() => {
  vi.unstubAllGlobals();
});

function installSillyTavernContext(): void {
  vi.stubGlobal('SillyTavern', {
    getContext: () => ({
      getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test' }),
    }),
  });
}

const precomputed = {
  source: 'webllm',
  model: 'storyecho-openai-compatible--embedding-model',
  precomputed: {
    provider: 'openai-compatible' as const,
    endpoint: 'https://example.com/v1/embeddings',
    model: 'embedding-model',
    apiKey: 'embedding-secret',
    timeoutMs: 1_000,
  },
};

describe('SillyTavernVectorStore precomputed embeddings', () => {
  it('generates vectors externally and lets Vector Storage persist them', async () => {
    installSillyTavernContext();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const embeddingClient: EmbeddingClient = {
      embed: vi.fn().mockResolvedValue([[0.1, 0.2], [0.3, 0.4]]),
    };
    const store = new SillyTavernVectorStore(() => embeddingClient);

    await store.insert('collection', [
      { hash: 11, text: '记忆一', index: 1 },
      { hash: 22, text: '记忆二', index: 2 },
    ], precomputed);

    expect(embeddingClient.embed).toHaveBeenCalledWith({
      ...precomputed.precomputed,
      texts: ['记忆一', '记忆二'],
      signal: expect.any(AbortSignal),
    });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      collectionId: 'collection',
      source: 'webllm',
      model: 'storyecho-openai-compatible--embedding-model',
      embeddings: {
        '记忆一': [0.1, 0.2],
        '记忆二': [0.3, 0.4],
      },
    });
    expect(body).not.toHaveProperty('precomputed');
  });

  it('supplies the query vector while Vector Storage performs similarity search', async () => {
    installSillyTavernContext();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      metadata: [{ hash: 22, text: '记忆二', index: 2 }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const embeddingClient: EmbeddingClient = {
      embed: vi.fn().mockResolvedValue([[0.5, 0.6]]),
    };
    const store = new SillyTavernVectorStore(() => embeddingClient);

    const results = await store.query('collection', '当前查询', 5, 0.25, precomputed);

    expect(results).toEqual([{ hash: 22, text: '记忆二', index: 2, rank: 0 }]);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      source: 'webllm',
      searchText: '当前查询',
      embeddings: { '当前查询': [0.5, 0.6] },
    });
  });

  it('batches large embedding rebuilds before one Vector Storage insert', async () => {
    installSillyTavernContext();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const embed = vi.fn<EmbeddingClient['embed']>().mockImplementation(async ({ texts }) =>
      texts.map((_, index) => [index, index + 1]));
    const store = new SillyTavernVectorStore(() => ({ embed }));
    const items = Array.from({ length: 65 }, (_, index) => ({
      hash: index + 1,
      text: `记忆-${index}`,
      index,
    }));

    await store.insert('collection', items, precomputed);

    expect(embed).toHaveBeenCalledTimes(2);
    expect(embed.mock.calls[0]?.[0].texts).toHaveLength(64);
    expect(embed.mock.calls[1]?.[0].texts).toEqual(['记忆-64']);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('accepts SillyTavern plain-text success acknowledgements', async () => {
    installSillyTavernContext();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('OK', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const store = new SillyTavernVectorStore();

    await expect(store.purge('collection')).resolves.toBeUndefined();
  });

  it('bounds a stalled Vector Storage request even when fetch ignores abort', async () => {
    installSillyTavernContext();
    const fetchMock = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    const store = new SillyTavernVectorStore();

    await expect(store.query(
      'collection',
      '当前查询',
      5,
      0.25,
      { source: 'transformers' },
      { timeoutMs: 10 },
    )).rejects.toThrow('Vector Storage查询超时（10ms）');

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(true);
  });

  it('propagates caller cancellation through embedding and Vector Storage work', async () => {
    installSillyTavernContext();
    const controller = new AbortController();
    const reason = new Error('audit cancellation');
    const embed = vi.fn<EmbeddingClient['embed']>(
      ({ signal }) => new Promise<number[][]>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    );
    vi.stubGlobal('fetch', vi.fn<typeof fetch>());
    const store = new SillyTavernVectorStore(() => ({ embed }));
    const query = store.query(
      'collection',
      '当前查询',
      5,
      0.25,
      precomputed,
      { signal: controller.signal, timeoutMs: 1_000 },
    );

    controller.abort(reason);

    await expect(query).rejects.toBe(reason);
    expect(embed.mock.calls[0]?.[0].signal?.aborted).toBe(true);
  });
});
