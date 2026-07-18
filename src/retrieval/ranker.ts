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
  return rank === undefined ? 0 : 5 / (rank + 1);
}

const CURRENT_STATE_QUERY = /(现在|当前|目前|如今|最新|仍然|还在|在哪|哪里|何处|位置|状态|持有者|归属)/u;
const CURRENT_STATE_FACT = /(现在|当前|目前|仍然|已(?:经)?|转移|移到|改为|不再|为空|位置|持有者)/u;

function currentStateBonus(queryPlan: RetrievalQueryPlan, memory: StoryMemory): number {
  if (!CURRENT_STATE_QUERY.test(queryPlan.intentQuery)) {
    return 0;
  }
  const representsCurrentState =
    memory.type === 'state_change' ||
    memory.stateChanges.length > 0 ||
    CURRENT_STATE_FACT.test(`${memory.event}\n${memory.consequence ?? ''}\n${memory.retrievalText}`);
  return representsCurrentState ? 3 : 0;
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
      const intentMatches = exactEntityMatches(queryPlan.keywordIntentQuery, memory);
      const sceneMatches = exactEntityMatches(queryPlan.keywordSceneQuery, memory);
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
        currentStateBonus(queryPlan, memory) +
        memory.importance * 2;
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
