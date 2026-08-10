import { describe, expect, it } from 'vitest';
import {
  buildDebugReport,
  buildRecentErrorReport,
  RECENT_ERROR_REPORT_LIMIT,
} from '../src/debug/report';
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

    expect(report).toContain('"levelCounts"');
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

  it('copies only bounded recent diagnostics without story-derived content', () => {
    const state = chatState({
      stageSummary: {
        entries: [{
          text: '不应出现在精简错误报告中的阶段总结正文',
          level: 1,
          sourceStartMessageId: 0,
          sourceEndMessageId: 1,
          sourceHash: 'saved-source',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }],
        coveredThroughMessageId: 1,
        coveredThroughHash: 'saved-source',
        rebuildCheckpoint: {
          targetEndMessageId: 11,
          targetSourceHash: 'target-source',
          generationSignature: 'generation-signature',
          entries: [{
            text: '不应复制的重建草稿正文',
            level: 1,
            sourceStartMessageId: 0,
            sourceEndMessageId: 3,
            sourceHash: 'draft-source',
            updatedAt: '2026-01-01T00:00:00.000Z',
          }],
          totalDurationMs: 100,
          totalMessagesCovered: 4,
          updatedAt: '2026-01-01T00:00:01.000Z',
        },
      },
    });
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.llm.custom.baseUrl = 'https://private.example/v1';
    settings.llm.custom.apiKey = 'secret-key';
    state.recentInternalLlmAttempts = Array.from({ length: 7 }, (_, index) => ({
      id: `attempt-${index}`,
      task: 'stage-summary' as const,
      status: index === 6 ? 'failed' as const : 'completed' as const,
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1_000,
      requestedMaxTokens: 3_000,
      agentActiveAtStart: false,
      agentActiveAtEnd: false,
      ...(index === 6 ? {
        attemptErrors: ['LLM请求超时（300000ms）。', '主连接流式请求返回了错误。'],
        error: `failed at ${settings.llm.custom.baseUrl} with ${settings.llm.custom.apiKey}`,
      } : {}),
    }));
    state.debugTraces = [{
      id: 'trace-error',
      createdAt: '2026-01-01T00:00:02.000Z',
      stage: 'error',
      message: 'rebuild failed',
    }];

    const report = buildRecentErrorReport(state, settings);

    expect(RECENT_ERROR_REPORT_LIMIT).toBe(5);
    expect(report).not.toContain('attempt-0');
    expect(report).not.toContain('attempt-1');
    expect(report).toContain('attempt-2');
    expect(report).toContain('attemptErrors');
    expect(report).toContain('draftEntryCount');
    expect(report).not.toContain('阶段总结正文');
    expect(report).not.toContain('重建草稿正文');
    expect(report).not.toContain('private.example');
    expect(report).not.toContain('secret-key');
  });
});
