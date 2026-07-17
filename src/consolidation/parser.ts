import type { ConsolidationOperation, StoryMemory } from '../core/types';
import { parseMemoryCandidate } from '../extraction/parser';
import type { ExtractedMemoryCandidate } from '../extraction/types';
import { normalizedFact, normalizedStateSlot } from './shortlist';
import type { ConsolidationDecision } from './types';

const OPERATIONS = new Set<ConsolidationOperation>([
  'CREATE',
  'MERGE',
  'UPDATE',
  'RESOLVE',
  'SUPERSEDE',
  'IGNORE',
]);

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseJson(raw: string): Record<string, unknown> {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('整理模型没有返回JSON对象。');
  }
  try {
    return record(JSON.parse(trimmed.slice(start, end + 1)));
  } catch (error) {
    throw new Error('整理模型返回的JSON无法解析。', { cause: error });
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, 50);
}

function combinedText(left: string, right: string, maxLength = 2_000): string {
  const normalizedLeft = normalizedFact(left);
  const normalizedRight = normalizedFact(right);
  if (!normalizedLeft) {
    return right.slice(0, maxLength);
  }
  if (!normalizedRight || normalizedLeft === normalizedRight || normalizedLeft.includes(normalizedRight)) {
    return left.slice(0, maxLength);
  }
  if (normalizedRight.includes(normalizedLeft)) {
    return right.slice(0, maxLength);
  }
  return `${left}；${right}`.slice(0, maxLength);
}

function mergeWithMemory(
  memory: StoryMemory,
  candidate: ExtractedMemoryCandidate,
): ExtractedMemoryCandidate {
  const changes = new Map(memory.stateChanges.map((change) => [
    normalizedStateSlot(change.entity, change.attribute),
    { ...change, before: change.before ?? '' },
  ]));
  for (const change of candidate.stateChanges) {
    changes.set(normalizedStateSlot(change.entity, change.attribute), change);
  }
  return {
    type: candidate.type,
    scene: {
      location: candidate.scene.location || memory.scene.location || '',
      time: candidate.scene.time || memory.scene.time || '',
      participants: unique([...memory.scene.participants, ...candidate.scene.participants]),
    },
    event: combinedText(memory.event, candidate.event),
    cause: candidate.cause || memory.cause || '',
    consequence: candidate.consequence || memory.consequence || '',
    entities: unique([...memory.entities, ...candidate.entities]),
    aliases: unique([...memory.aliases, ...candidate.aliases]),
    stateChanges: [...changes.values()].slice(0, 30),
    unresolvedThreads: unique([...memory.unresolvedThreads, ...candidate.unresolvedThreads]),
    knownBy: unique([...memory.knownBy, ...candidate.knownBy]),
    truthStatus: candidate.truthStatus,
    importance: Math.max(memory.importance, candidate.importance),
    retrievalText: combinedText(memory.retrievalText, candidate.retrievalText, 4_000),
    injectionText: combinedText(memory.injectionText, candidate.injectionText),
  };
}

export function fallbackConsolidationDecisions(
  candidates: ExtractedMemoryCandidate[],
  memories: StoryMemory[],
): ConsolidationDecision[] {
  return candidates.map((candidate, candidateIndex) => {
    const exact = memories.find(
      (memory) => normalizedFact(memory.retrievalText) === normalizedFact(candidate.retrievalText),
    );
    if (exact) {
      return {
        candidateIndex,
        operation: 'IGNORE',
        targetMemoryId: exact.id,
        reason: '检索文本完全重复。',
        result: candidate,
      };
    }

    const candidateChanges = new Map(candidate.stateChanges.map((change) => [
      normalizedStateSlot(change.entity, change.attribute),
      change,
    ]));
    const sameSlot = memories
      .flatMap((memory) => memory.stateChanges.map((change) => ({ memory, change })))
      .filter(({ change }) => candidateChanges.has(normalizedStateSlot(change.entity, change.attribute)))
      .sort((left, right) => right.memory.updatedAt.localeCompare(left.memory.updatedAt))[0];
    if (sameSlot) {
      const candidateChange = candidateChanges.get(
        normalizedStateSlot(sameSlot.change.entity, sameSlot.change.attribute),
      );
      const sameValue = candidateChange &&
        normalizedFact(candidateChange.after) === normalizedFact(sameSlot.change.after);
      return {
        candidateIndex,
        operation: sameValue ? 'MERGE' : 'SUPERSEDE',
        targetMemoryId: sameSlot.memory.id,
        reason: sameValue ? '同一状态槽且当前值相同。' : '同一状态槽出现了新值。',
        result: sameValue ? mergeWithMemory(sameSlot.memory, candidate) : candidate,
      };
    }

    return {
      candidateIndex,
      operation: 'CREATE',
      reason: '没有可确定关联的旧记忆。',
      result: candidate,
    };
  });
}

export function parseConsolidationResponse(
  raw: string,
  candidates: ExtractedMemoryCandidate[],
  memories: StoryMemory[],
): ConsolidationDecision[] {
  const fallback = fallbackConsolidationDecisions(candidates, memories);
  const allowedTargets = new Set(memories.map((memory) => memory.id));
  const actions = parseJson(raw)['actions'];
  if (!Array.isArray(actions)) {
    throw new Error('整理结果缺少actions数组。');
  }

  const parsed = new Map<number, ConsolidationDecision>();
  for (const value of actions.slice(0, 20)) {
    const action = record(value);
    const candidateIndex = Number(action['candidateIndex']);
    const operation = String(action['operation'] ?? '') as ConsolidationOperation;
    if (
      !Number.isInteger(candidateIndex) ||
      candidateIndex < 0 ||
      candidateIndex >= candidates.length ||
      !OPERATIONS.has(operation) ||
      parsed.has(candidateIndex)
    ) {
      continue;
    }
    const targetMemoryId = String(action['targetMemoryId'] ?? '').trim();
    const needsTarget = !['CREATE', 'IGNORE'].includes(operation);
    if (needsTarget && !allowedTargets.has(targetMemoryId)) {
      continue;
    }
    const result = parseMemoryCandidate(action['result']) ?? candidates[candidateIndex]!;
    parsed.set(candidateIndex, {
      candidateIndex,
      operation,
      ...(targetMemoryId && allowedTargets.has(targetMemoryId) ? { targetMemoryId } : {}),
      reason: String(action['reason'] ?? '').trim().slice(0, 500) || '模型未提供原因。',
      result,
    });
  }

  return fallback.map((decision) => parsed.get(decision.candidateIndex) ?? decision);
}
