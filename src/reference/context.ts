import type { StoryEchoSettings, TavernChatMessage } from '../core/types';
import { storyContent } from '../content/story-content';
import {
  getContext,
  type SillyTavernContext,
  type SillyTavernWorldInfoEntry,
} from '../platform/sillytavern';
import { estimateTokens } from '../prompt/render';

const WORLD_INFO_MODULE_URL = '/scripts/world-info.js';
const MAX_REFERENCE_SOURCE_CHARACTERS = 100_000;
export const MAX_SKELETON_CONSTANT_WORLD_INFO_CHARACTERS = 20_000;
export const MAX_SKELETON_MATCHED_WORLD_INFO_CHARACTERS = 10_000;
export const MAX_STAGE_SUMMARY_CONSTANT_WORLD_INFO_CHARACTERS =
  MAX_SKELETON_CONSTANT_WORLD_INFO_CHARACTERS;
export const MAX_STAGE_SUMMARY_MATCHED_WORLD_INFO_CHARACTERS =
  MAX_SKELETON_MATCHED_WORLD_INFO_CHARACTERS;

interface WorldInfoModule {
  getSortedEntries?: () => Promise<SillyTavernWorldInfoEntry[]>;
}

export interface WorldInfoReferenceContext {
  text: string;
  tokenCount: number;
  worldInfoEntries: string[];
  constantWorldInfoEntries: string[];
  matchedWorldInfoEntries: string[];
  constantWorldInfoCharacters: number;
  matchedWorldInfoCharacters: number;
  truncated: boolean;
  warnings: string[];
}

interface MatchedWorldInfoEntry {
  entry: SillyTavernWorldInfoEntry;
  matchedKeys: string[];
  activation: 'keyword' | 'constant';
}

interface PreparedHistoryText {
  raw: string;
  caseSensitive: string;
  caseInsensitive: string;
}

let worldInfoModulePromise: Promise<WorldInfoModule> | undefined;

function clean(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().slice(0, MAX_REFERENCE_SOURCE_CHARACTERS)
    : '';
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function escapeReferenceValue(value: string): string {
  return value
    .replaceAll('<', '＜')
    .replaceAll('>', '＞')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function safeSubstitute(context: SillyTavernContext, value: string): string {
  if (!context.substituteParams) {
    return value;
  }
  try {
    return context.substituteParams(value);
  } catch {
    return value;
  }
}

function prepareHistoryText(value: string): PreparedHistoryText {
  const caseSensitive = value.normalize('NFKC');
  return {
    raw: value,
    caseSensitive,
    caseInsensitive: caseSensitive.toLocaleLowerCase(),
  };
}

function regexFromWorldInfoKey(value: string): RegExp | null {
  if (!value.startsWith('/')) {
    return null;
  }
  const closingSlash = value.lastIndexOf('/');
  if (closingSlash <= 0) {
    return null;
  }
  try {
    return new RegExp(value.slice(1, closingSlash), value.slice(closingSlash + 1));
  } catch {
    return null;
  }
}

function matchesKey(
  historyText: PreparedHistoryText,
  rawKey: string,
  entry: SillyTavernWorldInfoEntry,
  context: SillyTavernContext,
): boolean {
  const substituted = safeSubstitute(context, rawKey).trim();
  if (!substituted) {
    return false;
  }
  const keyRegex = regexFromWorldInfoKey(substituted);
  if (keyRegex) {
    keyRegex.lastIndex = 0;
    return keyRegex.test(historyText.raw);
  }

  const caseSensitive = entry.caseSensitive === true;
  const haystack = caseSensitive ? historyText.caseSensitive : historyText.caseInsensitive;
  const needle = (caseSensitive
    ? substituted.normalize('NFKC')
    : substituted.normalize('NFKC').toLocaleLowerCase());
  if (!entry.matchWholeWords || /[\u3400-\u9fff\uf900-\ufaff]/u.test(needle) || /\s/u.test(needle)) {
    return haystack.includes(needle);
  }
  try {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?:$|[^\\p{L}\\p{N}_])`, 'u')
      .test(haystack);
  } catch {
    return haystack.includes(needle);
  }
}

function passesCharacterFilter(
  entry: SillyTavernWorldInfoEntry,
  context: SillyTavernContext,
  batchNames: string[],
): boolean {
  const filter = entry.characterFilter;
  if (!filter) {
    return true;
  }
  const character = Number.isInteger(context.characterId)
    ? context.characters?.[context.characterId!]
    : undefined;
  const activeNames = new Set(unique([
    clean(character?.avatar),
    clean(character?.name),
    clean(context.name2),
    ...batchNames,
  ]));
  if (Array.isArray(filter.names) && filter.names.length > 0) {
    const included = filter.names.some((name) => activeNames.has(clean(name)));
    if (filter.isExclude ? included : !included) {
      return false;
    }
  }
  if (Array.isArray(filter.tags) && filter.tags.length > 0) {
    const activeTags = new Set([...activeNames].flatMap((name) => context.tagMap?.[name] ?? []));
    const included = filter.tags.some((tag) => activeTags.has(tag));
    if (filter.isExclude ? included : !included) {
      return false;
    }
  }
  return true;
}

function worldInfoEntryAvailable(
  entry: SillyTavernWorldInfoEntry,
  context: SillyTavernContext,
  batchNames: string[],
): boolean {
  return entry.disable !== true &&
    Boolean(clean(entry.content)) &&
    !entry.decorators?.some((decorator) => decorator.startsWith('@@dont_activate')) &&
    (!Array.isArray(entry.triggers) || entry.triggers.length === 0 || entry.triggers.includes('normal')) &&
    passesCharacterFilter(entry, context, batchNames);
}

function matchedWorldInfoKeys(
  entry: SillyTavernWorldInfoEntry,
  historyText: PreparedHistoryText,
  context: SillyTavernContext,
  batchNames: string[],
): string[] {
  if (!worldInfoEntryAvailable(entry, context, batchNames)) {
    return [];
  }
  const primary = Array.isArray(entry.key) ? entry.key : [];
  const primaryMatches = primary.filter((key) => matchesKey(historyText, key, entry, context));
  if (primaryMatches.length === 0) {
    return [];
  }
  const secondary = Array.isArray(entry.keysecondary) ? entry.keysecondary : [];
  if (!entry.selective || secondary.length === 0) {
    return primaryMatches;
  }
  const secondaryMatches = secondary.map((key) => matchesKey(historyText, key, entry, context));
  const anySecondary = secondaryMatches.some(Boolean);
  const allSecondary = secondaryMatches.every(Boolean);
  const accepted = entry.selectiveLogic === 1
    ? !allSecondary
    : entry.selectiveLogic === 2
      ? !anySecondary
      : entry.selectiveLogic === 3
        ? allSecondary
        : anySecondary;
  return accepted ? primaryMatches : [];
}

async function sortedWorldInfoEntries(
  context: SillyTavernContext,
): Promise<SillyTavernWorldInfoEntry[]> {
  if (context.getSortedWorldInfoEntries) {
    return context.getSortedWorldInfoEntries();
  }
  worldInfoModulePromise ??= import(/* @vite-ignore */ WORLD_INFO_MODULE_URL) as Promise<WorldInfoModule>;
  try {
    const module = await worldInfoModulePromise;
    if (!module.getSortedEntries) {
      throw new Error('当前SillyTavern未公开getSortedEntries()。');
    }
    return module.getSortedEntries();
  } catch (error) {
    worldInfoModulePromise = undefined;
    throw error;
  }
}

function worldInfoEntryReference(
  matched: MatchedWorldInfoEntry,
  context: SillyTavernContext,
  index: number,
): string {
  const { entry, matchedKeys, activation } = matched;
  const header = [
    `世界书${index + 1}`,
    `${clean(entry.world) || '未命名世界书'}#${entry.uid === undefined ? '?' : String(entry.uid)}`,
    clean(entry.comment),
    activation === 'constant'
      ? '激活方式=蓝灯常驻'
      : `触发词=${matchedKeys.map((key) => clean(key)).filter(Boolean).join('、')}`,
  ].filter(Boolean).join('｜');
  return `[${escapeReferenceValue(header)}]\n${escapeReferenceValue(
    safeSubstitute(context, clean(entry.content)),
  )}`;
}

function fitWholeWorldInfoEntries(
  entries: readonly MatchedWorldInfoEntry[],
  context: SillyTavernContext,
  maxCharacters: number,
): { entries: MatchedWorldInfoEntry[]; text: string; truncated: boolean } {
  const selected: MatchedWorldInfoEntry[] = [];
  const blocks: string[] = [];
  let characters = 0;
  for (const entry of entries) {
    const block = worldInfoEntryReference(entry, context, selected.length);
    const nextCharacters = characters + (blocks.length > 0 ? 2 : 0) + Array.from(block).length;
    if (nextCharacters > maxCharacters) {
      return { entries: selected, text: blocks.join('\n\n'), truncated: true };
    }
    selected.push(entry);
    blocks.push(block);
    characters = nextCharacters;
  }
  return { entries: selected, text: blocks.join('\n\n'), truncated: false };
}

function emptyReference(warnings: string[] = []): WorldInfoReferenceContext {
  return {
    text: '',
    tokenCount: 0,
    worldInfoEntries: [],
    constantWorldInfoEntries: [],
    matchedWorldInfoEntries: [],
    constantWorldInfoCharacters: 0,
    matchedWorldInfoCharacters: 0,
    truncated: false,
    warnings,
  };
}

async function buildHistoricalWorldInfoReferenceContext(
  messages: TavernChatMessage[],
  settings: StoryEchoSettings['summary']['reference'],
  context: SillyTavernContext,
  limits: { constantCharacters: number; matchedCharacters: number },
): Promise<WorldInfoReferenceContext> {
  if (!settings.enabled) {
    return emptyReference();
  }

  const warnings: string[] = [];
  const batchNames = unique(messages.map((message) => clean(message.name)));
  const historyText = prepareHistoryText(messages
    .filter((message) => !message.is_system)
    .map((message) => [clean(message.name), storyContent(message)].filter(Boolean).join(': '))
    .reverse()
    .join('\n'));
  const maximumMatches = Math.min(20, Math.max(0, Math.floor(settings.maxWorldInfoEntries)));
  const constants: MatchedWorldInfoEntry[] = [];
  const matches: MatchedWorldInfoEntry[] = [];
  let matchOverflow = false;

  try {
    const entries = (await sortedWorldInfoEntries(context))
      .filter((entry) => worldInfoEntryAvailable(entry, context, batchNames));
    const seen = new Set<string>();
    const identityOf = (entry: SillyTavernWorldInfoEntry): string => [
      clean(entry.world),
      entry.uid === undefined ? '' : String(entry.uid),
      clean(entry.comment),
      clean(entry.content),
    ].join('\u0000');

    for (const entry of entries) {
      if (entry.constant !== true) {
        continue;
      }
      const identity = identityOf(entry);
      if (!seen.has(identity)) {
        seen.add(identity);
        constants.push({ entry, matchedKeys: [], activation: 'constant' });
      }
    }
    for (const entry of entries) {
      if (entry.constant === true) {
        continue;
      }
      const identity = identityOf(entry);
      if (seen.has(identity)) {
        continue;
      }
      const matchedKeys = matchedWorldInfoKeys(entry, historyText, context, batchNames);
      if (matchedKeys.length === 0) {
        continue;
      }
      if (matches.length >= maximumMatches) {
        matchOverflow = true;
        continue;
      }
      seen.add(identity);
      matches.push({ entry, matchedKeys, activation: 'keyword' });
    }
  } catch (error) {
    return emptyReference([
      `世界书参考读取失败：${error instanceof Error ? error.message : String(error)}`,
    ]);
  }

  const fittedConstants = fitWholeWorldInfoEntries(constants, context, limits.constantCharacters);
  const fittedMatches = fitWholeWorldInfoEntries(matches, context, limits.matchedCharacters);
  const truncated = fittedConstants.truncated || fittedMatches.truncated || matchOverflow;
  if (!fittedConstants.text && !fittedMatches.text) {
    return { ...emptyReference(warnings), truncated };
  }

  const text = [
    '<story_echo_world_background>',
    '以下世界书内容只作为故事背景与设定参考，用于理解世界规则、专有名词、人物身份、地点和能力体系。',
    '它们不证明某件剧情已经发生，也不代表角色当前状态；具体剧情事实以随后提供的剧情原文、阶段总结或现有骨架为依据。',
    ...(fittedConstants.text
      ? ['<constant_world_info>', fittedConstants.text, '</constant_world_info>']
      : []),
    ...(fittedMatches.text
      ? ['<matched_world_info>', fittedMatches.text, '</matched_world_info>']
      : []),
    '</story_echo_world_background>',
  ].join('\n');
  let tokenCount = estimateTokens(text);
  if (context.getTokenCountAsync) {
    try {
      const count = await context.getTokenCountAsync(text, 0);
      if (Number.isFinite(count) && count >= 0) {
        tokenCount = Math.ceil(count);
      }
    } catch {
      warnings.push('酒馆Tokenizer不可用，参考上下文Token统计使用本地估算。');
    }
  }
  const entryIdentity = ({ entry }: MatchedWorldInfoEntry): string => [
    clean(entry.world) || '未命名世界书',
    entry.uid === undefined ? '?' : String(entry.uid),
    clean(entry.comment),
  ].filter(Boolean).join('#');
  const selected = [...fittedConstants.entries, ...fittedMatches.entries];
  return {
    text,
    tokenCount,
    worldInfoEntries: selected.map(entryIdentity),
    constantWorldInfoEntries: fittedConstants.entries.map(entryIdentity),
    matchedWorldInfoEntries: fittedMatches.entries.map(entryIdentity),
    constantWorldInfoCharacters: Array.from(fittedConstants.text).length,
    matchedWorldInfoCharacters: Array.from(fittedMatches.text).length,
    truncated,
    warnings,
  };
}

export async function buildSummaryWorldInfoReferenceContext(
  messages: TavernChatMessage[],
  settings: StoryEchoSettings['summary']['reference'],
  context = getContext(),
): Promise<WorldInfoReferenceContext> {
  return buildHistoricalWorldInfoReferenceContext(messages, settings, context, {
    constantCharacters: MAX_STAGE_SUMMARY_CONSTANT_WORLD_INFO_CHARACTERS,
    matchedCharacters: MAX_STAGE_SUMMARY_MATCHED_WORLD_INFO_CHARACTERS,
  });
}

export async function buildStorySkeletonWorldInfoReferenceContext(
  messages: TavernChatMessage[],
  settings: StoryEchoSettings['summary']['reference'],
  context = getContext(),
): Promise<WorldInfoReferenceContext> {
  return buildHistoricalWorldInfoReferenceContext(messages, settings, context, {
    constantCharacters: MAX_SKELETON_CONSTANT_WORLD_INFO_CHARACTERS,
    matchedCharacters: MAX_SKELETON_MATCHED_WORLD_INFO_CHARACTERS,
  });
}
