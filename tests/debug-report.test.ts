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
    state.recentInternalLlmAttempts.push({
      id: 'attempt-1',
      task: 'stage-summary',
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1_000,
      sourceStartMessageId: 10,
      sourceEndMessageId: 19,
      requestedMaxTokens: 3_000,
      agentActiveAtStart: true,
      agentActiveAtEnd: false,
      completion: {
        provider: 'main',
        requestedMaxTokens: 3_000,
        finishReason: 'length',
        completionTokens: 125,
        reasoningTokens: 80,
        responseCharacters: 125,
      },
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
    });
    const report = buildDebugReport(state, settings);

    expect(report).toContain('"storySkeleton"');
    expect(report).toContain('"stageSummary"');
    expect(report).toContain('"metrics"');
    expect(report).toContain('"recentInternalLlmAttempts"');
    expect(report).toContain('"finishReason": "length"');
    expect(report).toContain('"reasoningTokens": 80');
    expect(report).toContain('"hasReasoning": true');
    expect(report).toContain('"messageFields"');
    expect(report).not.toContain('private.example');
    expect(report).not.toContain('apiKey');
    expect(report).not.toContain('llm-secret');
  });
});
