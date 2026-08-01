import { describe, expect, it } from 'vitest';
import type { TavernChatMessage } from '../src/core/types';
import { currentStoryPhaseStart } from '../src/history/story-phase';
import { estimateMessageTokens } from '../src/prompt/render';
import { removeMessagesAtIndices, selectRecentWindow } from '../src/prompt/window';
import { chatState } from './fixtures';

interface Timing {
  p50: number;
  p95: number;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function measure(iterations: number, operation: () => void): Timing {
  const durations: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const startedAt = performance.now();
    operation();
    durations.push(performance.now() - startedAt);
  }
  return {
    p50: percentile(durations, 0.5),
    p95: percentile(durations, 0.95),
  };
}

function messagesForScale(size: number): TavernChatMessage[] {
  const messages = Array.from({ length: size }, (_, index): TavernChatMessage => ({
    is_user: index % 2 === 0,
    mes: `第 ${index} 条：角色在地点 ${index % 17} 推进剧情。${'剧情文本'.repeat(40)}`,
  }));
  const phaseBoundary = Math.floor(size * 0.8 / 2) * 2;
  messages[phaseBoundary] = {
    is_user: true,
    mes: '上一段剧情已经结束，接下来进入全新的篇章。',
  };
  messages.push({ is_user: true, mes: '继续当前剧情。' });
  return messages;
}

describe('context-only long-chat performance', () => {
  it('keeps local prompt preparation bounded through 2000 messages', () => {
    const results = [500, 1_000, 2_000].map((size) => {
      const messages = messagesForScale(size);
      const selection = selectRecentWindow(messages, 12, 'turns');
      expect(selection).not.toBeNull();

      let retainedMessages = 0;
      const promptPreparation = measure(40, () => {
        const nextSelection = selectRecentWindow(messages, 12, 'turns')!;
        const request = messages.slice();
        removeMessagesAtIndices(request, nextSelection.removableIndices);
        retainedMessages = request.length;
      });
      let estimatedTokens = 0;
      const tokenEstimation = measure(40, () => {
        estimatedTokens = estimateMessageTokens(messages, selection!.removableIndices);
      });
      let phaseStart: number | null = null;
      const storyPhaseScan = measure(40, () => {
        phaseStart = currentStoryPhaseStart(messages, messages.length - 1);
      });

      const summaryCount = Math.floor(size / 20);
      const state = chatState({
        stageSummary: {
          entries: Array.from({ length: summaryCount }, (_, index) => ({
            text: `阶段 ${index + 1}：${'关键剧情与因果。'.repeat(20)}`,
            sourceStartMessageId: index * 20,
            sourceEndMessageId: index * 20 + 19,
            sourceHash: `summary-source-${index}`,
            updatedAt: '2026-01-01T00:00:00.000Z',
          })),
          coveredThroughMessageId: summaryCount * 20 - 1,
          coveredThroughHash: `summary-source-${summaryCount - 1}`,
        },
      });
      let metadataBytes = 0;
      const metadataSerialization = measure(40, () => {
        metadataBytes = new TextEncoder().encode(JSON.stringify(state)).byteLength;
      });

      expect(retainedMessages).toBe(25);
      expect(estimatedTokens).toBeGreaterThan(0);
      expect(phaseStart).toBe(Math.floor(size * 0.8 / 2) * 2);
      expect(metadataBytes).toBeLessThan(500_000);
      for (const timing of [
        promptPreparation,
        tokenEstimation,
        storyPhaseScan,
        metadataSerialization,
      ]) {
        expect(timing.p95).toBeLessThan(100);
      }

      return {
        messages: messages.length,
        stageSummaries: summaryCount,
        retainedMessages,
        metadataBytes,
        promptPreparation,
        tokenEstimation,
        storyPhaseScan,
        metadataSerialization,
      };
    });

    console.info('[StoryEcho context benchmark]', JSON.stringify(results.map((result) => ({
      ...result,
      promptPreparation: {
        p50: Number(result.promptPreparation.p50.toFixed(3)),
        p95: Number(result.promptPreparation.p95.toFixed(3)),
      },
      tokenEstimation: {
        p50: Number(result.tokenEstimation.p50.toFixed(3)),
        p95: Number(result.tokenEstimation.p95.toFixed(3)),
      },
      storyPhaseScan: {
        p50: Number(result.storyPhaseScan.p50.toFixed(3)),
        p95: Number(result.storyPhaseScan.p95.toFixed(3)),
      },
      metadataSerialization: {
        p50: Number(result.metadataSerialization.p50.toFixed(3)),
        p95: Number(result.metadataSerialization.p95.toFixed(3)),
      },
    }))));
  });
});
