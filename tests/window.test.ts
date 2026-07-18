import { describe, expect, it } from 'vitest';
import type { TavernChatMessage } from '../src/core/types';
import {
  alignRetainedStartToTurn,
  countNonSystemMessages,
  removeMessagesAtIndices,
  selectRecentWindow,
} from '../src/prompt/window';

const chat: TavernChatMessage[] = [
  { is_user: false, mes: 'greeting' },
  { is_user: true, mes: 'user 1' },
  { is_user: false, mes: 'assistant 1' },
  { is_user: true, mes: 'user 2' },
  { is_user: false, mes: 'assistant 2' },
  { is_user: true, mes: 'current input' },
];

describe('selectRecentWindow', () => {
  it('keeps the latest completed turn plus current input', () => {
    const result = selectRecentWindow(chat, 1, 'turns');
    expect(result?.retainedStartIndex).toBe(3);
    expect(result?.removableIndices).toEqual([0, 1, 2]);
  });

  it('counts recent historical messages without counting current input', () => {
    const result = selectRecentWindow(chat, 2, 'messages');
    expect(result?.retainedStartIndex).toBe(3);
    expect(result?.removableIndices).toEqual([0, 1, 2]);
  });

  it('preserves system messages outside the window', () => {
    const messages: TavernChatMessage[] = [
      { is_user: false, is_system: true, mes: 'system injection' },
      ...chat,
    ];
    const result = selectRecentWindow(messages, 1, 'turns');
    expect(result?.removableIndices).not.toContain(0);
  });

  it('keeps all history when fewer turns exist than requested', () => {
    const result = selectRecentWindow(chat, 20, 'turns');
    expect(result?.retainedStartIndex).toBe(0);
    expect(result?.removableIndices).toEqual([]);
  });

  it.each(['turns', 'messages'] as const)('keeps only current input when %s size is zero', (unit) => {
    const result = selectRecentWindow(chat, 0, unit);
    expect(result?.retainedStartIndex).toBe(5);
    expect(result?.removableIndices).toEqual([0, 1, 2, 3, 4]);
  });

  it('compacts a removable prefix while preserving order and system messages', () => {
    const messages: TavernChatMessage[] = [
      { is_user: false, mes: 'old greeting' },
      { is_user: false, is_system: true, mes: 'persistent system message' },
      { is_user: true, mes: 'old user' },
      { is_user: false, mes: 'recent assistant' },
      { is_user: true, mes: 'current input' },
    ];

    removeMessagesAtIndices(messages, [0, 2]);

    expect(messages.map((message) => message.mes)).toEqual([
      'persistent system message',
      'recent assistant',
      'current input',
    ]);
  });

  it('backs a summary boundary up to the user that began the retained turn', () => {
    expect(alignRetainedStartToTurn(chat, 2)).toBe(1);
    expect(alignRetainedStartToTurn(chat, 3)).toBe(3);
  });

  it('keeps a complete turn when system messages sit on the summary boundary', () => {
    const messages: TavernChatMessage[] = [
      { is_user: true, mes: 'user 1' },
      { is_user: false, is_system: true, mes: 'narrator' },
      { is_user: false, mes: 'assistant 1' },
      { is_user: true, mes: 'current input' },
    ];

    expect(alignRetainedStartToTurn(messages, 1)).toBe(0);
  });

  it('translates a source boundary to the exact number of retained prompt messages', () => {
    const messages: TavernChatMessage[] = [
      { is_user: false, mes: 'assistant greeting' },
      { is_user: false, is_system: true, mes: 'system' },
      { is_user: true, mes: 'user' },
      { is_user: false, mes: 'assistant' },
      { is_user: true, mes: 'current' },
    ];

    expect(countNonSystemMessages(messages, 0, 4)).toBe(3);
  });
});
