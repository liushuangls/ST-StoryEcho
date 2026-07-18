import { getRequestHeaders } from '../platform/sillytavern';
import { resolveEmbeddingRequestUrl } from './url';

interface EmbeddingResponseItem {
  index?: unknown;
  embedding?: unknown;
}

export interface EmbeddingRequest {
  endpoint: string;
  model: string;
  apiKey: string;
  texts: string[];
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface EmbeddingClient {
  embed(request: EmbeddingRequest): Promise<number[][]>;
}

type RequestHeadersProvider = () => Promise<Record<string, string>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
      if (!Array.isArray(rawVector) || rawVector.length === 0) {
        throw new Error('Embedding接口返回了空向量。');
      }
      const vector = rawVector.map((value) => typeof value === 'number' ? value : Number.NaN);
      if (vector.some((number) => !Number.isFinite(number))) {
        throw new Error('Embedding接口返回了无效向量数值。');
      }
      dimension ??= vector.length;
      if (vector.length !== dimension) {
        throw new Error('Embedding接口返回的向量维度不一致。');
      }
      return vector;
    });
}

function errorMessage(payload: unknown, fallback: string, apiKey: string): string {
  let message = fallback;
  if (isRecord(payload)) {
    const error = payload['error'];
    if (typeof error === 'string') {
      message = error;
    } else if (isRecord(error) && typeof error['message'] === 'string') {
      message = error['message'];
    } else if (typeof payload['message'] === 'string') {
      message = payload['message'];
    }
  }
  const limited = message.replace(/\s+/g, ' ').slice(0, 500);
  return apiKey ? limited.split(apiKey).join('[REDACTED]') : limited;
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
    if (!request.model.trim()) {
      throw new Error('Embedding模型不能为空。');
    }
    const apiKey = request.apiKey.trim();
    if (apiKey.length > 16_384) {
      throw new Error('Embedding API Key过长。');
    }
    if (/[\r\n]/.test(apiKey)) {
      throw new Error('Embedding API Key不能包含换行符。');
    }
    const timeoutMs = Math.min(300_000, Math.max(1_000, Math.floor(request.timeoutMs)));
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort();
    request.signal?.addEventListener('abort', abort, { once: true });
    try {
      const requestUrl = resolveEmbeddingRequestUrl(request.endpoint);
      const response = await this.fetchImpl(requestUrl, {
        method: 'POST',
        headers: {
          ...await this.requestHeaders(),
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: request.model.trim(),
          input: request.texts,
        }),
        signal: controller.signal,
        redirect: 'error',
      });
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > 32 * 1024 * 1024) {
        throw new Error('Embedding接口响应过大。');
      }
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > 32 * 1024 * 1024) {
        throw new Error('Embedding接口响应过大。');
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
        const detail = errorMessage(payload, '', apiKey);
        throw new Error(detail ? `${fallback} ${detail}` : fallback);
      }
      return parseVectors(payload, request.texts.length);
    } catch (error) {
      if (request.signal?.aborted) {
        throw error;
      }
      if (controller.signal.aborted) {
        throw new Error(`Embedding请求超时（${timeoutMs}ms）。`);
      }
      if (error instanceof TypeError) {
        throw new Error('无法连接SillyTavern代理；请检查酒馆地址、网络和enableCorsProxy设置。');
      }
      throw error;
    } finally {
      globalThis.clearTimeout(timeout);
      request.signal?.removeEventListener('abort', abort);
    }
  }
}

export const openAiCompatibleEmbeddingClient = new OpenAiCompatibleEmbeddingClient();
