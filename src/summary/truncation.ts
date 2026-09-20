import type { StageSummaryEntry, SummarySourceRange } from '../core/types';
import { outputLimitReached } from '../llm/finish-reason';
const MAX_TRUNCATION_RANGES = 32;

export function stageSummaryOutputTruncated(entry: StageSummaryEntry): boolean {
  if (entry.manuallyEdited || entry.deleted) return false;
  return outputLimitReached(entry.generation?.finishReason);
}

/** Bounded, conservative affected ranges; adjacent ranges need only one marker. */
export function normalizeTruncatedSourceRanges(
  value: unknown,
  start: number,
  end: number,
): SummarySourceRange[] {
  if (!Array.isArray(value)) return [];
  const ranges = value.flatMap((item): SummarySourceRange[] => {
    if (!item || typeof item !== 'object') return [];
    const { sourceStartMessageId: first, sourceEndMessageId: last } = item;
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < start || last > end || first > last) {
      return [];
    }
    return [{ sourceStartMessageId: first, sourceEndMessageId: last }];
  }).sort((a, b) => a.sourceStartMessageId - b.sourceStartMessageId);
  const merged: SummarySourceRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && (
      range.sourceStartMessageId <= previous.sourceEndMessageId + 1 ||
      merged.length >= MAX_TRUNCATION_RANGES
    )) {
      previous.sourceEndMessageId = Math.max(previous.sourceEndMessageId, range.sourceEndMessageId);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/** Inherited risk remains visible even after a normal completion or manual edit. */
export function stageSummarySourceTruncationRanges(entry: StageSummaryEntry): SummarySourceRange[] {
  if (entry.deleted) return [];
  return normalizeTruncatedSourceRanges(
    entry.compaction?.sources.filter((source) => !source.deleted)
      .flatMap((source) => source.truncatedSourceRanges ?? []),
    entry.sourceStartMessageId,
    entry.sourceEndMessageId,
  );
}

export function summaryTruncationRanges(entry: StageSummaryEntry): SummarySourceRange[] {
  const inherited = stageSummarySourceTruncationRanges(entry);
  return stageSummaryOutputTruncated(entry)
    ? [{ sourceStartMessageId: entry.sourceStartMessageId, sourceEndMessageId: entry.sourceEndMessageId }]
    : inherited;
}
