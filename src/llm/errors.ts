export class LlmRequestTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`自定义LLM请求超时（${timeoutMs}ms）。`);
    this.name = 'LlmRequestTimeoutError';
  }
}

export function isLlmRequestTimeoutError(error: unknown): error is LlmRequestTimeoutError {
  return error instanceof LlmRequestTimeoutError;
}
