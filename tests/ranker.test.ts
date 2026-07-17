import { describe, expect, it } from 'vitest';
import type { StoryMemory } from '../src/core/types';
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
    const result = rankMemories('我把钟楼钥匙交给了她', [memory({})], []);
    expect(result.map((item) => item.id)).toEqual(['mem-1']);
  });

  it('does not include an unrelated unpinned item without a vector result', () => {
    const result = rankMemories('我们去港口', [memory({})], []);
    expect(result).toEqual([]);
  });
});
