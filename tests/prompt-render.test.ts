import { describe, expect, it } from 'vitest';
import { renderMemoryBlock } from '../src/prompt/render';
import { memory } from './fixtures';

describe('renderMemoryBlock', () => {
  it('tells the role model to preserve proper nouns and fact boundaries', () => {
    const block = renderMemoryBlock([memory({
      event: '沈砚转移了北辰纹紫铜罗盘',
      consequence: '北辰纹紫铜罗盘现在藏在第四幅海景画后',
      entities: ['沈砚', '北辰纹紫铜罗盘', '第四幅海景画'],
      aliases: [],
      stateChanges: [],
      knownBy: ['沈砚'],
      injectionText: '我把它藏好了。',
    })]);

    expect(block).toContain('严格保持专名、完整地点、数量、状态和知情范围');
    expect(block).toContain('不得改字、用近音字');
    expect(block).toContain('事件：沈砚转移了北辰纹紫铜罗盘');
    expect(block).toContain('结果/当前状态：北辰纹紫铜罗盘现在藏在第四幅海景画后');
    expect(block).toContain('知情范围：沈砚');
    expect(block).toContain('回答地点须保留完整层级');
    expect(block).toContain('知情者须明确写出姓名');
    expect(block).not.toContain('我把它藏好了');
  });
});
