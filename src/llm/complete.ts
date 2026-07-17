import type { LlmRequest, StoryEchoSettings } from '../core/types';
import { logger } from '../core/logger';
import { MainLlmProvider } from './main-provider';
import { createLlmProvider } from './provider-factory';

export async function completeWithConfiguredProvider(
  settings: StoryEchoSettings,
  request: LlmRequest,
): Promise<string> {
  const provider = createLlmProvider(settings);
  try {
    return await provider.complete(request);
  } catch (error) {
    if (request.signal?.aborted) {
      throw error;
    }
    if (provider.id !== 'openai-compatible' || !settings.llm.custom.fallbackToMain) {
      throw error;
    }
    logger.warn('自定义LLM调用失败，回退到SillyTavern主连接。', error);
    return new MainLlmProvider().complete(request);
  }
}
