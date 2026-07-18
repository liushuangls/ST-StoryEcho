import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsRepository } from '../src/settings/repository';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SettingsRepository credential persistence', () => {
  it('stores both custom keys in SillyTavern extension settings', () => {
    const extensionSettings: Record<string, unknown> = {};
    const saveSettingsDebounced = vi.fn();
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ extensionSettings, saveSettingsDebounced }),
    });
    const repository = new SettingsRepository();

    repository.update((settings) => {
      settings.llm.custom.apiKey = 'llm-secret';
      settings.vector.custom.apiKey = 'embedding-secret';
      settings.vector.volcengine.apiKey = 'volcengine-secret';
    });

    expect(extensionSettings['story_echo']).toMatchObject({
      llm: { custom: { apiKey: 'llm-secret' } },
      vector: {
        custom: { apiKey: 'embedding-secret' },
        volcengine: { apiKey: 'volcengine-secret' },
      },
    });
    expect(saveSettingsDebounced).toHaveBeenCalledOnce();

    expect(new SettingsRepository().get()).toMatchObject({
      llm: { custom: { apiKey: 'llm-secret' } },
      vector: {
        custom: { apiKey: 'embedding-secret' },
        volcengine: { apiKey: 'volcengine-secret' },
      },
    });
  });

  it('migrates an existing Volcengine custom key into the dedicated provider once', () => {
    const extensionSettings: Record<string, unknown> = {
      story_echo: {
        vector: {
          custom: {
            baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
            model: 'doubao-embedding-large-text-250515',
            apiKey: 'legacy-ark-secret',
            timeoutMs: 45_000,
          },
        },
      },
    };
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ extensionSettings, saveSettingsDebounced: vi.fn() }),
    });

    expect(new SettingsRepository().get().vector.volcengine).toMatchObject({
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      model: 'doubao-embedding-vision-251215',
      apiKey: 'legacy-ark-secret',
      timeoutMs: 45_000,
    });
  });

  it('migrates the legacy three-turn extraction batch to the faster default', () => {
    const extensionSettings: Record<string, unknown> = {
      story_echo: {
        version: 1,
        extraction: { automatic: true, targetTurnsPerChunk: 3 },
      },
    };
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ extensionSettings, saveSettingsDebounced: vi.fn() }),
    });

    expect(new SettingsRepository().get()).toMatchObject({
      version: 3,
      extraction: { automatic: true, targetTurnsPerChunk: 5 },
      summary: {
        enabled: true,
        automatic: true,
        targetTurnsPerUpdate: 10,
        maxTokens: 1_600,
      },
    });
  });
});
