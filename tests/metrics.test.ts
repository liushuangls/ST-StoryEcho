import { describe, expect, it } from 'vitest';
import {
  normalizeMetrics,
  recordDebugTrace,
  resetDiagnostics,
} from '../src/debug/metrics';
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
    recordDebugTrace(state, true, 'summary', 'trace');
    resetDiagnostics(state);

    expect(state.stageSummary.entries).toHaveLength(1);
    expect(state.metrics.summaryUpdates).toBe(0);
    expect(state.debugTraces).toEqual([]);
  });
});
