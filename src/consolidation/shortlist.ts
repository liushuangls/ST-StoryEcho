import type { StoryMemory } from '../core/types';
import type { ExtractedMemoryCandidate } from '../extraction/types';

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function candidateTerms(candidate: ExtractedMemoryCandidate): Set<string> {
  return new Set([
    ...candidate.entities,
    ...candidate.aliases,
    ...candidate.scene.participants,
    ...candidate.stateChanges.flatMap((change) => [change.entity, change.attribute]),
  ].map(normalized).filter((term) => term.length >= 2));
}

function memoryTerms(memory: StoryMemory): Set<string> {
  return new Set([
    ...memory.entities,
    ...memory.aliases,
    ...memory.scene.participants,
    ...memory.stateChanges.flatMap((change) => [change.entity, change.attribute]),
  ].map(normalized).filter((term) => term.length >= 2));
}

function stateSlotsForCandidate(candidate: ExtractedMemoryCandidate): Set<string> {
  return new Set(candidate.stateChanges.map(
    (change) => `${normalized(change.entity)}\u0000${normalized(change.attribute)}`,
  ));
}

function stateSlotsForMemory(memory: StoryMemory): Set<string> {
  return new Set(memory.stateChanges.map(
    (change) => `${normalized(change.entity)}\u0000${normalized(change.attribute)}`,
  ));
}

export function shortlistMemories(
  candidates: ExtractedMemoryCandidate[],
  memories: StoryMemory[],
  vectorHashes: ReadonlySet<number>,
  limit = 16,
): StoryMemory[] {
  const allCandidateTerms = candidates.map(candidateTerms);
  const allCandidateSlots = candidates.map(stateSlotsForCandidate);

  return memories
    .filter(
      (memory) =>
        memory.status !== 'invalid' &&
        memory.status !== 'superseded' &&
        (!memory.manuallyEdited || candidates.some(
          (candidate) => normalizedFact(candidate.retrievalText) === normalizedFact(memory.retrievalText),
        )),
    )
    .map((memory) => {
      const terms = memoryTerms(memory);
      const slots = stateSlotsForMemory(memory);
      let score = vectorHashes.has(memory.vectorHash) ? 20 : 0;
      for (let index = 0; index < candidates.length; index += 1) {
        const candidateTermsAtIndex = allCandidateTerms[index] ?? new Set<string>();
        const candidateSlotsAtIndex = allCandidateSlots[index] ?? new Set<string>();
        const candidate = candidates[index]!;
        const exactTerms = [...candidateTermsAtIndex].filter((term) => terms.has(term)).length;
        const sameSlots = [...candidateSlotsAtIndex].filter((slot) => slots.has(slot)).length;
        score = Math.max(
          score,
          normalizedFact(candidate.retrievalText) === normalizedFact(memory.retrievalText) ? 100 : 0,
          sameSlots * 30 + exactTerms * 4 +
            (exactTerms > 0 && candidate.type === memory.type ? 1 : 0),
        );
      }
      return { memory, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || right.memory.updatedAt.localeCompare(left.memory.updatedAt))
    .slice(0, Math.max(1, limit))
    .map(({ memory }) => memory);
}

export function normalizedStateSlot(entity: string, attribute: string): string {
  return `${normalized(entity)}\u0000${normalized(attribute)}`;
}

export function normalizedFact(value: string): string {
  return normalized(value);
}
