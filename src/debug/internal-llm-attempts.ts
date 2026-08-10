import type {
  InternalLlmAttempt,
  StoryEchoChatState,
} from '../core/types';
import { normalizeLlmCompletionMetadata } from '../llm/completion-metadata';
import { normalizeLlmResponseDiagnostic } from '../llm/response-diagnostic';

export const MAX_INTERNAL_LLM_ATTEMPTS = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback;
}

function optionalMessageId(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

function normalizeAttempt(value: unknown): InternalLlmAttempt | null {
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'string' ||
    !['stage-summary', 'summary-compaction'].includes(String(value['task'])) ||
    !['completed', 'cancelled', 'failed'].includes(String(value['status'])) ||
    typeof value['startedAt'] !== 'string' ||
    typeof value['finishedAt'] !== 'string'
  ) {
    return null;
  }
  const sourceStartMessageId = optionalMessageId(value['sourceStartMessageId']);
  const sourceEndMessageId = optionalMessageId(value['sourceEndMessageId']);
  const completion = normalizeLlmCompletionMetadata(value['completion']);
  const responseDiagnostic = normalizeLlmResponseDiagnostic(value['responseDiagnostic']);
  const error = typeof value['error'] === 'string'
    ? value['error'].replace(/\s+/gu, ' ').trim().slice(0, 500)
    : '';
  const attemptErrors = Array.isArray(value['attemptErrors'])
    ? value['attemptErrors']
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.replace(/\s+/gu, ' ').trim().slice(0, 500))
      .filter(Boolean)
      .slice(0, 4)
    : [];
  return {
    id: value['id'].slice(0, 200),
    task: value['task'] as InternalLlmAttempt['task'],
    status: value['status'] as InternalLlmAttempt['status'],
    startedAt: value['startedAt'],
    finishedAt: value['finishedAt'],
    durationMs: finiteInteger(value['durationMs'], 0),
    ...(sourceStartMessageId !== undefined ? { sourceStartMessageId } : {}),
    ...(sourceEndMessageId !== undefined ? { sourceEndMessageId } : {}),
    requestedMaxTokens: finiteInteger(value['requestedMaxTokens'], 0),
    agentActiveAtStart: value['agentActiveAtStart'] === true,
    agentActiveAtEnd: value['agentActiveAtEnd'] === true,
    ...(completion ? { completion } : {}),
    ...(responseDiagnostic ? { responseDiagnostic } : {}),
    ...(attemptErrors.length > 0 ? { attemptErrors } : {}),
    ...(error ? { error } : {}),
  };
}

export function normalizeInternalLlmAttempts(value: unknown): InternalLlmAttempt[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .flatMap((candidate) => {
      const attempt = normalizeAttempt(candidate);
      return attempt ? [attempt] : [];
    })
    .slice(-MAX_INTERNAL_LLM_ATTEMPTS);
}

export function recordInternalLlmAttempt(
  state: StoryEchoChatState,
  attempt: InternalLlmAttempt,
): void {
  state.recentInternalLlmAttempts.push(attempt);
  if (state.recentInternalLlmAttempts.length > MAX_INTERNAL_LLM_ATTEMPTS) {
    state.recentInternalLlmAttempts.splice(
      0,
      state.recentInternalLlmAttempts.length - MAX_INTERNAL_LLM_ATTEMPTS,
    );
  }
}

/** Preserve attempts recorded on an operation snapshot when committing into a live state clone. */
export function mergeInternalLlmAttempts(
  target: StoryEchoChatState,
  source: StoryEchoChatState,
): void {
  const byId = new Map(
    [...target.recentInternalLlmAttempts, ...source.recentInternalLlmAttempts]
      .map((attempt) => [attempt.id, attempt] as const),
  );
  target.recentInternalLlmAttempts = [...byId.values()].slice(-MAX_INTERNAL_LLM_ATTEMPTS);
}
