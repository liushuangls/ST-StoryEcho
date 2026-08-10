import { CHAT_STATE_VERSION, MODULE_ID } from '../core/constants';
import { createUuid } from '../core/uuid';
import type {
  InspectionRecord,
  StageSummaryEntry,
  StageSummaryRebuildCheckpoint,
  StoryEchoChatState,
  StoryEchoDebugTrace,
} from '../core/types';
import { normalizeInternalLlmAttempts } from '../debug/internal-llm-attempts';
import { createMetrics, normalizeMetrics } from '../debug/metrics';
import { normalizeLlmCompletionMetadata } from '../llm/completion-metadata';
import { getContext, getCurrentChatId } from '../platform/sillytavern';
import { SettingsRepository } from '../settings/repository';
import { normalizeStorySkeletonText } from '../summary/skeleton-state';

export interface StageSummaryEdit {
  text: string;
}

export interface StorySkeletonEdit {
  text: string;
}

const MAX_EDITED_SUMMARY_CHARACTERS = 64_000;
const LEGACY_SUMMARY_UPDATED_AT = '1970-01-01T00:00:00.000Z';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : fallback;
}

function createState(ownerChatId: string): StoryEchoChatState {
  return {
    schemaVersion: CHAT_STATE_VERSION,
    chatUuid: createUuid(),
    ownerChatId,
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
    metrics: createMetrics(),
    debugTraces: [],
    recentInternalLlmAttempts: [],
  };
}

function normalizeStageSummaryEntry(value: unknown): StageSummaryEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const text = typeof value['text'] === 'string' ? value['text'].trim() : '';
  const deleted = value['deleted'] === true;
  const generation = normalizeLlmCompletionMetadata(value['generation']);
  const sourceStartMessageId = Number(value['sourceStartMessageId']);
  const sourceEndMessageId = Number(value['sourceEndMessageId']);
  if (
    (!text && !deleted) ||
    !Number.isInteger(sourceStartMessageId) ||
    !Number.isInteger(sourceEndMessageId) ||
    sourceStartMessageId < 0 ||
    sourceEndMessageId < sourceStartMessageId
  ) {
    return null;
  }
  return {
    text: deleted ? '' : text,
    characterCount: deleted ? 0 : Array.from(text).length,
    ...(generation ? { generation } : {}),
    sourceStartMessageId,
    sourceEndMessageId,
    sourceHash: typeof value['sourceHash'] === 'string' ? value['sourceHash'] : '',
    updatedAt: typeof value['updatedAt'] === 'string'
      ? value['updatedAt']
      : LEGACY_SUMMARY_UPDATED_AT,
    ...(value['manuallyEdited'] === true ? { manuallyEdited: true } : {}),
    ...(deleted ? { deleted: true } : {}),
  };
}

function normalizeStageSummaryRebuildCheckpoint(
  value: unknown,
): StageSummaryRebuildCheckpoint | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const targetEndMessageId = finiteInteger(value['targetEndMessageId'], -1);
  const targetSourceHash = typeof value['targetSourceHash'] === 'string'
    ? value['targetSourceHash']
    : '';
  const generationSignature = typeof value['generationSignature'] === 'string'
    ? value['generationSignature']
    : '';
  const updatedAt = typeof value['updatedAt'] === 'string' ? value['updatedAt'] : '';
  if (
    targetEndMessageId < 0 ||
    !targetSourceHash ||
    !generationSignature ||
    !updatedAt ||
    !Array.isArray(value['entries'])
  ) {
    return undefined;
  }
  const entries: StageSummaryEntry[] = [];
  let expectedStartMessageId = 0;
  for (const candidate of value['entries']) {
    const entry = normalizeStageSummaryEntry(candidate);
    if (
      !entry ||
      entry.deleted ||
      entry.sourceStartMessageId !== expectedStartMessageId ||
      entry.sourceEndMessageId > targetEndMessageId
    ) {
      return undefined;
    }
    entries.push(entry);
    expectedStartMessageId = entry.sourceEndMessageId + 1;
  }
  if (entries.length === 0) {
    return undefined;
  }
  return {
    targetEndMessageId,
    targetSourceHash,
    generationSignature,
    entries,
    totalDurationMs: Math.max(0, finiteInteger(value['totalDurationMs'], 0)),
    totalMessagesCovered: Math.max(0, finiteInteger(value['totalMessagesCovered'], 0)),
    updatedAt,
  };
}

function normalizeStageSummary(value: unknown): StoryEchoChatState['stageSummary'] {
  const stored = isRecord(value) ? value : {};
  const entries: StageSummaryEntry[] = [];
  const candidates = Array.isArray(stored['entries']) ? stored['entries'] : [];
  let expectedStartMessageId = 0;
  for (const candidate of candidates) {
    const entry = normalizeStageSummaryEntry(candidate);
    if (!entry || entry.sourceStartMessageId !== expectedStartMessageId) {
      break;
    }
    entries.push(entry);
    expectedStartMessageId = entry.sourceEndMessageId + 1;
  }

  // Preserve the pre-entry rolling-summary format when upgrading very old chats.
  if (entries.length === 0) {
    const legacyText = typeof stored['text'] === 'string' ? stored['text'].trim() : '';
    const legacyEnd = finiteInteger(stored['coveredThroughMessageId'], -1);
    if (legacyText && legacyEnd >= 0) {
      entries.push({
        text: legacyText,
        characterCount: Array.from(legacyText).length,
        sourceStartMessageId: 0,
        sourceEndMessageId: legacyEnd,
        sourceHash: typeof stored['coveredThroughHash'] === 'string'
          ? stored['coveredThroughHash']
          : '',
        updatedAt: typeof stored['updatedAt'] === 'string'
          ? stored['updatedAt']
          : LEGACY_SUMMARY_UPDATED_AT,
      });
    }
  }

  const latest = entries.at(-1);
  const rebuildCheckpoint = normalizeStageSummaryRebuildCheckpoint(
    stored['rebuildCheckpoint'],
  );
  return {
    entries,
    coveredThroughMessageId: latest?.sourceEndMessageId ?? -1,
    coveredThroughHash: latest?.sourceHash ?? '',
    ...(latest ? { updatedAt: latest.updatedAt } : {}),
    ...(rebuildCheckpoint ? { rebuildCheckpoint } : {}),
  };
}

function normalizeStorySkeleton(value: unknown): StoryEchoChatState['storySkeleton'] {
  const stored = isRecord(value) ? value : {};
  const text = typeof stored['text'] === 'string' ? stored['text'].trim() : '';
  const coveredThroughMessageId = finiteInteger(stored['coveredThroughMessageId'], -1);
  if (!text || coveredThroughMessageId < 0) {
    return {
      text: '',
      coveredThroughMessageId: -1,
      sourceHash: '',
    };
  }
  const sourceHash = typeof stored['sourceHash'] === 'string' ? stored['sourceHash'] : '';
  return {
    text,
    coveredThroughMessageId,
    sourceHash,
    ...(typeof stored['updatedAt'] === 'string' ? { updatedAt: stored['updatedAt'] } : {}),
    ...(stored['manuallyEdited'] === true ? { manuallyEdited: true } : {}),
    ...(stored['stale'] === true || !sourceHash ? { stale: true } : {}),
  };
}

function normalizeInspection(value: unknown): InspectionRecord | undefined {
  if (!isRecord(value) || typeof value['createdAt'] !== 'string') {
    return undefined;
  }
  return {
    createdAt: value['createdAt'],
    generationType: typeof value['generationType'] === 'string' ? value['generationType'] : 'normal',
    retainedStartIndex: finiteInteger(value['retainedStartIndex'], 0),
    retainedEndIndex: finiteInteger(value['retainedEndIndex'], -1),
    removedMessageCount: Math.max(0, finiteInteger(value['removedMessageCount'], 0)),
    estimatedRemovedTokens: Math.max(0, finiteInteger(value['estimatedRemovedTokens'], 0)),
    estimatedInjectedTokens: Math.max(0, finiteInteger(value['estimatedInjectedTokens'], 0)),
    estimatedNetSavedTokens: Math.max(0, finiteInteger(value['estimatedNetSavedTokens'], 0)),
    estimatedSummaryTokens: Math.max(0, finiteInteger(value['estimatedSummaryTokens'], 0)),
    summaryCoveredThroughMessageId: finiteInteger(value['summaryCoveredThroughMessageId'], -1),
    durationMs: Math.max(0, finiteInteger(value['durationMs'], 0)),
    warnings: Array.isArray(value['warnings'])
      ? value['warnings'].filter((item): item is string => typeof item === 'string').slice(0, 100)
      : [],
  };
}

function normalizeDebugTraces(value: unknown): StoryEchoDebugTrace[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((candidate): StoryEchoDebugTrace[] => {
    if (
      !isRecord(candidate) ||
      typeof candidate['id'] !== 'string' ||
      typeof candidate['createdAt'] !== 'string' ||
      typeof candidate['message'] !== 'string' ||
      !['summary', 'interceptor', 'error'].includes(String(candidate['stage']))
    ) {
      return [];
    }
    const details = isRecord(candidate['details'])
      ? Object.fromEntries(Object.entries(candidate['details']).flatMap(([key, detail]) => (
          typeof detail === 'string' ||
          typeof detail === 'number' ||
          typeof detail === 'boolean' ||
          detail === null
            ? [[key, detail]]
            : []
        )))
      : undefined;
    return [{
      id: candidate['id'],
      createdAt: candidate['createdAt'],
      stage: candidate['stage'] as StoryEchoDebugTrace['stage'],
      message: candidate['message'],
      ...(details ? { details } : {}),
    }];
  }).slice(-50);
}

function isStoredState(value: unknown): value is Record<string, unknown> {
  return isRecord(value) &&
    (value['schemaVersion'] === 1 || value['schemaVersion'] === CHAT_STATE_VERSION) &&
    typeof value['chatUuid'] === 'string' &&
    typeof value['ownerChatId'] === 'string';
}

function normalizeState(stored: Record<string, unknown>): StoryEchoChatState {
  const inspection = normalizeInspection(stored['lastInspection']);
  return {
    schemaVersion: CHAT_STATE_VERSION,
    chatUuid: stored['chatUuid'] as string,
    ownerChatId: stored['ownerChatId'] as string,
    stageSummary: normalizeStageSummary(stored['stageSummary']),
    storySkeleton: normalizeStorySkeleton(stored['storySkeleton']),
    metrics: normalizeMetrics(stored['metrics']),
    debugTraces: normalizeDebugTraces(stored['debugTraces']),
    recentInternalLlmAttempts: normalizeInternalLlmAttempts(
      stored['recentInternalLlmAttempts'],
    ),
    ...(inspection ? { lastInspection: inspection } : {}),
  };
}

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

export class StoryStateRepository {
  private readonly settingsRepository = new SettingsRepository();

  getExisting(): StoryEchoChatState | null {
    const context = getContext();
    const stored = context.chatMetadata[MODULE_ID];
    if (!isStoredState(stored) || stored['ownerChatId'] !== getCurrentChatId(context)) {
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
    if (!isStoredState(stored)) {
      const state = createState(currentChatId);
      context.chatMetadata[MODULE_ID] = state;
      await context.saveMetadata();
      return state;
    }

    let state = normalizeState(stored);
    if (state.ownerChatId !== currentChatId) {
      state = {
        ...structuredClone(state),
        chatUuid: createUuid(),
        ownerChatId: currentChatId,
        metrics: createMetrics(),
        debugTraces: [],
        recentInternalLlmAttempts: [],
      };
      if (state.storySkeleton.text) {
        state.storySkeleton.stale = true;
      }
      delete state.stageSummary.rebuildCheckpoint;
      delete state.lastInspection;
      context.chatMetadata[MODULE_ID] = state;
      await context.saveMetadata();
      return state;
    }

    // Version 2 intentionally drops all obsolete memory/vector fields.
    if (stored['schemaVersion'] !== CHAT_STATE_VERSION) {
      context.chatMetadata[MODULE_ID] = state;
      await context.saveMetadata();
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

  async adoptRenamedChat(oldOwnerChatId: string, newOwnerChatId: string): Promise<boolean> {
    const context = getContext();
    const stored = context.chatMetadata[MODULE_ID];
    if (
      !isStoredState(stored) ||
      stored['ownerChatId'] !== oldOwnerChatId ||
      getCurrentChatId(context) !== newOwnerChatId
    ) {
      return false;
    }
    const state = normalizeState(stored);
    state.ownerChatId = newOwnerChatId;
    context.chatMetadata[MODULE_ID] = state;
    await context.saveMetadata();
    return true;
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
      characterCount: Array.from(normalized.text).length,
      updatedAt: new Date().toISOString(),
      manuallyEdited: true,
    };
    delete state.stageSummary.rebuildCheckpoint;
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

  async deleteStageSummaryEntry(sourceStartMessageId: number): Promise<StoryEchoChatState> {
    const state = await this.getOrCreate();
    if (!state) {
      throw new Error('当前没有可用聊天。');
    }
    const index = state.stageSummary.entries.findIndex(
      (entry) => entry.sourceStartMessageId === sourceStartMessageId,
    );
    const existing = index >= 0 ? state.stageSummary.entries[index] : undefined;
    if (!existing || existing.deleted) {
      throw new Error('要删除的阶段总结不存在，可能已在其他页面删除或失效。');
    }
    const entries = [...state.stageSummary.entries];
    delete state.stageSummary.rebuildCheckpoint;
    markSkeletonStaleForSummary(state, existing.sourceEndMessageId);
    if (index === entries.length - 1) {
      entries.pop();
    } else {
      entries[index] = {
        ...existing,
        text: '',
        characterCount: 0,
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
    state.storySkeleton = {
      ...state.storySkeleton,
      text: normalizeStorySkeletonText(edit.text, maxTokens),
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
