import { CHAT_STATE_VERSION, MODULE_ID, VECTOR_COLLECTION_PREFIX } from '../core/constants';
import { allocateVectorHash, sha256 } from '../core/hash';
import type {
  EvidenceRole,
  MemoryStatus,
  MemoryType,
  StageSummaryEntry,
  StoryEchoChatState,
  StoryMemory,
  TavernChatMessage,
  TruthStatus,
} from '../core/types';
import { createMetrics, normalizeMetrics } from '../debug/metrics';
import { getContext, getCurrentChatId } from '../platform/sillytavern';
import { createUuid } from '../core/uuid';
import { deriveLogicalKey } from '../consolidation/identity';
import { classifyEvidenceRole } from '../extraction/evidence';
import { SettingsRepository } from '../settings/repository';
import { normalizeStorySkeletonText } from '../summary/skeleton-state';

function createCollectionId(chatUuid: string): string {
  return `${VECTOR_COLLECTION_PREFIX}_${chatUuid}_v${CHAT_STATE_VERSION}`;
}

const MEMORY_TYPES = new Set<MemoryType>([
  'event',
  'state_change',
  'relationship_change',
  'commitment',
  'revelation',
  'clue',
  'conflict',
]);
const MEMORY_STATUSES = new Set<MemoryStatus>(['active', 'resolved', 'superseded', 'invalid']);
const TRUTH_STATUSES = new Set<TruthStatus>(['confirmed', 'claimed', 'inferred', 'uncertain']);

export interface StoryMemoryEdit {
  type: MemoryType;
  status: MemoryStatus;
  truthStatus: TruthStatus;
  importance: number;
  event: string;
  cause: string;
  consequence: string;
  scene: {
    location: string;
    time: string;
    participants: string[];
  };
  entities: string[];
  aliases: string[];
  stateChanges: Array<{
    entity: string;
    attribute: string;
    before?: string;
    after: string;
  }>;
  unresolvedThreads: string[];
  knownBy: string[];
  retrievalText: string;
  injectionText: string;
  pinned: boolean;
  excluded: boolean;
}

export interface StageSummaryEdit {
  text: string;
}

export interface StorySkeletonEdit {
  text: string;
}

const MAX_EDITED_SUMMARY_CHARACTERS = 64_000;

function normalizeStageSummaryEdit(edit: StageSummaryEdit): StageSummaryEdit {
  const text = String(edit.text ?? '').trim();
  if (!text) {
    throw new Error('阶段总结正文不能为空。');
  }
  if (text.length > MAX_EDITED_SUMMARY_CHARACTERS) {
    throw new Error(`阶段总结正文不能超过${MAX_EDITED_SUMMARY_CHARACTERS}个字符。`);
  }
  return { text };
}

function editableText(value: string, field: string, maxLength: number, required = false): string {
  const normalized = String(value ?? '').trim().slice(0, maxLength);
  if (required && !normalized) {
    throw new Error(`${field}不能为空。`);
  }
  return normalized;
}

function editableList(values: readonly string[], maxItems = 50): string[] {
  return [...new Set(values
    .slice(0, maxItems)
    .map((value) => String(value ?? '').trim().slice(0, 200))
    .filter(Boolean))];
}

function normalizeMemoryEdit(edit: StoryMemoryEdit): StoryMemoryEdit {
  if (!MEMORY_TYPES.has(edit.type)) {
    throw new Error('记忆类型无效。');
  }
  if (!MEMORY_STATUSES.has(edit.status)) {
    throw new Error('记忆状态无效。');
  }
  if (!TRUTH_STATUSES.has(edit.truthStatus)) {
    throw new Error('事实可信度无效。');
  }
  const importance = Number(edit.importance);
  if (!Number.isFinite(importance)) {
    throw new Error('重要度必须是数字。');
  }
  const stateChanges = edit.stateChanges.slice(0, 30).map((change) => {
    const entity = editableText(change.entity, '状态主体', 200, true);
    const attribute = editableText(change.attribute, '状态属性', 200, true);
    const before = editableText(change.before ?? '', '变更前状态', 500);
    const after = editableText(change.after, '变更后状态', 500, true);
    return {
      entity,
      attribute,
      ...(before ? { before } : {}),
      after,
    };
  });
  return {
    type: edit.type,
    status: edit.status,
    truthStatus: edit.truthStatus,
    importance: Math.min(1, Math.max(0, importance)),
    event: editableText(edit.event, '事件', 2_000, true),
    cause: editableText(edit.cause, '原因', 2_000),
    consequence: editableText(edit.consequence, '结果', 2_000),
    scene: {
      location: editableText(edit.scene.location, '地点', 300),
      time: editableText(edit.scene.time, '时间', 300),
      participants: editableList(edit.scene.participants),
    },
    entities: editableList(edit.entities),
    aliases: editableList(edit.aliases),
    stateChanges,
    unresolvedThreads: editableList(edit.unresolvedThreads),
    knownBy: editableList(edit.knownBy),
    retrievalText: editableText(edit.retrievalText, '检索文本', 4_000, true),
    injectionText: editableText(edit.injectionText, '注入文本', 2_000, true),
    pinned: Boolean(edit.pinned),
    excluded: Boolean(edit.excluded),
  };
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
    storySkeleton: {
      text: '',
      coveredThroughMessageId: -1,
      sourceHash: '',
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

interface StoredStorySkeleton {
  text?: unknown;
  coveredThroughMessageId?: unknown;
  sourceHash?: unknown;
  updatedAt?: unknown;
  manuallyEdited?: unknown;
  stale?: unknown;
}

type StoredState = Omit<
  StoryEchoChatState,
  | 'memories'
  | 'pendingVectorHashes'
  | 'pendingVectorDeleteHashes'
  | 'vectorFingerprint'
  | 'indexedPrefixHash'
  | 'stageSummary'
  | 'storySkeleton'
  | 'metrics'
  | 'debugTraces'
> & {
  memories: StoredMemory[];
  pendingVectorHashes?: number[];
  pendingVectorDeleteHashes?: number[];
  vectorFingerprint?: string;
  indexedPrefixHash?: string;
  stageSummary?: StoredStageSummary;
  storySkeleton?: StoredStorySkeleton;
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
  const deleted = value['deleted'] === true;
  const sourceStartMessageId = Number(value['sourceStartMessageId']);
  const sourceEndMessageId = Number(value['sourceEndMessageId']);
  if (
    (!text && !deleted) ||
    !Number.isFinite(sourceStartMessageId) ||
    !Number.isFinite(sourceEndMessageId) ||
    sourceStartMessageId < 0 ||
    sourceEndMessageId < sourceStartMessageId
  ) {
    return null;
  }
  return {
    text: deleted ? '' : text,
    sourceStartMessageId: Math.floor(sourceStartMessageId),
    sourceEndMessageId: Math.floor(sourceEndMessageId),
    sourceHash: typeof value['sourceHash'] === 'string' ? value['sourceHash'] : '',
    updatedAt: typeof value['updatedAt'] === 'string'
      ? value['updatedAt']
      : LEGACY_SUMMARY_UPDATED_AT,
    ...(value['manuallyEdited'] === true ? { manuallyEdited: true } : {}),
    ...(deleted ? { deleted: true } : {}),
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

function normalizeStorySkeleton(
  value: StoredStorySkeleton | undefined,
): StoryEchoChatState['storySkeleton'] {
  const text = typeof value?.text === 'string' ? value.text.trim() : '';
  const covered = Number(value?.coveredThroughMessageId);
  if (!text || !Number.isFinite(covered) || covered < 0) {
    return {
      text: '',
      coveredThroughMessageId: -1,
      sourceHash: '',
    };
  }
  const sourceHash = typeof value?.sourceHash === 'string' ? value.sourceHash : '';
  return {
    text,
    coveredThroughMessageId: Math.floor(covered),
    sourceHash,
    ...(typeof value?.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
    ...(value?.manuallyEdited === true ? { manuallyEdited: true } : {}),
    ...(value?.stale === true || !sourceHash ? { stale: true } : {}),
  };
}

function isCurrentStorySkeleton(value: StoredStorySkeleton | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = normalizeStorySkeleton(value);
  return normalized.text === (typeof value.text === 'string' ? value.text.trim() : '') &&
    normalized.coveredThroughMessageId === Number(value.coveredThroughMessageId) &&
    normalized.sourceHash === (typeof value.sourceHash === 'string' ? value.sourceHash : '');
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
    storySkeleton: normalizeStorySkeleton(stored.storySkeleton),
    metrics: normalizeMetrics(stored.metrics),
    debugTraces: Array.isArray(stored.debugTraces) ? stored.debugTraces.slice(-50) : [],
    ...(lastInspection ? { lastInspection } : {}),
  };
}

function markSkeletonStaleForSummary(
  state: StoryEchoChatState,
  sourceEndMessageId: number,
): void {
  if (
    state.storySkeleton.text &&
    sourceEndMessageId <= state.storySkeleton.coveredThroughMessageId
  ) {
    state.storySkeleton.stale = true;
  }
}

export class MemoryRepository {
  private readonly settingsRepository = new SettingsRepository();

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
      !isCurrentStorySkeleton(stored.storySkeleton) ||
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
      if (branchState.storySkeleton.text) {
        branchState.storySkeleton.stale = true;
      }
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

  async updateMemory(memoryId: string, edit: StoryMemoryEdit): Promise<StoryEchoChatState> {
    const state = await this.getOrCreate();
    if (!state) {
      throw new Error('当前没有可用聊天。');
    }
    const index = state.memories.findIndex((memory) => memory.id === memoryId);
    const existing = index >= 0 ? state.memories[index] : undefined;
    if (!existing) {
      throw new Error('要修改的剧情记忆不存在，可能已在其他页面删除。');
    }

    const normalized = normalizeMemoryEdit(edit);
    const retrievalChanged = normalized.retrievalText !== existing.retrievalText;
    const retrievalHash = retrievalChanged
      ? await sha256(normalized.retrievalText)
      : existing.retrievalHash;
    const occupied = new Set(state.memories
      .filter((memory) => memory.id !== memoryId)
      .map((memory) => memory.vectorHash));
    const vectorHash = retrievalChanged
      ? allocateVectorHash(`${existing.id}:${retrievalHash}`, occupied)
      : existing.vectorHash;
    const updatedAt = new Date().toISOString();
    const replacement: StoryMemory = {
      ...existing,
      type: normalized.type,
      status: normalized.status,
      truthStatus: normalized.truthStatus,
      importance: normalized.importance,
      event: normalized.event,
      scene: {
        ...(normalized.scene.location ? { location: normalized.scene.location } : {}),
        ...(normalized.scene.time ? { time: normalized.scene.time } : {}),
        participants: normalized.scene.participants,
      },
      entities: normalized.entities,
      aliases: normalized.aliases,
      stateChanges: normalized.stateChanges,
      unresolvedThreads: normalized.status === 'resolved' ? [] : normalized.unresolvedThreads,
      knownBy: normalized.knownBy,
      retrievalText: normalized.retrievalText,
      injectionText: normalized.injectionText,
      retrievalHash,
      vectorHash,
      pinned: normalized.pinned,
      excluded: normalized.excluded,
      manuallyEdited: true,
      lastOperation: 'UPDATE',
      updatedAt,
    };
    if (normalized.cause) {
      replacement.cause = normalized.cause;
    } else {
      delete replacement.cause;
    }
    if (normalized.consequence) {
      replacement.consequence = normalized.consequence;
    } else {
      delete replacement.consequence;
    }
    if (normalized.status !== 'superseded') {
      delete replacement.replacedByMemoryId;
    }
    replacement.logicalKey = deriveLogicalKey(replacement);

    state.memories[index] = replacement;
    const existingVectorEligible = existing.status !== 'invalid' && existing.status !== 'superseded';
    const vectorEligible = replacement.status !== 'invalid' && replacement.status !== 'superseded';
    if (existing.vectorHash !== replacement.vectorHash) {
      state.pendingVectorHashes = state.pendingVectorHashes.filter(
        (hash) => hash !== existing.vectorHash,
      );
      state.pendingVectorDeleteHashes.push(existing.vectorHash);
      if (vectorEligible) {
        state.pendingVectorHashes.push(replacement.vectorHash);
      }
    } else if (existingVectorEligible && !vectorEligible) {
      state.pendingVectorHashes = state.pendingVectorHashes.filter(
        (hash) => hash !== existing.vectorHash,
      );
      state.pendingVectorDeleteHashes.push(replacement.vectorHash);
    } else if (!existingVectorEligible && vectorEligible) {
      state.pendingVectorHashes.push(replacement.vectorHash);
      state.pendingVectorDeleteHashes = state.pendingVectorDeleteHashes.filter(
        (hash) => hash !== replacement.vectorHash,
      );
    }
    if (vectorEligible) {
      state.pendingVectorDeleteHashes = state.pendingVectorDeleteHashes.filter(
        (hash) => hash !== replacement.vectorHash,
      );
    }
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

  async updateStageSummaryEntry(
    sourceStartMessageId: number,
    edit: StageSummaryEdit,
  ): Promise<StoryEchoChatState> {
    const state = await this.getOrCreate();
    if (!state) {
      throw new Error('当前没有可用聊天。');
    }
    const index = state.stageSummary.entries.findIndex(
      (entry) => entry.sourceStartMessageId === sourceStartMessageId,
    );
    const existing = index >= 0 ? state.stageSummary.entries[index] : undefined;
    if (!existing || existing.deleted) {
      throw new Error('要修改的阶段总结不存在，可能已在其他页面删除或失效。');
    }
    const normalized = normalizeStageSummaryEdit(edit);
    state.stageSummary.entries[index] = {
      ...existing,
      text: normalized.text,
      updatedAt: new Date().toISOString(),
      manuallyEdited: true,
    };
    markSkeletonStaleForSummary(state, existing.sourceEndMessageId);
    const latest = state.stageSummary.entries.at(-1);
    state.stageSummary = {
      entries: state.stageSummary.entries,
      coveredThroughMessageId: latest?.sourceEndMessageId ?? -1,
      coveredThroughHash: latest?.sourceHash ?? '',
      ...(latest ? { updatedAt: latest.updatedAt } : {}),
    };
    delete state.lastInspection;
    await this.save(state);
    return state;
  }

  /**
   * Deleting the physical tail retreats the coverage cursor so that tail's
   * raw source participates in later requests again. Deleting an older entry
   * leaves a coverage tombstone: the summary stops being injected, while old
   * raw history stays compressed and all later summaries remain valid.
   */
  async deleteStageSummaryEntry(sourceStartMessageId: number): Promise<StoryEchoChatState> {
    const state = await this.getOrCreate();
    if (!state) {
      throw new Error('当前没有可用聊天。');
    }
    const index = state.stageSummary.entries.findIndex(
      (entry) => entry.sourceStartMessageId === sourceStartMessageId,
    );
    if (index < 0) {
      throw new Error('要删除的阶段总结不存在，可能已在其他页面删除或失效。');
    }
    const existing = state.stageSummary.entries[index]!;
    if (existing.deleted) {
      throw new Error('要删除的阶段总结不存在，可能已在其他页面删除或失效。');
    }
    const entries = [...state.stageSummary.entries];
    markSkeletonStaleForSummary(state, existing.sourceEndMessageId);
    if (index === entries.length - 1) {
      entries.pop();
    } else {
      entries[index] = {
        ...existing,
        text: '',
        deleted: true,
        updatedAt: new Date().toISOString(),
      };
    }
    const latest = entries.at(-1);
    state.stageSummary = {
      entries,
      coveredThroughMessageId: latest?.sourceEndMessageId ?? -1,
      coveredThroughHash: latest?.sourceHash ?? '',
      ...(latest ? { updatedAt: latest.updatedAt } : {}),
    };
    delete state.lastInspection;
    await this.save(state);
    return state;
  }

  async updateStorySkeleton(edit: StorySkeletonEdit): Promise<StoryEchoChatState> {
    const state = await this.getOrCreate();
    if (!state || !state.storySkeleton.text) {
      throw new Error('当前还没有可编辑的全局剧情骨架。');
    }
    const maxTokens = this.settingsRepository.get().summary.skeletonMaxTokens;
    const text = normalizeStorySkeletonText(edit.text, maxTokens);
    state.storySkeleton = {
      ...state.storySkeleton,
      text,
      updatedAt: new Date().toISOString(),
      manuallyEdited: true,
    };
    delete state.lastInspection;
    await this.save(state);
    return state;
  }

  async clear(): Promise<void> {
    const context = getContext();
    delete context.chatMetadata[MODULE_ID];
    await context.saveMetadata();
  }
}
