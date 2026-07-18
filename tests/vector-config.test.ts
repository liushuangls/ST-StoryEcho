import { describe, expect, it } from 'vitest';
import { resolveVectorConfig, vectorConfigFingerprint } from '../src/vector/config';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';

describe('vectorConfigFingerprint', () => {
  it('is independent of object key order', async () => {
    const first = await vectorConfigFingerprint({
      source: 'ollama',
      model: 'embed-model',
      sourceSettings: { keep: true, apiUrl: 'http://localhost:11434' },
    });
    const second = await vectorConfigFingerprint({
      sourceSettings: { apiUrl: 'http://localhost:11434', keep: true },
      model: 'embed-model',
      source: 'ollama',
    });

    expect(first).toBe(second);
  });

  it('changes when the embedding model changes without exposing configuration', async () => {
    const first = await vectorConfigFingerprint({ source: 'openai', model: 'model-a' });
    const second = await vectorConfigFingerprint({ source: 'openai', model: 'model-b' });

    expect(first).not.toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain('model-a');
  });

  it('ignores request timeout changes but tracks embedding endpoint changes', async () => {
    const first = await vectorConfigFingerprint({
      source: 'webllm',
      model: 'storyecho-model',
      precomputed: {
        provider: 'openai-compatible',
        endpoint: 'https://example.com/v1/embeddings',
        model: 'model-a',
        apiKey: 'first-secret',
        timeoutMs: 10_000,
      },
    });
    const sameEmbedding = await vectorConfigFingerprint({
      source: 'webllm',
      model: 'storyecho-model',
      precomputed: {
        provider: 'openai-compatible',
        endpoint: 'https://example.com/v1/embeddings',
        model: 'model-a',
        apiKey: 'changed-secret',
        timeoutMs: 60_000,
      },
    });
    const differentEndpoint = await vectorConfigFingerprint({
      source: 'webllm',
      model: 'storyecho-model',
      precomputed: {
        provider: 'openai-compatible',
        endpoint: 'https://other.example.com/v1/embeddings',
        model: 'model-a',
        apiKey: 'first-secret',
        timeoutMs: 10_000,
      },
    });

    expect(first).toBe(sameEmbedding);
    expect(first).not.toBe(differentEndpoint);
  });

  it('maps custom OpenAI-compatible embeddings to precomputed Vector Storage input', () => {
    const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    settings.vector.source = 'openai-compatible';
    settings.vector.custom.model = 'doubao-embedding-text-test';

    expect(resolveVectorConfig(settings)).toEqual({
      source: 'webllm',
      model: 'storyecho-openai-compatible--doubao-embedding-text-test',
      precomputed: {
        provider: 'openai-compatible',
        endpoint: 'https://ark.cn-beijing.volces.com/api/v3/embeddings',
        model: 'doubao-embedding-text-test',
        apiKey: '',
        timeoutMs: 60_000,
      },
    });
  });

  it('maps Volcengine multimodal embeddings to precomputed Vector Storage input', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.vector.source = 'volcengine-multimodal';
    settings.vector.volcengine.apiKey = 'ark-secret';

    expect(resolveVectorConfig(settings)).toEqual({
      source: 'webllm',
      model: 'storyecho-volcengine-multimodal--doubao-embedding-vision-251215',
      precomputed: {
        provider: 'volcengine-multimodal',
        endpoint: 'https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal',
        model: 'doubao-embedding-vision-251215',
        apiKey: 'ark-secret',
        timeoutMs: 60_000,
      },
    });
  });
});
