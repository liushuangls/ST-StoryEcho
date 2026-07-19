import type {
  ConsolidationOperation,
  StoryEchoChatState,
  StoryMemory,
  StoryMemorySource,
} from '../core/types';
import { incrementAction } from '../debug/metrics';
import { createStoryMemory } from '../extraction/memory-factory';
import { deriveResidualCandidate } from './residual';
import { relatedMemoryTargets } from './identity';
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

function pushChanged(changed: StoryMemory[], memory: StoryMemory): void {
  if (!changed.some((item) => item.id === memory.id)) {
    changed.push(memory);
  }
}

async function supersedeAdditionalTarget(
  state: StoryEchoChatState,
  target: StoryMemory,
  authority: StoryMemory,
  result: ConsolidationDecision['result'],
  occupied: Set<number>,
  created: StoryMemory[],
  changed: StoryMemory[],
): Promise<boolean> {
  if (
    target.id === authority.id ||
    target.manuallyEdited ||
    target.status === 'invalid' ||
    target.status === 'superseded'
  ) {
    return false;
  }

  const residualCandidate = deriveResidualCandidate(target, result);
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
    state.memories.push(residual);
    state.pendingVectorHashes.push(residual.vectorHash);
    created.push(residual);
  }

  target.status = 'superseded';
  target.replacedByMemoryId = authority.id;
  target.lastOperation = 'SUPERSEDE';
  target.updatedAt = new Date().toISOString();
  authority.sourceHistory = uniqueSources([
    ...authority.sourceHistory,
    ...target.sourceHistory,
  ]);
  authority.supersedesMemoryIds = [...new Set([
    ...authority.supersedesMemoryIds,
    ...target.supersedesMemoryIds,
    target.id,
  ])];
  authority.pinned = authority.pinned || target.pinned;
  state.pendingVectorDeleteHashes.push(target.vectorHash);
  pushChanged(changed, target);
  incrementAction(state.metrics, 'SUPERSEDE');
  return true;
}

async function supersedeAdditionalTargets(
  state: StoryEchoChatState,
  targetIds: string[],
  primaryTargetId: string | undefined,
  authority: StoryMemory,
  result: ConsolidationDecision['result'],
  occupied: Set<number>,
  created: StoryMemory[],
  changed: StoryMemory[],
): Promise<string[]> {
  const appliedIds: string[] = [];
  for (const id of targetIds) {
    if (id === primaryTargetId) {
      continue;
    }
    const target = state.memories.find((memory) => memory.id === id);
    if (target && await supersedeAdditionalTarget(
      state,
      target,
      authority,
      result,
      occupied,
      created,
      changed,
    )) {
      appliedIds.push(id);
    }
  }
  return appliedIds;
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
  const memoriesAtStart = [...state.memories];

  for (const decision of decisions.sort((left, right) => left.candidateIndex - right.candidateIndex)) {
    const deterministicTargetIds = relatedMemoryTargets(decision.result, memoriesAtStart)
      .map((memory) => memory.id);
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

    let authority: StoryMemory | undefined;

    if (operation === 'CREATE' || targetIndex < 0 || !target) {
      const memory = await createStoryMemory(decision.result, source, occupied, {
        lastOperation: 'CREATE',
      });
      occupied.add(memory.vectorHash);
      state.memories.push(memory);
      state.pendingVectorHashes.push(memory.vectorHash);
      created.push(memory);
      authority = memory;
      incrementAction(state.metrics, 'CREATE');
      const appliedDecision = actualDecision(
        decision,
        'CREATE',
        operation === 'CREATE' ? decision.reason : `${decision.reason}；目标不可用，已保守创建。`,
      );
      const additionalTargetMemoryIds = await supersedeAdditionalTargets(
        state,
        deterministicTargetIds,
        decision.targetMemoryId,
        authority,
        decision.result,
        occupied,
        created,
        changed,
      );
      applied.push({
        ...appliedDecision,
        ...(additionalTargetMemoryIds.length > 0 ? { additionalTargetMemoryIds } : {}),
      });
      continue;
    }

    if (operation === 'SUPERSEDE') {
      const residualCandidate = deriveResidualCandidate(target, decision.result);
      const replacement = await createStoryMemory(decision.result, source, occupied, {
        sourceHistory: uniqueSources([...target.sourceHistory, source]),
        supersedesMemoryIds: [...new Set([...target.supersedesMemoryIds, target.id])],
        lastOperation: 'SUPERSEDE',
        logicalKey: target.logicalKey,
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
      authority = replacement;
      if (residual) {
        created.push(residual);
      }
      pushChanged(changed, target);
      incrementAction(state.metrics, 'SUPERSEDE');
      const additionalTargetMemoryIds = await supersedeAdditionalTargets(
        state,
        deterministicTargetIds,
        target.id,
        authority,
        decision.result,
        occupied,
        created,
        changed,
      );
      applied.push({
        ...decision,
        ...(additionalTargetMemoryIds.length > 0 ? { additionalTargetMemoryIds } : {}),
      });
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
      logicalKey: target.logicalKey,
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
    authority = replacement;
    occupied.add(replacement.vectorHash);
    queueVectorReplacement(state, previousHash, replacement);
    pushChanged(changed, replacement);
    incrementAction(state.metrics, operation);
    const additionalTargetMemoryIds = await supersedeAdditionalTargets(
      state,
      deterministicTargetIds,
      target.id,
      authority,
      decision.result,
      occupied,
      created,
      changed,
    );
    applied.push({
      ...decision,
      ...(additionalTargetMemoryIds.length > 0 ? { additionalTargetMemoryIds } : {}),
    });
  }

  state.pendingVectorHashes = [...new Set(state.pendingVectorHashes)];
  state.pendingVectorDeleteHashes = [...new Set(state.pendingVectorDeleteHashes)];
  return { created, changed, decisions: applied };
}
