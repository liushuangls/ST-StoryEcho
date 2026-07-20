import { sha256 } from '../core/hash';
import type { StageSummaryEntry, StoryEchoChatState } from '../core/types';
import { estimateTokens } from '../prompt/render';
import { STORY_SKELETON_HEADINGS } from './skeleton-prompts';

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
  let previousIndex = -1;
  for (const heading of STORY_SKELETON_HEADINGS) {
    const index = text.indexOf(heading);
    if (index < 0 || index <= previousIndex) {
      throw new Error(`全局剧情骨架缺少或打乱分级标题：${heading}`);
    }
    previousIndex = index;
  }
  return text;
}

/** Narrowly repair one omitted empty interior section, matching stage-summary tolerance. */
export function repairGeneratedStorySkeletonSections(raw: string): string {
  const positions = STORY_SKELETON_HEADINGS.map((heading) => raw.indexOf(heading));
  const missing = positions
    .map((position, index) => ({ position, index }))
    .filter(({ position }) => position < 0);
  if (missing.length !== 1) {
    return raw;
  }
  const missingIndex = missing[0]!.index;
  if (missingIndex === 0 || missingIndex === STORY_SKELETON_HEADINGS.length - 1) {
    return raw;
  }
  let previousPosition = -1;
  for (const position of positions) {
    if (position < 0) {
      continue;
    }
    if (position <= previousPosition) {
      return raw;
    }
    previousPosition = position;
  }
  const nextHeading = STORY_SKELETON_HEADINGS[missingIndex + 1]!;
  const insertionPoint = raw.indexOf(nextHeading);
  if (insertionPoint < 0) {
    return raw;
  }
  return [
    raw.slice(0, insertionPoint).trimEnd(),
    STORY_SKELETON_HEADINGS[missingIndex],
    '无',
    raw.slice(insertionPoint).trimStart(),
  ].join('\n');
}
