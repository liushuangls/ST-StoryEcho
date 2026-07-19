import type { ConsolidationOperation, StoryMemory } from '../core/types';
import { evidenceRoleRank } from '../extraction/evidence';
import type { ExtractedMemoryCandidate } from '../extraction/types';
import {
  canonicalStateSlot,
  isCommitmentCompletion,
  normalizeIdentityText,
} from './identity';

const EXPLICIT_TRANSITION_CUE = /(?:后来|随后|之后|转移|移到|搬到|带到|藏进|放入|取出|拿走|取走|带走|夺走|偷走|交给|交由|转交|获得|失去|改为|变为|成为|离开|抵达|得知|告知|泄露|完成|履行|兑现|证实|推翻|否定|和解|背叛|死亡|复活|被捕|释放)/u;

function latestSourceMessageId(memory: StoryMemory): number {
  return Math.max(memory.source.endMessageId, ...memory.sourceMessageIds);
}

function isStrictlyLaterEvidence(
  candidate: ExtractedMemoryCandidate,
  memory: StoryMemory,
): boolean {
  const sourceIds = candidate.sourceMessageIds.filter((messageId) => Number.isInteger(messageId));
  return sourceIds.length > 0 && Math.min(...sourceIds) > latestSourceMessageId(memory);
}

function valuesReferToSameState(left: string, right: string): boolean {
  const normalizedLeft = normalizeIdentityText(left);
  const normalizedRight = normalizeIdentityText(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  if (normalizedLeft === normalizedRight) {
    return true;
  }
  return Math.min(normalizedLeft.length, normalizedRight.length) >= 3 && (
    normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)
  );
}

function isExplicitLaterStateTransition(
  candidate: ExtractedMemoryCandidate,
  memory: StoryMemory,
): boolean {
  if (candidate.truthStatus !== 'confirmed' || !isStrictlyLaterEvidence(candidate, memory)) {
    return false;
  }

  const currentBySlot = new Map(memory.stateChanges.map((change) => [
    canonicalStateSlot(change.entity, change.attribute, memory.type),
    change.after,
  ]));
  const transitionText = [
    candidate.event,
    candidate.cause,
    candidate.consequence,
    candidate.retrievalText,
    candidate.injectionText,
  ].join('\n');

  return candidate.stateChanges.some((change) => {
    const current = currentBySlot.get(
      canonicalStateSlot(change.entity, change.attribute, candidate.type),
    );
    if (!current || valuesReferToSameState(change.after, current)) {
      return false;
    }
    return valuesReferToSameState(change.before ?? '', current) ||
      EXPLICIT_TRANSITION_CUE.test(transitionText);
  });
}

/**
 * User evidence wins a bare contradiction, but an Assistant reply is also
 * canonical story evidence when it explicitly narrates a later state change.
 */
export function protectedByHigherAuthority(
  candidate: ExtractedMemoryCandidate,
  memory: StoryMemory,
  operation: ConsolidationOperation,
): boolean {
  if (evidenceRoleRank(candidate.evidenceRole) >= evidenceRoleRank(memory.evidenceRole)) {
    return false;
  }
  if (operation === 'RESOLVE' && isCommitmentCompletion(candidate)) {
    return false;
  }
  if (
    (operation === 'SUPERSEDE' || operation === 'UPDATE') &&
    isExplicitLaterStateTransition(candidate, memory)
  ) {
    return false;
  }
  return true;
}
