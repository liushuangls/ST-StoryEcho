import { CHAT_STATE_VERSION, MODULE_ID } from '../core/constants';
import { createUuid } from '../core/uuid';
import type {
  InspectionRecord,
  StageSummaryEntry,
  StageSummaryRebuildCheckpoint,
  StoryEchoChatState,
  StoryEchoDebugTrace,
  SummaryCompactionProvenance,
  SummaryCompactionSource,
} from '../core/types';
import { normalizeInternalLlmAttempts } from '../debug/internal-llm-attempts';
import { createMetrics, normalizeMetrics } from '../debug/metrics';
import { normalizeLlmCompletionMetadata } from '../llm/completion-metadata';
import { getContext, getCurrentChatId } from '../platform/sillytavern';

export interface StageSummaryEdit {
  text: string;
}

export type StageSummaryTarget = Pick<
  StageSummaryEntry,
  'level' | 'sourceStartMessageId' | 'sourceEndMessageId' | 'updatedAt'
>;

const MAX_EDITED_SUMMARY_CHARACTERS = 64_000;
const LEGACY_SUMMARY_UPDATED_AT = '1970-01-01T00:00:00.000Z';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : fallback;
}

function positiveLevel(value: unknown, fallback = 1): number {
  const level = finiteInteger(value, fallback);
  return Math.min(32, Math.max(1, level));
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
    metrics: createMetrics(),
    debugTraces: [],
    recentInternalLlmAttempts: [],
  };
}

function normalizeCompactionSource(value: unknown): SummaryCompactionSource | null {
  if (!isRecord(value)) {
    return null;
  }
  const deleted = value['deleted'] === true;
  const text = typeof value['text'] === 'string' ? value['text'].trim() : '';
  const sourceStartMessageId = finiteInteger(value['sourceStartMessageId'], -1);
  const sourceEndMessageId = finiteInteger(value['sourceEndMessageId'], -1);
  if (
    (!text && !deleted) ||
    sourceStartMessageId < 0 ||
    sourceEndMessageId < sourceStartMessageId
  ) {
    return null;
  }
  return {
    text: deleted ? '' : text,
    level: positiveLevel(value['level']),
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

function normalizeCompaction(
  value: unknown,
  parentLevel: number,
  parentStart: number,
  parentEnd: number,
): SummaryCompactionProvenance | undefined {
  if (!isRecord(value) || parentLevel < 2 || !Array.isArray(value['sources'])) {
    return undefined;
  }
  const sourceLevel = positiveLevel(value['sourceLevel']);
  const inputHash = typeof value['inputHash'] === 'string' ? value['inputHash'] : '';
  const sources = value['sources'].map(normalizeCompactionSource);
  if (
    sourceLevel !== parentLevel - 1 ||
    !inputHash ||
    sources.length < 2 ||
    sources.some((source) => !source)
  ) {
    return undefined;
  }
  const normalized = sources as SummaryCompactionSource[];
  if (
    normalized.some((source) => source.level !== sourceLevel) ||
    normalized[0]!.sourceStartMessageId !== parentStart ||
    normalized.at(-1)!.sourceEndMessageId !== parentEnd
  ) {
    return undefined;
  }
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1]!.sourceEndMessageId + 1 !== normalized[index]!.sourceStartMessageId) {
      return undefined;
    }
  }
  return {
    sourceLevel,
    sourceEntryCount: normalized.length,
    inputHash,
    sources: normalized,
  };
}

function normalizeStageSummaryEntry(value: unknown): StageSummaryEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const text = typeof value['text'] === 'string' ? value['text'].trim() : '';
  const deleted = value['deleted'] === true;
  const generation = normalizeLlmCompletionMetadata(value['generation']);
  const sourceStartMessageId = finiteInteger(value['sourceStartMessageId'], -1);
  const sourceEndMessageId = finiteInteger(value['sourceEndMessageId'], -1);
  if (
    (!text && !deleted) ||
    sourceStartMessageId < 0 ||
    sourceEndMessageId < sourceStartMessageId
  ) {
    return null;
  }
  const level = positiveLevel(value['level']);
  const compaction = normalizeCompaction(
    value['compaction'],
    level,
    sourceStartMessageId,
    sourceEndMessageId,
  );
  return {
    text: deleted ? '' : text,
    level,
    characterCount: deleted ? 0 : Array.from(text).length,
    ...(generation ? { generation } : {}),
    sourceStartMessageId,
    sourceEndMessageId,
    sourceHash: typeof value['sourceHash'] === 'string' ? value['sourceHash'] : '',
    updatedAt: typeof value['updatedAt'] === 'string'
      ? value['updatedAt']
      : LEGACY_SUMMARY_UPDATED_AT,
    ...(value['manuallyEdited'] === true ? { manuallyEdited: true } : {}),
    ...(compaction ? { compaction } : {}),
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
      entry.level !== 1 ||
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
        level: 1,
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
  const rebuildCheckpoint = normalizeStageSummaryRebuildCheckpoint(stored['rebuildCheckpoint']);
  return {
    entries,
    coveredThroughMessageId: latest?.sourceEndMessageId ?? -1,
    coveredThroughHash: latest?.sourceHash ?? '',
    ...(latest ? { updatedAt: latest.updatedAt } : {}),
    ...(rebuildCheckpoint ? { rebuildCheckpoint } : {}),
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
    [1, 2, CHAT_STATE_VERSION].includes(Number(value['schemaVersion'])) &&
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
    metrics: normalizeMetrics(stored['metrics']),
    debugTraces: normalizeDebugTraces(stored['debugTraces']),
    recentInternalLlmAttempts: normalizeInternalLlmAttempts(stored['recentInternalLlmAttempts']),
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

function updateCoverage(state: StoryEchoChatState): void {
  const latest = state.stageSummary.entries.at(-1);
  state.stageSummary = {
    entries: state.stageSummary.entries,
    coveredThroughMessageId: latest?.sourceEndMessageId ?? -1,
    coveredThroughHash: latest?.sourceHash ?? '',
    ...(latest ? { updatedAt: latest.updatedAt } : {}),
  };
}

export class StoryStateRepository {
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
      delete state.stageSummary.rebuildCheckpoint;
      delete state.lastInspection;
      context.chatMetadata[MODULE_ID] = state;
      await context.saveMetadata();
      return state;
    }

    // Version 3 drops the global skeleton and upgrades legacy entries to Level 1.
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
    target: StageSummaryTarget,
    edit: StageSummaryEdit,
  ): Promise<StoryEchoChatState> {
    const state = await this.getOrCreate();
    if (!state) {
      throw new Error('当前没有可用聊天。');
    }
    const index = state.stageSummary.entries.findIndex(
      (entry) =>
        entry.level === target.level &&
        entry.sourceStartMessageId === target.sourceStartMessageId &&
        entry.sourceEndMessageId === target.sourceEndMessageId,
    );
    const existing = index >= 0 ? state.stageSummary.entries[index] : undefined;
    if (!existing || existing.deleted || existing.updatedAt !== target.updatedAt) {
      throw new Error('要修改的阶段总结不存在或已发生变化，请刷新后重试。');
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
    updateCoverage(state);
    delete state.lastInspection;
    await this.save(state);
    return state;
  }

  async deleteStageSummaryEntry(target: StageSummaryTarget): Promise<StoryEchoChatState> {
    const state = await this.getOrCreate();
    if (!state) {
      throw new Error('当前没有可用聊天。');
    }
    const index = state.stageSummary.entries.findIndex(
      (entry) =>
        entry.level === target.level &&
        entry.sourceStartMessageId === target.sourceStartMessageId &&
        entry.sourceEndMessageId === target.sourceEndMessageId,
    );
    const existing = index >= 0 ? state.stageSummary.entries[index] : undefined;
    if (!existing || existing.deleted || existing.updatedAt !== target.updatedAt) {
      throw new Error('要删除的阶段总结不存在或已发生变化，请刷新后重试。');
    }
    const entries = [...state.stageSummary.entries];
    delete state.stageSummary.rebuildCheckpoint;
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
    state.stageSummary.entries = entries;
    updateCoverage(state);
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
