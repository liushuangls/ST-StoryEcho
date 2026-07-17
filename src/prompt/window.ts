import type { TavernChatMessage, WindowUnit } from '../core/types';

export interface WindowSelection {
  currentInputIndex: number;
  retainedStartIndex: number;
  removableIndices: number[];
}

function findCurrentInputIndex(messages: TavernChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.is_user && !message.is_system) {
      return index;
    }
  }
  return -1;
}

export function selectRecentWindow(
  messages: TavernChatMessage[],
  size: number,
  unit: WindowUnit,
): WindowSelection | null {
  const currentInputIndex = findCurrentInputIndex(messages);
  if (currentInputIndex < 0) {
    return null;
  }

  const normalizedSize = Math.max(0, Math.floor(size));
  let retainedStartIndex = currentInputIndex;

  if (normalizedSize === 0) {
    retainedStartIndex = currentInputIndex;
  } else if (unit === 'messages') {
    const historical = messages
      .map((message, index) => ({ message, index }))
      .filter(({ message, index }) => index < currentInputIndex && !message.is_system);
    const firstRetained = historical.at(-normalizedSize);
    retainedStartIndex = firstRetained?.index ?? (historical.length <= normalizedSize ? 0 : currentInputIndex);
  } else {
    const historicalUserIndices = messages
      .map((message, index) => ({ message, index }))
      .filter(({ message, index }) => index < currentInputIndex && message.is_user && !message.is_system)
      .map(({ index }) => index);
    const firstRetainedUser = historicalUserIndices.at(-normalizedSize);
    retainedStartIndex =
      firstRetainedUser ?? (historicalUserIndices.length <= normalizedSize ? 0 : currentInputIndex);
  }

  const removableIndices = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message, index }) => index < retainedStartIndex && !message.is_system)
    .map(({ index }) => index);

  return { currentInputIndex, retainedStartIndex, removableIndices };
}
