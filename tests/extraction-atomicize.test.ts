import { describe, expect, it } from 'vitest';
import {
  atomicizeMemoryCandidate,
  normalizeCandidatesByType,
} from '../src/extraction/atomicize';
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

  it('splits a compound custody state into independent location and holder slots', () => {
    const result = atomicizeMemoryCandidate(candidate({
      type: 'state_change',
      event: '真月桂铜印R-1转入C4保险柜并由哈丽雅特·莫斯保管。',
      entities: ['真月桂铜印R-1', 'C4保险柜', '哈丽雅特·莫斯'],
      aliases: ['R-1'],
      stateChanges: [{
        entity: '真月桂铜印R-1',
        attribute: '保管状态',
        before: '位于S9证物柜，由雷斯垂德保管',
        after: '存放于C4保险柜，由哈丽雅特·莫斯保管',
      }],
      retrievalText: 'R-1现存放于C4保险柜，由哈丽雅特·莫斯保管。',
      injectionText: 'R-1已经转入C4保险柜并交由哈丽雅特·莫斯保管。',
    }));

    expect(result.map((item) => item.stateChanges[0])).toEqual([
      {
        entity: '真月桂铜印R-1',
        attribute: '位置',
        before: 'S9证物柜',
        after: 'C4保险柜',
      },
      {
        entity: '真月桂铜印R-1',
        attribute: '持有者',
        before: '雷斯垂德',
        after: '哈丽雅特·莫斯',
      },
    ]);
  });

  it('also splits compact parenthesized custody output from a less compliant model', () => {
    const result = atomicizeMemoryCandidate(candidate({
      stateChanges: [{
        entity: 'R-1',
        attribute: '位置及保管情况',
        before: 'S9证物柜（雷斯垂德保管）',
        after: 'C4保险柜（哈丽雅特·莫斯保管）',
      }],
    }));

    expect(result.map((item) => item.stateChanges[0])).toEqual([
      { entity: 'R-1', attribute: '位置', before: 'S9证物柜', after: 'C4保险柜' },
      { entity: 'R-1', attribute: '持有者', before: '雷斯垂德', after: '哈丽雅特·莫斯' },
    ]);
  });

  it('keeps high-value state facts when a dense batch exceeds the candidate limit', () => {
    const routineEvents = Array.from({ length: 9 }, (_, index) => candidate({
      type: 'event',
      sourceMessageIds: [index * 2, index * 2 + 1],
      event: `支线事件${index}`,
      entities: [`支线实体${index}`],
      aliases: [],
      stateChanges: [],
      importance: 0.6,
      retrievalText: `支线事件${index}发生。`,
      injectionText: `支线事件${index}发生。`,
    }));
    const holder = candidate({
      type: 'state_change',
      evidenceRole: 'assistant',
      sourceMessageIds: [18, 19],
      event: 'R-1移交给哈丽雅特·莫斯。',
      entities: ['R-1', '哈丽雅特·莫斯'],
      aliases: [],
      stateChanges: [{ entity: 'R-1', attribute: '持有者', before: '雷斯垂德', after: '哈丽雅特·莫斯' }],
      importance: 0.9,
      retrievalText: 'R-1当前由哈丽雅特·莫斯保管。',
      injectionText: 'R-1当前由哈丽雅特·莫斯保管。',
    });

    const result = normalizeCandidatesByType([...routineEvents, holder], 9);

    expect(result).toHaveLength(9);
    expect(result.some((item) => item.stateChanges[0]?.after === '哈丽雅特·莫斯')).toBe(true);
  });

  it('preserves a causal episode alongside many accepted atomic state facts', () => {
    const states = Array.from({ length: 20 }, (_, index) => candidate({
      type: 'state_change',
      event: `证物${index}的封存状态发生变化。`,
      entities: [`证物${index}`],
      aliases: [],
      stateChanges: [{
        entity: `证物${index}`,
        attribute: '封存状态',
        before: '待封存',
        after: '已封存',
      }],
      importance: 0.8,
      retrievalText: `证物${index}已经封存。`,
      injectionText: `证物${index}已经封存。`,
    }));
    const episode = candidate({
      type: 'conflict',
      event: '陌白阻止灰帽男人焚毁证物，并触发全部证物紧急封存。',
      cause: '灰帽男人试图焚毁证物。',
      consequence: '证物获救并进入紧急封存流程。',
      entities: ['陌白', '灰帽男人', '证物'],
      aliases: [],
      stateChanges: [],
      importance: 0.95,
      retrievalText: '陌白阻止灰帽男人焚毁证物。',
      injectionText: '陌白阻止灰帽男人焚毁证物，证物随后全部封存。',
    });

    const result = normalizeCandidatesByType([...states, episode], 20);

    expect(result).toHaveLength(20);
    expect(result.some((item) => item.type === 'conflict')).toBe(true);
  });
});
