import type { StoryMemory } from '../core/types';
import { canonicalStateSlot, normalizeIdentityText } from '../consolidation/identity';
import { evidenceRoleRank } from '../extraction/evidence';
import type { VectorQueryResult } from '../vector/adapter';
import type { RetrievalQueryPlan } from './query-builder';

export interface RetrievalVectorResults {
  intent: VectorQueryResult[];
  scene: VectorQueryResult[];
}

export const MIN_RECALL_RANK_SCORE = 2;
export const RELATIVE_RECALL_RANK_RATIO = 0.4;

export interface RankedMemory {
  memory: StoryMemory;
  score: number;
  hasVectorResult: boolean;
  exactMatches: number;
}

function stateTransitionAdvances(newer: StoryMemory, older: StoryMemory): boolean {
  if (
    newer.truthStatus !== 'confirmed' ||
    newer.source.endMessageId <= older.source.endMessageId ||
    newer.stateChanges.length !== 1 ||
    older.stateChanges.length !== 1
  ) {
    return false;
  }
  const before = normalizeIdentityText(newer.stateChanges[0]?.before ?? '');
  const previous = normalizeIdentityText(older.stateChanges[0]?.after ?? '');
  return before.length >= 2 && previous.length >= 2 && (
    before === previous || before.includes(previous) || previous.includes(before)
  );
}

function preferredStateMemory(left: StoryMemory, right: StoryMemory): StoryMemory {
  if (left.manuallyEdited !== right.manuallyEdited) {
    return left.manuallyEdited ? left : right;
  }
  if (stateTransitionAdvances(left, right)) {
    return left;
  }
  if (stateTransitionAdvances(right, left)) {
    return right;
  }
  const truthRank = (memory: StoryMemory): number => {
    switch (memory.truthStatus) {
      case 'confirmed': return 4;
      case 'claimed': return 3;
      case 'inferred': return 2;
      case 'uncertain': return 1;
    }
  };
  const truthDifference = truthRank(left) - truthRank(right);
  if (truthDifference !== 0) {
    return truthDifference > 0 ? left : right;
  }
  const authority = evidenceRoleRank(left.evidenceRole) - evidenceRoleRank(right.evidenceRole);
  if (authority !== 0) {
    return authority > 0 ? left : right;
  }
  return left.source.endMessageId !== right.source.endMessageId
    ? left.source.endMessageId > right.source.endMessageId ? left : right
    : left.importance >= right.importance ? left : right;
}

/**
 * Old plugin versions may have left two one-slot state memories active. Hide
 * the stale duplicate at read time so users get the current fact immediately,
 * even before choosing “rebuild automatic metadata”. Composite legacy memories
 * are left untouched because dropping one could discard unrelated facts.
 */
export function suppressStaleAtomicStates(memories: StoryMemory[]): StoryMemory[] {
  const preferredBySlot = new Map<string, StoryMemory>();
  for (const memory of memories) {
    if (memory.stateChanges.length !== 1) {
      continue;
    }
    const change = memory.stateChanges[0]!;
    const slot = canonicalStateSlot(change.entity, change.attribute, memory.type);
    const existing = preferredBySlot.get(slot);
    preferredBySlot.set(slot, existing ? preferredStateMemory(existing, memory) : memory);
  }
  const preferredIds = new Set([...preferredBySlot.values()].map((memory) => memory.id));
  return memories.filter((memory) => (
    memory.stateChanges.length !== 1 || preferredIds.has(memory.id)
  ));
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

function currentStateBonus(
  queryPlan: RetrievalQueryPlan,
  memory: StoryMemory,
  hasStrongEvidence: boolean,
): number {
  if (!CURRENT_STATE_QUERY.test(queryPlan.intentQuery) || !hasStrongEvidence) {
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

  const ranked: RankedMemory[] = memories
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
      const hasStrongEvidence =
        intentMatches + sceneMatches > 0 ||
        (intentRank !== undefined && intentRank <= 2) ||
        (sceneRank !== undefined && sceneRank <= 1);
      const score =
        (memory.pinned ? 100 : 0) +
        vectorRankScore +
        exactMatchScore +
        currentStateBonus(queryPlan, memory, hasStrongEvidence) +
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
    .sort((left, right) => right.score - left.score);
  const bestNonPinnedScore = ranked.find(({ memory }) => !memory.pinned)?.score ?? 0;
  const effectiveCutoff = Math.max(
    MIN_RECALL_RANK_SCORE,
    bestNonPinnedScore * RELATIVE_RECALL_RANK_RATIO,
  );

  return ranked
    .filter(({ memory, score }) => memory.pinned || score >= effectiveCutoff)
    .map(({ memory }) => memory);
}
