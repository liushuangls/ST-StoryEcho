import { describe, expect, it } from 'vitest';
import type { TavernChatMessage } from '../src/core/types';
import { countCompletedTurns, planNextChunk } from '../src/extraction/chunk-planner';

const messages: TavernChatMessage[] = [
  { is_user: false, mes: 'greeting' },
  { is_user: true, mes: 'u1' },
  { is_user: false, mes: 'a1' },
  { is_user: true, mes: 'u2' },
  { is_user: false, mes: 'a2' },
  { is_user: true, mes: 'u3' },
  { is_user: false, mes: 'a3' },
];

describe('planNextChunk', () => {
  it('counts only complete user plus assistant turns', () => {
    expect(countCompletedTurns(messages)).toBe(3);
    expect(countCompletedTurns([...messages, { is_user: true, mes: 'unfinished' }])).toBe(3);
  });
  it('ends before the user message that begins the next turn', () => {
    expect(planNextChunk(messages, 0, 6, 2)).toEqual({
      startMessageId: 0,
      endMessageId: 4,
    });
  });

  it('uses the requested maximum when fewer turns remain', () => {
    expect(planNextChunk(messages, 5, 6, 3)).toEqual({
      startMessageId: 5,
      endMessageId: 6,
    });
  });

  it('caps unusually large chunks by character count', () => {
    const longMessages: TavernChatMessage[] = [
      { is_user: true, mes: '甲'.repeat(800) },
      { is_user: false, mes: '乙'.repeat(400) },
      { is_user: true, mes: '丙'.repeat(100) },
    ];

    expect(planNextChunk(longMessages, 0, 2, 5, 1_000)).toEqual({
      startMessageId: 0,
      endMessageId: 1,
    });
  });
});
