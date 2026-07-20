import type { StoryMemory, TavernChatMessage } from '../core/types';
import { normalizeIdentityText } from '../consolidation/identity';

/**
 * A story-phase boundary must be explicit. Ordinary scene changes, time skips,
 * new clues and side activities are deliberately excluded so long-lived facts
 * are not hidden merely because the narrative moved forward.
 *
 * “案件/案子” remains one supported genre noun in this local deterministic
 * detector, alongside chapters, quests, journeys and story arcs. None of these
 * detector phrases are sent to an LLM.
 */
const PHASE_NOUN = '(?:剧情(?:阶段|线)?|故事(?:阶段|线)?|篇章|章节|任务|委托|旅程|冒险|阶段|主线|支线|事件|案件|案子|章|案)';
const STORY_SCALE_NOUN = '(?:剧情(?:阶段|线)?|故事(?:阶段|线)?|篇章|章节|旅程|冒险|阶段|主线|案件|案子|章|案)';
const CLOSED = '(?:已(?:经)?|刚|正式)?(?:结束|完成|告一段落|收尾|落幕|完结|完(?:了)?|解决|结(?:案)?)';
const STARTED = '(?:开始|进入|切换(?:到|至)?|转入|开启|展开|启动|接手|接到|接受|承接)';
const NEW_PHASE = `(?:一段|一个|一项|一场|一宗|一起|一桩)?(?:全新(?:的)?|新的?|下一(?:段|个|项|场|章)?|另一(?:段|个|项|场|宗|起|桩)?)[^，。！？；\\n]{0,12}${PHASE_NOUN}`;
const NEW_STORY_SCALE_PHASE = `(?:一段|一个|一场|一宗|一起|一桩)?(?:全新(?:的)?|新的?|下一(?:段|个|场|章)?|另一(?:段|个|场|宗|起|桩)?)[^，。！？；\\n]{0,12}${STORY_SCALE_NOUN}`;
const NEW_INDEPENDENT_PHASE = `(?:一段|一个|一项|一场|一宗|一起|一桩)?(?:全新(?:的)?|新的?|下一(?:段|个|项|场|章)?|另一(?:段|个|项|场|宗|起|桩)?)[^，。！？；\\n]{0,12}(?:独立(?:的)?|与此前无关(?:的)?)[^，。！？；\\n]{0,8}${PHASE_NOUN}`;
const PREVIOUS_PHASE = `(?:上一(?:段|个|项|场|章)?|前一(?:段|个|项|场|章)?|此前(?:的)?|之前(?:的)?|原(?:本|来)(?:的)?|旧(?:的)?)${PHASE_NOUN}`;

const EXPLICIT_STORY_PHASE_BOUNDARY = [
  new RegExp(`${PREVIOUS_PHASE}.{0,16}${CLOSED}.{0,36}${STARTED}.{0,16}${NEW_PHASE}`, 'u'),
  new RegExp(`${PHASE_NOUN}.{0,16}${CLOSED}.{0,36}${STARTED}.{0,16}${NEW_PHASE}`, 'u'),
  /第[一二三四五六七八九十百千万\d]+(?:章|节|幕|卷).{0,16}(?:结束|完成|落幕|完结|到此为止).{0,32}第[一二三四五六七八九十百千万\d]+(?:章|节|幕|卷).{0,12}(?:开始|开启|展开)/u,
  new RegExp(`${STARTED}.{0,12}(?:${NEW_STORY_SCALE_PHASE}|${NEW_INDEPENDENT_PHASE})`, 'u'),
  new RegExp(`(?:${NEW_STORY_SCALE_PHASE}|${NEW_INDEPENDENT_PHASE}).{0,12}(?:已(?:经)?|正式)?(?:开始|开启|展开|启动)`, 'u'),
  new RegExp(`(?:这是|这将是).{0,6}(?:${NEW_STORY_SCALE_PHASE}|${NEW_INDEPENDENT_PHASE})`, 'u'),
];

const EARLIER_STORY_PHASE_QUERY = [
  new RegExp(`${PREVIOUS_PHASE}.{0,32}(?:谁|什么|哪|回顾|复盘|总结|追溯|回忆|记得|结论|结果|证据|线索|发生|情况|状态|位置|下落|如何)`, 'u'),
  new RegExp(`(?:谁|什么|哪|回顾|复盘|总结|追溯|回忆|记得|结论|结果|证据|线索|情况|状态|位置|下落).{0,32}${PREVIOUS_PHASE}`, 'u'),
  /(?:回顾|复盘|总结|追溯|回忆|记得).{0,20}(?:以前|之前|此前|较早|过去|上一段|前一段)(?:发生)?(?:的)?(?:剧情|故事|经历|事情|内容)/u,
];

const HYPOTHETICAL_CUE = /(?:如果|假如|假设|若(?:是)?|等到|待到)/u;
const NEGATED_TRANSITION = /(?:尚未|还没(?:有)?|没有|并未|不是|并非|不要|别|不应|不能).{0,20}(?:结束|完成|告一段落|收尾|落幕|完结|解决|开始|进入|切换|转入|开启|展开|启动|接手|接到|接受|承接)/u;

function sentenceContext(value: string, matchIndex: number, matchLength: number): string {
  const prefix = value.slice(0, matchIndex);
  const sentenceStart = Math.max(
    prefix.lastIndexOf('。'),
    prefix.lastIndexOf('！'),
    prefix.lastIndexOf('？'),
    prefix.lastIndexOf('\n'),
  ) + 1;
  return value.slice(sentenceStart, matchIndex + matchLength);
}

function isExplicitStoryPhaseBoundary(value: string): boolean {
  return EXPLICIT_STORY_PHASE_BOUNDARY.some((pattern) => {
    const match = pattern.exec(value);
    if (!match) {
      return false;
    }
    const context = sentenceContext(value, match.index, match[0].length);
    return !HYPOTHETICAL_CUE.test(context) && !NEGATED_TRANSITION.test(context);
  });
}

function asksForEarlierStoryPhase(value: string): boolean {
  return EARLIER_STORY_PHASE_QUERY.some((pattern) => pattern.test(value));
}

function memoryTerms(memory: StoryMemory): string[] {
  return [...new Set([
    ...memory.entities,
    ...memory.aliases,
    ...memory.stateChanges.map((change) => change.entity),
  ])]
    .map(normalizeIdentityText)
    .filter((term) => term.length >= 2);
}

export function currentStoryPhaseStart(
  messages: readonly TavernChatMessage[],
  currentInputMessageId: number,
): number | null {
  const end = Math.min(messages.length - 1, Math.max(0, Math.floor(currentInputMessageId)));
  for (let index = end; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.is_user && !message.is_system && isExplicitStoryPhaseBoundary(message.mes)) {
      return index;
    }
  }
  return null;
}

export function firstStoryPhaseBoundary(
  messages: readonly TavernChatMessage[],
  startMessageId: number,
  endMessageId: number,
): number | null {
  const start = Math.max(0, Math.floor(startMessageId));
  const end = Math.min(messages.length - 1, Math.floor(endMessageId));
  if (start > end) {
    return null;
  }
  for (let index = start; index <= end; index += 1) {
    const message = messages[index];
    if (message?.is_user && !message.is_system && isExplicitStoryPhaseBoundary(message.mes)) {
      return index;
    }
  }
  return null;
}

export interface StoryPhaseMemoryScope {
  boundaryMessageId: number | null;
  memories: StoryMemory[];
  excludedMemoryIds: string[];
  earlierPhaseQuery: boolean;
}

/**
 * Keep automatic recall inside the latest explicitly declared story phase.
 * Pinned/manual memories remain global. An older memory may cross the boundary
 * only when the current User explicitly names one of its entities and the same
 * entity has no fact in the current phase.
 */
export function scopeMemoriesToCurrentStoryPhase(
  memories: StoryMemory[],
  messages: readonly TavernChatMessage[],
  currentInputMessageId: number,
): StoryPhaseMemoryScope {
  const boundaryMessageId = currentStoryPhaseStart(messages, currentInputMessageId);
  const currentInput = messages[currentInputMessageId]?.mes ?? '';
  const earlierPhaseQuery = asksForEarlierStoryPhase(currentInput);
  if (boundaryMessageId === null || earlierPhaseQuery) {
    return {
      boundaryMessageId,
      memories,
      excludedMemoryIds: [],
      earlierPhaseQuery,
    };
  }

  const normalizedQuery = normalizeIdentityText(currentInput);
  const currentPhaseTerms = new Set(memories
    .filter((memory) => memory.source.endMessageId >= boundaryMessageId)
    .flatMap(memoryTerms));
  const kept: StoryMemory[] = [];
  const excludedMemoryIds: string[] = [];

  for (const memory of memories) {
    const terms = memoryTerms(memory);
    const explicitlyRequestedOlderEntity = terms.some((term) => (
      normalizedQuery.includes(term) && !currentPhaseTerms.has(term)
    ));
    if (
      memory.source.endMessageId >= boundaryMessageId ||
      memory.pinned ||
      memory.manuallyEdited ||
      explicitlyRequestedOlderEntity
    ) {
      kept.push(memory);
    } else {
      excludedMemoryIds.push(memory.id);
    }
  }

  return {
    boundaryMessageId,
    memories: kept,
    excludedMemoryIds,
    earlierPhaseQuery,
  };
}
