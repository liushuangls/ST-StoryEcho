export type WindowUnit = 'turns' | 'messages';
export type LlmProviderId = 'main' | 'openai-compatible';
export type RetrievalQueryMode = 'llm' | 'local';
export type ExtractionReferenceMode = 'off' | 'character' | 'character-world-info';
export type VectorSourceMode = 'inherit' | 'openai-compatible' | 'volcengine-multimodal';
export type MemoryType =
  | 'event'
  | 'state_change'
  | 'relationship_change'
  | 'commitment'
  | 'revelation'
  | 'clue'
  | 'conflict';
export type TruthStatus = 'confirmed' | 'claimed' | 'inferred' | 'uncertain';
export type MemoryStatus = 'active' | 'resolved' | 'superseded' | 'invalid';
export type EvidenceRole = 'user' | 'assistant' | 'mixed' | 'unknown';
export type ConsolidationOperation =
  | 'CREATE'
  | 'MERGE'
  | 'UPDATE'
  | 'RESOLVE'
  | 'SUPERSEDE'
  | 'IGNORE';
export type DebugStage =
  | 'summary'
  | 'extraction'
  | 'consolidation'
  | 'vector'
  | 'retrieval'
  | 'interceptor'
  | 'error';

export interface ExternalEmbeddingSettings {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  allowInsecureHttp: boolean;
}

export interface StoryEchoSettings {
  version: 8;
  enabled: boolean;
  memory: {
    enabled: boolean;
  };
  debug: boolean;
  recentWindow: {
    size: number;
    unit: WindowUnit;
  };
  summary: {
    /** @deprecated Kept only to migrate pre-0.17 settings. Summaries follow the master switch. */
    enabled: boolean;
    /** @deprecated Kept only to migrate pre-0.17 settings. Summary maintenance is automatic. */
    automatic: boolean;
    targetTurnsPerUpdate: number;
    windowSize: number;
    maxTokens: number;
    /** Maximum output and stored size of the always-on global story skeleton. */
    skeletonMaxTokens: number;
  };
  recall: {
    maxEvents: number;
    maxTokens: number;
    scoreThreshold: number;
    queryMode: RetrievalQueryMode;
  };
  extraction: {
    /** @deprecated Kept only to migrate pre-0.17 settings. Extraction follows memory.enabled. */
    automatic: boolean;
    targetTurnsPerChunk: number;
    reference: {
      mode: ExtractionReferenceMode;
      maxTokens: number;
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
      strictJsonSchema: boolean;
    };
  };
  vector: {
    source: VectorSourceMode | string;
    model: string;
    custom: ExternalEmbeddingSettings;
    volcengine: ExternalEmbeddingSettings;
  };
}

export interface StoryMemorySource {
  startMessageId: number;
  endMessageId: number;
  sourceHash: string;
}

export interface StoryMemory {
  id: string;
  /** Stable identity for a continuing state slot, especially commitments. */
  logicalKey: string;
  type: MemoryType;
  source: StoryMemorySource;
  /** Exact chat floors cited by the extraction model as evidence. */
  sourceMessageIds: number[];
  /** Which chat role directly supports this memory. Explicit User facts win conflicts. */
  evidenceRole: EvidenceRole;
  sourceHistory: StoryMemorySource[];
  scene: {
    location?: string;
    time?: string;
    participants: string[];
  };
  event: string;
  cause?: string;
  consequence?: string;
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
  truthStatus: TruthStatus;
  importance: number;
  status: MemoryStatus;
  retrievalText: string;
  injectionText: string;
  vectorHash: number;
  retrievalHash: string;
  pinned: boolean;
  excluded: boolean;
  manuallyEdited: boolean;
  supersedesMemoryIds: string[];
  replacedByMemoryId?: string;
  lastOperation: ConsolidationOperation;
  createdAt: string;
  updatedAt: string;
}

export interface PendingRange {
  startMessageId: number;
  endMessageId: number;
}

export interface StageSummaryEntry {
  text: string;
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
  query: string;
  candidateMemoryIds: string[];
  selectedMemoryIds: string[];
  estimatedRecallTokens: number;
  estimatedRemovedTokens: number;
  estimatedInjectedTokens: number;
  estimatedNetSavedTokens: number;
  estimatedSummaryTokens: number;
  summaryCoveredThroughMessageId: number;
  vectorResultCount: number;
  durationMs: number;
  warnings: string[];
}

export interface StoryEchoMetrics {
  summaryUpdates: number;
  summaryFailures: number;
  summaryMessagesCovered: number;
  skeletonUpdates: number;
  skeletonFailures: number;
  extractionChunks: number;
  extractionFailures: number;
  candidatesExtracted: number;
  referenceContextBuilds: number;
  referenceContextPartialFailures: number;
  referenceContextTokens: number;
  referenceWorldInfoEntries: number;
  consolidationCalls: number;
  consolidationFailures: number;
  actions: Record<ConsolidationOperation, number>;
  vectorQueries: number;
  vectorQueryFailures: number;
  vectorSyncFailures: number;
  vectorItemsInserted: number;
  vectorItemsDeleted: number;
  vectorRebuilds: number;
  queryRewriteRequests: number;
  queryRewriteFailures: number;
  queryRewriteCacheHits: number;
  generationAttempts: number;
  generationsTrimmed: number;
  generationsDeferred: number;
  messagesRemoved: number;
  memoriesInjected: number;
  estimatedRemovedTokens: number;
  estimatedInjectedTokens: number;
  totalExtractionMs: number;
  totalSummaryMs: number;
  totalSkeletonMs: number;
  totalConsolidationMs: number;
  totalRetrievalMs: number;
  totalQueryRewriteMs: number;
  lastExtractionAt?: string;
  lastSummaryAt?: string;
  lastSkeletonAt?: string;
  lastGenerationAt?: string;
}

export type DebugDetails = Record<string, string | number | boolean | null>;

export interface StoryEchoDebugTrace {
  id: string;
  createdAt: string;
  stage: DebugStage;
  message: string;
  details?: DebugDetails;
}

export interface StoryEchoChatState {
  schemaVersion: 1;
  chatUuid: string;
  ownerChatId: string;
  vectorCollectionId: string;
  indexedThroughMessageId: number;
  indexedThroughHash: string;
  indexedPrefixHash: string;
  stageSummary: {
    entries: StageSummaryEntry[];
    coveredThroughMessageId: number;
    coveredThroughHash: string;
    updatedAt?: string;
  };
  storySkeleton: StorySkeleton;
  memories: StoryMemory[];
  pendingRanges: PendingRange[];
  pendingVectorHashes: number[];
  pendingVectorDeleteHashes: number[];
  vectorFingerprint: string;
  metrics: StoryEchoMetrics;
  debugTraces: StoryEchoDebugTrace[];
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
  jsonSchema?: Record<string, unknown>;
  jsonExample?: unknown;
  structuredOutput?: LlmStructuredOutputMode;
  maxTokens?: number;
  signal?: AbortSignal;
}

export type LlmStructuredOutputMode = 'json-object' | 'json-schema' | 'text';

export interface LlmProvider {
  readonly id: LlmProviderId;
  supportsStructuredOutput(mode: LlmStructuredOutputMode): boolean;
  structuredOutputOrder(): readonly LlmStructuredOutputMode[];
  complete(request: LlmRequest): Promise<string>;
  testConnection(): Promise<void>;
}
