import type { TavernChatMessage } from '../core/types';

/** Stable raw-chat representation used by every summary level's source hash. */
export function summarySourcePayload(
  messages: readonly TavernChatMessage[],
  sourceStartMessageId: number,
): string {
  return JSON.stringify(messages.map((message, offset) => ({
    messageId: sourceStartMessageId + offset,
    isUser: message.is_user,
    isSystem: Boolean(message.is_system),
    name: message.name || '',
    content: message.mes,
  })));
}
