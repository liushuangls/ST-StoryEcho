import { describe, expect, it } from 'vitest';
import type { StoryMemory, TavernChatMessage } from '../src/core/types';
import { shortlistMemories } from '../src/consolidation/shortlist';
import {
  directlyGroundedStoryMemoryNames,
  normalizedStoryEntityName,
  unsupportedStoryMemoryNames,
} from '../src/extraction/quality';
import { buildRetrievalQueryPlan } from '../src/retrieval/query-builder';
import { scopeMemoriesToCurrentStoryPhase } from '../src/retrieval/story-phase';
import { rankMemories } from '../src/retrieval/ranker';
import { invalidatedMemoryIdsByStageSummaries } from '../src/retrieval/summary-shadow';
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
      mes: `第 ${index} 楼：角色${index}与物品${index}。${'剧情文本'.repeat(80)}`,
    }));
    messages.push({ is_user: true, mes: '银钥匙现在在哪里？' });

    const memories: StoryMemory[] = Array.from({ length: 300 }, (_, index) => memory({
      id: `memory-${index}`,
      vectorHash: index + 1,
      event: `角色${index}完成第${index}件长期事件`,
      entities: [`角色${index}`, `物品${index}`],
      aliases: [],
      stateChanges: [{
        entity: `物品${index}`,
        attribute: '持有者',
        after: `角色${index}`,
      }],
      retrievalText: `角色${index}与物品${index}的当前状态`,
      sourceMessageIds: [index],
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
    let groundedMemoryCount = 0;
    const groundingAverageMs = averageDuration(20, () => {
      const establishedNames = new Set(memories.flatMap((item) => (
        directlyGroundedStoryMemoryNames(item, messages).map(normalizedStoryEntityName)
      )));
      groundedMemoryCount = memories.filter((item) => (
        unsupportedStoryMemoryNames(item, messages, establishedNames).length === 0
      )).length;
    });
    const state = chatState(memories);
    state.stageSummary.entries = Array.from({ length: 23 }, (_, index) => ({
      text: [
        '【已确认剧情】',
        `第${index + 1}阶段：${'关键剧情与人物关系。'.repeat(20)}`,
        '【当前状态】',
        '无',
        '【未解决线索】',
        '无',
        '【角色主张与推测】',
        '无',
        '【已失效或否定事实】',
        '无',
      ].join('\n'),
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
    let invalidatedMemoryCount = 0;
    const summaryShadowAverageMs = averageDuration(50, () => {
      invalidatedMemoryCount = invalidatedMemoryIdsByStageSummaries(
        memories,
        state.stageSummary.entries,
      ).size;
    });
    const storyPhaseMessages = messages.map((message) => ({ ...message }));
    storyPhaseMessages[400] = {
      is_user: true,
      mes: '上一段剧情已经结束，接下来进入全新的篇章。',
    };
    let storyPhaseMemoryCount = 0;
    const storyPhaseScopeAverageMs = averageDuration(100, () => {
      storyPhaseMemoryCount = scopeMemoriesToCurrentStoryPhase(
        memories,
        storyPhaseMessages,
        storyPhaseMessages.length - 1,
      ).memories.length;
    });
    const metadataBytes = new TextEncoder().encode(JSON.stringify(state)).byteLength;

    console.info('[StoryEcho long-chat benchmark]', JSON.stringify({
      messages: messages.length,
      memories: memories.length,
      windowAverageMs: Number(windowAverageMs.toFixed(3)),
      tokenEstimateAverageMs: Number(tokenEstimateAverageMs.toFixed(3)),
      rankingAverageMs: Number(rankingAverageMs.toFixed(3)),
      shortlistAverageMs: Number(shortlistAverageMs.toFixed(3)),
      groundingAverageMs: Number(groundingAverageMs.toFixed(3)),
      stageSummaries: state.stageSummary.entries.length,
      summaryWindowAverageMs: Number(summaryWindowAverageMs.toFixed(3)),
      summaryShadowAverageMs: Number(summaryShadowAverageMs.toFixed(3)),
      storyPhaseScopeAverageMs: Number(storyPhaseScopeAverageMs.toFixed(3)),
      metadataBytes,
    }));

    expect(compactedLength).toBe(41);
    expect(estimatedTokens).toBeGreaterThan(0);
    expect(rankedCount).toBeGreaterThan(0);
    expect(rankedCount).toBeLessThanOrEqual(4);
    expect(shortlistCount).toBe(3);
    expect(groundedMemoryCount).toBe(300);
    expect(summaryWindowCount).toBe(4);
    expect(invalidatedMemoryCount).toBe(0);
    expect(storyPhaseMemoryCount).toBe(0);
    expect(windowAverageMs).toBeLessThan(20);
    expect(tokenEstimateAverageMs).toBeLessThan(20);
    expect(rankingAverageMs).toBeLessThan(50);
    expect(shortlistAverageMs).toBeLessThan(100);
    expect(groundingAverageMs).toBeLessThan(100);
    expect(summaryWindowAverageMs).toBeLessThan(5);
    expect(summaryShadowAverageMs).toBeLessThan(50);
    expect(storyPhaseScopeAverageMs).toBeLessThan(20);
    expect(metadataBytes).toBeLessThan(1_000_000);
  });
});
