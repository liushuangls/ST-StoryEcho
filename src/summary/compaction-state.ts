import type {
  StageSummaryEntry,
  StoryEchoSettings,
  SummaryCompactionSource,
} from '../core/types';

export interface SummaryCompactionCandidate {
  level: number;
  startIndex: number;
  entries: StageSummaryEntry[];
}

export interface SummaryCompactionThresholds {
  level1: number;
  higherLevels: number;
}

export function configuredSummaryCompactionThresholds(
  summary: StoryEchoSettings['summary'],
): SummaryCompactionThresholds {
  return {
    level1: summary.level1EntriesPerGroup,
    higherLevels: summary.higherLevelEntriesPerGroup,
  };
}

function thresholdForLevel(level: number, thresholds: SummaryCompactionThresholds): number {
  const configured = level === 1 ? thresholds.level1 : thresholds.higherLevels;
  return Math.max(2, Math.floor(configured));
}

export function summaryCompactionSource(entry: StageSummaryEntry): SummaryCompactionSource {
  return {
    text: entry.text,
    level: entry.level,
    sourceStartMessageId: entry.sourceStartMessageId,
    sourceEndMessageId: entry.sourceEndMessageId,
    sourceHash: entry.sourceHash,
    updatedAt: entry.updatedAt,
    ...(entry.manuallyEdited ? { manuallyEdited: true } : {}),
    ...(entry.deleted ? { deleted: true } : {}),
  };
}

export function summaryCompactionInput(sources: readonly SummaryCompactionSource[]): string {
  return JSON.stringify(sources.map((source) => ({
    text: source.text,
    level: source.level,
    sourceStartMessageId: source.sourceStartMessageId,
    sourceEndMessageId: source.sourceEndMessageId,
    sourceHash: source.sourceHash,
    updatedAt: source.updatedAt,
    manuallyEdited: Boolean(source.manuallyEdited),
    deleted: Boolean(source.deleted),
  })));
}

export function sameSummaryEntries(
  left: readonly StageSummaryEntry[],
  right: readonly StageSummaryEntry[],
): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index];
    return Boolean(
      other &&
      entry.text === other.text &&
      entry.level === other.level &&
      entry.sourceStartMessageId === other.sourceStartMessageId &&
      entry.sourceEndMessageId === other.sourceEndMessageId &&
      entry.sourceHash === other.sourceHash &&
      entry.updatedAt === other.updatedAt &&
      Boolean(entry.manuallyEdited) === Boolean(other.manuallyEdited) &&
      Boolean(entry.deleted) === Boolean(other.deleted) &&
      entry.compaction?.inputHash === other.compaction?.inputHash
    );
  });
}

export function summaryLevelCounts(
  entries: readonly StageSummaryEntry[],
): Map<number, number> {
  const counts = new Map<number, number>();
  for (const entry of entries) {
    counts.set(entry.level, (counts.get(entry.level) ?? 0) + 1);
  }
  return counts;
}

/**
 * Finds the lowest overflowing level and returns its oldest radix-sized run.
 * Runs must be adjacent in the chronological frontier so replacement remains atomic.
 */
export function findSummaryCompactionCandidate(
  entries: readonly StageSummaryEntry[],
  thresholds: SummaryCompactionThresholds,
): SummaryCompactionCandidate | null {
  const counts = summaryLevelCounts(entries);
  const overflowingLevel = [...counts.entries()]
    .filter(([level, count]) => count > thresholdForLevel(level, thresholds))
    .map(([level]) => level)
    .sort((left, right) => left - right)[0];
  if (overflowingLevel === undefined) {
    return null;
  }
  const capacity = thresholdForLevel(overflowingLevel, thresholds);

  const matchingIndices: number[] = [];
  for (let index = 0; index < entries.length && matchingIndices.length < capacity; index += 1) {
    if (entries[index]?.level === overflowingLevel) {
      matchingIndices.push(index);
    }
  }
  if (matchingIndices.length !== capacity) {
    return null;
  }
  const startIndex = matchingIndices[0]!;
  if (!matchingIndices.every((index, offset) => index === startIndex + offset)) {
    throw new Error(`L${overflowingLevel}总结未形成连续区间，无法安全压缩。`);
  }
  const candidates = entries.slice(startIndex, startIndex + capacity);
  for (let index = 1; index < candidates.length; index += 1) {
    if (candidates[index - 1]!.sourceEndMessageId + 1 !== candidates[index]!.sourceStartMessageId) {
      throw new Error(`L${overflowingLevel}总结来源范围不连续，无法安全压缩。`);
    }
  }
  return {
    level: overflowingLevel,
    startIndex,
    entries: candidates.map((entry) => structuredClone(entry)),
  };
}

export function summaryCompactionDue(
  entries: readonly StageSummaryEntry[],
  thresholds: SummaryCompactionThresholds,
): boolean {
  return [...summaryLevelCounts(entries).entries()]
    .some(([level, count]) => count > thresholdForLevel(level, thresholds));
}
