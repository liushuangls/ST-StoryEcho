import { CHAT_STATE_VERSION, MODULE_ID, VECTOR_COLLECTION_PREFIX } from '../core/constants';
import type {
  EvidenceRole,
  StageSummaryEntry,
  StoryEchoChatState,
  StoryMemory,
  TavernChatMessage,
} from '../core/types';
import { createMetrics, normalizeMetrics } from '../debug/metrics';
import { getContext, getCurrentChatId } from '../platform/sillytavern';
import { createUuid } from '../core/uuid';
import { deriveLogicalKey } from '../consolidation/identity';
import { classifyEvidenceRole } from '../extraction/evidence';

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
    stageSummary: {
      entries: [],
      coveredThroughMessageId: -1,
      coveredThroughHash: '',
    },
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
  | 'logicalKey'
  | 'sourceMessageIds'
  | 'evidenceRole'
  | 'sourceHistory'
  | 'supersedesMemoryIds'
  | 'lastOperation'
> & Partial<Pick<
  StoryMemory,
  | 'logicalKey'
  | 'sourceMessageIds'
  | 'evidenceRole'
  | 'sourceHistory'
  | 'supersedesMemoryIds'
  | 'lastOperation'
>>;

interface StoredStageSummary {
  entries?: unknown;
  text?: unknown;
  coveredThroughMessageId?: unknown;
  coveredThroughHash?: unknown;
  updatedAt?: unknown;
}

type StoredState = Omit<
  StoryEchoChatState,
  | 'memories'
  | 'pendingVectorHashes'
  | 'pendingVectorDeleteHashes'
  | 'vectorFingerprint'
  | 'indexedPrefixHash'
  | 'stageSummary'
  | 'metrics'
  | 'debugTraces'
> & {
  memories: StoredMemory[];
  pendingVectorHashes?: number[];
  pendingVectorDeleteHashes?: number[];
  vectorFingerprint?: string;
  indexedPrefixHash?: string;
  stageSummary?: StoredStageSummary;
  metrics?: StoryEchoChatState['metrics'];
  debugTraces?: StoryEchoChatState['debugTraces'];
};

const LEGACY_SUMMARY_UPDATED_AT = '1970-01-01T00:00:00.000Z';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeEvidenceRole(
  value: unknown,
  sourceMessageIds: number[],
  chat: readonly TavernChatMessage[],
): EvidenceRole {
  if (value === 'user' || value === 'assistant' || value === 'mixed' || value === 'unknown') {
    return value;
  }
  return classifyEvidenceRole(sourceMessageIds, chat);
}

function normalizeStageSummaryEntry(value: unknown): StageSummaryEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const text = typeof value['text'] === 'string' ? value['text'].trim() : '';
  const sourceStartMessageId = Number(value['sourceStartMessageId']);
  const sourceEndMessageId = Number(value['sourceEndMessageId']);
  if (
    !text ||
    !Number.isFinite(sourceStartMessageId) ||
    !Number.isFinite(sourceEndMessageId) ||
    sourceStartMessageId < 0 ||
    sourceEndMessageId < sourceStartMessageId
  ) {
    return null;
  }
  return {
    text,
    sourceStartMessageId: Math.floor(sourceStartMessageId),
    sourceEndMessageId: Math.floor(sourceEndMessageId),
    sourceHash: typeof value['sourceHash'] === 'string' ? value['sourceHash'] : '',
    updatedAt: typeof value['updatedAt'] === 'string'
      ? value['updatedAt']
      : LEGACY_SUMMARY_UPDATED_AT,
  };
}

function normalizeStageSummary(value: StoredStageSummary | undefined): StoryEchoChatState['stageSummary'] {
  const entries: StageSummaryEntry[] = [];
  const storedEntries = Array.isArray(value?.entries) ? value.entries : [];
  let expectedStartMessageId = 0;
  for (const candidate of storedEntries) {
    const entry = normalizeStageSummaryEntry(candidate);
    if (!entry || entry.sourceStartMessageId !== expectedStartMessageId) {
      break;
    }
    entries.push(entry);
    expectedStartMessageId = entry.sourceEndMessageId + 1;
  }

  // 0.8.x stored one rolling summary. Preserve it as a single legacy entry so
  // upgrading never discards already compressed history; all later entries
  // are generated independently.
  if (entries.length === 0) {
    const legacyText = typeof value?.text === 'string' ? value.text.trim() : '';
    const legacyEnd = Number(value?.coveredThroughMessageId);
    if (legacyText && Number.isFinite(legacyEnd) && legacyEnd >= 0) {
      entries.push({
        text: legacyText,
        sourceStartMessageId: 0,
        sourceEndMessageId: Math.floor(legacyEnd),
        sourceHash: typeof value?.coveredThroughHash === 'string' ? value.coveredThroughHash : '',
        updatedAt: typeof value?.updatedAt === 'string'
          ? value.updatedAt
          : LEGACY_SUMMARY_UPDATED_AT,
      });
    }
  }

  const latest = entries.at(-1);
  return {
    entries,
    coveredThroughMessageId: latest?.sourceEndMessageId ?? -1,
    coveredThroughHash: latest?.sourceHash ?? '',
    ...(latest ? { updatedAt: latest.updatedAt } : {}),
  };
}

function isCurrentStageSummary(value: StoredStageSummary | undefined): boolean {
  if (
    !value ||
    !Array.isArray(value.entries) ||
    !Number.isFinite(value.coveredThroughMessageId) ||
    typeof value.coveredThroughHash !== 'string'
  ) {
    return false;
  }
  const normalized = normalizeStageSummary(value);
  return (
    normalized.entries.length === value.entries.length &&
    normalized.coveredThroughMessageId === value.coveredThroughMessageId &&
    normalized.coveredThroughHash === value.coveredThroughHash
  );
}

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

function normalizeState(
  stored: StoredState,
  chat: readonly TavernChatMessage[] = [],
): StoryEchoChatState {
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
        estimatedSummaryTokens: Number.isFinite(stored.lastInspection.estimatedSummaryTokens)
          ? stored.lastInspection.estimatedSummaryTokens
          : 0,
        summaryCoveredThroughMessageId: Number.isFinite(
          stored.lastInspection.summaryCoveredThroughMessageId,
        )
          ? stored.lastInspection.summaryCoveredThroughMessageId
          : -1,
      }
    : undefined;
  return {
    ...stored,
    memories: stored.memories.map((memory) => {
      const sourceMessageIds = Array.isArray(memory.sourceMessageIds) && memory.sourceMessageIds.length > 0
        ? [...new Set(memory.sourceMessageIds
          .map((messageId) => Number(messageId))
          .filter((messageId) => Number.isInteger(messageId) && messageId >= 0))]
        : memory.source.startMessageId === memory.source.endMessageId
          ? [memory.source.startMessageId]
          : [memory.source.startMessageId, memory.source.endMessageId];
      return {
        ...memory,
        logicalKey: typeof memory.logicalKey === 'string' && memory.logicalKey.trim()
          ? memory.logicalKey.trim()
          : deriveLogicalKey(memory),
        sourceMessageIds,
        evidenceRole: normalizeEvidenceRole(memory.evidenceRole, sourceMessageIds, chat),
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
      };
    }),
    pendingVectorHashes: Array.isArray(stored.pendingVectorHashes) ? stored.pendingVectorHashes : [],
    pendingVectorDeleteHashes: Array.isArray(stored.pendingVectorDeleteHashes)
      ? stored.pendingVectorDeleteHashes
      : [],
    vectorFingerprint: typeof stored.vectorFingerprint === 'string' ? stored.vectorFingerprint : '',
    indexedPrefixHash: typeof stored.indexedPrefixHash === 'string' ? stored.indexedPrefixHash : '',
    stageSummary: normalizeStageSummary(stored.stageSummary),
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
    return normalizeState(stored, context.chat);
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

    const state = normalizeState(stored, context.chat);
    if (
      !Array.isArray(stored.pendingVectorHashes) ||
      !Array.isArray(stored.pendingVectorDeleteHashes) ||
      typeof stored.vectorFingerprint !== 'string' ||
      typeof stored.indexedPrefixHash !== 'string' ||
      !isCurrentStageSummary(stored.stageSummary) ||
      !stored.metrics ||
      !Array.isArray(stored.debugTraces) ||
      (stored.lastInspection !== undefined &&
        (!Number.isFinite(stored.lastInspection.vectorResultCount) ||
          !Number.isFinite(stored.lastInspection.durationMs) ||
          !Number.isFinite(stored.lastInspection.estimatedRemovedTokens) ||
          !Number.isFinite(stored.lastInspection.estimatedInjectedTokens) ||
          !Number.isFinite(stored.lastInspection.estimatedNetSavedTokens) ||
          !Number.isFinite(stored.lastInspection.estimatedSummaryTokens) ||
          !Number.isFinite(stored.lastInspection.summaryCoveredThroughMessageId))) ||
      stored.memories.some(
        (memory) =>
          !Array.isArray(memory.sourceHistory) ||
          memory.sourceHistory.length === 0 ||
          typeof memory.logicalKey !== 'string' ||
          !memory.logicalKey.trim() ||
          !Array.isArray(memory.sourceMessageIds) ||
          memory.sourceMessageIds.length === 0 ||
          !['user', 'assistant', 'mixed', 'unknown'].includes(String(memory.evidenceRole ?? '')) ||
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
