import { describe, expect, it } from 'vitest';
import {
  completionMetadataFromPayload,
  normalizeLlmCompletionMetadata,
} from '../src/llm/completion-metadata';

describe('LLM completion metadata', () => {
  it('normalizes Anthropic/Gemini-style finish and usage fields without inventing null counts', () => {
    expect(completionMetadataFromPayload({
      stop_reason: 'max_tokens',
      usage: {
        input_tokens: '120',
        output_tokens: null,
      },
      usageMetadata: {
        candidatesTokenCount: 30,
        totalTokenCount: 150,
        thoughtsTokenCount: 10,
      },
    }, {
      provider: 'main',
      requestedMaxTokens: 3_000,
      responseText: '剧情🎭',
      source: 'claude',
      model: 'model-name',
    })).toEqual({
      provider: 'main',
      requestedMaxTokens: 3_000,
      finishReason: 'max_tokens',
      promptTokens: 120,
      completionTokens: 30,
      reasoningTokens: 10,
      totalTokens: 150,
      responseCharacters: 3,
      source: 'claude',
      model: 'model-name',
    });
  });

  it('rejects incomplete stored metadata and bounds optional provenance fields', () => {
    expect(normalizeLlmCompletionMetadata({
      provider: 'main',
      requestedMaxTokens: null,
      responseCharacters: '',
    })).toBeUndefined();
    expect(normalizeLlmCompletionMetadata({
      provider: 'openai-compatible',
      requestedMaxTokens: '3000',
      responseCharacters: 125,
      finishReason: `length${'x'.repeat(300)}`,
      fallbackFrom: 'main',
    })).toMatchObject({
      provider: 'openai-compatible',
      requestedMaxTokens: 3_000,
      responseCharacters: 125,
      fallbackFrom: 'main',
      finishReason: expect.stringMatching(/^lengthx{194}$/u),
    });
  });
});
