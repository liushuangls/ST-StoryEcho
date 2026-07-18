import type { StoryMemory } from '../core/types';

/**
 * A merged memory may contain facts from several message ranges. Looking only
 * at its latest source range can hide older, still-effective facts exactly when
 * they cross the sliding-window boundary.
 */
export function hasSourceOutsideWindow(memory: StoryMemory, retainedStartIndex: number): boolean {
  const sources = memory.sourceHistory.length > 0 ? memory.sourceHistory : [memory.source];
  return sources.some((source) => source.endMessageId < retainedStartIndex);
}
