import { embeddingSecretVault } from '../llm/secret-vault';
import { getRequestHeaders } from '../platform/sillytavern';
import { corsProxyUrl } from './url';

type FetchLike = typeof fetch;
type RequestHeadersProvider = () => Promise<Record<string, string>>;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

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

function parseErrorBody(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    if (typeof parsed.error === 'string') {
      return parsed.error.slice(0, 500);
    }
    if (typeof parsed.error?.message === 'string') {
      return parsed.error.message.slice(0, 500);
    }
    if (typeof parsed.message === 'string') {
      return parsed.message.slice(0, 500);
    }
  } catch {
    // Use the sanitized plain response below.
  }
  return trimmed.replace(/\s+/g, ' ').slice(0, 500);
}

function redactSecret(value: string, secret: string): string {
  return value.split(secret).join('[REDACTED]');
}

async function readLimitedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error('Embedding接口响应过大，已拒绝处理。');
  }
  if (!response.body) {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new Error('Embedding接口响应过大，已拒绝处理。');
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    byteLength += value.byteLength;
    if (byteLength > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('Embedding接口响应过大，已拒绝处理。');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parseVectors(data: unknown, expectedCount: number): number[][] {
  if (typeof data !== 'object' || data === null || !Array.isArray((data as { data?: unknown }).data)) {
    throw new Error('Embedding接口响应缺少data数组。');
  }

  const items = [...((data as { data: EmbeddingResponseItem[] }).data)]
    .sort((left, right) => Number(left.index ?? 0) - Number(right.index ?? 0));
  if (items.length !== expectedCount) {
    throw new Error(`Embedding接口返回${items.length}条向量，预期${expectedCount}条。`);
  }

  let dimension: number | undefined;
  return items.map((item) => {
    if (!Array.isArray(item.embedding) || item.embedding.length === 0) {
      throw new Error('Embedding接口返回了空向量。');
    }
    const vector = item.embedding.map(Number);
    if (vector.some((value) => !Number.isFinite(value))) {
      throw new Error('Embedding接口返回了无效的向量数值。');
    }
    dimension ??= vector.length;
    if (vector.length !== dimension) {
      throw new Error('Embedding接口返回的向量维度不一致。');
    }
    return vector;
  });
}

export class OpenAiCompatibleEmbeddingClient implements EmbeddingClient {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly requestHeaders: RequestHeadersProvider = getRequestHeaders,
  ) {}

  async embed(request: EmbeddingRequest): Promise<number[][]> {
    if (request.texts.length === 0) {
      return [];
    }
    const apiKey = embeddingSecretVault.getSessionKey();
    if (!apiKey) {
      throw new Error('尚未加载Embedding API Key。请在StoryEcho设置中输入。');
    }
    if (!request.model.trim()) {
      throw new Error('Embedding模型不能为空。');
    }

    const timeoutMs = Math.min(300_000, Math.max(1_000, Math.floor(request.timeoutMs)));
    const controller = new AbortController();
    const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const requestBody = JSON.stringify({
        input: request.texts,
        model: request.model,
        encoding_format: 'float',
      });
      const directHeaders = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      };
      let response: Response;
      try {
        response = await this.fetchImpl(request.endpoint, {
          method: 'POST',
          headers: directHeaders,
          body: requestBody,
          signal: controller.signal,
          redirect: 'error',
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw error;
        }
        const proxyHeaders = await this.requestHeaders();
        response = await this.fetchImpl(corsProxyUrl(request.endpoint), {
          method: 'POST',
          headers: {
            ...proxyHeaders,
            ...directHeaders,
          },
          body: requestBody,
          signal: controller.signal,
        });
      }
      const responseText = await readLimitedText(response);
      if (!response.ok) {
        const detail = redactSecret(parseErrorBody(responseText), apiKey);
        if (response.status === 404 && responseText.includes('CORS proxy is disabled')) {
          throw new Error('SillyTavern CORS代理未启用。请在config.yaml设置enableCorsProxy: true并重启酒馆。');
        }
        throw new Error(`Embedding请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
      }

      let data: unknown;
      try {
        data = JSON.parse(responseText);
      } catch {
        throw new Error('Embedding接口返回的不是有效JSON。');
      }
      return parseVectors(data, request.texts.length);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(`Embedding请求超时（${timeoutMs}ms）。`);
      }
      throw error;
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
  }
}

export const openAiCompatibleEmbeddingClient = new OpenAiCompatibleEmbeddingClient();
