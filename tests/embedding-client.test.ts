import { describe, expect, it, vi } from 'vitest';
import type { StoryEchoServerClient } from '../src/server/client';
import { OpenAiCompatibleEmbeddingClient } from '../src/vector/openai-compatible-embedding';

function clientWithVectors(vectors: unknown): {
  client: OpenAiCompatibleEmbeddingClient;
  embed: ReturnType<typeof vi.fn>;
} {
  const embed = vi.fn().mockResolvedValue(vectors);
  const serverClient = { embed } as unknown as StoryEchoServerClient;
  return { client: new OpenAiCompatibleEmbeddingClient(serverClient), embed };
}

describe('OpenAiCompatibleEmbeddingClient', () => {
  it('delegates vector generation to the StoryEcho server plugin', async () => {
    const { client, embed } = clientWithVectors([[0.1, 0.2], [0.3, 0.4]]);
    const request = {
      endpoint: 'https://ark.cn-beijing.volces.com/api/v3/embeddings',
      model: 'embedding-model',
      texts: ['第一条', '第二条'],
      timeoutMs: 1_000,
    };

    await expect(client.embed(request)).resolves.toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(embed).toHaveBeenCalledWith(request);
  });

  it('validates vectors returned by the server', async () => {
    const { client } = clientWithVectors([[0.1, 0.2], [Number.NaN, 0.4]]);

    await expect(client.embed({
      endpoint: 'https://example.com/v1/embeddings',
      model: 'embedding-model',
      texts: ['第一条', '第二条'],
      timeoutMs: 1_000,
    })).rejects.toThrow('无效向量数值');
  });

  it('does not call the server for an empty batch', async () => {
    const { client, embed } = clientWithVectors([]);

    await expect(client.embed({
      endpoint: 'https://example.com/v1/embeddings',
      model: 'embedding-model',
      texts: [],
      timeoutMs: 1_000,
    })).resolves.toEqual([]);
    expect(embed).not.toHaveBeenCalled();
  });
});
