import type { TavernChatMessage } from '../core/types';

export interface ExtractionChunk {
  startMessageId: number;
  endMessageId: number;
}

export function planNextChunk(
  messages: TavernChatMessage[],
  startMessageId: number,
  maximumEndMessageId: number,
  targetTurns: number,
): ExtractionChunk | null {
  if (startMessageId > maximumEndMessageId || startMessageId >= messages.length) {
    return null;
  }

  const maximumEnd = Math.min(maximumEndMessageId, messages.length - 1);
  const target = Math.max(1, Math.floor(targetTurns));
  let userMessages = 0;

  for (let index = startMessageId; index <= maximumEnd; index += 1) {
    const message = messages[index];
    if (!message?.is_system && message?.is_user) {
      if (userMessages >= target) {
        return { startMessageId, endMessageId: Math.max(startMessageId, index - 1) };
      }
      userMessages += 1;
    }
  }

  return { startMessageId, endMessageId: maximumEnd };
}
