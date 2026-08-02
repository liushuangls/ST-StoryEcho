import { EXTENSION_VERSION } from '../core/constants';
import type { StoryEchoChatState, StoryEchoSettings } from '../core/types';
import { storyEchoTaskCoordinator } from '../runtime/task-coordinator';

export function buildDebugReport(
  state: StoryEchoChatState,
  settings: StoryEchoSettings,
): string {
  const report = JSON.stringify({
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
        entries: state.stageSummary.entries,
      },
      storySkeleton: state.storySkeleton,
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
  }, null, 2);
  const redactions = [
    settings.llm.custom.baseUrl.trim(),
    settings.llm.custom.apiKey.trim(),
  ].filter(Boolean);
  return redactions.reduce(
    (sanitized, value) => sanitized.split(value).join('[REDACTED]'),
    report,
  );
}
