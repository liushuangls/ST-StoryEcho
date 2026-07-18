import type { StoryMemory } from '../core/types';
import type { VectorQueryResult } from '../vector/adapter';
import type { RetrievalQueryPlan } from './query-builder';

export interface RetrievalVectorResults {
  intent: VectorQueryResult[];
  scene: VectorQueryResult[];
}

function exactEntityMatches(query: string, memory: StoryMemory): number {
  const normalizedQuery = query.toLocaleLowerCase();
  const entityTerms = [...new Set([...memory.entities, ...memory.aliases])]
    .map((term) => term.trim().toLocaleLowerCase())
    .filter((term) => term.length >= 2);
  return entityTerms.reduce(
    (count, term) => count + (normalizedQuery.includes(term) ? 1 : 0),
    0,
  );
}

function reciprocalRankScore(rank: number | undefined): number {
  return rank === undefined ? 0 : 10 / (rank + 1);
}

export function rankMemories(
  queryPlan: RetrievalQueryPlan,
  memories: StoryMemory[],
  vectorResults: RetrievalVectorResults,
): StoryMemory[] {
  const intentRankByHash = new Map(vectorResults.intent.map((result) => [result.hash, result.rank]));
  const sceneRankByHash = new Map(vectorResults.scene.map((result) => [result.hash, result.rank]));

  return memories
    .map((memory) => {
      const intentRank = intentRankByHash.get(memory.vectorHash);
      const sceneRank = sceneRankByHash.get(memory.vectorHash);
      const intentMatches = exactEntityMatches(queryPlan.intentQuery, memory);
      const sceneMatches = exactEntityMatches(queryPlan.sceneQuery, memory);
      const vectorRankScore =
        reciprocalRankScore(intentRank) * queryPlan.intentWeight +
        reciprocalRankScore(sceneRank) * queryPlan.sceneWeight;
      const exactMatchScore =
        intentMatches * 0.7 * queryPlan.intentWeight +
        sceneMatches * 0.35 * queryPlan.sceneWeight;
      const score =
        (memory.pinned ? 100 : 0) +
        vectorRankScore +
        exactMatchScore +
        memory.importance * 2 +
        (memory.status === 'resolved' ? -2 : 0);
      return {
        memory,
        score,
        hasVectorResult: intentRank !== undefined || sceneRank !== undefined,
        exactMatches: intentMatches + sceneMatches,
      };
    })
    .filter(({ memory, hasVectorResult, exactMatches }) =>
      memory.pinned || hasVectorResult || exactMatches > 0)
    .sort((left, right) => right.score - left.score)
    .map(({ memory }) => memory);
}
