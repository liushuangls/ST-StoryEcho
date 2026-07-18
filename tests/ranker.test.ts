import { describe, expect, it } from 'vitest';
import type { StoryMemory } from '../src/core/types';
import { buildRetrievalQueryPlan } from '../src/retrieval/query-builder';
import { rankMemories } from '../src/retrieval/ranker';

function memory(overrides: Partial<StoryMemory>): StoryMemory {
  return {
    id: 'mem-1',
    type: 'event',
    source: { startMessageId: 1, endMessageId: 2, sourceHash: 'source' },
    sourceHistory: [{ startMessageId: 1, endMessageId: 2, sourceHash: 'source' }],
    scene: { participants: [] },
    event: '林雨获得银色钥匙',
    entities: ['林雨', '银色钥匙'],
    aliases: ['钟楼钥匙'],
    stateChanges: [],
    unresolvedThreads: [],
    knownBy: [],
    truthStatus: 'confirmed',
    importance: 0.8,
    status: 'active',
    retrievalText: '林雨 银色钥匙 钟楼钥匙',
    injectionText: '林雨持有银色钥匙。',
    vectorHash: 123,
    retrievalHash: 'retrieval',
    pinned: false,
    excluded: false,
    manuallyEdited: false,
    supersedesMemoryIds: [],
    lastOperation: 'CREATE',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('rankMemories', () => {
  it('can recall a Chinese entity match when vector search is unavailable', () => {
    const plan = buildRetrievalQueryPlan([{ is_user: true, mes: '我把钟楼钥匙交给了她' }], 0);
    const result = rankMemories(plan, [memory({})], { intent: [], scene: [] });
    expect(result.map((item) => item.id)).toEqual(['mem-1']);
  });

  it('does not include an unrelated unpinned item without a vector result', () => {
    const plan = buildRetrievalQueryPlan([{ is_user: true, mes: '我们去港口' }], 0);
    const result = rankMemories(plan, [memory({})], { intent: [], scene: [] });
    expect(result).toEqual([]);
  });

  it('gives the user-intent vector channel more weight for a concrete input', () => {
    const intentMemory = memory({ id: 'intent', vectorHash: 1, entities: [], aliases: [] });
    const sceneMemory = memory({ id: 'scene', vectorHash: 2, entities: [], aliases: [] });
    const plan = buildRetrievalQueryPlan([
      { is_user: false, mes: '场景里提到了港口。' },
      { is_user: true, mes: '我要询问银色钥匙。' },
    ], 1);
    const result = rankMemories(plan, [sceneMemory, intentMemory], {
      intent: [{ hash: 1, text: '', index: 1, rank: 0 }],
      scene: [{ hash: 2, text: '', index: 1, rank: 0 }],
    });

    expect(result.map((item) => item.id)).toEqual(['intent', 'scene']);
  });

  it('gives the scene vector channel more weight for a weak input', () => {
    const intentMemory = memory({ id: 'intent', vectorHash: 1, entities: [], aliases: [] });
    const sceneMemory = memory({ id: 'scene', vectorHash: 2, entities: [], aliases: [] });
    const plan = buildRetrievalQueryPlan([
      { is_user: false, mes: '林雨把银色钥匙放在桌上。' },
      { is_user: true, mes: '继续' },
    ], 1);
    const result = rankMemories(plan, [intentMemory, sceneMemory], {
      intent: [{ hash: 1, text: '', index: 1, rank: 0 }],
      scene: [{ hash: 2, text: '', index: 1, rank: 0 }],
    });

    expect(result.map((item) => item.id)).toEqual(['scene', 'intent']);
  });
});
