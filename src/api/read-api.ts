import { EXTENSION_VERSION, MODULE_ID } from '../core/constants';
import type {
  StageSummaryEntry,
  SummarySourceRange,
} from '../core/types';
import {
  getContext,
  getCurrentChatId,
  type SillyTavernContext,
} from '../platform/sillytavern';
import { StoryStateRepository } from '../state/repository';
import {
  stageSummaryOutputTruncated,
  stageSummarySourceTruncationRanges,
} from '../summary/truncation';
import {
  emitStoryEchoPublicApiChanged,
  subscribeStoryEchoPublicApiChanged,
  type StoryEchoPublicChangeReason,
} from './change-events';

export const STORY_ECHO_PUBLIC_API_NAME = 'story-echo';
export const STORY_ECHO_PUBLIC_API_VERSION = 1 as const;

export interface StoryEchoSummaryView {
  readonly text: string;
  readonly level: number;
  readonly sourceStartMessageId: number;
  readonly sourceEndMessageId: number;
  readonly sourceHash: string;
  readonly updatedAt: string;
  readonly characterCount: number;
  readonly manuallyEdited: boolean;
  readonly outputTruncated: boolean;
  readonly truncatedSourceRanges: readonly Readonly<SummarySourceRange>[];
}

export interface StoryEchoLevelCountView {
  readonly level: number;
  readonly count: number;
}

export interface StoryEchoCoverageView {
  readonly active: boolean;
  readonly enabled: boolean;
  readonly chatId: string;
  readonly chatUuid: string | null;
  readonly coveredThroughMessageId: number;
  readonly coveredThroughHash: string;
  readonly updatedAt: string | null;
  readonly frontierEntryCount: number;
  readonly storedEntryCount: number;
  readonly deletedEntryCount: number;
  readonly levelCounts: readonly StoryEchoLevelCountView[];
  readonly rebuildInProgress: boolean;
  readonly rebuildDraftEntryCount: number;
}

export interface StoryEchoLastInjectionView {
  readonly chatId: string;
  readonly chatUuid: string;
  readonly createdAt: string;
  readonly generationType: string;
  readonly retainedStartMessageId: number;
  readonly removedMessageCount: number;
  /** Exact StoryEcho history block inserted into the request. */
  readonly text: string;
  readonly summaries: readonly StoryEchoSummaryView[];
}

export interface StoryEchoPublicChangeView {
  readonly reason: StoryEchoPublicChangeReason;
  readonly createdAt: string;
  readonly active: boolean;
  readonly coverage: StoryEchoCoverageView | null;
  readonly frontier: readonly StoryEchoSummaryView[];
  readonly lastInjection: StoryEchoLastInjectionView | null;
}

export interface StoryEchoReadApi {
  readonly apiVersion: typeof STORY_ECHO_PUBLIC_API_VERSION;
  readonly extensionVersion: string;
  getFrontier(): readonly StoryEchoSummaryView[];
  getCoverage(): StoryEchoCoverageView | null;
  getLastInjection(): StoryEchoLastInjectionView | null;
  onStateChanged(listener: (change: StoryEchoPublicChangeView) => void): () => void;
}

export interface StoryEchoPublicGlobal {
  readonly version: string;
  readonly api: StoryEchoReadApi;
}

export interface StoryEchoInjectionRecord {
  generationToken: number;
  chatId: string;
  chatUuid: string;
  generationType: string;
  retainedStartMessageId: number;
  removedMessageCount: number;
  text: string;
  summaries: readonly StageSummaryEntry[];
}

declare global {
  var StoryEcho: StoryEchoPublicGlobal | undefined;
}

const EMPTY_FRONTIER = Object.freeze([]) as readonly StoryEchoSummaryView[];
const stateRepository = new StoryStateRepository();

let apiActive = false;
let lastInjection: StoryEchoLastInjectionView | null = null;
let latestExternalGenerationToken = 0;
let hostEventBinding: {
  eventSource: NonNullable<SillyTavernContext['eventSource']>;
  registrations: Array<{
    eventName: string;
    handler: (...args: unknown[]) => void;
  }>;
} | null = null;

const registeredHostApis = new WeakSet<NonNullable<SillyTavernContext['registerExtensionApi']>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function frozenRange(range: SummarySourceRange): Readonly<SummarySourceRange> {
  return Object.freeze({
    sourceStartMessageId: range.sourceStartMessageId,
    sourceEndMessageId: range.sourceEndMessageId,
  });
}

function summaryView(entry: StageSummaryEntry): StoryEchoSummaryView {
  const truncatedSourceRanges = stageSummarySourceTruncationRanges(entry).map(frozenRange);
  return Object.freeze({
    text: entry.text,
    level: entry.level,
    sourceStartMessageId: entry.sourceStartMessageId,
    sourceEndMessageId: entry.sourceEndMessageId,
    sourceHash: entry.sourceHash,
    updatedAt: entry.updatedAt,
    characterCount: entry.characterCount ?? Array.from(entry.text).length,
    manuallyEdited: Boolean(entry.manuallyEdited),
    outputTruncated: stageSummaryOutputTruncated(entry),
    truncatedSourceRanges: Object.freeze(truncatedSourceRanges),
  });
}

function currentContext(): SillyTavernContext | null {
  try {
    return getContext();
  } catch {
    return null;
  }
}

function contextManagementEnabled(context: SillyTavernContext): boolean {
  const settings = context.extensionSettings[MODULE_ID];
  return isRecord(settings) && settings['enabled'] === true;
}

function getFrontier(): readonly StoryEchoSummaryView[] {
  try {
    const state = stateRepository.getExisting();
    if (!state) {
      return EMPTY_FRONTIER;
    }
    return Object.freeze(
      state.stageSummary.entries
        .filter((entry) => !entry.deleted)
        .map(summaryView),
    );
  } catch {
    return EMPTY_FRONTIER;
  }
}

function getCoverage(): StoryEchoCoverageView | null {
  try {
    const context = currentContext();
    if (!context) {
      return null;
    }
    const chatId = getCurrentChatId(context);
    if (!chatId) {
      return null;
    }
    const state = stateRepository.getExisting();
    const entries = state?.stageSummary.entries ?? [];
    const activeEntries = entries.filter((entry) => !entry.deleted);
    const countByLevel = new Map<number, number>();
    for (const entry of activeEntries) {
      countByLevel.set(entry.level, (countByLevel.get(entry.level) ?? 0) + 1);
    }
    const levelCounts = [...countByLevel.entries()]
      .sort(([left], [right]) => left - right)
      .map(([level, count]) => Object.freeze({ level, count }));
    return Object.freeze({
      active: apiActive,
      enabled: contextManagementEnabled(context),
      chatId,
      chatUuid: state?.chatUuid ?? null,
      coveredThroughMessageId: state?.stageSummary.coveredThroughMessageId ?? -1,
      coveredThroughHash: state?.stageSummary.coveredThroughHash ?? '',
      updatedAt: state?.stageSummary.updatedAt ?? null,
      frontierEntryCount: activeEntries.length,
      storedEntryCount: entries.length,
      deletedEntryCount: entries.length - activeEntries.length,
      levelCounts: Object.freeze(levelCounts),
      rebuildInProgress: Boolean(state?.stageSummary.rebuildCheckpoint),
      rebuildDraftEntryCount: state?.stageSummary.rebuildCheckpoint?.entries.length ?? 0,
    });
  } catch {
    return null;
  }
}

function cloneLastInjection(value: StoryEchoLastInjectionView): StoryEchoLastInjectionView {
  return Object.freeze({
    chatId: value.chatId,
    chatUuid: value.chatUuid,
    createdAt: value.createdAt,
    generationType: value.generationType,
    retainedStartMessageId: value.retainedStartMessageId,
    removedMessageCount: value.removedMessageCount,
    text: value.text,
    summaries: Object.freeze(value.summaries.map((entry) => Object.freeze({
      ...entry,
      truncatedSourceRanges: Object.freeze(entry.truncatedSourceRanges.map(frozenRange)),
    }))),
  });
}

function getLastInjection(): StoryEchoLastInjectionView | null {
  if (!lastInjection) {
    return null;
  }
  const context = currentContext();
  if (!context || getCurrentChatId(context) !== lastInjection.chatId) {
    return null;
  }
  return cloneLastInjection(lastInjection);
}

function publicChangeView(reason: StoryEchoPublicChangeReason): StoryEchoPublicChangeView {
  return Object.freeze({
    reason,
    createdAt: new Date().toISOString(),
    active: apiActive,
    coverage: getCoverage(),
    frontier: getFrontier(),
    lastInjection: getLastInjection(),
  });
}

function publicSnapshotSignature(change: StoryEchoPublicChangeView): string {
  return JSON.stringify({
    active: change.active,
    coverage: change.coverage,
    frontier: change.frontier,
    lastInjection: change.lastInjection,
  });
}

function onStateChanged(
  listener: (change: StoryEchoPublicChangeView) => void,
): () => void {
  if (typeof listener !== 'function') {
    return () => undefined;
  }
  let signature = publicSnapshotSignature(publicChangeView('state'));
  return subscribeStoryEchoPublicApiChanged((reason) => {
    const change = publicChangeView(reason);
    const nextSignature = publicSnapshotSignature(change);
    if (nextSignature === signature) {
      return;
    }
    signature = nextSignature;
    listener(change);
  });
}

export const storyEchoReadApi: StoryEchoReadApi = Object.freeze({
  apiVersion: STORY_ECHO_PUBLIC_API_VERSION,
  extensionVersion: EXTENSION_VERSION,
  getFrontier,
  getCoverage,
  getLastInjection,
  onStateChanged,
});

const publicGlobal: StoryEchoPublicGlobal = Object.freeze({
  version: EXTENSION_VERSION,
  api: storyEchoReadApi,
});

function exposeGlobalApi(): boolean {
  try {
    if (globalThis.StoryEcho !== publicGlobal) {
      globalThis.StoryEcho = publicGlobal;
    }
    return true;
  } catch {
    console.warn('[StoryEcho] Could not expose the global read-only API.');
    return false;
  }
}

function unbindHostEvents(): void {
  if (!hostEventBinding) {
    return;
  }
  const remove = hostEventBinding.eventSource.off ?? hostEventBinding.eventSource.removeListener;
  for (const registration of hostEventBinding.registrations) {
    try {
      remove?.call(hostEventBinding.eventSource, registration.eventName, registration.handler);
    } catch {
      console.warn('[StoryEcho] Could not remove a public API host listener.');
    }
  }
  hostEventBinding = null;
}

function bindHostEvents(context: SillyTavernContext): boolean {
  const eventSource = context.eventSource;
  if (!eventSource || hostEventBinding?.eventSource === eventSource) {
    return Boolean(eventSource);
  }
  unbindHostEvents();
  const eventNames = new Set([
    context.event_types?.['CHAT_CHANGED'] ?? context.eventTypes?.['CHAT_CHANGED'],
    context.event_types?.['CHAT_LOADED'] ?? context.eventTypes?.['CHAT_LOADED'],
  ].filter((eventName): eventName is string => Boolean(eventName)));
  const registrations: Array<{
    eventName: string;
    handler: (...args: unknown[]) => void;
  }> = [];
  try {
    for (const eventName of eventNames) {
      const handler = (): void => {
        latestExternalGenerationToken += 1;
        lastInjection = null;
        queueMicrotask(() => emitStoryEchoPublicApiChanged('chat'));
      };
      eventSource.on(eventName, handler);
      registrations.push({ eventName, handler });
    }
  } catch {
    const remove = eventSource.off ?? eventSource.removeListener;
    for (const registration of registrations) {
      try {
        remove?.call(eventSource, registration.eventName, registration.handler);
      } catch {
        // Best-effort cleanup after an optional host integration failed.
      }
    }
    console.warn('[StoryEcho] Could not register public API host listeners.');
    return false;
  }
  hostEventBinding = { eventSource, registrations };
  return true;
}

/** Expose the API globally and, when available, through Luker's registry. */
export function registerStoryEchoPublicApi(): boolean {
  exposeGlobalApi();
  const context = currentContext();
  if (!context) {
    return false;
  }
  bindHostEvents(context);
  const register = context.registerExtensionApi;
  if (!register) {
    return false;
  }
  try {
    if (context.getExtensionApi?.call(context, STORY_ECHO_PUBLIC_API_NAME) === storyEchoReadApi) {
      registeredHostApis.add(register);
      return true;
    }
    if (!context.getExtensionApi && registeredHostApis.has(register)) {
      return true;
    }
    register.call(context, STORY_ECHO_PUBLIC_API_NAME, storyEchoReadApi);
    registeredHostApis.add(register);
    return true;
  } catch {
    console.warn('[StoryEcho] Could not register the read-only API with this host.');
    return false;
  }
}

export function activateStoryEchoPublicApi(): void {
  exposeGlobalApi();
  const changed = !apiActive;
  apiActive = true;
  registerStoryEchoPublicApi();
  if (changed) {
    emitStoryEchoPublicApiChanged('lifecycle');
  }
}

export function deactivateStoryEchoPublicApi(): void {
  const changed = apiActive || lastInjection !== null;
  apiActive = false;
  latestExternalGenerationToken += 1;
  lastInjection = null;
  unbindHostEvents();
  if (changed) {
    emitStoryEchoPublicApiChanged('lifecycle');
  }
}

export function clearStoryEchoLastInjection(): void {
  latestExternalGenerationToken += 1;
  if (!lastInjection) {
    return;
  }
  lastInjection = null;
  emitStoryEchoPublicApiChanged('injection');
}

/** Start a user-facing generation and invalidate any older injection snapshot. */
export function beginStoryEchoExternalGeneration(): number {
  clearStoryEchoLastInjection();
  return latestExternalGenerationToken;
}

export function recordStoryEchoLastInjection(record: StoryEchoInjectionRecord): boolean {
  if (record.generationToken !== latestExternalGenerationToken) {
    return false;
  }
  lastInjection = Object.freeze({
    chatId: record.chatId,
    chatUuid: record.chatUuid,
    createdAt: new Date().toISOString(),
    generationType: record.generationType,
    retainedStartMessageId: record.retainedStartMessageId,
    removedMessageCount: record.removedMessageCount,
    text: record.text,
    summaries: Object.freeze(record.summaries.map(summaryView)),
  });
  emitStoryEchoPublicApiChanged('injection');
  return true;
}
