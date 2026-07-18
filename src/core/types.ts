export type WindowUnit = 'turns' | 'messages';
export type LlmProviderId = 'main' | 'openai-compatible';
export type RetrievalQueryMode = 'llm' | 'local';
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
  version: 4;
  enabled: boolean;
  debug: boolean;
  recentWindow: {
    size: number;
    unit: WindowUnit;
  };
  summary: {
    enabled: boolean;
    automatic: boolean;
    targetTurnsPerUpdate: number;
    windowSize: number;
    maxTokens: number;
  };
  recall: {
    maxEvents: number;
    maxTokens: number;
    scoreThreshold: number;
    queryMode: RetrievalQueryMode;
  };
  extraction: {
    automatic: boolean;
    targetTurnsPerChunk: number;
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
  type: MemoryType;
  source: StoryMemorySource;
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
  extractionChunks: number;
  extractionFailures: number;
  candidatesExtracted: number;
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
  totalConsolidationMs: number;
  totalRetrievalMs: number;
  totalQueryRewriteMs: number;
  lastExtractionAt?: string;
  lastSummaryAt?: string;
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
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LlmProvider {
  readonly id: LlmProviderId;
  complete(request: LlmRequest): Promise<string>;
  testConnection(): Promise<void>;
}
