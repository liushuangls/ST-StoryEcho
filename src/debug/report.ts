import { EXTENSION_VERSION } from '../core/constants';
import type { StoryEchoChatState, StoryEchoSettings } from '../core/types';
import { storyEchoTaskCoordinator } from '../runtime/task-coordinator';
import { summaryLevelCounts } from '../summary/compaction-state';

export const RECENT_ERROR_REPORT_LIMIT = 5;

function sanitizedReport(value: unknown, settings: StoryEchoSettings): string {
  const report = JSON.stringify(value, null, 2);
  const redactions = [
    settings.llm.custom.baseUrl.trim(),
    settings.llm.custom.apiKey.trim(),
  ].filter(Boolean);
  return redactions.reduce(
    (sanitized, redaction) => sanitized.split(redaction).join('[REDACTED]'),
    report,
  );
}

export function buildDebugReport(
  state: StoryEchoChatState,
  settings: StoryEchoSettings,
): string {
  return sanitizedReport({
    storyEchoVersion: EXTENSION_VERSION,
    generatedAt: new Date().toISOString(),
    chat: {
      ownerChatId: state.ownerChatId,
      chatUuid: state.chatUuid,
      stageSummary: {
        coveredThroughMessageId: state.stageSummary.coveredThroughMessageId,
        updatedAt: state.stageSummary.updatedAt ?? null,
        entryCount: state.stageSummary.entries.filter((entry) => !entry.deleted).length,
        deletedEntryCount: state.stageSummary.entries.filter((entry) => entry.deleted).length,
        levelCounts: Object.fromEntries(summaryLevelCounts(state.stageSummary.entries)),
        entries: state.stageSummary.entries,
        rebuildCheckpoint: state.stageSummary.rebuildCheckpoint
          ? {
              targetEndMessageId: state.stageSummary.rebuildCheckpoint.targetEndMessageId,
              draftEntryCount: state.stageSummary.rebuildCheckpoint.entries.length,
              coveredThroughMessageId: state.stageSummary.rebuildCheckpoint.entries.at(-1)
                ?.sourceEndMessageId ?? -1,
              updatedAt: state.stageSummary.rebuildCheckpoint.updatedAt,
            }
          : null,
      },
    },
    settings: {
      enabled: settings.enabled,
      debug: settings.debug,
      recentWindow: settings.recentWindow,
      summary: settings.summary,
      llmProvider: settings.llm.provider,
    },
    metrics: state.metrics,
    runtimeDiagnostics: {
      taskQueue: storyEchoTaskCoordinator.snapshot(),
      recentInternalLlmAttempts: state.recentInternalLlmAttempts,
    },
    lastInspection: state.lastInspection ?? null,
    recentDebugTraces: state.debugTraces,
  }, settings);
}

export function buildRecentErrorReport(
  state: StoryEchoChatState,
  settings: StoryEchoSettings,
  limit = RECENT_ERROR_REPORT_LIMIT,
): string {
  const retained = Math.max(1, Math.min(20, Math.floor(limit)));
  const checkpoint = state.stageSummary.rebuildCheckpoint;
  return sanitizedReport({
    storyEchoVersion: EXTENSION_VERSION,
    generatedAt: new Date().toISOString(),
    llmProvider: settings.llm.provider,
    level1MaxTokens: settings.summary.level1MaxTokens,
    higherLevelMaxTokens: settings.summary.higherLevelMaxTokens,
    taskQueue: storyEchoTaskCoordinator.snapshot(),
    rebuildCheckpoint: checkpoint
      ? {
          targetEndMessageId: checkpoint.targetEndMessageId,
          draftEntryCount: checkpoint.entries.length,
          coveredThroughMessageId: checkpoint.entries.at(-1)?.sourceEndMessageId ?? -1,
          updatedAt: checkpoint.updatedAt,
        }
      : null,
    recentInternalLlmAttempts: state.recentInternalLlmAttempts.slice(-retained),
    recentErrorTraces: state.debugTraces
      .filter((trace) => trace.stage === 'error')
      .slice(-retained),
  }, settings);
}
