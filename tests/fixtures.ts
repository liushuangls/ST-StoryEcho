import type { StoryEchoChatState } from '../src/core/types';
import { createMetrics } from '../src/debug/metrics';

export function chatState(
  overrides: Partial<StoryEchoChatState> = {},
): StoryEchoChatState {
  return {
    schemaVersion: 3,
    chatUuid: 'chat-uuid',
    ownerChatId: 'chat-id',
    stageSummary: {
      entries: [],
      coveredThroughMessageId: -1,
      coveredThroughHash: '',
    },
    metrics: createMetrics(),
    debugTraces: [],
    recentInternalLlmAttempts: [],
    ...overrides,
  };
}
