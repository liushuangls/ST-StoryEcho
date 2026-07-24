import { logger } from '../core/logger';
import { readResponseTextWithLimit } from '../http/response';
import { getRequestHeaders } from '../platform/sillytavern';
import {
  embeddingErrorMessage,
  isRecord,
  parseEmbeddingVector,
  safeEmbeddingFailureDetail,
  validateEmbeddingRequest,
} from './embedding-client';
import type { EmbeddingClient, EmbeddingRequest, RequestHeadersProvider } from './embedding-client';
import { resolveEmbeddingRequestUrl } from './url';

export type { EmbeddingClient, EmbeddingRequest } from './embedding-client';

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const RESPONSE_TOO_LARGE_MESSAGE = 'Embedding接口响应过大。';

interface EmbeddingResponseItem {
  index?: unknown;
  embedding?: unknown;
}

function parseVectors(payload: unknown, expectedCount: number): number[][] {
  const record = isRecord(payload) ? payload : {};
  const value = Array.isArray(record['data'])
    ? record['data']
    : Array.isArray(record['embeddings'])
      ? record['embeddings']
      : null;
  if (!value) {
    throw new Error('Embedding接口响应缺少data或embeddings数组。');
  }
  if (value.length !== expectedCount) {
    throw new Error(`Embedding接口返回${value.length}条向量，预期${expectedCount}条。`);
  }

  let dimension: number | undefined;
  return (value as EmbeddingResponseItem[])
    .map((item, fallbackIndex) => {
      const rawIndex = Array.isArray(item) ? undefined : item.index;
      const index = rawIndex === undefined ? fallbackIndex : Number(rawIndex);
      if (!Number.isInteger(index) || index < 0 || index >= expectedCount) {
        throw new Error('Embedding接口返回了无效向量索引。');
      }
      return { item, index };
    })
    .sort((left, right) => left.index - right.index)
    .map(({ item, index }, position) => {
      if (index !== position) {
        throw new Error('Embedding接口返回了重复或缺失的向量索引。');
      }
      const rawVector = Array.isArray(item) ? item : item.embedding;
      const vector = parseEmbeddingVector(rawVector);
      dimension ??= vector.length;
      if (vector.length !== dimension) {
        throw new Error('Embedding接口返回的向量维度不一致。');
      }
      return vector;
    });
}

export class OpenAiCompatibleEmbeddingClient implements EmbeddingClient {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly requestHeaders: RequestHeadersProvider = getRequestHeaders,
  ) {}

  async embed(request: EmbeddingRequest): Promise<number[][]> {
    if (request.texts.length === 0) {
      return [];
    }
    const { model, apiKey, timeoutMs } = validateEmbeddingRequest(request);
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort();
    request.signal?.addEventListener('abort', abort, { once: true });
    try {
      let requestUrl: string;
      try {
        requestUrl = resolveEmbeddingRequestUrl(request.endpoint);
      } catch (error) {
        throw new Error(`构造Embedding代理地址失败：${safeEmbeddingFailureDetail(error, apiKey)}`);
      }

      let headers: Record<string, string>;
      try {
        headers = {
          ...await this.requestHeaders(),
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        };
      } catch (error) {
        throw new Error(`读取SillyTavern请求头失败：${safeEmbeddingFailureDetail(error, apiKey)}`);
      }

      let response: Response;
      try {
        response = await this.fetchImpl.call(globalThis, requestUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            input: request.texts,
          }),
          signal: controller.signal,
          redirect: 'error',
        });
      } catch (error) {
        if (request.signal?.aborted) {
          throw error;
        }
        if (controller.signal.aborted) {
          throw new Error(`Embedding请求超时（${timeoutMs}ms）。`);
        }
        if (error instanceof TypeError) {
          logger.error('Embedding代理请求失败。', error);
          throw new Error(
            `无法连接SillyTavern代理：${safeEmbeddingFailureDetail(error, apiKey)}；请检查酒馆地址、网络和enableCorsProxy设置。`,
          );
        }
        throw error;
      }
      let text: string;
      try {
        text = await readResponseTextWithLimit(
          response,
          MAX_RESPONSE_BYTES,
          RESPONSE_TOO_LARGE_MESSAGE,
        );
      } catch (error) {
        if (error instanceof Error && error.message === RESPONSE_TOO_LARGE_MESSAGE) {
          throw error;
        }
        throw new Error(`读取Embedding代理响应失败：${safeEmbeddingFailureDetail(error, apiKey)}`);
      }
      let payload: unknown = null;
      try {
        payload = text ? JSON.parse(text) as unknown : null;
      } catch {
        if (response.ok) {
          throw new Error('Embedding接口返回了非JSON响应。');
        }
      }
      if (!response.ok) {
        if (text.includes('CORS proxy is disabled')) {
          throw new Error(
            'SillyTavern CORS代理未启用；请在config.yaml设置enableCorsProxy: true并重启酒馆。',
          );
        }
        const fallback = `Embedding请求失败（HTTP ${response.status}）。`;
        const detail = embeddingErrorMessage(payload, '', apiKey);
        throw new Error(detail ? `${fallback} ${detail}` : fallback);
      }
      return parseVectors(payload, request.texts.length);
    } finally {
      globalThis.clearTimeout(timeout);
      request.signal?.removeEventListener('abort', abort);
    }
  }
}

export const openAiCompatibleEmbeddingClient = new OpenAiCompatibleEmbeddingClient();
