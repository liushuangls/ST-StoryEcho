export class LlmRequestTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly upstreamStatus?: number,
  ) {
    super(upstreamStatus
      ? `自定义LLM上游暂时不可用（HTTP ${upstreamStatus}），按超时处理。`
      : `自定义LLM请求超时（${timeoutMs}ms）。`);
    this.name = 'LlmRequestTimeoutError';
  }
}

export function isLlmRequestTimeoutError(error: unknown): error is LlmRequestTimeoutError {
  return error instanceof LlmRequestTimeoutError;
}

const RETRIABLE_UPSTREAM_TIMEOUT_STATUSES = new Set([
  408,
  502,
  503,
  504,
  520,
  521,
  522,
  523,
  524,
]);

export function isRetriableUpstreamTimeoutStatus(status: number): boolean {
  return RETRIABLE_UPSTREAM_TIMEOUT_STATUSES.has(status);
}

export function findRetriableUpstreamTimeoutStatus(message: string): number | null {
  for (const match of message.matchAll(/\b(?:HTTP|status)\s*[:=]?\s*(\d{3})\b/gi)) {
    const status = Number(match[1]);
    if (isRetriableUpstreamTimeoutStatus(status)) {
      return status;
    }
  }
  return null;
}
