import type {
  StoryEchoChatState,
  StoryMemory,
} from '../src/core/types';
import { createMetrics } from '../src/debug/metrics';
import type { ExtractedMemoryCandidate } from '../src/extraction/types';

export function candidate(
  overrides: Partial<ExtractedMemoryCandidate> = {},
): ExtractedMemoryCandidate {
  return {
    sourceMessageIds: [1, 2],
    evidenceRole: 'user',
    type: 'state_change',
    scene: { location: '', time: '', participants: ['林雨'] },
    event: '林雨获得银色钥匙',
    cause: '',
    consequence: '',
    entities: ['林雨', '银色钥匙'],
    aliases: ['钟楼钥匙'],
    stateChanges: [{ entity: '银色钥匙', attribute: '持有者', before: '', after: '林雨' }],
    unresolvedThreads: [],
    knownBy: ['林雨'],
    truthStatus: 'confirmed',
    importance: 0.8,
    retrievalText: '银色钥匙现在由林雨持有，别名钟楼钥匙。',
    injectionText: '较早时，林雨获得并持有银色钥匙。',
    ...overrides,
  };
}
export function memory(overrides: Partial<StoryMemory> = {}): StoryMemory {
  const source = { startMessageId: 1, endMessageId: 2, sourceHash: 'source-1' };
  return {
    id: 'mem-1',
    logicalKey: 'holder:银色钥匙',
    type: 'state_change',
    source,
    sourceMessageIds: [1, 2],
    evidenceRole: 'user',
    sourceHistory: [source],
    scene: { participants: ['林雨'] },
    event: '林雨获得银色钥匙',
    entities: ['林雨', '银色钥匙'],
    aliases: ['钟楼钥匙'],
    stateChanges: [{ entity: '银色钥匙', attribute: '持有者', after: '林雨' }],
    unresolvedThreads: [],
    knownBy: ['林雨'],
    truthStatus: 'confirmed',
    importance: 0.8,
    status: 'active',
    retrievalText: '银色钥匙现在由林雨持有，别名钟楼钥匙。',
    injectionText: '较早时，林雨获得并持有银色钥匙。',
    vectorHash: 123,
    retrievalHash: 'retrieval-1',
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

export function chatState(memories: StoryMemory[] = []): StoryEchoChatState {
  return {
    schemaVersion: 1,
    chatUuid: 'chat-uuid',
    ownerChatId: 'chat-id',
    vectorCollectionId: 'story_echo_chat-uuid_v1',
    indexedThroughMessageId: 2,
    indexedThroughHash: 'source-1',
    indexedPrefixHash: '',
    stageSummary: {
      entries: [],
      coveredThroughMessageId: -1,
      coveredThroughHash: '',
    },
    storySkeleton: {
      text: '',
      coveredThroughMessageId: -1,
      sourceHash: '',
    },
    memories,
    pendingRanges: [],
    pendingVectorHashes: [],
    pendingVectorDeleteHashes: [],
    vectorFingerprint: 'fingerprint',
    metrics: createMetrics(),
    debugTraces: [],
  };
}
