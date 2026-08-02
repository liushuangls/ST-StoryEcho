import type {
  LlmCompletionMetadata,
  LlmProviderId,
} from '../core/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (
      (typeof value !== 'number' && typeof value !== 'string') ||
      (typeof value === 'string' && !value.trim())
    ) {
      continue;
    }
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) {
      return Math.floor(number);
    }
  }
  return undefined;
}

function boundedString(value: unknown, maximumLength = 200): string | undefined {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, maximumLength)
    : undefined;
}

function nestedRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  return isRecord(value) ? value : {};
}

export function completionMetadataFromPayload(
  payload: unknown,
  options: {
    provider: LlmProviderId;
    requestedMaxTokens: number;
    responseText: string;
    source?: string;
    model?: string;
  },
): LlmCompletionMetadata {
  const root = isRecord(payload) ? payload : {};
  const choices = Array.isArray(root['choices']) ? root['choices'] : [];
  const choice = isRecord(choices[0]) ? choices[0] : {};
  const candidates = Array.isArray(root['candidates']) ? root['candidates'] : [];
  const candidate = isRecord(candidates[0]) ? candidates[0] : {};
  const usage = nestedRecord(root, 'usage');
  const usageMetadata = nestedRecord(root, 'usageMetadata');
  const completionDetails = nestedRecord(usage, 'completion_tokens_details');
  const outputDetails = nestedRecord(usage, 'output_tokens_details');
  const promptTokens = nonNegativeInteger(
    usage['prompt_tokens'],
    usage['input_tokens'],
    usageMetadata['promptTokenCount'],
  );
  const completionTokens = nonNegativeInteger(
    usage['completion_tokens'],
    usage['output_tokens'],
    usageMetadata['candidatesTokenCount'],
  );
  const reasoningTokens = nonNegativeInteger(
    completionDetails['reasoning_tokens'],
    outputDetails['reasoning_tokens'],
    usage['reasoning_tokens'],
    usageMetadata['thoughtsTokenCount'],
  );
  const totalTokens = nonNegativeInteger(
    usage['total_tokens'],
    usageMetadata['totalTokenCount'],
    promptTokens !== undefined && completionTokens !== undefined
      ? promptTokens + completionTokens
      : undefined,
  );
  const finishReason = boundedString(
    choice['finish_reason']
      ?? choice['stop_reason']
      ?? root['finish_reason']
      ?? root['stop_reason']
      ?? root['stopReason']
      ?? candidate['finishReason'],
  );
  const source = boundedString(options.source);
  const model = boundedString(root['model'] ?? options.model);

  return {
    provider: options.provider,
    requestedMaxTokens: Math.max(0, Math.floor(options.requestedMaxTokens)),
    ...(finishReason ? { finishReason } : {}),
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    responseCharacters: Array.from(options.responseText).length,
    ...(source ? { source } : {}),
    ...(model ? { model } : {}),
  };
}

export function normalizeLlmCompletionMetadata(
  value: unknown,
): LlmCompletionMetadata | undefined {
  if (!isRecord(value) || !['main', 'openai-compatible'].includes(String(value['provider']))) {
    return undefined;
  }
  const requestedMaxTokens = nonNegativeInteger(value['requestedMaxTokens']);
  const responseCharacters = nonNegativeInteger(value['responseCharacters']);
  if (requestedMaxTokens === undefined || responseCharacters === undefined) {
    return undefined;
  }
  const finishReason = boundedString(value['finishReason']);
  const source = boundedString(value['source']);
  const model = boundedString(value['model']);
  const fallbackFrom = ['main', 'openai-compatible'].includes(String(value['fallbackFrom']))
    ? value['fallbackFrom'] as LlmProviderId
    : undefined;
  const promptTokens = nonNegativeInteger(value['promptTokens']);
  const completionTokens = nonNegativeInteger(value['completionTokens']);
  const reasoningTokens = nonNegativeInteger(value['reasoningTokens']);
  const totalTokens = nonNegativeInteger(value['totalTokens']);
  return {
    provider: value['provider'] as LlmProviderId,
    requestedMaxTokens,
    ...(finishReason ? { finishReason } : {}),
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    responseCharacters,
    ...(source ? { source } : {}),
    ...(model ? { model } : {}),
    ...(fallbackFrom ? { fallbackFrom } : {}),
  };
}
