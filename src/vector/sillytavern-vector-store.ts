import { getRequestHeaders } from '../platform/sillytavern';
import { readResponseTextWithLimit } from '../http/response';
import {
  runStoryEchoTaskAbortable,
} from '../runtime/task-cancellation';
import { storyEchoTaskCoordinator } from '../runtime/task-coordinator';
import type {
  VectorItem,
  VectorQueryResult,
  VectorRequestConfig,
  VectorRequestOptions,
  VectorStoreAdapter,
} from './adapter';
import type { EmbeddingClientResolver } from './embedding-providers';
import { resolveEmbeddingClient } from './embedding-providers';

const EMBEDDING_BATCH_SIZE = 64;
const DEFAULT_VECTOR_QUERY_TIMEOUT_MS = 30_000;
const DEFAULT_VECTOR_MUTATION_TIMEOUT_MS = 120_000;
const MAX_VECTOR_REQUEST_TIMEOUT_MS = 300_000;
const MAX_VECTOR_RESPONSE_BYTES = 8 * 1024 * 1024;
export const FOREGROUND_VECTOR_QUERY_TIMEOUT_MS = 8_000;

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
    signal: AbortSignal,
  ): Promise<number[][]> {
    const embeddingClient = this.embeddingClientResolver(config.provider);
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
      vectors.push(...await embeddingClient.embed({
        ...config,
        texts: texts.slice(start, start + EMBEDDING_BATCH_SIZE),
        signal,
      }));
    }
    return vectors;
  }

  async insert(
    collectionId: string,
    items: VectorItem[],
    config: VectorRequestConfig,
    options?: VectorRequestOptions,
  ): Promise<void> {
    if (items.length === 0) {
      return;
    }
    await this.runRequest('写入', DEFAULT_VECTOR_MUTATION_TIMEOUT_MS, options, async (signal) => {
      const embeddings = config.precomputed
        ? embeddingMap(
            items.map((item) => item.text),
            await this.embedTexts(items.map((item) => item.text), config.precomputed, signal),
          )
        : undefined;
      await this.post('/api/vector/insert', requestBody(collectionId, config, {
        items,
        ...(embeddings ? { embeddings } : {}),
      }), signal);
    });
  }

  async query(
    collectionId: string,
    searchText: string,
    topK: number,
    threshold: number,
    config: VectorRequestConfig,
    options?: VectorRequestOptions,
  ): Promise<VectorQueryResult[]> {
    return this.runRequest('查询', DEFAULT_VECTOR_QUERY_TIMEOUT_MS, options, async (signal) => {
      const embeddings = config.precomputed
        ? embeddingMap(
            [searchText],
            await this.embedTexts([searchText], config.precomputed, signal),
          )
        : undefined;
      const response = await this.post('/api/vector/query',
        requestBody(collectionId, config, {
          searchText,
          topK,
          threshold,
          ...(embeddings ? { embeddings } : {}),
        }),
        signal);
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
    });
  }

  async list(
    collectionId: string,
    config: VectorRequestConfig,
    options?: VectorRequestOptions,
  ): Promise<number[]> {
    return this.runRequest('读取', DEFAULT_VECTOR_QUERY_TIMEOUT_MS, options, async (signal) => {
      const response = await this.post(
        '/api/vector/list',
        requestBody(collectionId, config),
        signal,
      );
      if (!Array.isArray(response)) {
        return [];
      }
      return response.map(Number).filter(Number.isFinite);
    });
  }

  async delete(
    collectionId: string,
    hashes: number[],
    config: VectorRequestConfig,
    options?: VectorRequestOptions,
  ): Promise<void> {
    if (hashes.length === 0) {
      return;
    }
    await this.runRequest('删除', DEFAULT_VECTOR_MUTATION_TIMEOUT_MS, options, async (signal) => {
      await this.post(
        '/api/vector/delete',
        requestBody(collectionId, config, { hashes }),
        signal,
      );
    });
  }

  async purge(collectionId: string, options?: VectorRequestOptions): Promise<void> {
    await this.runRequest('清空', DEFAULT_VECTOR_MUTATION_TIMEOUT_MS, options, async (signal) => {
      await this.post('/api/vector/purge', { collectionId }, signal);
    });
  }

  private async runRequest<T>(
    operationName: string,
    defaultTimeoutMs: number,
    options: VectorRequestOptions | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const upstreamSignal = options?.signal ?? storyEchoTaskCoordinator.activeTaskSignal();
    const timeoutMs = Math.min(
      MAX_VECTOR_REQUEST_TIMEOUT_MS,
      Math.max(1, Math.floor(options?.timeoutMs ?? defaultTimeoutMs)),
    );
    const controller = new AbortController();
    const abortFromUpstream = (): void => {
      controller.abort(upstreamSignal?.reason);
    };
    if (upstreamSignal?.aborted) {
      abortFromUpstream();
    } else {
      upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
    }
    const timeoutError = new Error(`Vector Storage${operationName}超时（${timeoutMs}ms）。`);
    const timeout = globalThis.setTimeout(() => controller.abort(timeoutError), timeoutMs);
    try {
      return await runStoryEchoTaskAbortable(
        () => operation(controller.signal),
        controller.signal,
      );
    } finally {
      globalThis.clearTimeout(timeout);
      upstreamSignal?.removeEventListener('abort', abortFromUpstream);
    }
  }

  private async post(
    path: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | unknown[]> {
    const headers = await getRequestHeaders();
    const response = await fetch(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Vector Storage请求失败：${path}（HTTP ${response.status}）`);
    }
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return {};
    }

    const text = await readResponseTextWithLimit(
      response,
      MAX_VECTOR_RESPONSE_BYTES,
      `Vector Storage响应过大：${path}`,
    );
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
