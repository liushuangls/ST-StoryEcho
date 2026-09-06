import type { PromptEvalCompletion } from './openai-compatible-client';

export function isPromptEvalTruncated(finishReason: string): boolean {
  const normalized = finishReason.trim().toLowerCase().replace(/[\s-]+/gu, '_');
  return new Set(['length', 'max_token', 'max_tokens', 'max_output_tokens', 'token_limit', 'output_token_limit']).has(normalized);
}

export function assertPromptEvalComplete(completion: PromptEvalCompletion): void {
  if (!completion.text.trim() || isPromptEvalTruncated(completion.finishReason)) {
    throw new Error('评测响应为空或触及输出上限，不能用作完整结果。');
  }
}
