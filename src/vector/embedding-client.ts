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

export type RequestHeadersProvider = () => Promise<Record<string, string>>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateEmbeddingRequest(request: EmbeddingRequest): {
  model: string;
  apiKey: string;
  timeoutMs: number;
} {
  const model = request.model.trim();
  if (!model) {
    throw new Error('Embedding模型不能为空。');
  }
  const apiKey = request.apiKey.trim();
  if (apiKey.length > 16_384) {
    throw new Error('Embedding API Key过长。');
  }
  if (/[\r\n]/.test(apiKey)) {
    throw new Error('Embedding API Key不能包含换行符。');
  }
  return {
    model,
    apiKey,
    timeoutMs: Math.min(300_000, Math.max(1_000, Math.floor(request.timeoutMs))),
  };
}

export function parseEmbeddingVector(rawVector: unknown): number[] {
  if (!Array.isArray(rawVector) || rawVector.length === 0) {
    throw new Error('Embedding接口返回了空向量。');
  }
  const vector = rawVector.map((value) => typeof value === 'number' ? value : Number.NaN);
  if (vector.some((number) => !Number.isFinite(number))) {
    throw new Error('Embedding接口返回了无效向量数值。');
  }
  return vector;
}

export function embeddingErrorMessage(payload: unknown, fallback: string, apiKey: string): string {
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

export function safeEmbeddingFailureDetail(error: unknown, apiKey: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = apiKey ? raw.split(apiKey).join('[REDACTED]') : raw;
  return redacted.replace(/\s+/g, ' ').slice(0, 300) || '未知错误';
}
