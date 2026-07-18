import { storyEchoServerClient, type StoryEchoServerClient } from '../server/client';

interface EmbeddingResponseItem {
  index?: unknown;
  embedding?: unknown;
}

export interface EmbeddingRequest {
  endpoint: string;
  model: string;
  texts: string[];
  timeoutMs: number;
}

export interface EmbeddingClient {
  embed(request: EmbeddingRequest): Promise<number[][]>;
}

function parseVectors(value: unknown, expectedCount: number): number[][] {
  if (!Array.isArray(value)) {
    throw new Error('StoryEcho服务端响应缺少向量数组。');
  }
  if (value.length !== expectedCount) {
    throw new Error(`StoryEcho服务端返回${value.length}条向量，预期${expectedCount}条。`);
  }

  let dimension: number | undefined;
  return (value as EmbeddingResponseItem[]).map((item) => {
    const rawVector = Array.isArray(item) ? item : item.embedding;
    if (!Array.isArray(rawVector) || rawVector.length === 0) {
      throw new Error('StoryEcho服务端返回了空向量。');
    }
    const vector = rawVector.map(Number);
    if (vector.some((number) => !Number.isFinite(number))) {
      throw new Error('StoryEcho服务端返回了无效向量数值。');
    }
    dimension ??= vector.length;
    if (vector.length !== dimension) {
      throw new Error('StoryEcho服务端返回的向量维度不一致。');
    }
    return vector;
  });
}

export class OpenAiCompatibleEmbeddingClient implements EmbeddingClient {
  constructor(private readonly serverClient: StoryEchoServerClient = storyEchoServerClient) {}

  async embed(request: EmbeddingRequest): Promise<number[][]> {
    if (request.texts.length === 0) {
      return [];
    }
    if (!request.model.trim()) {
      throw new Error('Embedding模型不能为空。');
    }
    const vectors = await this.serverClient.embed(request);
    return parseVectors(vectors, request.texts.length);
  }
}

export const openAiCompatibleEmbeddingClient = new OpenAiCompatibleEmbeddingClient();
