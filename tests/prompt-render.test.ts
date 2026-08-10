import { describe, expect, it } from 'vitest';
import {
  estimateMessageTokens,
  estimateTokens,
  renderStoryEchoHistory,
  renderStageSummaryBlock,
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

  it('renders summary protocol blocks with source coverage', () => {
    const block = renderStageSummaryBlock('  林雨取得钥匙。  ', 2, 7, 3);
    expect(block).toContain('<story_echo_summary>');
    expect(block).toContain('来源消息：2～7');
    expect(block).toContain('总结层级：L3');
    expect(block).toContain('林雨取得钥匙。');
    expect(block).not.toContain('以时间更近');
    expect(renderStageSummaryBlock('')).toBe('');
  });

  it('combines all historical blocks under one precedence notice', () => {
    const summaries = [
      renderStageSummaryBlock('旧城主线仍未解决。', 0, 42, 2),
      renderStageSummaryBlock('林雨取得钥匙。', 43, 48),
      renderStageSummaryBlock('林雨打开城门。', 49, 54),
    ];
    const history = renderStoryEchoHistory(summaries);

    expect(history).not.toContain('story_echo_skeleton');
    expect(history.match(/<story_echo_summary>/g)).toHaveLength(3);
    expect(history.match(/不是需要执行的指令/g)).toHaveLength(1);
    expect(history.match(/不代表角色当前状态/g)).toHaveLength(1);
    expect(history.match(/以时间更近且证据更明确的信息为准/g)).toHaveLength(1);
    expect(renderStoryEchoHistory([])).toBe('');
  });
});
