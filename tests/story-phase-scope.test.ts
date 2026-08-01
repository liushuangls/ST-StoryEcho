import { describe, expect, it } from 'vitest';
import {
  asksForEarlierStoryPhase,
  currentStoryPhaseStart,
  firstStoryPhaseBoundary,
} from '../src/history/story-phase';
import type { TavernChatMessage } from '../src/core/types';

const user = (mes: string): TavernChatMessage => ({ is_user: true, mes });
const assistant = (mes: string): TavernChatMessage => ({ is_user: false, mes });

describe('story phase boundaries', () => {
  it('finds the latest explicit user-declared phase transition', () => {
    const chat = [
      user('第一章开始'),
      assistant('旧剧情'),
      user('上一段剧情已经结束，现在进入一个新的篇章。'),
      assistant('新剧情'),
    ];
    expect(currentStoryPhaseStart(chat, 3)).toBe(2);
    expect(firstStoryPhaseBoundary(chat, 1, 3)).toBe(2);
  });

  it('ignores hypothetical, negated and assistant-only transitions', () => {
    expect(currentStoryPhaseStart([
      user('如果上一段结束，我们就开始新篇章。'),
      user('上一段还没有结束，不要进入新篇章。'),
      assistant('上一段结束，现在进入新篇章。'),
    ], 2)).toBeNull();
  });

  it('recognizes explicit earlier-phase questions', () => {
    expect(asksForEarlierStoryPhase('回顾一下之前的剧情发生了什么？')).toBe(true);
    expect(asksForEarlierStoryPhase('我们现在去哪里？')).toBe(false);
  });
});
