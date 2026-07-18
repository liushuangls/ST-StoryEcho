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
  maxCharacters = 32_000,
): ExtractionChunk | null {
  if (startMessageId > maximumEndMessageId || startMessageId >= messages.length) {
    return null;
  }

  const maximumEnd = Math.min(maximumEndMessageId, messages.length - 1);
  const target = Math.max(1, Math.floor(targetTurns));
  const characterLimit = Math.max(1_000, Math.floor(maxCharacters));
  let userMessages = 0;
  let characters = 0;

  for (let index = startMessageId; index <= maximumEnd; index += 1) {
    const message = messages[index];
    const nextCharacters = characters + (message?.mes.length ?? 0);
    if (index > startMessageId && nextCharacters > characterLimit) {
      return { startMessageId, endMessageId: index - 1 };
    }
    characters = nextCharacters;
    if (!message?.is_system && message?.is_user) {
      if (userMessages >= target) {
        return { startMessageId, endMessageId: Math.max(startMessageId, index - 1) };
      }
      userMessages += 1;
    }
  }

  return { startMessageId, endMessageId: maximumEnd };
}
