import type { LlmCompletionMetadata, LlmCompletionResult } from '../core/types';
import { LlmRefusalError, LlmTruncatedResponseError } from './errors';
import { outputLimitReached } from './finish-reason';

const BLOCKED_FINISH_REASONS = new Set([
  'CONTENT_FILTER', 'REFUSAL', 'SAFETY', 'BLOCKLIST',
  'PROHIBITED_CONTENT', 'SPII', 'RECITATION', 'MODEL_ARMOR',
]);

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function first(value: unknown): Record<string, unknown> {
  return Array.isArray(value) ? record(value[0]) : {};
}

function blockedFinishReason(value: unknown): boolean {
  return typeof value === 'string' && BLOCKED_FINISH_REASONS.has(value.trim().toUpperCase());
}

function refusalMessage(value: unknown): boolean {
  const message = record(value);
  if (typeof message['refusal'] === 'string' && message['refusal'].trim()) {
    return true;
  }
  return Array.isArray(message['content']) && message['content'].some(
    (part: unknown) => record(part)['type'] === 'refusal',
  );
}

/** Inspect protocol signals only; a story mentioning rejection is not a refusal. */
export function assertNoLlmRefusal(
  payload: unknown,
  completion?: LlmCompletionMetadata,
): void {
  const root = record(payload);
  const choice = first(root['choices']);
  const candidate = first(root['candidates']);
  const delta = record(root['delta']);
  const feedback = record(root['promptFeedback']);
  const blockReason = typeof feedback['blockReason'] === 'string'
    ? feedback['blockReason'].trim().toUpperCase()
    : '';
  const blockedPrompt = Boolean(blockReason && blockReason !== 'BLOCK_REASON_UNSPECIFIED');
  const blocked = [
    choice['finish_reason'], choice['stop_reason'], root['finish_reason'],
    root['stop_reason'], root['stopReason'], delta['stop_reason'], candidate['finishReason'],
  ].some(blockedFinishReason);
  const refusal = [root, choice['message'], choice['delta'], root['message'], delta]
    .some(refusalMessage);
  if (blockedPrompt || blocked || refusal
    || root['type'] === 'response.refusal.delta'
    || root['type'] === 'response.refusal.done') {
    throw new LlmRefusalError(completion);
  }
}

function looksLikeRefusalText(text: string): boolean {
  const opening = text.trim()
    .replace(/^```(?:text|markdown|md)?\s*/iu, '')
    .replace(/^<story_echo_summary>\s*/iu, '')
    .replace(/^[*#_\s]+/u, '')
    .slice(0, 600);
  // Anchor to the model speaking about its task. Do not keyword-scan the
  // summary body, where refusals, boundaries and quoted dialogue are facts.
  const chinese = /^(?:(?:很|非常)?抱歉|对不起|很遗憾)?[，,。！!：:\s]*(?:作为(?:一[个名])?(?:AI|人工智能|语言模型)[^。！？\n]{0,60}[，,]\s*)?我(?:无法|不能|不便|不会)(?:帮助|协助|为(?:你|您|这|该|包含|涉及)|对(?:此|这|该|包含|涉及)|继续|提供|生成|总结|概述|处理|完成|支持|满足|执行)/iu;
  const apologetic = /^(?:(?:很|非常)?抱歉|对不起|很遗憾)[^。！？\n]{0,180}(?:无法|不能|不便)(?:帮助|协助|提供|生成|总结|概述|处理|完成|继续)/u;
  const english = /^(?:(?:i(?:['’]m| am) (?:sorry|afraid)|sorry)[,.:!\s]*)?(?:as an? (?:ai|language model)[^.!?\n]{0,80},\s*)?i (?:cannot|can['’]t|am unable to|won['’]t|must decline to|am not able to)\s+(?:help|assist|summari[sz]e|provide|generate|process|comply|fulfil|continue)/iu;
  return chinese.test(opening) || apologetic.test(opening) || english.test(opening);
}

export function assertSummaryCompletionAccepted(result: LlmCompletionResult): void {
  if (blockedFinishReason(result.metadata.finishReason) || looksLikeRefusalText(result.text)) {
    throw new LlmRefusalError(result.metadata);
  }
  if (outputLimitReached(result.metadata.finishReason)) {
    throw new LlmTruncatedResponseError(result.metadata);
  }
}
