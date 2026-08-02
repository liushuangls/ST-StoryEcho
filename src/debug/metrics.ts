import type {
  DebugDetails,
  DebugStage,
  StoryEchoChatState,
  StoryEchoMetrics,
} from '../core/types';
import { createUuid } from '../core/uuid';

const MAX_DEBUG_TRACES = 50;

export function createMetrics(): StoryEchoMetrics {
  return {
    summaryUpdates: 0,
    summaryFailures: 0,
    summaryMessagesCovered: 0,
    skeletonUpdates: 0,
    skeletonFailures: 0,
    generationAttempts: 0,
    generationsTrimmed: 0,
    generationsDeferred: 0,
    messagesRemoved: 0,
    estimatedRemovedTokens: 0,
    estimatedInjectedTokens: 0,
    totalSummaryMs: 0,
    totalSkeletonMs: 0,
  };
}

function finiteCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function normalizeMetrics(value: unknown): StoryEchoMetrics {
  const source = typeof value === 'object' && value !== null
    ? value as Partial<StoryEchoMetrics>
    : {};
  const metrics = createMetrics();

  for (const key of Object.keys(metrics) as Array<keyof StoryEchoMetrics>) {
    (metrics[key] as number) = finiteCount(source[key]);
  }
  for (const field of ['lastSummaryAt', 'lastSkeletonAt', 'lastGenerationAt'] as const) {
    if (typeof source[field] === 'string') {
      metrics[field] = source[field];
    }
  }
  return metrics;
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
  state.recentInternalLlmAttempts = [];
  delete state.lastInspection;
}
