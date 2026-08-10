import type {
  LlmCompletionMetadata,
  LlmResponseDiagnostic,
} from '../core/types';

export class LlmEmptyResponseError extends Error {
  constructor(
    message: string,
    readonly completion: LlmCompletionMetadata,
    readonly responseDiagnostic: LlmResponseDiagnostic,
  ) {
    super(message);
    this.name = 'LlmEmptyResponseError';
  }
}

export function isLlmEmptyResponseError(error: unknown): error is LlmEmptyResponseError {
  return error instanceof LlmEmptyResponseError;
}

export class LlmRequestTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly upstreamStatus?: number,
  ) {
    super(upstreamStatus
      ? `LLM上游暂时不可用（HTTP ${upstreamStatus}），按超时处理。`
      : `LLM请求超时（${timeoutMs}ms）。`);
    this.name = 'LlmRequestTimeoutError';
  }
}

export function isLlmRequestTimeoutError(error: unknown): error is LlmRequestTimeoutError {
  return error instanceof LlmRequestTimeoutError;
}

function boundedAttemptError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 500);
}

export class LlmRequestRetryError extends Error {
  readonly attemptErrors: string[];

  constructor(errors: readonly unknown[]) {
    const attemptErrors = errors.map(boundedAttemptError).filter(Boolean);
    const [first = '未知错误', retry = '未知错误'] = attemptErrors;
    super(`内部LLM首次请求失败：${first}；当前批次重试失败：${retry}`);
    this.name = 'LlmRequestRetryError';
    this.attemptErrors = attemptErrors;
  }
}

export function isLlmRequestRetryError(error: unknown): error is LlmRequestRetryError {
  return error instanceof LlmRequestRetryError;
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
