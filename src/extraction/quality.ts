import type { ExtractedMemoryCandidate } from './types';

export interface RejectedMemoryCandidate {
  candidate: ExtractedMemoryCandidate;
  reason: string;
}

export interface MemoryCandidateAssessment {
  accepted: ExtractedMemoryCandidate[];
  rejected: RejectedMemoryCandidate[];
  removedUnsupportedThreads: string[];
}

const EXPLICIT_UNRESOLVED_CUE = /[?？]|(?:尚未|仍未|还未|还没|不知|不清楚|不明|未解|待查|待确认|待解决|下落不明|去向不明|谜团|悬念)|(?:(?:需要|必须|打算|准备|试图|要).{0,12}(?:寻找|找到|调查|查明|确认|解决|追查))/u;

function hasDurableStructure(candidate: ExtractedMemoryCandidate): boolean {
  return Boolean(
    candidate.cause ||
    candidate.consequence ||
    candidate.stateChanges.length > 0 ||
    candidate.unresolvedThreads.length > 0 ||
    candidate.knownBy.length >= 2 ||
    candidate.entities.length >= 3
  );
}

function importanceFloor(candidate: ExtractedMemoryCandidate): number {
  if (candidate.type === 'event') {
    return hasDurableStructure(candidate) ? 0.65 : candidate.importance;
  }
  if (candidate.type === 'clue') {
    return 0.6;
  }
  return 0.7;
}

function normalizedCandidate(
  candidate: ExtractedMemoryCandidate,
  sourceText: string,
  removedUnsupportedThreads: string[],
): ExtractedMemoryCandidate {
  const keepUnresolved = !sourceText || EXPLICIT_UNRESOLVED_CUE.test(sourceText);
  if (!keepUnresolved && candidate.unresolvedThreads.length > 0) {
    removedUnsupportedThreads.push(...candidate.unresolvedThreads);
  }
  const normalized = {
    ...candidate,
    unresolvedThreads: keepUnresolved ? candidate.unresolvedThreads : [],
  };
  return {
    ...normalized,
    importance: Math.max(candidate.importance, importanceFloor(normalized)),
  };
}

function rejectionReason(candidate: ExtractedMemoryCandidate): string | null {
  if (
    candidate.type === 'event' &&
    candidate.importance < 0.6 &&
    !hasDurableStructure(candidate)
  ) {
    return `低价值普通事件：${candidate.event.slice(0, 120)}`;
  }
  return null;
}

/**
 * Apply a conservative deterministic gate after LLM extraction.
 *
 * Models sometimes emit ordinary travel, meals, or "nothing happened" as a
 * generic event with the default importance. Those entries add vector noise
 * without helping future plot decisions. Typed changes and structurally rich
 * events remain eligible even when a provider omits a useful importance score.
 */
export function assessMemoryCandidates(
  candidates: ExtractedMemoryCandidate[],
  sourceText = '',
): MemoryCandidateAssessment {
  const accepted: ExtractedMemoryCandidate[] = [];
  const rejected: RejectedMemoryCandidate[] = [];
  const removedUnsupportedThreads: string[] = [];

  for (const candidate of candidates) {
    const normalized = normalizedCandidate(candidate, sourceText, removedUnsupportedThreads);
    const reason = rejectionReason(normalized);
    if (reason) {
      rejected.push({ candidate: normalized, reason });
      continue;
    }
    accepted.push(normalized);
  }

  return { accepted, rejected, removedUnsupportedThreads };
}
