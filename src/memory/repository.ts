import { CHAT_STATE_VERSION, MODULE_ID, VECTOR_COLLECTION_PREFIX } from '../core/constants';
import type { StoryEchoChatState, StoryMemory } from '../core/types';
import { createMetrics, normalizeMetrics } from '../debug/metrics';
import { getContext, getCurrentChatId } from '../platform/sillytavern';
import { createUuid } from '../core/uuid';

function createCollectionId(chatUuid: string): string {
  return `${VECTOR_COLLECTION_PREFIX}_${chatUuid}_v${CHAT_STATE_VERSION}`;
}

function createState(ownerChatId: string): StoryEchoChatState {
  const chatUuid = createUuid();
  return {
    schemaVersion: CHAT_STATE_VERSION,
    chatUuid,
    ownerChatId,
    vectorCollectionId: createCollectionId(chatUuid),
    indexedThroughMessageId: -1,
    indexedThroughHash: '',
    indexedPrefixHash: '',
    memories: [],
    pendingRanges: [],
    pendingVectorHashes: [],
    pendingVectorDeleteHashes: [],
    vectorFingerprint: '',
    metrics: createMetrics(),
    debugTraces: [],
  };
}

type StoredMemory = Omit<
  StoryMemory,
  'sourceHistory' | 'supersedesMemoryIds' | 'lastOperation'
> & Partial<Pick<StoryMemory, 'sourceHistory' | 'supersedesMemoryIds' | 'lastOperation'>>;

type StoredState = Omit<
  StoryEchoChatState,
  | 'memories'
  | 'pendingVectorHashes'
  | 'pendingVectorDeleteHashes'
  | 'vectorFingerprint'
  | 'indexedPrefixHash'
  | 'metrics'
  | 'debugTraces'
> & {
  memories: StoredMemory[];
  pendingVectorHashes?: number[];
  pendingVectorDeleteHashes?: number[];
  vectorFingerprint?: string;
  indexedPrefixHash?: string;
  metrics?: StoryEchoChatState['metrics'];
  debugTraces?: StoryEchoChatState['debugTraces'];
};

function isStateBase(value: unknown): value is StoredState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<StoryEchoChatState>;
  return (
    candidate.schemaVersion === CHAT_STATE_VERSION &&
    typeof candidate.chatUuid === 'string' &&
    typeof candidate.ownerChatId === 'string' &&
    typeof candidate.vectorCollectionId === 'string' &&
    typeof candidate.indexedThroughMessageId === 'number' &&
    Array.isArray(candidate.memories) &&
    Array.isArray(candidate.pendingRanges)
  );
}

function normalizeState(stored: StoredState): StoryEchoChatState {
  const lastInspection = stored.lastInspection
    ? {
        ...stored.lastInspection,
        vectorResultCount: Number.isFinite(stored.lastInspection.vectorResultCount)
          ? stored.lastInspection.vectorResultCount
          : 0,
        durationMs: Number.isFinite(stored.lastInspection.durationMs)
          ? stored.lastInspection.durationMs
          : 0,
        estimatedRemovedTokens: Number.isFinite(stored.lastInspection.estimatedRemovedTokens)
          ? stored.lastInspection.estimatedRemovedTokens
          : 0,
        estimatedInjectedTokens: Number.isFinite(stored.lastInspection.estimatedInjectedTokens)
          ? stored.lastInspection.estimatedInjectedTokens
          : 0,
        estimatedNetSavedTokens: Number.isFinite(stored.lastInspection.estimatedNetSavedTokens)
          ? stored.lastInspection.estimatedNetSavedTokens
          : 0,
      }
    : undefined;
  return {
    ...stored,
    memories: stored.memories.map((memory) => ({
      ...memory,
      unresolvedThreads: memory.status === 'resolved'
        ? []
        : Array.isArray(memory.unresolvedThreads) ? memory.unresolvedThreads : [],
      sourceHistory: Array.isArray(memory.sourceHistory) && memory.sourceHistory.length > 0
        ? memory.sourceHistory
        : [memory.source],
      supersedesMemoryIds: Array.isArray(memory.supersedesMemoryIds)
        ? memory.supersedesMemoryIds
        : [],
      lastOperation: memory.lastOperation ?? 'CREATE',
    })),
    pendingVectorHashes: Array.isArray(stored.pendingVectorHashes) ? stored.pendingVectorHashes : [],
    pendingVectorDeleteHashes: Array.isArray(stored.pendingVectorDeleteHashes)
      ? stored.pendingVectorDeleteHashes
      : [],
    vectorFingerprint: typeof stored.vectorFingerprint === 'string' ? stored.vectorFingerprint : '',
    indexedPrefixHash: typeof stored.indexedPrefixHash === 'string' ? stored.indexedPrefixHash : '',
    metrics: normalizeMetrics(stored.metrics),
    debugTraces: Array.isArray(stored.debugTraces) ? stored.debugTraces.slice(-50) : [],
    ...(lastInspection ? { lastInspection } : {}),
  };
}

export class MemoryRepository {
  getExisting(): StoryEchoChatState | null {
    const context = getContext();
    const stored = context.chatMetadata[MODULE_ID];
    if (!isStateBase(stored) || stored.ownerChatId !== getCurrentChatId(context)) {
      return null;
    }
    return normalizeState(stored);
  }

  async getOrCreate(): Promise<StoryEchoChatState | null> {
    const context = getContext();
    const currentChatId = getCurrentChatId(context);
    if (!currentChatId) {
      return null;
    }

    const stored = context.chatMetadata[MODULE_ID];
    if (!isStateBase(stored)) {
      const state = createState(currentChatId);
      context.chatMetadata[MODULE_ID] = state;
      await context.saveMetadata();
      return state;
    }

    const state = normalizeState(stored);
    if (
      !Array.isArray(stored.pendingVectorHashes) ||
      !Array.isArray(stored.pendingVectorDeleteHashes) ||
      typeof stored.vectorFingerprint !== 'string' ||
      typeof stored.indexedPrefixHash !== 'string' ||
      !stored.metrics ||
      !Array.isArray(stored.debugTraces) ||
      (stored.lastInspection !== undefined &&
        (!Number.isFinite(stored.lastInspection.vectorResultCount) ||
          !Number.isFinite(stored.lastInspection.durationMs) ||
          !Number.isFinite(stored.lastInspection.estimatedRemovedTokens) ||
          !Number.isFinite(stored.lastInspection.estimatedInjectedTokens) ||
          !Number.isFinite(stored.lastInspection.estimatedNetSavedTokens))) ||
      stored.memories.some(
        (memory) =>
          !Array.isArray(memory.sourceHistory) ||
          memory.sourceHistory.length === 0 ||
          !Array.isArray(memory.supersedesMemoryIds) ||
          !Array.isArray(memory.unresolvedThreads) ||
          !memory.lastOperation ||
          (memory.status === 'resolved' && memory.unresolvedThreads.length > 0),
      )
    ) {
      context.chatMetadata[MODULE_ID] = state;
      await context.saveMetadata();
    }

    if (state.ownerChatId !== currentChatId) {
      const branchUuid = createUuid();
      const branchState: StoryEchoChatState = {
        ...structuredClone(state),
        chatUuid: branchUuid,
        ownerChatId: currentChatId,
        vectorCollectionId: createCollectionId(branchUuid),
        pendingVectorHashes: state.memories
          .filter((memory) => memory.status !== 'invalid' && memory.status !== 'superseded')
          .map((memory) => memory.vectorHash),
        pendingVectorDeleteHashes: [],
        vectorFingerprint: '',
        metrics: createMetrics(),
        debugTraces: [],
      };
      delete branchState.lastInspection;
      context.chatMetadata[MODULE_ID] = branchState;
      await context.saveMetadata();
      return branchState;
    }

    return state;
  }

  async save(state: StoryEchoChatState): Promise<void> {
    const context = getContext();
    if (getCurrentChatId(context) !== state.ownerChatId) {
      throw new Error('保存期间聊天发生切换，已取消写入。');
    }
    context.chatMetadata[MODULE_ID] = state;
    await context.saveMetadata();
  }

  async upsertMemories(memories: StoryMemory[]): Promise<StoryEchoChatState> {
    const state = await this.getOrCreate();
    if (!state) {
      throw new Error('当前没有可用聊天。');
    }

    const byId = new Map(state.memories.map((memory) => [memory.id, memory]));
    for (const memory of memories) {
      const existing = byId.get(memory.id);
      if (existing && existing.vectorHash !== memory.vectorHash) {
        state.pendingVectorDeleteHashes.push(existing.vectorHash);
      }
      if (memory.status !== 'invalid' && memory.status !== 'superseded') {
        state.pendingVectorHashes.push(memory.vectorHash);
      } else {
        state.pendingVectorDeleteHashes.push(memory.vectorHash);
      }
      byId.set(memory.id, memory);
    }
    state.memories = [...byId.values()];
    state.pendingVectorHashes = [...new Set(state.pendingVectorHashes)];
    state.pendingVectorDeleteHashes = [...new Set(state.pendingVectorDeleteHashes)];
    await this.save(state);
    return state;
  }

  async removeMemory(memoryId: string): Promise<StoryEchoChatState> {
    const state = await this.getOrCreate();
    if (!state) {
      throw new Error('当前没有可用聊天。');
    }
    const removed = state.memories.find((memory) => memory.id === memoryId);
    state.memories = state.memories.filter((memory) => memory.id !== memoryId);
    if (removed) {
      state.pendingVectorHashes = state.pendingVectorHashes.filter((hash) => hash !== removed.vectorHash);
      state.pendingVectorDeleteHashes = [...new Set([
        ...state.pendingVectorDeleteHashes,
        removed.vectorHash,
      ])];
    }
    await this.save(state);
    return state;
  }

  async clear(): Promise<void> {
    const context = getContext();
    delete context.chatMetadata[MODULE_ID];
    await context.saveMetadata();
  }
}
