import { describe, expect, it } from 'vitest';
import {
  normalizeMetrics,
  recordDebugTrace,
  resetDiagnostics,
} from '../src/debug/metrics';
import {
  MAX_INTERNAL_LLM_ATTEMPTS,
  normalizeInternalLlmAttempts,
  recordInternalLlmAttempt,
} from '../src/debug/internal-llm-attempts';
import { chatState } from './fixtures';

describe('diagnostics metrics', () => {
  it('normalizes the retained counters from partial legacy data', () => {
    const metrics = normalizeMetrics({
      summaryUpdates: 3,
      generationsTrimmed: 2,
      extractionChunks: 99,
    });
    expect(metrics.summaryUpdates).toBe(3);
    expect(metrics.generationsTrimmed).toBe(2);
    expect(metrics.skeletonUpdates).toBe(0);
    expect(metrics).not.toHaveProperty('extractionChunks');
  });

  it('keeps only the most recent 50 debug traces and honors the switch', () => {
    const state = chatState();
    recordDebugTrace(state, false, 'summary', 'ignored');
    for (let index = 0; index < 55; index += 1) {
      recordDebugTrace(state, true, 'interceptor', `trace-${index}`);
    }
    expect(state.debugTraces).toHaveLength(50);
    expect(state.debugTraces[0]?.message).toBe('trace-5');
    expect(state.debugTraces.at(-1)?.message).toBe('trace-54');
  });

  it('resets diagnostics without deleting summaries or the skeleton', () => {
    const state = chatState();
    state.stageSummary.entries.push({
      text: '阶段总结',
      sourceStartMessageId: 0,
      sourceEndMessageId: 1,
      sourceHash: 'hash',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    state.metrics.summaryUpdates = 5;
    state.recentInternalLlmAttempts.push({
      id: 'attempt',
      task: 'stage-summary',
      status: 'failed',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1_000,
      requestedMaxTokens: 3_000,
      agentActiveAtStart: false,
      agentActiveAtEnd: false,
      error: 'failed',
    });
    recordDebugTrace(state, true, 'summary', 'trace');
    resetDiagnostics(state);

    expect(state.stageSummary.entries).toHaveLength(1);
    expect(state.metrics.summaryUpdates).toBe(0);
    expect(state.debugTraces).toEqual([]);
    expect(state.recentInternalLlmAttempts).toEqual([]);
  });

  it('bounds persistent internal-model diagnostics to the latest twenty attempts', () => {
    const state = chatState();
    for (let index = 0; index < 25; index += 1) {
      recordInternalLlmAttempt(state, {
        id: `attempt-${index}`,
        task: 'stage-summary',
        status: 'completed',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:01.000Z',
        durationMs: 1_000,
        requestedMaxTokens: 3_000,
        agentActiveAtStart: false,
        agentActiveAtEnd: false,
      });
    }

    expect(state.recentInternalLlmAttempts).toHaveLength(MAX_INTERNAL_LLM_ATTEMPTS);
    expect(state.recentInternalLlmAttempts[0]?.id).toBe('attempt-5');
    expect(state.recentInternalLlmAttempts.at(-1)?.id).toBe('attempt-24');
  });

  it('normalizes structural empty-response diagnostics without response content', () => {
    const attempts = normalizeInternalLlmAttempts([{
      id: 'attempt-empty',
      task: 'stage-summary',
      status: 'failed',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1_000,
      requestedMaxTokens: 3_000,
      agentActiveAtStart: false,
      agentActiveAtEnd: false,
      responseDiagnostic: {
        responseType: 'object',
        rootFields: ['choices', 'usage'],
        choiceFields: ['finish_reason', 'message'],
        messageFields: ['content', 'reasoning_content'],
        messageContentType: 'string',
        choiceTextType: 'missing',
        rootContentType: 'missing',
        hasReasoning: true,
      },
      error: '自定义LLM没有返回可读取的内容。',
    }]);

    expect(attempts[0]?.responseDiagnostic).toMatchObject({
      hasReasoning: true,
      messageFields: ['content', 'reasoning_content'],
    });
  });
});
