export type WindowUnit = 'turns' | 'messages';
export type LlmProviderId = 'main' | 'openai-compatible';

export interface LlmCompletionMetadata {
  provider: LlmProviderId;
  /** Actual output budget sent to the provider after local clamping/retry. */
  requestedMaxTokens: number;
  /** Provider-specific completion reason, for example `stop` or `length`. */
  finishReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  /** Unicode code-point count of the raw visible provider response. */
  responseCharacters: number;
  source?: string;
  model?: string;
  fallbackFrom?: LlmProviderId;
}

export interface LlmCompletionResult {
  text: string;
  metadata: LlmCompletionMetadata;
}

export type LlmResponseValueType =
  | 'missing'
  | 'null'
  | 'string'
  | 'array'
  | 'object'
  | 'number'
  | 'boolean'
  | 'other';

/** Structural response diagnostics only; never contains response text or credentials. */
export interface LlmResponseDiagnostic {
  responseType: LlmResponseValueType;
  rootFields: string[];
  choiceFields: string[];
  messageFields: string[];
  messageContentType: LlmResponseValueType;
  choiceTextType: LlmResponseValueType;
  rootContentType: LlmResponseValueType;
  hasReasoning: boolean;
}

export interface StoryEchoSettings {
  version: 10;
  enabled: boolean;
  debug: boolean;
  recentWindow: {
    size: number;
    unit: WindowUnit;
  };
  summary: {
    targetTurnsPerUpdate: number;
    windowSize: number;
    maxTokens: number;
    /** Maximum output and stored size of the always-on global story skeleton. */
    skeletonMaxTokens: number;
    reference: {
      /** Add blue-light and batch-matched green-light world-book entries. */
      enabled: boolean;
      /** Maximum number of green-light entries matched by one source batch. */
      maxWorldInfoEntries: number;
    };
  };
  llm: {
    provider: LlmProviderId;
    custom: {
      baseUrl: string;
      model: string;
      apiKey: string;
      timeoutMs: number;
      allowInsecureHttp: boolean;
      fallbackToMain: boolean;
    };
  };
}

export interface StageSummaryEntry {
  text: string;
  /** Unicode code-point count of the current stored summary text. */
  characterCount?: number;
  /** Generation provenance. Manual edits change characterCount but preserve this provenance. */
  generation?: LlmCompletionMetadata;
  sourceStartMessageId: number;
  sourceEndMessageId: number;
  sourceHash: string;
  updatedAt: string;
  /** User-edited summaries keep their source range/hash but are never silently rewritten. */
  manuallyEdited?: boolean;
  /**
   * A deleted non-tail entry remains as a coverage tombstone. It is never
   * injected, but keeps its old raw source range outside later requests.
   */
  deleted?: boolean;
}

export interface StorySkeleton {
  text: string;
  /** Last message covered by the stage-summary prefix folded into this historical skeleton. */
  coveredThroughMessageId: number;
  /** Digest of the exact stage-summary prefix used to build the current skeleton. */
  sourceHash: string;
  updatedAt?: string;
  /** Manual edits become the authoritative baseline for later incremental updates. */
  manuallyEdited?: boolean;
  /** Stale skeletons stay stored and editable, but are not injected until rebuilt. */
  stale?: boolean;
}

export interface InspectionRecord {
  createdAt: string;
  generationType: string;
  retainedStartIndex: number;
  retainedEndIndex: number;
  removedMessageCount: number;
  estimatedRemovedTokens: number;
  estimatedInjectedTokens: number;
  estimatedNetSavedTokens: number;
  estimatedSummaryTokens: number;
  summaryCoveredThroughMessageId: number;
  durationMs: number;
  warnings: string[];
}

export interface StoryEchoMetrics {
  summaryUpdates: number;
  summaryFailures: number;
  summaryMessagesCovered: number;
  skeletonUpdates: number;
  skeletonFailures: number;
  generationAttempts: number;
  generationsTrimmed: number;
  generationsDeferred: number;
  messagesRemoved: number;
  estimatedRemovedTokens: number;
  estimatedInjectedTokens: number;
  totalSummaryMs: number;
  totalSkeletonMs: number;
  lastSummaryAt?: string;
  lastSkeletonAt?: string;
  lastGenerationAt?: string;
}

export type DebugStage = 'summary' | 'interceptor' | 'error';
export type DebugDetails = Record<string, string | number | boolean | null>;

export interface StoryEchoDebugTrace {
  id: string;
  createdAt: string;
  stage: DebugStage;
  message: string;
  details?: DebugDetails;
}

export type InternalLlmTask = 'stage-summary' | 'story-skeleton';
export type InternalLlmAttemptStatus = 'completed' | 'cancelled' | 'failed';

export interface InternalLlmAttempt {
  id: string;
  task: InternalLlmTask;
  status: InternalLlmAttemptStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  sourceStartMessageId?: number;
  sourceEndMessageId?: number;
  requestedMaxTokens: number;
  agentActiveAtStart: boolean;
  agentActiveAtEnd: boolean;
  completion?: LlmCompletionMetadata;
  responseDiagnostic?: LlmResponseDiagnostic;
  error?: string;
}

export interface StoryEchoChatState {
  schemaVersion: 2;
  chatUuid: string;
  ownerChatId: string;
  stageSummary: {
    entries: StageSummaryEntry[];
    coveredThroughMessageId: number;
    coveredThroughHash: string;
    updatedAt?: string;
  };
  storySkeleton: StorySkeleton;
  metrics: StoryEchoMetrics;
  debugTraces: StoryEchoDebugTrace[];
  /** Bounded diagnostic history; never contains prompts, API keys, or response text. */
  recentInternalLlmAttempts: InternalLlmAttempt[];
  lastInspection?: InspectionRecord;
}

export interface TavernChatMessage {
  is_user: boolean;
  is_system?: boolean;
  name?: string;
  mes: string;
  send_date?: number | string;
  extra?: Record<string, unknown>;
}

export interface LlmRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
  /** Optional per-request deadline. Providers keep their normal default when omitted. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LlmProvider {
  readonly id: LlmProviderId;
  complete(request: LlmRequest): Promise<string>;
  completeDetailed?(request: LlmRequest): Promise<LlmCompletionResult>;
  testConnection(): Promise<void>;
}
