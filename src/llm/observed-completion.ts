import { createUuid } from '../core/uuid';
import type {
  InternalLlmTask,
  LlmCompletionResult,
  LlmRequest,
  StoryEchoChatState,
  StoryEchoSettings,
} from '../core/types';
import { recordInternalLlmAttempt } from '../debug/internal-llm-attempts';
import { tauriTavernAgentBridge } from '../platform/tauritavern-agent';
import { isStoryEchoTaskCancelledError } from '../runtime/task-cancellation';
import { completeWithConfiguredProviderDetailed } from './complete';
import { isLlmEmptyResponseError } from './errors';

interface ObservedCompletionContext {
  task: InternalLlmTask;
  sourceStartMessageId: number;
  sourceEndMessageId: number;
}

function requestedMaxTokens(request: LlmRequest): number {
  return Math.min(10_000, Math.max(16, Math.floor(request.maxTokens ?? 8_192)));
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 500);
}

export async function completeObservedInternalRequest(
  state: StoryEchoChatState,
  settings: StoryEchoSettings,
  request: LlmRequest,
  context: ObservedCompletionContext,
): Promise<LlmCompletionResult> {
  const startedAt = new Date();
  const startedAtMs = performance.now();
  const id = createUuid();
  const agentActiveAtStart = tauriTavernAgentBridge.isRunActive();
  try {
    const result = await completeWithConfiguredProviderDetailed(settings, request);
    const finishedAt = new Date();
    recordInternalLlmAttempt(state, {
      id,
      task: context.task,
      status: 'completed',
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.max(0, Math.round(performance.now() - startedAtMs)),
      sourceStartMessageId: context.sourceStartMessageId,
      sourceEndMessageId: context.sourceEndMessageId,
      requestedMaxTokens: result.metadata.requestedMaxTokens,
      agentActiveAtStart,
      agentActiveAtEnd: tauriTavernAgentBridge.isRunActive(),
      completion: result.metadata,
    });
    return result;
  } catch (error) {
    const finishedAt = new Date();
    const emptyResponse = isLlmEmptyResponseError(error) ? error : null;
    recordInternalLlmAttempt(state, {
      id,
      task: context.task,
      status: isStoryEchoTaskCancelledError(error) ? 'cancelled' : 'failed',
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.max(0, Math.round(performance.now() - startedAtMs)),
      sourceStartMessageId: context.sourceStartMessageId,
      sourceEndMessageId: context.sourceEndMessageId,
      requestedMaxTokens: emptyResponse?.completion.requestedMaxTokens
        ?? requestedMaxTokens(request),
      agentActiveAtStart,
      agentActiveAtEnd: tauriTavernAgentBridge.isRunActive(),
      ...(emptyResponse ? {
        completion: emptyResponse.completion,
        responseDiagnostic: emptyResponse.responseDiagnostic,
      } : {}),
      error: boundedError(error),
    });
    throw error;
  }
}
