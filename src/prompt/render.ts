import type { StoryMemory } from '../core/types';

export function estimateTokens(text: string): number {
  const cjkCount = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const remaining = Math.max(0, text.length - cjkCount);
  return cjkCount + Math.ceil(remaining / 4);
}

export function selectWithinBudget(
  memories: StoryMemory[],
  maxEvents: number,
  maxTokens: number,
): StoryMemory[] {
  const selected: StoryMemory[] = [];
  let usedTokens = 0;

  for (const memory of memories) {
    if (selected.length >= maxEvents) {
      break;
    }
    const cost = estimateTokens(memory.injectionText);
    if (selected.length > 0 && usedTokens + cost > maxTokens) {
      continue;
    }
    if (selected.length === 0 && cost > maxTokens) {
      continue;
    }
    selected.push(memory);
    usedTokens += cost;
  }

  return selected.sort((left, right) => left.source.endMessageId - right.source.endMessageId);
}

export function renderMemoryBlock(memories: StoryMemory[]): string {
  const lines = memories.map((memory) => `- ${memory.injectionText.trim()}`);
  return [
    '<story_echo>',
    '以下是与当前场景相关的较早事件，不代表当前正在发生：',
    ...lines,
    '</story_echo>',
  ].join('\n');
}
