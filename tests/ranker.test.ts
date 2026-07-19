import { describe, expect, it } from 'vitest';
import type { StoryMemory } from '../src/core/types';
import { buildRetrievalQueryPlan } from '../src/retrieval/query-builder';
import { rankMemories } from '../src/retrieval/ranker';

function memory(overrides: Partial<StoryMemory>): StoryMemory {
  return {
    id: 'mem-1',
    logicalKey: 'fact:林雨银色钥匙钟楼钥匙',
    type: 'event',
    source: { startMessageId: 1, endMessageId: 2, sourceHash: 'source' },
    sourceMessageIds: [1, 2],
    evidenceRole: 'user',
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

  it('prioritizes an effective state over a related commitment for a current-location question', () => {
    const commitment = memory({
      id: 'commitment',
      type: 'commitment',
      vectorHash: 1,
      event: '顾青承诺保守银钥匙的秘密',
      entities: ['顾青', '银钥匙'],
      aliases: [],
      stateChanges: [],
      retrievalText: '顾青承诺对银钥匙保密。',
    });
    const currentLocation = memory({
      id: 'current-location',
      type: 'state_change',
      vectorHash: 2,
      event: '银钥匙已转移到青石镇钟表铺地下室',
      entities: ['顾青', '银钥匙', '青石镇钟表铺'],
      aliases: [],
      stateChanges: [],
      retrievalText: '银钥匙现在位于青石镇钟表铺地下室的红色铁盒。',
    });
    const plan = buildRetrievalQueryPlan([
      { is_user: true, mes: '银钥匙现在具体藏在哪里？' },
    ], 0);
    const result = rankMemories(plan, [commitment, currentLocation], {
      intent: [
        { hash: 1, text: '', index: 0, rank: 0 },
        { hash: 2, text: '', index: 1, rank: 1 },
      ],
      scene: [],
    });

    expect(result.map((item) => item.id)).toEqual(['current-location', 'commitment']);
  });

  it('does not demote a resolved fact below an unrelated active state', () => {
    const disprovedRumor = memory({
      id: 'disproved-rumor',
      type: 'clue',
      status: 'resolved',
      vectorHash: 1,
      importance: 0.7,
      event: '核验确认木箱上没有黑色封条，旧传言为假。',
      entities: ['鹤鸣书院东库地下室', '木箱', '黑色封条'],
      aliases: [],
      retrievalText: '鹤鸣书院东库地下室木箱没有黑色封条，传言已被否定。',
    });
    const unrelatedActive = memory({
      id: 'unrelated-active',
      type: 'state_change',
      status: 'active',
      vectorHash: 2,
      event: '赤铜通行证当前由苏棠持有。',
      entities: ['赤铜通行证', '苏棠'],
      aliases: [],
      retrievalText: '赤铜通行证当前持有者是苏棠。',
    });
    const plan = buildRetrievalQueryPlan([{
      is_user: true,
      mes: '鹤鸣书院东库地下室木箱是否有黑色封条，当前核验事实是什么？',
    }], 0);
    const result = rankMemories(plan, [unrelatedActive, disprovedRumor], {
      intent: [
        { hash: 1, text: '', index: 0, rank: 1 },
        { hash: 2, text: '', index: 1, rank: 5 },
      ],
      scene: [],
    });

    expect(result.map((item) => item.id)).toEqual(['disproved-rumor']);
  });

  it('drops the weak vector tail after a clear best match while retaining pinned memories', () => {
    const memories = Array.from({ length: 6 }, (_, index) => memory({
      id: `vector-${index}`,
      vectorHash: index + 1,
      entities: [],
      aliases: [],
      ...(index === 5 ? { pinned: true } : {}),
    }));
    const plan = buildRetrievalQueryPlan([{ is_user: true, mes: '追查完全不同的旧线索' }], 0);
    const result = rankMemories(plan, memories, {
      intent: memories.slice(0, 5).map((item, rank) => ({
        hash: item.vectorHash,
        text: '',
        index: rank,
        rank,
      })),
      scene: [],
    });

    expect(result.map((item) => item.id)).toEqual([
      'vector-5',
      'vector-0',
      'vector-1',
      'vector-2',
      'vector-3',
    ]);
    expect(result.map((item) => item.id)).not.toContain('vector-4');
  });
});
