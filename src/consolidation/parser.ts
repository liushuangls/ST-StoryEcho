import type { ConsolidationOperation, StoryMemory } from '../core/types';
import type { ExtractedMemoryCandidate } from '../extraction/types';
import { normalizedFact } from './shortlist';
import { combineEvidenceRoles } from '../extraction/evidence';
import { protectedByHigherAuthority } from './authority';
import {
  canonicalStateSlot,
  commitmentsMatch,
  isCommitmentCompletion,
  matchingStateIdentities,
} from './identity';
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

function parseJson(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const objectStart = trimmed.indexOf('{');
  const arrayStart = trimmed.indexOf('[');
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  const start = starts.length > 0 ? Math.min(...starts) : -1;
  const end = start >= 0 && trimmed[start] === '['
    ? trimmed.lastIndexOf(']')
    : trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('整理模型没有返回JSON对象。');
  }
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
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
  const cleanLeft = left.trim().replace(/[；;。.!！?？]+$/u, '');
  const cleanRight = right.trim().replace(/^[；;]+/u, '');
  return `${cleanLeft}；${cleanRight}`.slice(0, maxLength);
}

function mergeWithMemory(
  memory: StoryMemory,
  candidate: ExtractedMemoryCandidate,
): ExtractedMemoryCandidate {
  const changes = new Map(memory.stateChanges.map((change) => [
    canonicalStateSlot(change.entity, change.attribute, memory.type),
    { ...change, before: change.before ?? '' },
  ]));
  for (const change of candidate.stateChanges) {
    changes.set(canonicalStateSlot(change.entity, change.attribute, candidate.type), change);
  }
  return {
    evidenceRole: combineEvidenceRoles(memory.evidenceRole, candidate.evidenceRole),
    sourceMessageIds: [...new Set([
      ...memory.sourceMessageIds,
      ...candidate.sourceMessageIds,
    ])].sort((left, right) => left - right),
    type: candidate.type,
    scene: {
      location: candidate.scene.location || memory.scene.location || '',
      time: candidate.scene.time || memory.scene.time || '',
      participants: unique([...memory.scene.participants, ...candidate.scene.participants]),
    },
    event: combinedText(memory.event, candidate.event),
    cause: combinedText(memory.cause ?? '', candidate.cause),
    consequence: combinedText(memory.consequence ?? '', candidate.consequence),
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

function protectedDecision(
  candidateIndex: number,
  candidate: ExtractedMemoryCandidate,
  memory: StoryMemory,
): ConsolidationDecision {
  return {
    candidateIndex,
    operation: 'IGNORE',
    targetMemoryId: memory.id,
    reason: 'AI续写与更高权威的用户事实冲突，等待用户确认后再更新。',
    result: candidate,
  };
}

function entityTerms(value: {
  entities: string[];
  aliases: string[];
  scene: { participants: string[] };
}): Set<string> {
  return new Set([
    ...value.entities,
    ...value.aliases,
    ...value.scene.participants,
  ].map(normalizedFact).filter((term) => term.length >= 2));
}

function sharedEntityCount(
  candidate: ExtractedMemoryCandidate,
  memory: StoryMemory,
): number {
  const candidateEntities = entityTerms(candidate);
  const memoryEntities = entityTerms(memory);
  return [...candidateEntities].filter((term) => memoryEntities.has(term)).length;
}

function bigrams(value: string): Set<string> {
  const normalized = normalizedFact(value);
  if (normalized.length < 2) {
    return new Set(normalized ? [normalized] : []);
  }
  const result = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    result.add(normalized.slice(index, index + 2));
  }
  return result;
}

function textSimilarity(left: string, right: string): number {
  const leftBigrams = bigrams(left);
  const rightBigrams = bigrams(right);
  if (leftBigrams.size === 0 || rightBigrams.size === 0) {
    return 0;
  }
  const shared = [...leftBigrams].filter((gram) => rightBigrams.has(gram)).length;
  return (2 * shared) / (leftBigrams.size + rightBigrams.size);
}

const REPLACEMENT_CUE = /(转移|搬到|搬去|移到|移入|改藏|取出|交给|归还|替换|更换|不再|已经?空|已为空|没有(?:了)?|从.+到)/u;

function candidateText(candidate: ExtractedMemoryCandidate): string {
  return `${candidate.event}\n${candidate.retrievalText}\n${candidate.injectionText}`;
}

function memoryText(memory: StoryMemory): string {
  return `${memory.event}\n${memory.retrievalText}\n${memory.injectionText}`;
}

function hasReplacementCue(value: string): boolean {
  return REPLACEMENT_CUE.test(value);
}

function relatedMemory(
  candidate: ExtractedMemoryCandidate,
  memories: StoryMemory[],
): { memory: StoryMemory; candidateReplaces: boolean; memoryReplaces: boolean } | null {
  const candidateContent = candidateText(candidate);
  const candidateReplaces = hasReplacementCue(candidateContent);
  const matches = memories.flatMap((memory) => {
    const memoryContent = memoryText(memory);
    const memoryReplaces = hasReplacementCue(memoryContent);
    const sharedEntities = sharedEntityCount(candidate, memory);
    const similarity = textSimilarity(candidateContent, memoryContent);
    const related =
      (sharedEntities >= 1 && similarity >= 0.45) ||
      (sharedEntities >= 3 && similarity >= 0.12) ||
      (sharedEntities >= 2 && candidateReplaces && memoryReplaces);
    return related
      ? [{
          memory,
          candidateReplaces,
          memoryReplaces,
          score: sharedEntities * 10 + similarity,
        }]
      : [];
  });
  const best = matches.sort((left, right) => right.score - left.score)[0];
  return best
    ? {
        memory: best.memory,
        candidateReplaces: best.candidateReplaces,
        memoryReplaces: best.memoryReplaces,
      }
    : null;
}

function candidateAddsDetail(
  memory: StoryMemory,
  candidate: ExtractedMemoryCandidate,
): boolean {
  const previousDetails = normalizedFact([
    memory.cause ?? '',
    memory.consequence ?? '',
    ...memory.entities,
    ...memory.aliases,
    ...memory.unresolvedThreads,
    ...memory.knownBy,
    ...memory.stateChanges.flatMap((change) => [
      change.entity,
      change.attribute,
      change.before ?? '',
      change.after,
    ]),
  ].join('\n'));
  const candidateDetails = [
    candidate.cause,
    candidate.consequence,
    ...candidate.entities,
    ...candidate.aliases,
    ...candidate.unresolvedThreads,
    ...candidate.knownBy,
    ...candidate.stateChanges.flatMap((change) => [
      change.entity,
      change.attribute,
      change.before,
      change.after,
    ]),
  ].map(normalizedFact).filter(Boolean);
  return candidateDetails.some((detail) => !previousDetails.includes(detail));
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
      if (protectedByHigherAuthority(candidate, exact, 'MERGE')) {
        return protectedDecision(candidateIndex, candidate, exact);
      }
      const addsDetail = candidateAddsDetail(exact, candidate);
      return {
        candidateIndex,
        operation: addsDetail ? 'MERGE' : 'IGNORE',
        targetMemoryId: exact.id,
        reason: addsDetail ? '同一检索事实包含新的互补细节。' : '检索文本和事实细节完全重复。',
        result: addsDetail ? mergeWithMemory(exact, candidate) : candidate,
      };
    }

    if (isCommitmentCompletion(candidate)) {
      const commitment = memories
        .filter((memory) => commitmentsMatch(candidate, memory))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      if (commitment) {
        const result = mergeWithMemory(commitment, candidate);
        result.unresolvedThreads = [...candidate.unresolvedThreads];
        return {
          candidateIndex,
          operation: 'RESOLVE',
          targetMemoryId: commitment.id,
          reason: '同一承诺或任务已明确完成。',
          result,
        };
      }
    }

    const sameSlot = memories
      .flatMap((memory) => matchingStateIdentities(candidate, memory)
        .map((match) => ({ memory, match })))
      .sort((left, right) => right.memory.updatedAt.localeCompare(left.memory.updatedAt))[0];
    if (sameSlot) {
      const sameValue = sameSlot.match.left.after === sameSlot.match.right.after;
      const operation = sameValue ? 'MERGE' : 'SUPERSEDE';
      if (protectedByHigherAuthority(candidate, sameSlot.memory, operation)) {
        return protectedDecision(candidateIndex, candidate, sameSlot.memory);
      }
      return {
        candidateIndex,
        operation,
        targetMemoryId: sameSlot.memory.id,
        reason: sameValue ? '同一状态槽且当前值相同。' : '同一状态槽出现了新值。',
        result: sameValue ? mergeWithMemory(sameSlot.memory, candidate) : candidate,
      };
    }

    const related = relatedMemory(candidate, memories);
    if (related) {
      const supersedes = related.candidateReplaces && !related.memoryReplaces;
      const operation = supersedes ? 'SUPERSEDE' : 'MERGE';
      if (protectedByHigherAuthority(candidate, related.memory, operation)) {
        return protectedDecision(candidateIndex, candidate, related.memory);
      }
      return {
        candidateIndex,
        operation,
        targetMemoryId: related.memory.id,
        reason: supersedes
          ? '同一核心实体出现明确搬移或旧状态失效。'
          : '同一核心事实的重复确认或互补描述。',
        result: supersedes ? candidate : mergeWithMemory(related.memory, candidate),
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
  const payload = parseJson(raw);
  const root = record(payload);
  const actions = Array.isArray(payload)
    ? payload
    : root['actions'] ?? root['decisions'] ?? root['operations'];
  if (!Array.isArray(actions)) {
    throw new Error('整理结果缺少actions数组。');
  }

  const parsed = new Map<number, ConsolidationDecision>();
  for (const value of actions.slice(0, 20)) {
    const action = record(value);
    const candidateIndex = Number(
      action['candidateIndex'] ?? action['candidate_index'] ?? action['index'],
    );
    const operation = String(action['operation'] ?? action['action'] ?? '')
      .trim()
      .toUpperCase() as ConsolidationOperation;
    if (
      !Number.isInteger(candidateIndex) ||
      candidateIndex < 0 ||
      candidateIndex >= candidates.length ||
      !OPERATIONS.has(operation) ||
      parsed.has(candidateIndex)
    ) {
      continue;
    }
    const targetMemoryId = String(
      action['targetMemoryId'] ?? action['target_memory_id'] ?? action['targetId'] ?? '',
    ).trim();
    const needsTarget = !['CREATE', 'IGNORE'].includes(operation);
    if (needsTarget && !allowedTargets.has(targetMemoryId)) {
      continue;
    }
    const candidate = candidates[candidateIndex]!;
    const target = targetMemoryId
      ? memories.find((memory) => memory.id === targetMemoryId)
      : undefined;
    // The model only chooses an operation and target. Never accept a rewritten
    // memory object from its response: doing so would let consolidation invent
    // facts that were absent from both the stored memory and the new candidate.
    const result = target && ['MERGE', 'UPDATE', 'RESOLVE'].includes(operation)
      ? mergeWithMemory(target, candidate)
      : candidate;
    if (target && protectedByHigherAuthority(candidate, target, operation)) {
      continue;
    }
    if (operation === 'RESOLVE') {
      // A resolved candidate is the current authority for remaining open
      // threads. Unioning the old pending question back into the memory makes
      // a completed promise or disproved rumor look unresolved again.
      result.unresolvedThreads = [...candidate.unresolvedThreads];
    }
    parsed.set(candidateIndex, {
      candidateIndex,
      operation,
      ...(targetMemoryId && allowedTargets.has(targetMemoryId) ? { targetMemoryId } : {}),
      reason: String(action['reason'] ?? action['rationale'] ?? '')
        .trim()
        .slice(0, 500) || '模型未提供原因。',
      result,
    });
  }

  return fallback.map((decision) => {
    const modelDecision = parsed.get(decision.candidateIndex);
    if (!modelDecision) {
      return decision;
    }
    if (
      decision.operation === 'IGNORE' ||
      decision.operation === 'RESOLVE' ||
      decision.operation === 'SUPERSEDE' ||
      (decision.operation === 'MERGE' && modelDecision.operation === 'CREATE')
    ) {
      return decision;
    }
    return modelDecision;
  });
}
