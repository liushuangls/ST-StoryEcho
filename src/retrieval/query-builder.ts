import type { TavernChatMessage } from '../core/types';

export function buildRetrievalQuery(
  messages: TavernChatMessage[],
  currentInputIndex: number,
  recentMessageCount = 3,
): string {
  const start = Math.max(0, currentInputIndex - recentMessageCount);
  return messages
    .slice(start, currentInputIndex + 1)
    .filter((message) => !message.is_system && message.mes.trim().length > 0)
    .map((message) => `${message.name || (message.is_user ? '用户' : '角色')}：${message.mes.trim()}`)
    .join('\n');
}
