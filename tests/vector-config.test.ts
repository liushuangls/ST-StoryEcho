import { describe, expect, it } from 'vitest';
import { vectorConfigFingerprint } from '../src/vector/config';

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
});
