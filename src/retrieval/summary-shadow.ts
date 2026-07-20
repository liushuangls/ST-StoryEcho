import type { StageSummaryEntry, StoryMemory } from '../core/types';
import { normalizeIdentityText } from '../consolidation/identity';

const SUMMARY_HEADINGS = [
  '【已确认剧情】',
  '【当前状态】',
  '【未解决线索】',
  '【角色主张与推测】',
  '【已失效或否定事实】',
] as const;

function summarySections(summary: string): Map<string, string> {
  const positions = SUMMARY_HEADINGS.map((heading) => summary.indexOf(heading));
  if (positions.some((position, index) => (
    position < 0 || (index > 0 && position <= positions[index - 1]!)
  ))) {
    return new Map();
  }
  return new Map(SUMMARY_HEADINGS.map((heading, index) => {
    const start = positions[index]! + heading.length;
    const end = positions[index + 1] ?? summary.length;
    return [heading, summary.slice(start, end).trim()];
  }));
}

function sectionSupportsState(section: string, entity: string, after: string): boolean {
  return entity.length >= 2 && after.length >= 2 &&
    section.includes(entity) && section.includes(after);
}

interface PreparedSummaryEvidence {
  sourceEndMessageId: number;
  confirmed: string;
  invalid: string;
}

function prepareSummaryEvidence(
  entries: readonly StageSummaryEntry[],
): PreparedSummaryEvidence[] {
  return [...entries]
    .sort((left, right) => left.sourceEndMessageId - right.sourceEndMessageId)
    .flatMap((entry) => {
      const sections = summarySections(entry.text);
      return sections.size === 0 ? [] : [{
        sourceEndMessageId: entry.sourceEndMessageId,
        confirmed: normalizeIdentityText(
          `${sections.get('【已确认剧情】') ?? ''}\n${sections.get('【当前状态】') ?? ''}`,
        ),
        invalid: normalizeIdentityText(sections.get('【已失效或否定事实】') ?? ''),
      }];
    });
}

function memoryIsInvalidated(
  memory: StoryMemory,
  entries: readonly PreparedSummaryEvidence[],
): boolean {
  if (memory.stateChanges.length === 0) {
    return false;
  }
  const invalidated = memory.stateChanges.map(() => false);
  for (const entry of entries) {
    if (entry.sourceEndMessageId < memory.source.endMessageId) {
      continue;
    }
    for (const [index, change] of memory.stateChanges.entries()) {
      const entity = normalizeIdentityText(change.entity);
      const after = normalizeIdentityText(change.after);
      if (sectionSupportsState(entry.confirmed, entity, after)) {
        invalidated[index] = false;
      }
      // Within one summary the explicit invalid section wins over a
      // contradictory confirmed sentence.
      if (sectionSupportsState(entry.invalid, entity, after)) {
        invalidated[index] = true;
      }
    }
  }
  return invalidated.some(Boolean);
}

export function invalidatedMemoryIdsByStageSummaries(
  memories: readonly StoryMemory[],
  entries: readonly StageSummaryEntry[],
): Set<string> {
  const prepared = prepareSummaryEvidence(entries);
  return new Set(memories
    .filter((memory) => memoryIsInvalidated(memory, prepared))
    .map((memory) => memory.id));
}

/**
 * A later summary can explicitly invalidate a stale structured state that an
 * older extraction failed to update. A still-later confirmed/current section
 * may re-establish it, so entries are evaluated chronologically.
 */
export function isMemoryInvalidatedByStageSummaries(
  memory: StoryMemory,
  entries: readonly StageSummaryEntry[],
): boolean {
  return memoryIsInvalidated(memory, prepareSummaryEvidence(entries));
}
