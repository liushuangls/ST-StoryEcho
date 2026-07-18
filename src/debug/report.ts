import { EXTENSION_VERSION } from '../core/constants';
import type { StoryEchoChatState, StoryEchoSettings } from '../core/types';
import { renderMemoryEntry } from '../prompt/render';

export function buildDebugReport(
  state: StoryEchoChatState,
  settings: StoryEchoSettings,
  vectorCount: number | string = 'unknown',
): string {
  const memoryStatus = {
    active: state.memories.filter((memory) => memory.status === 'active').length,
    resolved: state.memories.filter((memory) => memory.status === 'resolved').length,
    superseded: state.memories.filter((memory) => memory.status === 'superseded').length,
    invalid: state.memories.filter((memory) => memory.status === 'invalid').length,
  };
  const selected = new Set(state.lastInspection?.selectedMemoryIds ?? []);

  const report = JSON.stringify({
    storyEchoVersion: EXTENSION_VERSION,
    generatedAt: new Date().toISOString(),
    chat: {
      ownerChatId: state.ownerChatId,
      chatUuid: state.chatUuid,
      vectorCollectionId: state.vectorCollectionId,
      indexedThroughMessageId: state.indexedThroughMessageId,
      memoryStatus,
      vectorCount,
      pendingVectorHashes: state.pendingVectorHashes.length,
      pendingVectorDeleteHashes: state.pendingVectorDeleteHashes.length,
    },
    settings: {
      enabled: settings.enabled,
      debug: settings.debug,
      recentWindow: settings.recentWindow,
      recall: settings.recall,
      extraction: settings.extraction,
      llmProvider: settings.llm.provider,
      vectorSource: settings.vector.source,
      vectorModel: settings.vector.model,
    },
    metrics: state.metrics,
    lastInspection: state.lastInspection ?? null,
    selectedMemories: state.memories
      .filter((memory) => selected.has(memory.id))
      .map((memory) => ({
        id: memory.id,
        status: memory.status,
        lastOperation: memory.lastOperation,
        source: memory.source,
        injectionText: memory.injectionText,
        renderedInjection: renderMemoryEntry(memory),
      })),
    recentMemories: [...state.memories]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 100)
      .map((memory) => ({
        id: memory.id,
        type: memory.type,
        status: memory.status,
        lastOperation: memory.lastOperation,
        source: memory.source,
        supersedesMemoryIds: memory.supersedesMemoryIds,
        replacedByMemoryId: memory.replacedByMemoryId ?? null,
        event: memory.event,
        injectionText: memory.injectionText,
      })),
    recentDebugTraces: state.debugTraces,
  }, null, 2);
  const redactions = [
    settings.llm.custom.baseUrl.trim(),
    settings.vector.custom.baseUrl.trim(),
    settings.vector.volcengine.baseUrl.trim(),
    settings.llm.custom.apiKey.trim(),
    settings.vector.custom.apiKey.trim(),
    settings.vector.volcengine.apiKey.trim(),
  ].filter(Boolean);
  return redactions.reduce(
    (sanitized, value) => sanitized.split(value).join('[REDACTED]'),
    report,
  );
}
