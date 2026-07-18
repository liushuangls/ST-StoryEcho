import { logger } from '../core/logger';
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

const DEFAULT_CONCURRENCY = 4;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

function parseVolcengineVector(payload: unknown): number[] {
  const record = isRecord(payload) ? payload : {};
  const data = isRecord(record['data']) ? record['data'] : null;
  if (!data || !Object.hasOwn(data, 'embedding')) {
    throw new Error('火山方舟Embedding接口响应缺少data.embedding。');
  }
  return parseEmbeddingVector(data['embedding']);
}

export class VolcengineMultimodalEmbeddingClient implements EmbeddingClient {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly requestHeaders: RequestHeadersProvider = getRequestHeaders,
    private readonly concurrency = DEFAULT_CONCURRENCY,
  ) {}

  async embed(request: EmbeddingRequest): Promise<number[][]> {
    if (request.texts.length === 0) {
      return [];
    }
    const { model, apiKey, timeoutMs } = validateEmbeddingRequest(request);
    let requestUrl: string;
    try {
      requestUrl = resolveEmbeddingRequestUrl(request.endpoint);
    } catch (error) {
      throw new Error(`构造火山方舟Embedding代理地址失败：${safeEmbeddingFailureDetail(error, apiKey)}`);
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

    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort();
    request.signal?.addEventListener('abort', abort, { once: true });
    const vectors = new Array<number[]>(request.texts.length);
    let nextIndex = 0;

    const requestOne = async (text: string): Promise<number[]> => {
      let response: Response;
      try {
        response = await this.fetchImpl.call(globalThis, requestUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            input: [{ type: 'text', text }],
            encoding_format: 'float',
          }),
          signal: controller.signal,
          redirect: 'error',
        });
      } catch (error) {
        if (request.signal?.aborted) {
          throw error;
        }
        if (controller.signal.aborted) {
          throw new Error(`火山方舟Embedding请求超时（${timeoutMs}ms）。`);
        }
        if (error instanceof TypeError) {
          logger.error('火山方舟Embedding代理请求失败。', error);
          throw new Error(
            `无法连接SillyTavern代理：${safeEmbeddingFailureDetail(error, apiKey)}；请检查酒馆地址、网络和enableCorsProxy设置。`,
          );
        }
        throw error;
      }

      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        throw new Error('火山方舟Embedding接口响应过大。');
      }
      let responseText: string;
      try {
        responseText = await response.text();
      } catch (error) {
        throw new Error(`读取火山方舟Embedding代理响应失败：${safeEmbeddingFailureDetail(error, apiKey)}`);
      }
      if (new TextEncoder().encode(responseText).byteLength > MAX_RESPONSE_BYTES) {
        throw new Error('火山方舟Embedding接口响应过大。');
      }
      let payload: unknown = null;
      try {
        payload = responseText ? JSON.parse(responseText) as unknown : null;
      } catch {
        if (response.ok) {
          throw new Error('火山方舟Embedding接口返回了非JSON响应。');
        }
      }
      if (!response.ok) {
        if (responseText.includes('CORS proxy is disabled')) {
          throw new Error(
            'SillyTavern CORS代理未启用；请在config.yaml设置enableCorsProxy: true并重启酒馆。',
          );
        }
        const fallback = `火山方舟Embedding请求失败（HTTP ${response.status}）。`;
        const detail = embeddingErrorMessage(payload, '', apiKey);
        throw new Error(detail ? `${fallback} ${detail}` : fallback);
      }
      return parseVolcengineVector(payload);
    };

    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= request.texts.length) {
          return;
        }
        vectors[index] = await requestOne(request.texts[index] ?? '');
      }
    };

    try {
      const workerCount = Math.max(1, Math.min(Math.floor(this.concurrency), request.texts.length));
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      const dimension = vectors[0]?.length;
      if (!dimension || vectors.some((vector) => vector.length !== dimension)) {
        throw new Error('火山方舟Embedding接口返回的向量维度不一致。');
      }
      return vectors;
    } catch (error) {
      controller.abort();
      throw error;
    } finally {
      globalThis.clearTimeout(timeout);
      request.signal?.removeEventListener('abort', abort);
    }
  }
}

export const volcengineMultimodalEmbeddingClient = new VolcengineMultimodalEmbeddingClient();
