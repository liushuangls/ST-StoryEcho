import { CHAT_STATE_VERSION, MODULE_ID, VECTOR_COLLECTION_PREFIX } from '../core/constants';
import type { StoryEchoChatState, StoryMemory } from '../core/types';
import { getContext, getCurrentChatId } from '../platform/sillytavern';

function newUuid(): string {
  return crypto.randomUUID();
}

function createCollectionId(chatUuid: string): string {
  return `${VECTOR_COLLECTION_PREFIX}_${chatUuid}_v${CHAT_STATE_VERSION}`;
}

function createState(ownerChatId: string): StoryEchoChatState {
  const chatUuid = newUuid();
  return {
    schemaVersion: CHAT_STATE_VERSION,
    chatUuid,
    ownerChatId,
    vectorCollectionId: createCollectionId(chatUuid),
    indexedThroughMessageId: -1,
    indexedThroughHash: '',
    memories: [],
    pendingRanges: [],
    pendingVectorHashes: [],
    vectorFingerprint: '',
  };
}

type StoredState = Omit<StoryEchoChatState, 'pendingVectorHashes' | 'vectorFingerprint'> & {
  pendingVectorHashes?: number[];
  vectorFingerprint?: string;
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
  return {
    ...stored,
    pendingVectorHashes: Array.isArray(stored.pendingVectorHashes) ? stored.pendingVectorHashes : [],
    vectorFingerprint: typeof stored.vectorFingerprint === 'string' ? stored.vectorFingerprint : '',
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
    if (!Array.isArray(stored.pendingVectorHashes) || typeof stored.vectorFingerprint !== 'string') {
      context.chatMetadata[MODULE_ID] = state;
      await context.saveMetadata();
    }

    if (state.ownerChatId !== currentChatId) {
      const branchUuid = newUuid();
      const branchState: StoryEchoChatState = {
        ...structuredClone(state),
        chatUuid: branchUuid,
        ownerChatId: currentChatId,
        vectorCollectionId: createCollectionId(branchUuid),
        pendingVectorHashes: state.memories
          .filter((memory) => memory.status !== 'invalid' && memory.status !== 'superseded')
          .map((memory) => memory.vectorHash),
        vectorFingerprint: '',
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
      byId.set(memory.id, memory);
    }
    state.memories = [...byId.values()];
    await this.save(state);
    return state;
  }

  async removeMemory(memoryId: string): Promise<StoryEchoChatState> {
    const state = await this.getOrCreate();
    if (!state) {
      throw new Error('当前没有可用聊天。');
    }
    state.memories = state.memories.filter((memory) => memory.id !== memoryId);
    await this.save(state);
    return state;
  }

  async clear(): Promise<void> {
    const context = getContext();
    delete context.chatMetadata[MODULE_ID];
    await context.saveMetadata();
  }
}
