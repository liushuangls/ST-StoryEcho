import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoryEchoSettings } from '../src/core/types';
import { completeObservedInternalRequest } from '../src/llm/observed-completion';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { chatState } from './fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('observed internal LLM completion', () => {
  it('persists safe completion and response-shape metadata for an empty custom response', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        finish_reason: 'length',
        message: { content: '', reasoning_content: 'must not be persisted' },
      }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        completion_tokens_details: { reasoning_tokens: 50 },
      },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'csrf' }),
      }),
    });
    const settings: StoryEchoSettings = structuredClone(DEFAULT_SETTINGS);
    settings.llm.provider = 'openai-compatible';
    settings.llm.custom.baseUrl = 'https://example.com/v1';
    settings.llm.custom.model = 'model-name';
    settings.llm.custom.fallbackToMain = false;
    const state = chatState();

    await expect(completeObservedInternalRequest(state, settings, {
      system: 'system',
      prompt: 'prompt',
      maxTokens: 1_600,
    }, {
      task: 'stage-summary',
      sourceStartMessageId: 10,
      sourceEndMessageId: 19,
    })).rejects.toThrow('自定义LLM没有返回可读取的内容。');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(state.recentInternalLlmAttempts).toHaveLength(1);
    expect(state.recentInternalLlmAttempts[0]).toMatchObject({
      task: 'stage-summary',
      status: 'failed',
      requestedMaxTokens: 1_600,
      completion: {
        finishReason: 'length',
        promptTokens: 100,
        completionTokens: 50,
        reasoningTokens: 50,
        totalTokens: 150,
        responseCharacters: 0,
      },
      responseDiagnostic: {
        messageFields: ['content', 'reasoning_content'],
        messageContentType: 'string',
        hasReasoning: true,
      },
      error: '自定义LLM没有返回可读取的内容。',
    });
    expect(JSON.stringify(state.recentInternalLlmAttempts)).not.toContain('must not be persisted');
  });
});
