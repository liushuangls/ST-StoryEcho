import type {
  ConsolidationOperation,
  DebugDetails,
  DebugStage,
  StoryEchoChatState,
  StoryEchoMetrics,
} from '../core/types';
import { createUuid } from '../core/uuid';

const ACTIONS: ConsolidationOperation[] = [
  'CREATE',
  'MERGE',
  'UPDATE',
  'RESOLVE',
  'SUPERSEDE',
  'IGNORE',
];
const MAX_DEBUG_TRACES = 50;

export function createMetrics(): StoryEchoMetrics {
  return {
    summaryUpdates: 0,
    summaryFailures: 0,
    summaryMessagesCovered: 0,
    skeletonUpdates: 0,
    skeletonFailures: 0,
    extractionChunks: 0,
    extractionFailures: 0,
    candidatesExtracted: 0,
    referenceContextBuilds: 0,
    referenceContextPartialFailures: 0,
    referenceContextTokens: 0,
    referenceWorldInfoEntries: 0,
    consolidationCalls: 0,
    consolidationFailures: 0,
    actions: {
      CREATE: 0,
      MERGE: 0,
      UPDATE: 0,
      RESOLVE: 0,
      SUPERSEDE: 0,
      IGNORE: 0,
    },
    vectorQueries: 0,
    vectorQueryFailures: 0,
    vectorSyncFailures: 0,
    vectorItemsInserted: 0,
    vectorItemsDeleted: 0,
    vectorRebuilds: 0,
    queryRewriteRequests: 0,
    queryRewriteFailures: 0,
    queryRewriteCacheHits: 0,
    generationAttempts: 0,
    generationsTrimmed: 0,
    generationsDeferred: 0,
    messagesRemoved: 0,
    memoriesInjected: 0,
    estimatedRemovedTokens: 0,
    estimatedInjectedTokens: 0,
    totalSummaryMs: 0,
    totalSkeletonMs: 0,
    totalExtractionMs: 0,
    totalConsolidationMs: 0,
    totalRetrievalMs: 0,
    totalQueryRewriteMs: 0,
  };
}

function finiteCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function normalizeMetrics(value: unknown): StoryEchoMetrics {
  const source = typeof value === 'object' && value !== null
    ? value as Partial<StoryEchoMetrics>
    : {};
  const actionSource = typeof source.actions === 'object' && source.actions !== null
    ? source.actions as Partial<Record<ConsolidationOperation, number>>
    : {};
  const metrics = createMetrics();

  for (const key of Object.keys(metrics) as Array<keyof StoryEchoMetrics>) {
    if (
      key === 'actions' ||
      key === 'lastSummaryAt' ||
      key === 'lastSkeletonAt' ||
      key === 'lastExtractionAt' ||
      key === 'lastGenerationAt'
    ) {
      continue;
    }
    (metrics[key] as number) = finiteCount(source[key]);
  }
  for (const action of ACTIONS) {
    metrics.actions[action] = finiteCount(actionSource[action]);
  }
  if (typeof source.lastExtractionAt === 'string') {
    metrics.lastExtractionAt = source.lastExtractionAt;
  }
  if (typeof source.lastSummaryAt === 'string') {
    metrics.lastSummaryAt = source.lastSummaryAt;
  }
  if (typeof source.lastSkeletonAt === 'string') {
    metrics.lastSkeletonAt = source.lastSkeletonAt;
  }
  if (typeof source.lastGenerationAt === 'string') {
    metrics.lastGenerationAt = source.lastGenerationAt;
  }
  return metrics;
}

export function incrementAction(metrics: StoryEchoMetrics, operation: ConsolidationOperation): void {
  metrics.actions[operation] += 1;
}

export function recordDebugTrace(
  state: StoryEchoChatState,
  enabled: boolean,
  stage: DebugStage,
  message: string,
  details?: DebugDetails,
): void {
  if (!enabled) {
    return;
  }
  const boundedDetails = details
    ? Object.fromEntries(Object.entries(details).map(([key, value]) => [
        key,
        typeof value === 'string' ? value.slice(0, 4_000) : value,
      ]))
    : undefined;
  state.debugTraces.push({
    id: createUuid(),
    createdAt: new Date().toISOString(),
    stage,
    message,
    ...(boundedDetails ? { details: boundedDetails } : {}),
  });
  if (state.debugTraces.length > MAX_DEBUG_TRACES) {
    state.debugTraces.splice(0, state.debugTraces.length - MAX_DEBUG_TRACES);
  }
}

export function resetDiagnostics(state: StoryEchoChatState): void {
  state.metrics = createMetrics();
  state.debugTraces = [];
  delete state.lastInspection;
}
