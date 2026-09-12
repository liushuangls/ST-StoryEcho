import type { LlmProvider, StoryEchoSettings } from '../core/types';
import { MainLlmProvider } from './main-provider';
import { OpenAiCompatibleProvider } from './openai-compatible-provider';
import { ConnectionProfileLlmProvider } from './connection-profile-provider';

export function createLlmProvider(settings: StoryEchoSettings): LlmProvider {
  if (settings.llm.provider === 'connection-profile') {
    return new ConnectionProfileLlmProvider(settings.llm.connectionProfileId);
  }
  if (settings.llm.provider === 'openai-compatible') {
    return new OpenAiCompatibleProvider(settings.llm.custom);
  }
  return new MainLlmProvider();
}
