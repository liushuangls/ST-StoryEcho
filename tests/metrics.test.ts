import { describe, expect, it } from 'vitest';
import {
  normalizeMetrics,
  recordDebugTrace,
  resetDiagnostics,
} from '../src/debug/metrics';
import { chatState, memory } from './fixtures';

describe('diagnostics metrics', () => {
  it('normalizes partial legacy metrics', () => {
    const metrics = normalizeMetrics({ extractionChunks: 3, actions: { CREATE: 2 } });
    expect(metrics.extractionChunks).toBe(3);
    expect(metrics.actions.CREATE).toBe(2);
    expect(metrics.actions.SUPERSEDE).toBe(0);
    expect(metrics.vectorSyncFailures).toBe(0);
  });

  it('keeps only the most recent 50 debug traces', () => {
    const state = chatState();
    for (let index = 0; index < 55; index += 1) {
      recordDebugTrace(state, true, 'interceptor', `trace-${index}`);
    }
    expect(state.debugTraces).toHaveLength(50);
    expect(state.debugTraces[0]?.message).toBe('trace-5');
    expect(state.debugTraces.at(-1)?.message).toBe('trace-54');
  });

  it('resets diagnostics without deleting story memories', () => {
    const state = chatState([memory()]);
    state.metrics.actions.CREATE = 5;
    recordDebugTrace(state, true, 'extraction', 'trace');
    resetDiagnostics(state);

    expect(state.memories).toHaveLength(1);
    expect(state.metrics.actions.CREATE).toBe(0);
    expect(state.debugTraces).toEqual([]);
  });
});
