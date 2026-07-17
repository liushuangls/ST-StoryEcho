import type { StoryMemory } from '../core/types';
import type { VectorQueryResult } from '../vector/adapter';

export function rankMemories(
  query: string,
  memories: StoryMemory[],
  vectorResults: VectorQueryResult[],
): StoryMemory[] {
  const rankByHash = new Map(vectorResults.map((result) => [result.hash, result.rank]));
  const normalizedQuery = query.toLocaleLowerCase();

  return memories
    .map((memory) => {
      const rank = rankByHash.get(memory.vectorHash);
      const entityTerms = [...new Set([...memory.entities, ...memory.aliases])]
        .map((term) => term.trim().toLocaleLowerCase())
        .filter((term) => term.length >= 2);
      const exactMatches = entityTerms.reduce(
        (count, term) => count + (normalizedQuery.includes(term) ? 1 : 0),
        0,
      );
      const vectorRankScore = rank === undefined ? 0 : 10 / (rank + 1);
      const score =
        (memory.pinned ? 100 : 0) +
        vectorRankScore +
        exactMatches * 0.35 +
        memory.importance * 2 +
        (memory.status === 'resolved' ? -2 : 0);
      return { memory, score, hasVectorResult: rank !== undefined, exactMatches };
    })
    .filter(({ memory, hasVectorResult, exactMatches }) => memory.pinned || hasVectorResult || exactMatches > 0)
    .sort((left, right) => right.score - left.score)
    .map(({ memory }) => memory);
}
