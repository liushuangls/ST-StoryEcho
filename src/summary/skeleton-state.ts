import { sha256 } from '../core/hash';
import type { StageSummaryEntry, StoryEchoChatState } from '../core/types';
import { estimateTokens } from '../prompt/render';

export const MAX_SKELETON_SOURCE_BATCH_CHARACTERS = 80_000;
const MAX_STORED_SKELETON_CHARACTERS = 96_000;

export function activeStageSummaryEntries(state: StoryEchoChatState): StageSummaryEntry[] {
  return state.stageSummary.entries.filter((entry) => !entry.deleted);
}

export function archivedStageSummaryEntries(
  state: StoryEchoChatState,
  windowSize: number,
): StageSummaryEntry[] {
  const active = activeStageSummaryEntries(state);
  const retained = Math.max(1, Math.floor(windowSize));
  return active.slice(0, Math.max(0, active.length - retained));
}

function sourcePayload(
  entries: readonly StageSummaryEntry[],
  coveredThroughMessageId: number,
): string {
  return JSON.stringify(entries
    .filter((entry) => entry.sourceEndMessageId <= coveredThroughMessageId)
    .map((entry) => ({
      sourceStartMessageId: entry.sourceStartMessageId,
      sourceEndMessageId: entry.sourceEndMessageId,
      sourceHash: entry.sourceHash,
      text: entry.deleted ? '' : entry.text,
      deleted: Boolean(entry.deleted),
    })));
}

export function storySkeletonSourceHash(
  entries: readonly StageSummaryEntry[],
  coveredThroughMessageId: number,
): Promise<string> {
  return sha256(sourcePayload(entries, coveredThroughMessageId));
}

export function storySkeletonIsUsable(state: StoryEchoChatState): boolean {
  return Boolean(
    state.storySkeleton.text.trim() &&
    !state.storySkeleton.stale &&
    state.storySkeleton.coveredThroughMessageId >= 0 &&
    state.storySkeleton.sourceHash,
  );
}

export function pendingArchivedStageSummaryEntries(
  state: StoryEchoChatState,
  windowSize: number,
): StageSummaryEntry[] {
  const archived = archivedStageSummaryEntries(state, windowSize);
  if (!storySkeletonIsUsable(state)) {
    return archived;
  }
  return archived.filter((entry) => (
    entry.sourceEndMessageId > state.storySkeleton.coveredThroughMessageId
  ));
}

export function storySkeletonUpdateDue(
  _state: StoryEchoChatState,
  pending: readonly StageSummaryEntry[],
  _force = false,
): boolean {
  return pending.length > 0;
}

export function skeletonSourceEntryCharacters(entry: StageSummaryEntry): number {
  return Array.from(JSON.stringify({
    sourceStartMessageId: entry.sourceStartMessageId,
    sourceEndMessageId: entry.sourceEndMessageId,
    stageSummary: entry.text,
  })).length;
}

export function skeletonSourceBatchCharacters(entries: readonly StageSummaryEntry[]): number {
  return 2 + entries.reduce(
    (total, entry, index) => total + skeletonSourceEntryCharacters(entry) + (index > 0 ? 1 : 0),
    0,
  );
}

export function skeletonSourceBatches(
  entries: readonly StageSummaryEntry[],
  maxCharacters = MAX_SKELETON_SOURCE_BATCH_CHARACTERS,
): StageSummaryEntry[][] {
  const maximum = Math.max(1, Math.floor(maxCharacters));
  const batches: StageSummaryEntry[][] = [];
  let batch: StageSummaryEntry[] = [];
  let characters = 2;

  for (const entry of entries) {
    const entryCharacters = skeletonSourceEntryCharacters(entry);
    if (entryCharacters + 2 > maximum) {
      throw new Error(
        `单条阶段总结序列化后约 ${entryCharacters + 2} 字符，超过全局剧情骨架单批 ${maximum} 字符上限。`,
      );
    }
    const nextCharacters = entryCharacters + (batch.length > 0 ? 1 : 0);
    if (batch.length > 0 && characters + nextCharacters > maximum) {
      batches.push(batch);
      batch = [];
      characters = 2;
    }
    batch.push(entry);
    characters += entryCharacters + (batch.length > 1 ? 1 : 0);
  }
  if (batch.length > 0) {
    batches.push(batch);
  }
  return batches;
}

export function normalizeStorySkeletonText(raw: string, maxTokens: number): string {
  const text = String(raw ?? '')
    .trim()
    .replace(/^```(?:text|markdown|md)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .replace(/^<story_echo_skeleton>\s*/iu, '')
    .replace(/\s*<\/story_echo_skeleton>$/iu, '')
    .trim();
  if (!text) {
    throw new Error('全局剧情骨架不能为空，也不能删除。');
  }
  if (text.length > MAX_STORED_SKELETON_CHARACTERS || estimateTokens(text) > maxTokens) {
    throw new Error(`全局剧情骨架不能超过 ${maxTokens} Token。`);
  }
  return text;
}
