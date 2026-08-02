import { logger } from '../core/logger';
import type { TavernChatMessage } from '../core/types';
import { emitDiagnosticsUpdated } from '../debug/events';
import type { SillyTavernContext } from './sillytavern';
import { getCurrentChatId } from './sillytavern';

const AGENT_RUN_STATE_CHANGED_EVENT = 'tauritavern-agent-run-state-changed';
const AGENT_RUN_EVENT = 'tauritavern-agent-run-event';
const PROMPT_CAPTURE_MAX_AGE_MS = 2 * 60 * 1_000;
const MAX_CAPTURED_RUNS = 4;

interface TauriTavernAgentApi {
  readModelTurn?(input: {
    runId: string;
    round: number;
    invocationId?: string;
    maxChars?: number;
  }): Promise<unknown>;
}

interface TauriTavernGlobal {
  api?: {
    agent?: TauriTavernAgentApi;
  };
}

declare global {
  var __TAURITAVERN__: TauriTavernGlobal | undefined;
}

interface PendingAgentPrompt {
  chatId: string;
  prompt: AgentPromptSurface;
  capturedAt: number;
  sequence: number;
}

type AgentPromptSurface = Pick<
  TauriAgentPromptSnapshot,
  'messages' | 'toolDefinitions' | 'api' | 'model' | 'profile'
>;

interface StoryEchoPreparation {
  chatId: string;
  preparedAt: number;
  injectedBlockCount: number;
}

export interface TauriAgentPromptSnapshot {
  runId: string;
  chatId: string;
  generationType: string;
  expectedMessageId: number;
  messages: unknown[];
  toolDefinitions: unknown[];
  api: string;
  model: string;
  profile: string;
  capturedAt: number;
  actualInputTokens: number | null;
  storyEchoTrimmedByAgentAssembly: boolean;
}

export interface TauriAgentRunStateChange {
  activeRunId: string | null;
  previousRunId: string | null;
  terminalEventType: string;
}

type AgentRunStateListener = (change: TauriAgentRunStateChange) => void;

interface EventSourceLike {
  on(event: string, handler: (...args: unknown[]) => void | Promise<void>): void;
  off?(event: string, handler: (...args: unknown[]) => void | Promise<void>): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void | Promise<void>): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function finiteTokenCount(value: unknown): number | null {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'boolean' ||
    (typeof value === 'string' && !value.trim())
  ) {
    return null;
  }
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> | null {
  return isRecord(value) && isRecord(value[key]) ? value[key] : null;
}

/**
 * Provider usage shapes are not uniform. Prefer an explicit total-input field,
 * then the common OpenAI/Anthropic/Gemini prompt-input fields.
 */
export function agentUsageInputTokens(value: unknown): number | null {
  if (!isRecord(value)) {
    return null;
  }
  const usage = nestedRecord(value, 'usage') ?? value;
  const nestedUsage = nestedRecord(usage, 'usageMetadata') ?? usage;
  for (const key of ['total_input_tokens', 'totalInputTokens']) {
    const tokens = finiteTokenCount(nestedUsage[key]);
    if (tokens !== null) {
      return tokens;
    }
  }
  for (const key of ['prompt_tokens', 'promptTokens', 'prompt_token_count', 'promptTokenCount']) {
    const tokens = finiteTokenCount(nestedUsage[key]);
    if (tokens !== null) {
      return tokens;
    }
  }
  for (const key of ['input_tokens', 'inputTokens']) {
    const inputTokens = finiteTokenCount(nestedUsage[key]);
    if (inputTokens === null) {
      continue;
    }
    const cacheCreation = finiteTokenCount(
      nestedUsage['cache_creation_input_tokens'] ?? nestedUsage['cacheCreationInputTokens'],
    ) ?? 0;
    const cacheRead = finiteTokenCount(
      nestedUsage['cache_read_input_tokens'] ?? nestedUsage['cacheReadInputTokens'],
    ) ?? 0;
    return inputTokens + cacheCreation + cacheRead;
  }
  return null;
}

function agentRunId(value: unknown): string {
  if (!isRecord(value)) {
    return '';
  }
  return stringValue(value['runId'] ?? value['run_id']);
}

function agentGenerationType(value: unknown): string {
  if (!isRecord(value)) {
    return 'normal';
  }
  return stringValue(value['generationType'] ?? value['generation_type']) || 'normal';
}

function eventDetail(event: Event): Record<string, unknown> {
  const detail = (event as CustomEvent<unknown>).detail;
  return isRecord(detail) ? detail : {};
}

function messageAgentRunId(message: TavernChatMessage | undefined): string {
  const tauri = nestedRecord(message?.extra, 'tauritavern');
  const agent = nestedRecord(tauri, 'agent');
  return stringValue(agent?.['runId'] ?? agent?.['run_id']);
}

function messageAgentProfileId(message: TavernChatMessage | undefined): string {
  const tauri = nestedRecord(message?.extra, 'tauritavern');
  const agent = nestedRecord(tauri, 'agent');
  return stringValue(agent?.['profileId'] ?? agent?.['profile_id']);
}

function promptSurface(
  payload: unknown,
): AgentPromptSurface | null {
  if (!isRecord(payload) || !Array.isArray(payload['messages'])) {
    return null;
  }
  return {
    messages: payload['messages'],
    toolDefinitions: Array.isArray(payload['tools']) ? payload['tools'] : [],
    api: stringValue(payload['chat_completion_source'] ?? payload['chatCompletionSource']),
    model: stringValue(payload['model']),
    profile: stringValue(payload['agent_profile_id'] ?? payload['agentProfileId']),
  };
}

function clonePromptSurface(surface: AgentPromptSurface): AgentPromptSurface | null {
  let messages: unknown[];
  try {
    messages = structuredClone(surface.messages);
  } catch {
    return null;
  }
  let toolDefinitions: unknown[] = [];
  if (surface.toolDefinitions.length > 0) {
    try {
      toolDefinitions = structuredClone(surface.toolDefinitions);
    } catch {
      toolDefinitions = [];
    }
  }
  return {
    messages,
    toolDefinitions,
    api: surface.api,
    model: surface.model,
    profile: surface.profile,
  };
}

function storyEchoSummaryCount(messages: readonly unknown[]): number {
  return messages.reduce<number>((total, message) => {
    if (!isRecord(message)) {
      return total;
    }
    let serialized = '';
    try {
      serialized = typeof message['content'] === 'string'
        ? message['content']
        : JSON.stringify(message['content'] ?? '');
    } catch {
      return total;
    }
    const matches = serialized.match(/<story_echo_(?:skeleton|summary)>/giu);
    return total + (matches?.length ?? 0);
  }, 0);
}

function expectedMessageId(context: SillyTavernContext, generationType: string): number {
  return generationType === 'swipe'
    ? Math.max(0, context.chat.length - 1)
    : context.chat.length;
}

function currentAgentApi(): TauriTavernAgentApi | null {
  return globalThis.__TAURITAVERN__?.api?.agent ?? null;
}

export class TauriTavernAgentBridge {
  private registeredEventSource: EventSourceLike | null = null;
  private settingsEventName = '';
  private pendingPrompt: PendingAgentPrompt | null = null;
  private pendingPromptExpiry: ReturnType<typeof setTimeout> | undefined;
  private storyEchoPreparation: StoryEchoPreparation | null = null;
  private activeRunId: string | null = null;
  private readonly snapshots = new Map<string, TauriAgentPromptSnapshot>();
  private readonly snapshotPromptSequences = new Map<string, number>();
  private readonly usageReads = new Set<string>();
  private readonly stateListeners = new Set<AgentRunStateListener>();
  private promptSequence = 0;
  private registered = false;

  constructor(
    private readonly eventTarget: EventTarget = globalThis as unknown as EventTarget,
  ) {}

  register(context: SillyTavernContext): boolean {
    if (this.registered) {
      return true;
    }
    if (!currentAgentApi()) {
      return false;
    }
    const eventSource = context.eventSource;
    const eventTypes = {
      ...(context.event_types ?? {}),
      ...(context.eventTypes ?? {}),
    };
    const settingsEventName = eventTypes['CHAT_COMPLETION_SETTINGS_READY'];
    if (!eventSource || !settingsEventName) {
      return false;
    }

    eventSource.on(settingsEventName, this.onCompletionSettingsReady);
    this.eventTarget.addEventListener(AGENT_RUN_STATE_CHANGED_EVENT, this.onRunStateChanged);
    this.eventTarget.addEventListener(AGENT_RUN_EVENT, this.onRunEvent);
    this.registeredEventSource = eventSource;
    this.settingsEventName = settingsEventName;
    this.registered = true;
    return true;
  }

  unregister(): void {
    if (this.registeredEventSource && this.settingsEventName) {
      const remove = this.registeredEventSource.off
        ?? this.registeredEventSource.removeListener;
      remove?.call(
        this.registeredEventSource,
        this.settingsEventName,
        this.onCompletionSettingsReady,
      );
    }
    if (this.registered) {
      this.eventTarget.removeEventListener(
        AGENT_RUN_STATE_CHANGED_EVENT,
        this.onRunStateChanged,
      );
      this.eventTarget.removeEventListener(AGENT_RUN_EVENT, this.onRunEvent);
    }
    this.registeredEventSource = null;
    this.settingsEventName = '';
    if (this.pendingPromptExpiry !== undefined) {
      clearTimeout(this.pendingPromptExpiry);
      this.pendingPromptExpiry = undefined;
    }
    this.pendingPrompt = null;
    this.storyEchoPreparation = null;
    this.activeRunId = null;
    this.snapshots.clear();
    this.snapshotPromptSequences.clear();
    this.usageReads.clear();
    this.stateListeners.clear();
    this.promptSequence = 0;
    this.registered = false;
  }

  isRunActive(): boolean {
    return this.activeRunId !== null;
  }

  beginStoryEchoPreparation(chatId: string | null): void {
    this.storyEchoPreparation = chatId
      ? {
          chatId,
          preparedAt: Date.now(),
          injectedBlockCount: 0,
        }
      : null;
  }

  markStoryEchoSummaryInjected(chatId: string | null, blockCount = 1): void {
    if (
      !chatId ||
      !this.storyEchoPreparation ||
      this.storyEchoPreparation.chatId !== chatId
    ) {
      return;
    }
    this.storyEchoPreparation.injectedBlockCount = Math.max(0, Math.floor(blockCount));
  }

  subscribeRunState(listener: AgentRunStateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  promptForLatestMessage(
    context: SillyTavernContext,
  ): TauriAgentPromptSnapshot | null {
    const chatId = getCurrentChatId(context) ?? '';
    const latestMessageId = context.chat.length - 1;
    if (!chatId || latestMessageId < 0) {
      return null;
    }
    const messageRunId = messageAgentRunId(context.chat[latestMessageId]);
    if (messageRunId) {
      const snapshot = this.snapshots.get(messageRunId);
      if (snapshot?.chatId !== chatId) {
        return null;
      }
      snapshot.profile ||= messageAgentProfileId(context.chat[latestMessageId]);
      return snapshot;
    }
    const candidates = [...this.snapshots.values()]
      .filter((snapshot) => (
        snapshot.chatId === chatId &&
        snapshot.expectedMessageId === latestMessageId &&
        this.snapshotPromptSequences.get(snapshot.runId) === this.promptSequence
      ))
      .sort((left, right) => right.capturedAt - left.capturedAt);
    return candidates[0] ?? null;
  }

  latestMessageBelongsToAgent(context: SillyTavernContext): boolean {
    return Boolean(messageAgentRunId(context.chat[context.chat.length - 1]));
  }

  private readonly onCompletionSettingsReady = (payload: unknown): void => {
    let context: SillyTavernContext | undefined;
    try {
      context = globalThis.SillyTavern?.getContext();
    } catch {
      return;
    }
    const prompt = promptSurface(payload);
    const chatId = context ? getCurrentChatId(context) ?? '' : '';
    if (!chatId || !prompt) {
      return;
    }
    this.promptSequence += 1;
    this.pendingPrompt = {
      chatId,
      prompt,
      capturedAt: Date.now(),
      sequence: this.promptSequence,
    };
    if (this.pendingPromptExpiry !== undefined) {
      clearTimeout(this.pendingPromptExpiry);
    }
    const capturedPrompt = this.pendingPrompt;
    this.pendingPromptExpiry = setTimeout(() => {
      if (this.pendingPrompt === capturedPrompt) {
        this.pendingPrompt = null;
      }
      this.pendingPromptExpiry = undefined;
    }, PROMPT_CAPTURE_MAX_AGE_MS);
  };

  private readonly onRunStateChanged = (event: Event): void => {
    const detail = eventDetail(event);
    const activeRun = detail['activeRun'];
    const nextRunId = agentRunId(activeRun);
    const previousRunId = this.activeRunId;
    this.activeRunId = nextRunId || null;

    if (nextRunId) {
      this.captureStartedRun(nextRunId, activeRun);
    }
    const terminalEvent = isRecord(detail['lastEvent']) ? detail['lastEvent'] : {};
    const change: TauriAgentRunStateChange = {
      activeRunId: this.activeRunId,
      previousRunId,
      terminalEventType: stringValue(terminalEvent['type']),
    };
    for (const listener of this.stateListeners) {
      listener(change);
    }
  };

  private readonly onRunEvent = (event: Event): void => {
    const detail = eventDetail(event);
    const runEvent = isRecord(detail['event']) ? detail['event'] : {};
    const runId = agentRunId(runEvent) || this.activeRunId || '';
    const payload = isRecord(runEvent['payload']) ? runEvent['payload'] : {};
    if (stringValue(runEvent['type']) === 'profile_resolved') {
      const snapshot = this.snapshots.get(runId);
      if (snapshot) {
        snapshot.profile = stringValue(payload['profileId'] ?? payload['profile_id'])
          || snapshot.profile;
      }
      return;
    }
    if (stringValue(runEvent['type']) !== 'model_completed') {
      return;
    }
    const round = finiteTokenCount(payload['round']);
    if (round !== 1) {
      return;
    }
    if (!runId || !this.snapshots.has(runId) || this.usageReads.has(runId)) {
      return;
    }
    this.usageReads.add(runId);
    const invocationId = stringValue(payload['invocationId'] ?? payload['invocation_id']);
    void this.readFirstTurnUsage(runId, invocationId);
  };

  private captureStartedRun(runId: string, activeRun: unknown): void {
    let context: SillyTavernContext | undefined;
    try {
      context = globalThis.SillyTavern?.getContext();
    } catch {
      return;
    }
    if (!context) {
      return;
    }
    const chatId = getCurrentChatId(context) ?? '';
    const pending = this.pendingPrompt;
    const preparation = this.storyEchoPreparation;
    this.pendingPrompt = null;
    this.storyEchoPreparation = null;
    if (this.pendingPromptExpiry !== undefined) {
      clearTimeout(this.pendingPromptExpiry);
      this.pendingPromptExpiry = undefined;
    }
    const ageMs = pending ? Date.now() - pending.capturedAt : Number.POSITIVE_INFINITY;
    if (
      !chatId ||
      !pending ||
      pending.chatId !== chatId ||
      ageMs < 0 ||
      ageMs > PROMPT_CAPTURE_MAX_AGE_MS
    ) {
      return;
    }
    const prompt = clonePromptSurface(pending.prompt);
    if (!prompt) {
      return;
    }
    const generationType = agentGenerationType(activeRun);
    const preparationMatches = Boolean(
      preparation &&
      preparation.chatId === chatId &&
      Date.now() - preparation.preparedAt <= PROMPT_CAPTURE_MAX_AGE_MS,
    );
    const storyEchoTrimmedByAgentAssembly = Boolean(
      preparationMatches &&
      preparation?.injectedBlockCount &&
      storyEchoSummaryCount(prompt.messages) < preparation.injectedBlockCount,
    );
    const snapshot: TauriAgentPromptSnapshot = {
      runId,
      chatId,
      generationType,
      expectedMessageId: expectedMessageId(context, generationType),
      ...prompt,
      capturedAt: Date.now(),
      actualInputTokens: null,
      storyEchoTrimmedByAgentAssembly,
    };
    this.snapshots.set(runId, snapshot);
    this.snapshotPromptSequences.set(runId, pending.sequence);
    this.pruneSnapshots();
    if (storyEchoTrimmedByAgentAssembly) {
      logger.warn(
        'TauriTavern Agent 启动前的二次组装移除了StoryEcho骨架与阶段总结；若Profile限制了初始历史，请将“初始聊天历史楼数”设为 -1。',
      );
    }
    emitDiagnosticsUpdated();
  }

  private async readFirstTurnUsage(runId: string, invocationId: string): Promise<void> {
    const agentApi = currentAgentApi();
    const readModelTurn = agentApi?.readModelTurn;
    if (typeof readModelTurn !== 'function') {
      return;
    }
    try {
      const result = await readModelTurn.call(agentApi, {
        runId,
        round: 1,
        ...(invocationId ? { invocationId } : {}),
        maxChars: 1,
      });
      const snapshot = this.snapshots.get(runId);
      if (!snapshot || !isRecord(result)) {
        return;
      }
      const provider = isRecord(result['provider']) ? result['provider'] : {};
      snapshot.actualInputTokens = agentUsageInputTokens(provider['usage']);
      snapshot.api = stringValue(provider['source']) || snapshot.api;
      snapshot.model = stringValue(provider['model']) || snapshot.model;
      emitDiagnosticsUpdated();
    } catch (error) {
      logger.debug('读取TauriTavern Agent首轮Token用量失败，将保留本地估算。', error);
    }
  }

  private pruneSnapshots(): void {
    while (this.snapshots.size > MAX_CAPTURED_RUNS) {
      const oldestRunId = this.snapshots.keys().next().value as string | undefined;
      if (!oldestRunId) {
        return;
      }
      this.snapshots.delete(oldestRunId);
      this.snapshotPromptSequences.delete(oldestRunId);
      this.usageReads.delete(oldestRunId);
    }
  }
}

export const tauriTavernAgentBridge = new TauriTavernAgentBridge();
