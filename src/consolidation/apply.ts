import type {
  ConsolidationOperation,
  StoryEchoChatState,
  StoryMemory,
  StoryMemorySource,
} from '../core/types';
import { incrementAction } from '../debug/metrics';
import { createStoryMemory } from '../extraction/memory-factory';
import { deriveResidualCandidate } from './residual';
import type { ConsolidationDecision } from './types';

export interface AppliedConsolidation {
  created: StoryMemory[];
  changed: StoryMemory[];
  decisions: ConsolidationDecision[];
}

function uniqueSources(sources: StoryMemorySource[]): StoryMemorySource[] {
  const seen = new Set<string>();
  const unique = sources.filter((source) => {
    const key = `${source.startMessageId}:${source.endMessageId}:${source.sourceHash}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  return unique.length <= 100 ? unique : [unique[0]!, ...unique.slice(-99)];
}

function queueVectorReplacement(
  state: StoryEchoChatState,
  previousHash: number,
  memory: StoryMemory,
): void {
  if (previousHash === memory.vectorHash) {
    return;
  }
  state.pendingVectorDeleteHashes.push(previousHash);
  state.pendingVectorHashes.push(memory.vectorHash);
}

function actualDecision(
  decision: ConsolidationDecision,
  operation: ConsolidationOperation,
  reason: string,
): ConsolidationDecision {
  return { ...decision, operation, reason };
}

export async function applyConsolidationDecisions(
  state: StoryEchoChatState,
  decisions: ConsolidationDecision[],
  source: StoryMemorySource,
): Promise<AppliedConsolidation> {
  const created: StoryMemory[] = [];
  const changed: StoryMemory[] = [];
  const applied: ConsolidationDecision[] = [];
  const occupied = new Set(state.memories.map((memory) => memory.vectorHash));

  for (const decision of decisions.sort((left, right) => left.candidateIndex - right.candidateIndex)) {
    let operation = decision.operation;
    let targetIndex = decision.targetMemoryId
      ? state.memories.findIndex((memory) => memory.id === decision.targetMemoryId)
      : -1;
    const target = targetIndex >= 0 ? state.memories[targetIndex] : undefined;
    if (
      !['CREATE', 'IGNORE'].includes(operation) &&
      (!target || target.manuallyEdited || target.status === 'invalid' || target.status === 'superseded')
    ) {
      operation = 'CREATE';
      targetIndex = -1;
    }

    if (operation === 'IGNORE') {
      incrementAction(state.metrics, 'IGNORE');
      applied.push(actualDecision(decision, 'IGNORE', decision.reason));
      continue;
    }

    if (operation === 'CREATE' || targetIndex < 0 || !target) {
      const memory = await createStoryMemory(decision.result, source, occupied, {
        lastOperation: 'CREATE',
      });
      occupied.add(memory.vectorHash);
      state.memories.push(memory);
      state.pendingVectorHashes.push(memory.vectorHash);
      created.push(memory);
      incrementAction(state.metrics, 'CREATE');
      applied.push(actualDecision(
        decision,
        'CREATE',
        operation === 'CREATE' ? decision.reason : `${decision.reason}；目标不可用，已保守创建。`,
      ));
      continue;
    }

    if (operation === 'SUPERSEDE') {
      const residualCandidate = deriveResidualCandidate(target, decision.result);
      const replacement = await createStoryMemory(decision.result, source, occupied, {
        sourceHistory: uniqueSources([...target.sourceHistory, source]),
        supersedesMemoryIds: [...new Set([...target.supersedesMemoryIds, target.id])],
        lastOperation: 'SUPERSEDE',
      });
      replacement.pinned = target.pinned;
      replacement.excluded = target.excluded;
      occupied.add(replacement.vectorHash);
      const residual = residualCandidate
        ? await createStoryMemory(residualCandidate, target.source, occupied, {
            sourceHistory: target.sourceHistory,
            supersedesMemoryIds: [...new Set([...target.supersedesMemoryIds, target.id])],
            lastOperation: 'SUPERSEDE',
          })
        : null;
      if (residual) {
        residual.pinned = target.pinned;
        residual.excluded = target.excluded;
        occupied.add(residual.vectorHash);
      }
      target.status = 'superseded';
      target.replacedByMemoryId = replacement.id;
      target.lastOperation = 'SUPERSEDE';
      target.updatedAt = new Date().toISOString();
      state.memories.push(replacement);
      if (residual) {
        state.memories.push(residual);
      }
      state.pendingVectorDeleteHashes.push(target.vectorHash);
      state.pendingVectorHashes.push(replacement.vectorHash);
      if (residual) {
        state.pendingVectorHashes.push(residual.vectorHash);
      }
      created.push(replacement);
      if (residual) {
        created.push(residual);
      }
      changed.push(target);
      incrementAction(state.metrics, 'SUPERSEDE');
      applied.push(decision);
      continue;
    }

    const previousHash = target.vectorHash;
    occupied.delete(previousHash);
    const replacement = await createStoryMemory(decision.result, source, occupied, {
      id: target.id,
      createdAt: target.createdAt,
      sourceHistory: uniqueSources([...target.sourceHistory, source]),
      supersedesMemoryIds: target.supersedesMemoryIds,
      lastOperation: operation,
    });
    replacement.pinned = target.pinned;
    replacement.excluded = target.excluded;
    replacement.manuallyEdited = target.manuallyEdited;
    replacement.status = operation === 'RESOLVE'
      ? 'resolved'
      : operation === 'UPDATE'
        ? 'active'
        : target.status;
    state.memories[targetIndex] = replacement;
    occupied.add(replacement.vectorHash);
    queueVectorReplacement(state, previousHash, replacement);
    changed.push(replacement);
    incrementAction(state.metrics, operation);
    applied.push(decision);
  }

  state.pendingVectorHashes = [...new Set(state.pendingVectorHashes)];
  state.pendingVectorDeleteHashes = [...new Set(state.pendingVectorDeleteHashes)];
  return { created, changed, decisions: applied };
}
