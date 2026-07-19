import { describe, expect, it } from 'vitest';
import type { StoryMemory, TavernChatMessage } from '../src/core/types';
import { shortlistMemories } from '../src/consolidation/shortlist';
import { buildRetrievalQueryPlan } from '../src/retrieval/query-builder';
import { rankMemories } from '../src/retrieval/ranker';
import { estimateMessageTokens } from '../src/prompt/render';
import { removeMessagesAtIndices, selectRecentWindow } from '../src/prompt/window';
import { candidate, chatState, memory } from './fixtures';

function averageDuration(iterations: number, operation: () => void): number {
  const startedAt = performance.now();
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    operation();
  }
  return (performance.now() - startedAt) / iterations;
}

describe('hundreds-floor local performance', () => {
  it('keeps windowing and memory ranking bounded for 500 messages', () => {
    const messages: TavernChatMessage[] = Array.from({ length: 500 }, (_, index) => ({
      is_user: index % 2 === 0,
      mes: `第 ${index} 楼：${'剧情文本'.repeat(80)}`,
    }));
    messages.push({ is_user: true, mes: '银钥匙现在在哪里？' });

    const memories: StoryMemory[] = Array.from({ length: 300 }, (_, index) => memory({
      id: `memory-${index}`,
      vectorHash: index + 1,
      event: `角色${index}完成第${index}件长期事件`,
      entities: [`角色${index}`, `物品${index}`],
      aliases: [],
      retrievalText: `角色${index}与物品${index}的当前状态`,
      source: {
        startMessageId: index,
        endMessageId: index,
        sourceHash: `source-${index}`,
      },
      sourceHistory: [{
        startMessageId: index,
        endMessageId: index,
        sourceHash: `source-${index}`,
      }],
    }));
    const queryPlan = buildRetrievalQueryPlan(messages, messages.length - 1);
    const vectorResults = {
      intent: memories.slice(0, 15).map((item, rank) => ({
        hash: item.vectorHash,
        text: item.retrievalText,
        index: item.source.endMessageId,
        rank,
      })),
      scene: [],
    };
    const candidates = [0, 140, 299].map((index) => candidate({
      type: 'event',
      scene: { location: '', time: '', participants: [] },
      entities: [`角色${index}`, `物品${index}`],
      aliases: [],
      stateChanges: [],
      retrievalText: `角色${index}与物品${index}的当前状态`,
    }));
    const selection = selectRecentWindow(messages, 20, 'turns')!;

    let compactedLength = 0;
    const windowAverageMs = averageDuration(100, () => {
      const nextSelection = selectRecentWindow(messages, 20, 'turns')!;
      const promptMessages = messages.slice();
      removeMessagesAtIndices(promptMessages, nextSelection.removableIndices);
      compactedLength = promptMessages.length;
    });
    let estimatedTokens = 0;
    const tokenEstimateAverageMs = averageDuration(100, () => {
      estimatedTokens = estimateMessageTokens(messages, selection.removableIndices);
    });
    let rankedCount = 0;
    const rankingAverageMs = averageDuration(50, () => {
      rankedCount = rankMemories(queryPlan, memories, vectorResults).length;
    });
    let shortlistCount = 0;
    const shortlistAverageMs = averageDuration(30, () => {
      shortlistCount = shortlistMemories(candidates, memories, new Set()).length;
    });
    const state = chatState(memories);
    state.stageSummary.entries = Array.from({ length: 23 }, (_, index) => ({
      text: `第${index + 1}阶段总结：${'关键剧情与人物关系。'.repeat(20)}`,
      sourceStartMessageId: index * 20,
      sourceEndMessageId: index * 20 + 19,
      sourceHash: `summary-source-${index}`,
      updatedAt: '2026-01-01T00:00:00.000Z',
    }));
    state.stageSummary.coveredThroughMessageId = 459;
    state.stageSummary.coveredThroughHash = 'summary-source-22';
    let summaryWindowCount = 0;
    const summaryWindowAverageMs = averageDuration(1_000, () => {
      summaryWindowCount = state.stageSummary.entries.slice(-4).length;
    });
    const metadataBytes = new TextEncoder().encode(JSON.stringify(state)).byteLength;

    console.info('[StoryEcho long-chat benchmark]', JSON.stringify({
      messages: messages.length,
      memories: memories.length,
      windowAverageMs: Number(windowAverageMs.toFixed(3)),
      tokenEstimateAverageMs: Number(tokenEstimateAverageMs.toFixed(3)),
      rankingAverageMs: Number(rankingAverageMs.toFixed(3)),
      shortlistAverageMs: Number(shortlistAverageMs.toFixed(3)),
      stageSummaries: state.stageSummary.entries.length,
      summaryWindowAverageMs: Number(summaryWindowAverageMs.toFixed(3)),
      metadataBytes,
    }));

    expect(compactedLength).toBe(41);
    expect(estimatedTokens).toBeGreaterThan(0);
    expect(rankedCount).toBeGreaterThan(0);
    expect(rankedCount).toBeLessThanOrEqual(4);
    expect(shortlistCount).toBe(3);
    expect(summaryWindowCount).toBe(4);
    expect(windowAverageMs).toBeLessThan(20);
    expect(tokenEstimateAverageMs).toBeLessThan(20);
    expect(rankingAverageMs).toBeLessThan(50);
    expect(shortlistAverageMs).toBeLessThan(100);
    expect(summaryWindowAverageMs).toBeLessThan(5);
    expect(metadataBytes).toBeLessThan(1_000_000);
  });
});
