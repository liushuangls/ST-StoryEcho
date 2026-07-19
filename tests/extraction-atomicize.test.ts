import { describe, expect, it } from 'vitest';
import { atomicizeMemoryCandidate } from '../src/extraction/atomicize';
import { candidate } from './fixtures';

describe('extraction candidate atomicization', () => {
  it('keeps a complete revelation instead of splitting it by entity clauses', () => {
    const original = candidate({
      type: 'revelation',
      scene: { location: '', time: '', participants: [] },
      event: '琥珀戒指和银铃的位置都已确认。',
      entities: ['琥珀戒指', '白塔药铺', '银铃', '北境白塔'],
      aliases: [],
      stateChanges: [],
      knownBy: ['刘爽'],
      retrievalText: '琥珀戒指位于白塔药铺前厅掌柜抽屉；银铃位于北境白塔顶层悬挂。',
      injectionText: '白塔药铺的琥珀戒指在抽屉，北境白塔的银铃在顶层。',
    });
    const result = atomicizeMemoryCandidate(original);

    expect(result).toEqual([original]);
  });

  it('normalizes one state slot without splitting it by surrounding clauses', () => {
    const original = candidate({
      entities: ['银色钥匙', '暮钟旅店', '红色铁盒'],
      retrievalText: '银色钥匙已从暮钟旅店取出；银色钥匙现在位于红色铁盒。',
    });

    const result = atomicizeMemoryCandidate(original);
    expect(result).toHaveLength(1);
    expect(result[0]?.stateChanges).toEqual(original.stateChanges);
    expect(result[0]?.retrievalText).toContain('银色钥匙');
  });

  it('splits every independent state slot even when the model returned one broad clause', () => {
    const result = atomicizeMemoryCandidate(candidate({
      event: '刘爽取回玄纹玉简，赤铜盒和旧青铜匣都空了。',
      entities: ['刘爽', '玄纹玉简', '赤铜盒', '旧青铜匣'],
      aliases: [],
      stateChanges: [
        { entity: '玄纹玉简', attribute: '持有者', before: '赤铜盒', after: '刘爽' },
        { entity: '赤铜盒', attribute: '内容物', before: '玄纹玉简', after: '空' },
        { entity: '旧青铜匣', attribute: '内容物', before: '未知', after: '空' },
      ],
      retrievalText: '刘爽取回玄纹玉简，赤铜盒和旧青铜匣现在都空了。',
      injectionText: '刘爽已经取回玄纹玉简，两个盒子都空了。',
    }));

    expect(result).toHaveLength(3);
    expect(result.map((item) => item.stateChanges)).toEqual([
      [{ entity: '玄纹玉简', attribute: '持有者', before: '赤铜盒', after: '刘爽' }],
      [{ entity: '赤铜盒', attribute: '内容物', before: '玄纹玉简', after: '空' }],
      [{ entity: '旧青铜匣', attribute: '内容物', before: '未知', after: '空' }],
    ]);
  });

  it('does not bind a prefix-named person to the longer place name', () => {
    const result = atomicizeMemoryCandidate(candidate({
      event: '女修青石拿着星砂钥匙；青石台位于北坡。',
      scene: { location: '北坡', time: '', participants: ['青石'] },
      entities: ['青石', '青石台', '星砂钥匙', '北坡'],
      aliases: [],
      stateChanges: [
        { entity: '青石', attribute: '持有者', before: '', after: '星砂钥匙' },
        { entity: '青石台', attribute: '位置', before: '', after: '北坡' },
      ],
      retrievalText: '女修青石持有星砂钥匙；地点青石台位于北坡。',
      injectionText: '青石拿着星砂钥匙；青石台在北坡。',
    }));

    expect(result).toHaveLength(2);
    expect(result[0]?.entities).toEqual(['青石', '星砂钥匙']);
    expect(result[0]?.retrievalText).toContain('女修青石持有星砂钥匙');
    expect(result[0]?.retrievalText).not.toContain('青石台位于北坡');
    expect(result[1]?.entities).toEqual(['青石台', '北坡']);
    expect(result[1]?.retrievalText).toContain('地点青石台位于北坡');
    expect(result[1]?.retrievalText).not.toContain('持有星砂钥匙');
    expect(result[1]?.scene.participants).toEqual([]);
  });

  it('does not split a revelation with prefix-named entities', () => {
    const original = candidate({
      type: 'revelation',
      scene: { location: '', time: '', participants: ['青石'] },
      event: '青石发现密信，青石台出现裂缝。',
      entities: ['青石', '青石台'],
      aliases: [],
      stateChanges: [],
      retrievalText: '女修青石发现密信；地点青石台出现裂缝。',
      injectionText: '青石发现了密信；青石台出现了裂缝。',
    });
    const result = atomicizeMemoryCandidate(original);

    expect(result).toEqual([original]);
  });

  it('preserves a complete plot episode while deriving its independent state slots', () => {
    const result = atomicizeMemoryCandidate(candidate({
      type: 'event',
      event: '众人在煤窖取得罗盘和胶片，陌白把它们收入风衣暗袋。',
      entities: ['陌白', '罗盘', '胶片', '煤窖'],
      stateChanges: [
        { entity: '罗盘', attribute: '持有者', before: '', after: '陌白' },
        { entity: '胶片', attribute: '持有者', before: '', after: '陌白' },
      ],
      retrievalText: '煤窖取得罗盘和胶片，陌白持有两件证物。',
      injectionText: '陌白等人在煤窖取得了罗盘和胶片，并收进风衣暗袋。',
    }));

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({
      type: 'event',
      event: '众人在煤窖取得罗盘和胶片，陌白把它们收入风衣暗袋。',
      stateChanges: [],
    });
    expect(result.slice(1).map((item) => item.stateChanges[0]?.entity)).toEqual(['罗盘', '胶片']);
  });
});
