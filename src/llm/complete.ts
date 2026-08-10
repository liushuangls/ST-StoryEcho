import { logger } from '../core/logger';
import type {
  LlmCompletionResult,
  LlmProvider,
  LlmRequest,
  StoryEchoSettings,
} from '../core/types';
import { throwIfStoryEchoTaskCancelled } from '../runtime/task-cancellation';
import {
  BackgroundYieldForForegroundError,
  storyEchoTaskCoordinator,
} from '../runtime/task-coordinator';
import { isLlmRequestTimeoutError, LlmRequestRetryError } from './errors';
import { MainLlmProvider } from './main-provider';
import { createLlmProvider } from './provider-factory';

const MAX_RETRY_TOKENS = 10_000;
export const MAX_LLM_TIMEOUT_RETRIES = 1;

function withActiveTaskSignal(request: LlmRequest): LlmRequest {
  if (request.signal) {
    return request;
  }
  const signal = storyEchoTaskCoordinator.activeTaskSignal();
  return signal ? { ...request, signal } : request;
}

function yieldBackgroundAtRetryBoundary(): void {
  if (storyEchoTaskCoordinator.shouldYieldBackgroundToForeground()) {
    throw new BackgroundYieldForForegroundError();
  }
}

async function completeNonEmpty(
  provider: LlmProvider,
  request: LlmRequest,
): Promise<string> {
  const first = await provider.complete(request);
  if (first.trim()) {
    return first;
  }
  throwIfStoryEchoTaskCancelled(request.signal);
  yieldBackgroundAtRetryBoundary();

  const initialBudget = Math.max(128, Math.floor(request.maxTokens ?? 1_024));
  const retryBudget = Math.min(MAX_RETRY_TOKENS, initialBudget * 2);
  logger.warn(`内部LLM返回空内容，使用 ${retryBudget} Token预算重试一次。`);
  const second = await provider.complete({ ...request, maxTokens: retryBudget });
  if (!second.trim()) {
    throw new Error('内部LLM连续两次返回空内容。');
  }
  return second;
}

async function completeNonEmptyWithTimeoutRetry(
  provider: LlmProvider,
  request: LlmRequest,
): Promise<string> {
  const priorErrors: unknown[] = [];
  for (let retry = 0; ; retry += 1) {
    try {
      return await completeNonEmpty(provider, request);
    } catch (error) {
      throwIfStoryEchoTaskCancelled(request.signal);
      if (!isLlmRequestTimeoutError(error) || retry >= MAX_LLM_TIMEOUT_RETRIES) {
        if (priorErrors.length > 0) {
          throw new LlmRequestRetryError([...priorErrors, error]);
        }
        throw error;
      }
      priorErrors.push(error);
      yieldBackgroundAtRetryBoundary();
      logger.warn(`内部LLM请求超时，仅重试当前请求（${retry + 1}/${MAX_LLM_TIMEOUT_RETRIES}）。`);
    }
  }
}

async function providerCompleteDetailed(
  provider: LlmProvider,
  request: LlmRequest,
): Promise<LlmCompletionResult> {
  if (provider.completeDetailed) {
    return provider.completeDetailed(request);
  }
  const text = await provider.complete(request);
  return {
    text,
    metadata: {
      provider: provider.id,
      requestedMaxTokens: Math.min(
        MAX_RETRY_TOKENS,
        Math.max(16, Math.floor(request.maxTokens ?? 8_192)),
      ),
      responseCharacters: Array.from(text).length,
    },
  };
}

async function completeNonEmptyDetailed(
  provider: LlmProvider,
  request: LlmRequest,
): Promise<LlmCompletionResult> {
  const first = await providerCompleteDetailed(provider, request);
  if (first.text.trim()) {
    return first;
  }
  throwIfStoryEchoTaskCancelled(request.signal);
  yieldBackgroundAtRetryBoundary();

  const initialBudget = Math.max(128, Math.floor(request.maxTokens ?? 1_024));
  const retryBudget = Math.min(MAX_RETRY_TOKENS, initialBudget * 2);
  logger.warn(`内部LLM返回空内容，使用 ${retryBudget} Token预算重试一次。`);
  const second = await providerCompleteDetailed(provider, {
    ...request,
    maxTokens: retryBudget,
  });
  if (!second.text.trim()) {
    throw new Error('内部LLM连续两次返回空内容。');
  }
  return second;
}

async function completeNonEmptyDetailedWithTimeoutRetry(
  provider: LlmProvider,
  request: LlmRequest,
): Promise<LlmCompletionResult> {
  const priorErrors: unknown[] = [];
  for (let retry = 0; ; retry += 1) {
    try {
      return await completeNonEmptyDetailed(provider, request);
    } catch (error) {
      throwIfStoryEchoTaskCancelled(request.signal);
      if (!isLlmRequestTimeoutError(error) || retry >= MAX_LLM_TIMEOUT_RETRIES) {
        if (priorErrors.length > 0) {
          throw new LlmRequestRetryError([...priorErrors, error]);
        }
        throw error;
      }
      priorErrors.push(error);
      yieldBackgroundAtRetryBoundary();
      logger.warn(`内部LLM请求超时，仅重试当前请求（${retry + 1}/${MAX_LLM_TIMEOUT_RETRIES}）。`);
    }
  }
}

export async function completeWithConfiguredProvider(
  settings: StoryEchoSettings,
  request: LlmRequest,
): Promise<string> {
  request = withActiveTaskSignal(request);
  const provider = createLlmProvider(settings);
  try {
    return await completeNonEmptyWithTimeoutRetry(provider, request);
  } catch (error) {
    throwIfStoryEchoTaskCancelled(request.signal);
    if (provider.id !== 'openai-compatible' || !settings.llm.custom.fallbackToMain) {
      throw error;
    }
    yieldBackgroundAtRetryBoundary();
    logger.warn('自定义LLM调用失败，回退到SillyTavern主连接。', error);
    return completeNonEmptyWithTimeoutRetry(new MainLlmProvider(), request);
  }
}

export async function completeWithConfiguredProviderDetailed(
  settings: StoryEchoSettings,
  request: LlmRequest,
): Promise<LlmCompletionResult> {
  request = withActiveTaskSignal(request);
  const provider = createLlmProvider(settings);
  try {
    return await completeNonEmptyDetailedWithTimeoutRetry(provider, request);
  } catch (error) {
    throwIfStoryEchoTaskCancelled(request.signal);
    if (provider.id !== 'openai-compatible' || !settings.llm.custom.fallbackToMain) {
      throw error;
    }
    yieldBackgroundAtRetryBoundary();
    logger.warn('自定义LLM调用失败，回退到SillyTavern主连接。', error);
    const result = await completeNonEmptyDetailedWithTimeoutRetry(
      new MainLlmProvider(),
      request,
    );
    return {
      ...result,
      metadata: {
        ...result.metadata,
        fallbackFrom: provider.id,
      },
    };
  }
}
