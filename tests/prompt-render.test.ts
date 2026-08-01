import { describe, expect, it } from 'vitest';
import {
  estimateMessageTokens,
  estimateTokens,
  renderStageSummaryBlock,
  renderStorySkeletonBlock,
} from '../src/prompt/render';

describe('prompt rendering', () => {
  it('estimates Chinese characters and non-CJK text', () => {
    expect(estimateTokens('天地')).toBe(2);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('天地abcd')).toBe(3);
  });

  it('samples large removed message ranges without changing the estimate grain', () => {
    const messages = Array.from({ length: 1_000 }, (_, index) => ({
      mes: index % 2 === 0 ? '天地玄黄' : 'abcdefgh',
    }));
    const indices = messages.map((_, index) => index);
    expect(estimateMessageTokens(messages, indices, 100)).toBeGreaterThan(0);
    expect(estimateMessageTokens(messages, [], 100)).toBe(0);
    expect(estimateMessageTokens(messages, [0], 0)).toBe(4);
  });

  it('renders summaries as historical context with source coverage', () => {
    const block = renderStageSummaryBlock('  林雨取得钥匙。  ', 2, 7);
    expect(block).toContain('<story_echo_summary>');
    expect(block).toContain('来源消息：2～7');
    expect(block).toContain('林雨取得钥匙。');
    expect(block).toContain('以时间更近的信息为准');
    expect(renderStageSummaryBlock('')).toBe('');
  });

  it('renders the global skeleton without presenting it as current state', () => {
    const block = renderStorySkeletonBlock('旧城主线仍未解决。', 42);
    expect(block).toContain('<story_echo_skeleton>');
    expect(block).toContain('覆盖归档历史至消息：42');
    expect(block).toContain('不是角色当前状态');
    expect(renderStorySkeletonBlock(' ', 1)).toBe('');
  });
});
