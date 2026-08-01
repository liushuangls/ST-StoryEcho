import { describe, expect, it } from 'vitest';
import { buildDebugReport } from '../src/debug/report';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { chatState } from './fixtures';

describe('buildDebugReport', () => {
  it('includes context diagnostics while redacting custom credentials', () => {
    const state = chatState();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.llm.custom.baseUrl = 'https://private.example/v1/chat/completions';
    settings.llm.custom.apiKey = 'llm-secret';
    state.debugTraces.push({
      id: 'trace-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      stage: 'error',
      message: 'endpoint failed',
      details: { error: `Failed at ${settings.llm.custom.baseUrl}` },
    });
    const report = buildDebugReport(state, settings);

    expect(report).toContain('"storySkeleton"');
    expect(report).toContain('"stageSummary"');
    expect(report).toContain('"metrics"');
    expect(report).not.toContain('private.example');
    expect(report).not.toContain('apiKey');
    expect(report).not.toContain('llm-secret');
  });
});
