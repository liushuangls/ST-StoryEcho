import { describe, expect, it } from 'vitest';
import { storyContent, storyMessages } from '../src/content/story-content';

describe('story content cleaning', () => {
  it('keeps the displayed narrative and removes assistant reasoning or status siblings', () => {
    const content = storyContent({
      is_user: false,
      mes: '<think>内部推理，不应提取。</think><正文>顾青把银钥匙放入红色铁盒。</正文><status>HP 10</status>',
    });

    expect(content).toBe('顾青把银钥匙放入红色铁盒。');
  });

  it('removes hidden blocks without requiring a narrative wrapper', () => {
    const content = storyContent({
      is_user: false,
      mes: '<!-- prompt note --><analysis>先规划剧情</analysis>顾青锁好了铁盒。',
    });

    expect(content).toBe('顾青锁好了铁盒。');
  });

  it('leaves explicit User evidence unchanged', () => {
    const messages = storyMessages([{
      is_user: true,
      mes: '  用户明确写下 <think>这是剧情中的纸条</think>  ',
    }]);

    expect(messages[0]?.mes).toBe('用户明确写下 <think>这是剧情中的纸条</think>');
  });
});
