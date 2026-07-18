import { describe, expect, it } from 'vitest';
import { applyConsolidationDecisions } from '../src/consolidation/apply';
import {
  fallbackConsolidationDecisions,
  parseConsolidationResponse,
} from '../src/consolidation/parser';
import { shortlistMemories } from '../src/consolidation/shortlist';
import { candidate, chatState, memory } from './fixtures';

describe('event consolidation', () => {
  it('shortlists memories sharing the same state slot without vector search', () => {
    const oldMemory = memory();
    const result = shortlistMemories([
      candidate({
        stateChanges: [{ entity: '银色钥匙', attribute: '持有者', before: '林雨', after: '用户' }],
      }),
    ], [oldMemory], new Set());

    expect(result.map((item) => item.id)).toEqual(['mem-1']);
  });

  it('falls back to SUPERSEDE when a state slot receives a different value', () => {
    const decisions = fallbackConsolidationDecisions([
      candidate({
        event: '林雨把银色钥匙交给用户',
        stateChanges: [{ entity: '银色钥匙', attribute: '持有者', before: '林雨', after: '用户' }],
        retrievalText: '银色钥匙现在由用户持有。',
        injectionText: '后来，林雨把银色钥匙交给了用户。',
      }),
    ], [memory()]);

    expect(decisions[0]).toMatchObject({ operation: 'SUPERSEDE', targetMemoryId: 'mem-1' });
  });

  it('accepts a valid LLM merge decision', () => {
    const next = candidate({ consequence: '她答应暂时不用它。' });
    const raw = JSON.stringify({
      actions: [{
        candidateIndex: 0,
        operation: 'MERGE',
        targetMemoryId: 'mem-1',
        reason: '同一把钥匙的互补事实。',
      }],
    });

    expect(parseConsolidationResponse(raw, [next], [memory()])[0]).toMatchObject({
      operation: 'MERGE',
      targetMemoryId: 'mem-1',
      reason: '同一把钥匙的互补事实。',
    });
  });

  it('ignores a model-supplied rewritten result and derives merged facts locally', () => {
    const next = candidate({ consequence: '林雨答应暂时保管银色钥匙。' });
    const raw = JSON.stringify({
      actions: [{
        candidateIndex: 0,
        operation: 'MERGE',
        targetMemoryId: 'mem-1',
        reason: '同一把钥匙的互补事实。',
        result: candidate({
          event: '不存在的人把钥匙扔进了海里',
          consequence: '银色钥匙已经沉入海底。',
          retrievalText: '银色钥匙在海底。',
          injectionText: '银色钥匙已经沉入海底。',
        }),
      }],
    });

    const decision = parseConsolidationResponse(raw, [next], [memory()])[0];
    expect(decision?.result.event).toBe('林雨获得银色钥匙');
    expect(decision?.result.consequence).toBe('林雨答应暂时保管银色钥匙。');
    expect(decision?.result.retrievalText).not.toContain('海底');
  });

  it('supersedes a moved secret location even when the model omitted stateChanges', () => {
    const old = memory({
      type: 'event',
      event: '刘爽和顾青把银钥匙藏在暮钟旅店肖像后的暗格。',
      entities: ['刘爽', '顾青', '银钥匙', '暮钟旅店'],
      aliases: [],
      stateChanges: [],
      retrievalText: '银钥匙藏在暮钟旅店肖像后的暗格，顾青知情。',
      injectionText: '银钥匙原本藏在暮钟旅店肖像后的暗格。',
    });
    const moved = candidate({
      type: 'event',
      event: '刘爽和顾青把银钥匙从暮钟旅店取出，转移到钟表铺地下室的红色铁盒。',
      entities: ['刘爽', '顾青', '银钥匙', '暮钟旅店', '红色铁盒'],
      aliases: [],
      stateChanges: [],
      retrievalText: '银钥匙已从暮钟旅店暗格转移到红色铁盒，旧暗格已为空。',
      injectionText: '银钥匙现在位于红色铁盒，暮钟旅店旧暗格已为空。',
    });

    expect(fallbackConsolidationDecisions([moved], [old])[0]).toMatchObject({
      operation: 'SUPERSEDE',
      targetMemoryId: 'mem-1',
    });
  });

  it('merges a complementary confirmation into an existing moved-location fact', () => {
    const moved = memory({
      type: 'event',
      event: '银钥匙从暮钟旅店转移到红色铁盒。',
      entities: ['顾青', '银钥匙', '暮钟旅店', '红色铁盒'],
      aliases: [],
      stateChanges: [],
      retrievalText: '银钥匙已转移到红色铁盒，暮钟旅店旧暗格已为空。',
      injectionText: '银钥匙现在位于红色铁盒，旧暗格已为空。',
      consequence: '银钥匙当前位于青石镇钟表铺地下室的红色铁盒。',
    });
    const confirmation = candidate({
      type: 'state_change',
      event: '顾青锁好红色铁盒，并确认暮钟旅店旧暗格已经没有钥匙。',
      entities: ['顾青', '银钥匙', '暮钟旅店', '红色铁盒'],
      aliases: [],
      stateChanges: [],
      retrievalText: '顾青锁好红色铁盒，暮钟旅店旧暗格已经没有银钥匙。',
      injectionText: '顾青锁好红色铁盒，旧暗格已经没有银钥匙。',
      consequence: '红色铁盒已锁好，暮钟旅店旧暗格已经没有银钥匙。',
    });

    const decision = fallbackConsolidationDecisions([confirmation], [moved])[0];
    expect(decision).toMatchObject({
      operation: 'MERGE',
      targetMemoryId: 'mem-1',
    });
    expect(decision?.result.consequence).toContain('青石镇钟表铺地下室');
    expect(decision?.result.consequence).toContain('旧暗格已经没有银钥匙');
  });

  it('accepts common schema aliases but overrides a duplicate CREATE with deterministic MERGE', () => {
    const old = memory({
      stateChanges: [],
      entities: ['顾青', '银钥匙', '暮钟旅店'],
      aliases: [],
      event: '顾青把银钥匙藏在暮钟旅店暗格。',
      retrievalText: '顾青把银钥匙藏在暮钟旅店暗格。',
      injectionText: '银钥匙藏在暮钟旅店暗格。',
    });
    const repeated = candidate({
      stateChanges: [],
      entities: ['顾青', '银钥匙', '暮钟旅店'],
      aliases: [],
      event: '顾青确认银钥匙仍藏在暮钟旅店暗格。',
      retrievalText: '顾青确认银钥匙仍藏在暮钟旅店暗格。',
      injectionText: '顾青确认银钥匙仍在暮钟旅店暗格。',
    });
    const raw = JSON.stringify({
      decisions: [{
        candidate_index: 0,
        action: 'create',
        target_memory_id: '',
        rationale: '模型误判为新事件。',
      }],
    });

    expect(parseConsolidationResponse(raw, [repeated], [old])[0]).toMatchObject({
      operation: 'MERGE',
      targetMemoryId: 'mem-1',
    });
  });

  it('supersedes the old memory and queues vector replacement', async () => {
    const state = chatState([memory()]);
    const next = candidate({
      event: '林雨把银色钥匙交给用户',
      stateChanges: [{ entity: '银色钥匙', attribute: '持有者', before: '林雨', after: '用户' }],
      retrievalText: '银色钥匙现在由用户持有。',
      injectionText: '后来，用户从林雨手中接过银色钥匙。',
    });

    const result = await applyConsolidationDecisions(state, [{
      candidateIndex: 0,
      operation: 'SUPERSEDE',
      targetMemoryId: 'mem-1',
      reason: '持有者发生变化。',
      result: next,
    }], { startMessageId: 10, endMessageId: 11, sourceHash: 'source-2' });

    expect(state.memories[0]?.status).toBe('superseded');
    expect(state.memories[0]?.replacedByMemoryId).toBe(result.created[0]?.id);
    expect(result.created[0]?.supersedesMemoryIds).toContain('mem-1');
    expect(result.created[0]?.status).toBe('active');
    expect(state.pendingVectorDeleteHashes).toEqual([123]);
    expect(state.pendingVectorHashes).toEqual([result.created[0]?.vectorHash]);
    expect(state.metrics.actions.SUPERSEDE).toBe(1);
  });

  it.each([
    ['MERGE', 'active'],
    ['UPDATE', 'active'],
    ['RESOLVE', 'resolved'],
  ] as const)('applies %s in place and reindexes changed retrieval text', async (operation, status) => {
    const state = chatState([memory()]);
    const result = await applyConsolidationDecisions(state, [{
      candidateIndex: 0,
      operation,
      targetMemoryId: 'mem-1',
      reason: '同一事件的后续信息。',
      result: candidate({
        event: '钥匙事件有了后续',
        retrievalText: `钥匙事件${operation}后的完整检索事实。`,
        injectionText: `钥匙事件已经${operation}。`,
      }),
    }], { startMessageId: 8, endMessageId: 9, sourceHash: `source-${operation}` });

    expect(state.memories).toHaveLength(1);
    expect(state.memories[0]).toMatchObject({ id: 'mem-1', status, lastOperation: operation });
    expect(state.memories[0]?.sourceHistory).toHaveLength(2);
    expect(state.pendingVectorDeleteHashes).toEqual([123]);
    expect(state.pendingVectorHashes).toEqual([state.memories[0]?.vectorHash]);
    expect(state.metrics.actions[operation]).toBe(1);
    expect(result.changed).toHaveLength(1);
  });

  it('applies IGNORE without changing memory or vector queues', async () => {
    const oldMemory = memory();
    const state = chatState([oldMemory]);
    await applyConsolidationDecisions(state, [{
      candidateIndex: 0,
      operation: 'IGNORE',
      targetMemoryId: 'mem-1',
      reason: '完全重复。',
      result: candidate(),
    }], { startMessageId: 8, endMessageId: 9, sourceHash: 'source-ignore' });

    expect(state.memories).toEqual([oldMemory]);
    expect(state.pendingVectorDeleteHashes).toEqual([]);
    expect(state.pendingVectorHashes).toEqual([]);
    expect(state.metrics.actions.IGNORE).toBe(1);
  });

  it('protects manually edited memories by conservatively creating a new one', async () => {
    const state = chatState([memory({ manuallyEdited: true })]);
    const next = candidate({ retrievalText: '更新后的钥匙事实。' });
    const result = await applyConsolidationDecisions(state, [{
      candidateIndex: 0,
      operation: 'UPDATE',
      targetMemoryId: 'mem-1',
      reason: '模型尝试更新。',
      result: next,
    }], { startMessageId: 12, endMessageId: 13, sourceHash: 'source-3' });

    expect(state.memories).toHaveLength(2);
    expect(state.memories[0]?.manuallyEdited).toBe(true);
    expect(result.decisions[0]?.operation).toBe('CREATE');
    expect(state.metrics.actions.CREATE).toBe(1);
  });

  it('can ignore an exact duplicate of a manually edited memory without modifying it', () => {
    const manual = memory({ manuallyEdited: true });
    const candidates = [candidate()];
    const shortlist = shortlistMemories(candidates, [manual], new Set());
    const decisions = fallbackConsolidationDecisions(candidates, shortlist);

    expect(shortlist).toEqual([manual]);
    expect(decisions[0]?.operation).toBe('IGNORE');
  });
});
