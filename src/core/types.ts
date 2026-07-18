export type WindowUnit = 'turns' | 'messages';
export type LlmProviderId = 'main' | 'openai-compatible';
export type RetrievalQueryMode = 'llm' | 'local';
export type VectorSourceMode = 'inherit' | 'openai-compatible';
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
export type DebugStage = 'extraction' | 'consolidation' | 'vector' | 'retrieval' | 'interceptor' | 'error';

export interface StoryEchoSettings {
  version: 1;
  enabled: boolean;
  debug: boolean;
  recentWindow: {
    size: number;
    unit: WindowUnit;
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
      timeoutMs: number;
      allowInsecureHttp: boolean;
      fallbackToMain: boolean;
      strictJsonSchema: boolean;
    };
  };
  vector: {
    source: VectorSourceMode | string;
    model: string;
    custom: {
      baseUrl: string;
      model: string;
      timeoutMs: number;
      allowInsecureHttp: boolean;
    };
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
  vectorResultCount: number;
  durationMs: number;
  warnings: string[];
}

export interface StoryEchoMetrics {
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
  totalConsolidationMs: number;
  totalRetrievalMs: number;
  totalQueryRewriteMs: number;
  lastExtractionAt?: string;
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
  signal?: AbortSignal;
}

export interface LlmProvider {
  readonly id: LlmProviderId;
  complete(request: LlmRequest): Promise<string>;
  testConnection(): Promise<void>;
}
