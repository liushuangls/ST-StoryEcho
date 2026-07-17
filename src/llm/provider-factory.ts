import type { LlmProvider, StoryEchoSettings } from '../core/types';
import { MainLlmProvider } from './main-provider';
import { OpenAiCompatibleProvider } from './openai-compatible-provider';
import { sessionSecretVault } from './secret-vault';

export function createLlmProvider(settings: StoryEchoSettings): LlmProvider {
  if (settings.llm.provider === 'openai-compatible') {
    return new OpenAiCompatibleProvider(settings.llm.custom, sessionSecretVault);
  }
  return new MainLlmProvider();
}
