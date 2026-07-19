import type { StoryMemory } from '../core/types';

/**
 * A merged memory may contain facts from several message ranges. Looking only
 * at its latest source range can hide older, still-effective facts exactly when
 * they cross the sliding-window boundary.
 */
export function hasSourceOutsideWindow(memory: StoryMemory, retainedStartIndex: number): boolean {
  // SUPERSEDE creates a new authority whose payload describes the replacement
  // state. Its older sourceHistory entries are ancestry only: treating them as
  // effective evidence can re-inject a state that is already visible in the
  // recent raw window (and make it look older than it really is).
  if (memory.lastOperation === 'SUPERSEDE') {
    const directSources = memory.sourceMessageIds.filter(
      (messageId) => messageId >= memory.source.startMessageId && messageId <= memory.source.endMessageId,
    );
    return directSources.length > 0
      ? directSources.some((messageId) => messageId < retainedStartIndex)
      : memory.source.endMessageId < retainedStartIndex;
  }
  const sources = memory.sourceHistory.length > 0 ? memory.sourceHistory : [memory.source];
  return sources.some((source) => source.endMessageId < retainedStartIndex);
}
