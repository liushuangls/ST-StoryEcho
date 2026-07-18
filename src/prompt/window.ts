import type { TavernChatMessage, WindowUnit } from '../core/types';

export interface WindowSelection {
  currentInputIndex: number;
  retainedStartIndex: number;
  removableIndices: number[];
}

export function findCurrentInputIndex(messages: TavernChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.is_user && !message.is_system) {
      return index;
    }
  }
  return -1;
}

export function alignRetainedStartToTurn(
  messages: TavernChatMessage[],
  proposedStartIndex: number,
): number {
  let start = Math.min(messages.length, Math.max(0, Math.floor(proposedStartIndex)));
  if (start <= 0 || start >= messages.length) {
    return start;
  }
  let firstNonSystemIndex = start;
  while (firstNonSystemIndex < messages.length && messages[firstNonSystemIndex]?.is_system) {
    firstNonSystemIndex += 1;
  }
  if (firstNonSystemIndex >= messages.length) {
    return start;
  }
  if (messages[firstNonSystemIndex]?.is_user) {
    return firstNonSystemIndex;
  }
  for (let index = firstNonSystemIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.is_system) {
      continue;
    }
    if (message?.is_user) {
      return index;
    }
  }
  return 0;
}

export function countNonSystemMessages(
  messages: TavernChatMessage[],
  startIndex: number,
  endIndexExclusive: number,
): number {
  const start = Math.min(messages.length, Math.max(0, Math.floor(startIndex)));
  const end = Math.min(messages.length, Math.max(start, Math.floor(endIndexExclusive)));
  let count = 0;
  for (let index = start; index < end; index += 1) {
    if (!messages[index]?.is_system) {
      count += 1;
    }
  }
  return count;
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
  } else {
    let retainedUnits = 0;
    let foundBoundary = false;
    for (let index = currentInputIndex - 1; index >= 0; index -= 1) {
      const message = messages[index];
      const countsTowardWindow = unit === 'messages'
        ? !message?.is_system
        : Boolean(message?.is_user && !message.is_system);
      if (!countsTowardWindow) {
        continue;
      }
      retainedUnits += 1;
      if (retainedUnits === normalizedSize) {
        retainedStartIndex = index;
        foundBoundary = true;
        break;
      }
    }
    if (!foundBoundary) {
      retainedStartIndex = 0;
    }
  }

  const removableIndices: number[] = [];
  for (let index = 0; index < retainedStartIndex; index += 1) {
    if (!messages[index]?.is_system) {
      removableIndices.push(index);
    }
  }

  return { currentInputIndex, retainedStartIndex, removableIndices };
}

/** Remove many messages in one stable linear compaction pass. */
export function removeMessagesAtIndices(
  messages: TavernChatMessage[],
  indices: readonly number[],
): void {
  if (indices.length === 0) {
    return;
  }
  const removable = new Set(indices);
  let writeIndex = 0;
  for (let readIndex = 0; readIndex < messages.length; readIndex += 1) {
    if (removable.has(readIndex)) {
      continue;
    }
    messages[writeIndex] = messages[readIndex]!;
    writeIndex += 1;
  }
  messages.length = writeIndex;
}
