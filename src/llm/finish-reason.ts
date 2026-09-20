const OUTPUT_LIMIT_REASONS = new Set([
  'length', 'max_token', 'max_tokens', 'max_output_tokens', 'token_limit', 'output_token_limit',
]);

/** Missing finish metadata is not proof of truncation. Never infer from prose. */
export function outputLimitReached(finishReason: string | undefined): boolean {
  const reason = finishReason?.trim().toLowerCase().replace(/[\s-]+/gu, '_');
  return Boolean(reason && OUTPUT_LIMIT_REASONS.has(reason));
}
