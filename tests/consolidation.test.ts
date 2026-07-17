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
        result: next,
      }],
    });

    expect(parseConsolidationResponse(raw, [next], [memory()])[0]).toMatchObject({
      operation: 'MERGE',
      targetMemoryId: 'mem-1',
      reason: '同一把钥匙的互补事实。',
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
