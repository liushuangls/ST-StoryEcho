import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoryEchoSettings } from '../src/core/types';
import { extractCandidatesAdaptive } from '../src/extraction/service';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';

function typedState(sourceMessageId: number, entity: string): string {
  return JSON.stringify({
    episodes: [],
    stateFacts: [{
      sourceMessageIds: [sourceMessageId],
      scene: { location: '', time: '', participants: [] },
      entity,
      attribute: '位置',
      before: '',
      after: '档案室',
      aliases: [],
      knownBy: ['陌白'],
      truthStatus: 'confirmed',
      importance: 0.8,
    }],
    relationships: [],
    commitments: [],
    revelations: [],
    clues: [],
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('adaptive extraction splitting', () => {
  it('splits a failed multi-turn batch without breaking user/assistant pairs', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
    const generateRaw = vi.fn()
      .mockRejectedValueOnce(new Error('schema rejected'))
      .mockRejectedValueOnce(new Error('plain rejected'))
      .mockResolvedValueOnce(typedState(10, '罗盘'))
      .mockResolvedValueOnce(typedState(12, '胶片'));
    vi.stubGlobal('SillyTavern', { getContext: () => ({ generateRaw }) });
    const splits: Array<[number, number]> = [];

    const result = await extractCandidatesAdaptive(settings, [
      { is_user: true, mes: '罗盘在档案室。' },
      { is_user: false, mes: '陌白确认了罗盘的位置。' },
      { is_user: true, mes: '胶片也在档案室。' },
      { is_user: false, mes: '福尔摩斯记下了胶片的位置。' },
    ], 10, '', (left, right) => splits.push([left, right]));

    expect(splits).toEqual([[1, 1]]);
    expect(result.map((candidate) => candidate.sourceMessageIds)).toEqual([[10], [12]]);
    expect(generateRaw).toHaveBeenCalledTimes(4);
    expect(String(generateRaw.mock.calls[2]?.[0]?.prompt)).toContain('消息 10 到 11');
    expect(String(generateRaw.mock.calls[3]?.[0]?.prompt)).toContain('消息 12 到 13');
  });

  it('keeps a failed single turn uncommitted instead of splitting messages', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
    const generateRaw = vi.fn().mockRejectedValue(new Error('provider unavailable'));
    vi.stubGlobal('SillyTavern', { getContext: () => ({ generateRaw }) });

    await expect(extractCandidatesAdaptive(settings, [
      { is_user: true, mes: '单轮用户消息' },
      { is_user: false, mes: '单轮角色回复' },
    ], 0)).rejects.toThrow(/结构化输出全部失败/);
    expect(generateRaw).toHaveBeenCalledTimes(2);
  });
});
