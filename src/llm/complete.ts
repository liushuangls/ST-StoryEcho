import type { LlmRequest, StoryEchoSettings } from '../core/types';
import { logger } from '../core/logger';
import { MainLlmProvider } from './main-provider';
import { createLlmProvider } from './provider-factory';

const MAX_RETRY_TOKENS = 8_192;

async function completeNonEmpty(
  provider: ReturnType<typeof createLlmProvider> | MainLlmProvider,
  request: LlmRequest,
): Promise<string> {
  const first = await provider.complete(request);
  if (first.trim()) {
    return first;
  }
  if (request.signal?.aborted) {
    throw new Error('LLM请求已取消。');
  }

  const initialBudget = Math.max(128, Math.floor(request.maxTokens ?? 1_024));
  const retryBudget = Math.min(MAX_RETRY_TOKENS, initialBudget * 2);
  logger.warn(`内部LLM返回空内容，使用 ${retryBudget} Token预算重试一次。`);
  const second = await provider.complete({
    ...request,
    maxTokens: retryBudget,
  });
  if (!second.trim()) {
    throw new Error('内部LLM连续两次返回空内容。');
  }
  return second;
}

export async function completeWithConfiguredProvider(
  settings: StoryEchoSettings,
  request: LlmRequest,
): Promise<string> {
  const provider = createLlmProvider(settings);
  try {
    return await completeNonEmpty(provider, request);
  } catch (error) {
    if (request.signal?.aborted) {
      throw error;
    }
    if (provider.id !== 'openai-compatible' || !settings.llm.custom.fallbackToMain) {
      throw error;
    }
    logger.warn('自定义LLM调用失败，回退到SillyTavern主连接。', error);
    return completeNonEmpty(new MainLlmProvider(), request);
  }
}
