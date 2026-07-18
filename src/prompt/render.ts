import type { StoryMemory } from '../core/types';

export function estimateTokens(text: string): number {
  const cjkCount = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const remaining = Math.max(0, text.length - cjkCount);
  return cjkCount + Math.ceil(remaining / 4);
}

function clean(value: string | undefined): string {
  return value?.trim() ?? '';
}

export function renderMemoryEntry(memory: StoryMemory): string {
  const lines = [`- 事件：${clean(memory.event)}`];
  const scene = [
    clean(memory.scene.time),
    clean(memory.scene.location),
  ].filter(Boolean).join('；');
  if (scene) {
    lines.push(`  场景：${scene}`);
  }
  if (clean(memory.cause)) {
    lines.push(`  原因：${clean(memory.cause)}`);
  }
  if (clean(memory.consequence)) {
    lines.push(`  结果/当前状态：${clean(memory.consequence)}`);
  }
  if (memory.stateChanges.length > 0) {
    lines.push(`  状态变化：${memory.stateChanges.map((change) => [
      `${change.entity}.${change.attribute}`,
      clean(change.before) ? `${clean(change.before)} → ${clean(change.after)}` : clean(change.after),
    ].join('：')).join('；')}`);
  }
  const structuredFacts = lines.join('\n');
  const entities = [...new Set([...memory.entities, ...memory.aliases].map(clean).filter(Boolean))]
    .filter((entity) => !structuredFacts.includes(entity));
  if (entities.length > 0) {
    lines.push(`  涉及实体：${entities.join('、')}`);
  }
  if (memory.knownBy.length > 0) {
    lines.push(`  知情范围：${memory.knownBy.map(clean).filter(Boolean).join('、')}`);
  }
  if (memory.unresolvedThreads.length > 0) {
    lines.push(`  未解决：${memory.unresolvedThreads.map(clean).filter(Boolean).join('；')}`);
  }
  if (memory.truthStatus !== 'confirmed') {
    lines.push(`  事实状态：${memory.truthStatus}`);
  }
  return lines.join('\n');
}

export function estimateMemoryTokens(memory: StoryMemory): number {
  return estimateTokens(renderMemoryEntry(memory));
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
    const cost = estimateMemoryTokens(memory);
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
  const lines = memories.map(renderMemoryEntry);
  return [
    '<story_echo>',
    '较早且当前有效的剧情事实：',
    '严格保持专名、完整地点、数量、状态和知情范围，不得改字、用近音字、混淆对象或编造；直接询问时按“结果/当前状态”和“知情范围”回答。',
    '回答地点须保留完整层级；回答知情者须明确写出姓名，不得只用我、他或她。若近期猜测冲突，以此处最新事实为准。勿复述标签。',
    ...lines,
    '</story_echo>',
  ].join('\n');
}
