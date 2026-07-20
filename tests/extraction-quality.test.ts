import { describe, expect, it } from 'vitest';
import {
  assessMemoryCandidates,
  directlyGroundedStoryMemoryNames,
  normalizedStoryEntityName,
  unsupportedStoryMemoryNames,
} from '../src/extraction/quality';
import { candidate, memory } from './fixtures';

describe('memory candidate quality gate', () => {
  it('rejects a low-value generic event without durable plot structure', () => {
    const result = assessMemoryCandidates([candidate({
      type: 'event',
      event: '刘爽在河岸散步，没有谈论藏物。',
      entities: ['刘爽', '河岸'],
      aliases: [],
      stateChanges: [],
      unresolvedThreads: [],
      knownBy: ['刘爽'],
      importance: 0.5,
      retrievalText: '刘爽在河岸散步，没有谈论藏物。',
      injectionText: '之前，你在河岸散过步。',
    })]);

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]?.reason).toContain('低价值普通事件');
  });

  it('keeps a structurally rich event and raises its ranking floor', () => {
    const result = assessMemoryCandidates([candidate({
      type: 'event',
      event: '刘爽和顾青把银钥匙转移到钟表铺地下室的红色铁盒。',
      entities: ['刘爽', '顾青', '银钥匙', '红色铁盒'],
      aliases: [],
      stateChanges: [],
      unresolvedThreads: [],
      knownBy: ['刘爽', '顾青'],
      importance: 0.5,
    })]);

    expect(result.rejected).toEqual([]);
    expect(result.accepted[0]?.importance).toBe(0.65);
  });

  it('keeps typed clues while ranking them below irreversible changes', () => {
    const result = assessMemoryCandidates([candidate({
      type: 'clue',
      importance: 0.5,
      stateChanges: [],
    })]);

    expect(result.accepted[0]?.importance).toBe(0.6);
  });

  it('removes unresolved threads invented from merely absent information', () => {
    const result = assessMemoryCandidates([candidate({
      event: '顾青锁好红色铁盒并确认旧暗格没有钥匙。',
      unresolvedThreads: ['红色铁盒内装有何物', '旧暗格的钥匙去向不明'],
    })], '顾青锁好红色铁盒，确认暮钟旅店的旧暗格已经没有钥匙。');

    expect(result.accepted[0]?.unresolvedThreads).toEqual([]);
    expect(result.removedUnsupportedThreads).toEqual([
      '红色铁盒内装有何物',
      '旧暗格的钥匙去向不明',
    ]);
  });

  it('keeps unresolved threads when the source explicitly poses a question', () => {
    const result = assessMemoryCandidates([candidate({
      unresolvedThreads: ['红色铁盒内究竟装着什么'],
    })], '顾青盯着红色铁盒：里面究竟装着什么？');

    expect(result.accepted[0]?.unresolvedThreads).toEqual(['红色铁盒内究竟装着什么']);
    expect(result.removedUnsupportedThreads).toEqual([]);
  });

  it('rejects memories without a valid cited chat floor when source ids are enforced', () => {
    const result = assessMemoryCandidates([
      candidate({ sourceMessageIds: [99] }),
    ], '消息正文', [20, 21]);

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]?.reason).toContain('缺少有效源消息ID');
  });

  it('drops out-of-range citations while retaining valid source ids', () => {
    const result = assessMemoryCandidates([
      candidate({ sourceMessageIds: [20, 99, 21] }),
    ], '消息正文', [20, 21]);

    expect(result.rejected).toEqual([]);
    expect(result.accepted[0]?.sourceMessageIds).toEqual([20, 21]);
  });

  it('rejects a proper name invented inside an otherwise valid cited Assistant message', () => {
    const result = assessMemoryCandidates([candidate({
      sourceMessageIds: [108],
      evidenceRole: 'assistant',
      event: '失踪的托马斯主动制造了密室消失。',
      entities: ['托马斯', '失踪男子'],
      aliases: [],
      stateChanges: [{ entity: '托马斯', attribute: '失踪方式', before: '', after: '主动消失' }],
      truthStatus: 'confirmed',
    })], '', [108], [{
      is_user: false,
      name: '陌白·福尔摩斯',
      mes: '插销没有工具痕迹。那名失踪男子为什么主动插好门闩？是为了保护什么人，还是另有原因？',
    }], 108);

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]?.reason).toContain('引用楼层不支持专名：托马斯');
  });

  it('demotes Assistant deductions even when the model labels them confirmed', () => {
    const result = assessMemoryCandidates([candidate({
      sourceMessageIds: [108],
      evidenceRole: 'assistant',
      type: 'revelation',
      event: '陌白推断失踪男子主动制造了密室消失。',
      entities: ['失踪男子'],
      aliases: [],
      stateChanges: [],
      truthStatus: 'confirmed',
    })], '', [108], [{
      is_user: false,
      name: '陌白·福尔摩斯',
      mes: '插销没有工具痕迹，这说明他可能主动插好门闩，但原因尚未确认。',
    }], 108);

    expect(result.rejected).toEqual([]);
    expect(result.accepted[0]?.truthStatus).toBe('inferred');
  });

  it('keeps an explicit Assistant-authored plot transition confirmed', () => {
    const result = assessMemoryCandidates([candidate({
      sourceMessageIds: [22],
      evidenceRole: 'assistant',
      event: '灰帽男人从林雨手中夺走银色钥匙。',
      entities: ['灰帽男人', '林雨', '银色钥匙'],
      aliases: [],
      stateChanges: [{ entity: '银色钥匙', attribute: '持有者', before: '林雨', after: '灰帽男人' }],
      truthStatus: 'confirmed',
    })], '', [22], [{
      is_user: false,
      mes: '灰帽男人撞开林雨，夺走银色钥匙后跳上马车离开。',
    }], 22);

    expect(result.rejected).toEqual([]);
    expect(result.accepted[0]?.truthStatus).toBe('confirmed');
  });

  it('isolates legacy phantom names but permits a name grounded by an older memory', () => {
    const chat = [
      { is_user: true, mes: '侦探顾青进入车厢。' },
      { is_user: false, mes: '那名失踪男子可能主动锁上了门。' },
    ];
    const established = memory({
      id: 'established-gu',
      sourceMessageIds: [0],
      entities: ['顾青'],
      aliases: [],
      stateChanges: [],
    });
    const pronounUpdate = memory({
      id: 'pronoun-update',
      sourceMessageIds: [1],
      entities: ['顾青'],
      aliases: [],
      stateChanges: [],
    });
    const phantom = memory({
      id: 'phantom-thomas',
      sourceMessageIds: [1],
      entities: ['托马斯'],
      aliases: [],
      stateChanges: [],
    });
    const directlyGrounded = directlyGroundedStoryMemoryNames(established, chat);
    const establishedNames = new Set(directlyGrounded.map(normalizedStoryEntityName));

    expect(directlyGrounded).toEqual(['顾青']);
    expect(unsupportedStoryMemoryNames(pronounUpdate, chat, establishedNames)).toEqual([]);
    expect(unsupportedStoryMemoryNames(phantom, chat, establishedNames)).toEqual(['托马斯']);
  });

  it('rejects an invented holder hidden in a state value', () => {
    const result = assessMemoryCandidates([candidate({
      sourceMessageIds: [30],
      evidenceRole: 'assistant',
      event: '银色钥匙由托马斯保管。',
      entities: ['银色钥匙'],
      aliases: [],
      stateChanges: [{ entity: '银色钥匙', attribute: '持有者', before: '', after: '托马斯' }],
    })], '', [30], [{
      is_user: false,
      mes: '那名警探接过银色钥匙，收进了上衣内袋。',
    }], 30);

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]?.reason).toContain('引用楼层不支持专名：托马斯');
  });

  it('allows an established person name to resolve a pronoun-only state update', () => {
    const establishedNames = new Set([normalizedStoryEntityName('林雨')]);
    const result = assessMemoryCandidates([candidate({
      sourceMessageIds: [31],
      evidenceRole: 'assistant',
      event: '林雨接过银色钥匙。',
      entities: ['银色钥匙'],
      aliases: [],
      stateChanges: [{ entity: '银色钥匙', attribute: '持有者', before: '', after: '林雨' }],
    })], '', [31], [{
      is_user: false,
      mes: '她接过银色钥匙，收进了上衣内袋。',
    }], 31, establishedNames);

    expect(result.rejected).toEqual([]);
    expect(result.accepted[0]?.stateChanges[0]?.after).toBe('林雨');
  });

  it('does not mistake a locally normalized state subject for an invented person name', () => {
    const result = assessMemoryCandidates([candidate({
      sourceMessageIds: [9],
      evidenceRole: 'user',
      event: '用户纠正当前年份为2026年。',
      entities: ['当前年份'],
      aliases: [],
      stateChanges: [{ entity: '当前年份', attribute: '年份', before: '2025', after: '2026' }],
    })], '', [9], [{
      is_user: true,
      mes: '不是2025年，今年已经是2026年。',
    }], 9);

    expect(result.rejected).toEqual([]);
    expect(result.accepted[0]?.stateChanges[0]?.after).toBe('2026');
  });

  it('grounds stable identifiers separately inside a composite location value', () => {
    const result = assessMemoryCandidates([candidate({
      sourceMessageIds: [153],
      evidenceRole: 'user',
      event: 'M-7仍留在221B的墙体保险柜B-3格。',
      entities: ['M-7'],
      aliases: [],
      stateChanges: [{
        entity: 'M-7',
        attribute: '位置',
        before: '',
        after: '221B墙体保险柜B-3格',
      }],
    })], '', [153], [{
      is_user: true,
      mes: '我们不把真文件带出221B：M-7仍留在墙体保险柜B-3格。',
    }], 153);

    expect(result.rejected).toEqual([]);
    expect(result.accepted[0]?.stateChanges[0]?.after).toBe('221B墙体保险柜B-3格');
  });

  it('does not treat a first-person carried-state phrase as an invented full name', () => {
    const result = assessMemoryCandidates([candidate({
      sourceMessageIds: [154],
      evidenceRole: 'user',
      event: '诱饵M-7D由刘爽随身携带。',
      entities: ['M-7D'],
      aliases: [],
      stateChanges: [{
        entity: 'M-7D',
        attribute: '持有者',
        before: '',
        after: '刘爽随身携带',
      }],
    })], '', [154], [{
      is_user: true,
      name: '刘爽',
      mes: '诱饵M-7D由我随身携带。',
    }], 154);

    expect(result.rejected).toEqual([]);
    expect(result.accepted[0]?.stateChanges[0]?.after).toBe('刘爽随身携带');
  });
});
