import { describe, expect, it } from 'vitest';
import { assessMemoryCandidates } from '../src/extraction/quality';
import { candidate } from './fixtures';

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
});
