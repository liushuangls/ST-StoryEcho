import { sha256 } from '../core/hash';
import type { StageSummaryEntry, StoryEchoChatState } from '../core/types';
import { estimateTokens } from '../prompt/render';

export const SKELETON_UPDATE_ENTRY_THRESHOLD = 3;
export const SKELETON_UPDATE_TOKEN_THRESHOLD = 3_000;
export const MAX_SKELETON_SOURCE_CHARACTERS = 64_000;
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
  state: StoryEchoChatState,
  pending: readonly StageSummaryEntry[],
  force = false,
): boolean {
  if (pending.length === 0) {
    return false;
  }
  if (force || !state.storySkeleton.text.trim() || state.storySkeleton.stale) {
    return true;
  }
  return pending.length >= SKELETON_UPDATE_ENTRY_THRESHOLD ||
    pending.reduce((total, entry) => total + estimateTokens(entry.text), 0) >=
      SKELETON_UPDATE_TOKEN_THRESHOLD;
}

export function boundedSkeletonSourceEntries(
  entries: readonly StageSummaryEntry[],
  maxCharacters = MAX_SKELETON_SOURCE_CHARACTERS,
): StageSummaryEntry[] {
  const selected: StageSummaryEntry[] = [];
  let characters = 0;
  for (const entry of entries) {
    const nextCharacters = entry.text.length + 160;
    if (selected.length > 0 && characters + nextCharacters > maxCharacters) {
      break;
    }
    selected.push(entry);
    characters += nextCharacters;
  }
  return selected;
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
