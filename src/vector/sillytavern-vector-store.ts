import { getRequestHeaders } from '../platform/sillytavern';
import type {
  VectorItem,
  VectorQueryResult,
  VectorRequestConfig,
  VectorStoreAdapter,
} from './adapter';
import type { EmbeddingClientResolver } from './embedding-providers';
import { resolveEmbeddingClient } from './embedding-providers';

const EMBEDDING_BATCH_SIZE = 64;

interface VectorMetadata {
  hash?: number | string;
  text?: string;
  index?: number | string;
}

function requestBody(
  collectionId: string,
  config: VectorRequestConfig,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    collectionId,
    source: config.source,
    ...(config.model ? { model: config.model } : {}),
    ...(config.sourceSettings ?? {}),
    ...extra,
  };
}

function embeddingMap(texts: string[], vectors: number[][]): Record<string, number[]> {
  if (texts.length !== vectors.length) {
    throw new Error(`Embedding数量不匹配：文本${texts.length}条，向量${vectors.length}条。`);
  }
  return Object.fromEntries(texts.map((text, index) => [text, vectors[index] ?? []]));
}

export class SillyTavernVectorStore implements VectorStoreAdapter {
  constructor(private readonly embeddingClientResolver: EmbeddingClientResolver = resolveEmbeddingClient) {}

  private async embedTexts(
    texts: string[],
    config: NonNullable<VectorRequestConfig['precomputed']>,
  ): Promise<number[][]> {
    const embeddingClient = this.embeddingClientResolver(config.provider);
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
      vectors.push(...await embeddingClient.embed({
        ...config,
        texts: texts.slice(start, start + EMBEDDING_BATCH_SIZE),
      }));
    }
    return vectors;
  }

  async insert(collectionId: string, items: VectorItem[], config: VectorRequestConfig): Promise<void> {
    if (items.length === 0) {
      return;
    }
    const embeddings = config.precomputed
      ? embeddingMap(
          items.map((item) => item.text),
          await this.embedTexts(items.map((item) => item.text), config.precomputed),
        )
      : undefined;
    await this.post('/api/vector/insert', requestBody(collectionId, config, {
      items,
      ...(embeddings ? { embeddings } : {}),
    }));
  }

  async query(
    collectionId: string,
    searchText: string,
    topK: number,
    threshold: number,
    config: VectorRequestConfig,
  ): Promise<VectorQueryResult[]> {
    const embeddings = config.precomputed
      ? embeddingMap(
          [searchText],
          await this.embedTexts([searchText], config.precomputed),
        )
      : undefined;
    const response = await this.post('/api/vector/query',
      requestBody(collectionId, config, {
        searchText,
        topK,
        threshold,
        ...(embeddings ? { embeddings } : {}),
      }));
    const responseRecord = Array.isArray(response) ? {} : response;
    const metadata = Array.isArray(responseRecord['metadata'])
      ? (responseRecord['metadata'] as VectorMetadata[])
      : [];

    return metadata.flatMap((item, rank) => {
      const hash = Number(item.hash);
      const index = Number(item.index);
      if (!Number.isFinite(hash)) {
        return [];
      }
      return [{
        hash,
        text: typeof item.text === 'string' ? item.text : '',
        index: Number.isFinite(index) ? index : -1,
        rank,
      }];
    });
  }

  async list(collectionId: string, config: VectorRequestConfig): Promise<number[]> {
    const response = await this.post('/api/vector/list', requestBody(collectionId, config));
    if (!Array.isArray(response)) {
      return [];
    }
    return response.map(Number).filter(Number.isFinite);
  }

  async delete(collectionId: string, hashes: number[], config: VectorRequestConfig): Promise<void> {
    if (hashes.length === 0) {
      return;
    }
    await this.post('/api/vector/delete', requestBody(collectionId, config, { hashes }));
  }

  async purge(collectionId: string): Promise<void> {
    await this.post('/api/vector/purge', { collectionId });
  }

  private async post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown> | unknown[]> {
    const headers = await getRequestHeaders();
    const response = await fetch(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Vector Storage请求失败：${path}（HTTP ${response.status}）`);
    }
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return {};
    }

    const text = await response.text();
    if (!text) {
      return {};
    }
    try {
      return JSON.parse(text) as Record<string, unknown> | unknown[];
    } catch (error) {
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('json')) {
        throw new Error(`Vector Storage返回了无效JSON：${path}`, { cause: error });
      }
      // SillyTavern mutation routes may acknowledge success with plain "OK".
      return {};
    }
  }
}
