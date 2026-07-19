import type { TavernChatMessage } from '../core/types';

export interface ExtractionChunk {
  startMessageId: number;
  endMessageId: number;
}

export function countCompletedTurns(messages: TavernChatMessage[]): number {
  let waitingForAssistant = false;
  let completed = 0;
  for (const message of messages) {
    if (message.is_system) {
      continue;
    }
    if (message.is_user) {
      waitingForAssistant = true;
    } else if (waitingForAssistant) {
      completed += 1;
      waitingForAssistant = false;
    }
  }
  return completed;
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
  let completedTurns = 0;
  let waitingForAssistant = false;
  let lastCompletedTurnEnd = -1;
  let characters = 0;

  for (let index = startMessageId; index <= maximumEnd; index += 1) {
    const message = messages[index];
    const nextCharacters = characters + (message?.mes.length ?? 0);
    // Never split one user+assistant turn. If the next message would exceed
    // the cap, close at the most recent completed turn; one exceptionally
    // large turn is allowed to exceed the cap so indexing can still advance.
    if (nextCharacters > characterLimit && lastCompletedTurnEnd >= startMessageId) {
      return { startMessageId, endMessageId: lastCompletedTurnEnd };
    }
    characters = nextCharacters;
    if (message?.is_system) {
      continue;
    }
    if (message?.is_user) {
      waitingForAssistant = true;
      continue;
    }
    if (waitingForAssistant) {
      completedTurns += 1;
      waitingForAssistant = false;
      lastCompletedTurnEnd = index;
      if (completedTurns >= target || characters >= characterLimit) {
        return { startMessageId, endMessageId: index };
      }
    }
  }

  return { startMessageId, endMessageId: maximumEnd };
}
