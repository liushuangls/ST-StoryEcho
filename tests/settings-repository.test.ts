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
      version: 6,
      extraction: { automatic: true, targetTurnsPerChunk: 5 },
      summary: {
        enabled: true,
        automatic: true,
        targetTurnsPerUpdate: 10,
        windowSize: 4,
        maxTokens: 1_600,
      },
    });
  });

  it('adds the default S window when upgrading 0.8 settings', () => {
    const extensionSettings: Record<string, unknown> = {
      story_echo: {
        version: 3,
        recentWindow: { size: 12, unit: 'turns' },
        summary: {
          enabled: true,
          automatic: true,
          targetTurnsPerUpdate: 8,
          maxTokens: 2_048,
        },
      },
    };
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ extensionSettings, saveSettingsDebounced: vi.fn() }),
    });

    expect(new SettingsRepository().get()).toMatchObject({
      version: 6,
      recentWindow: { size: 12, unit: 'turns' },
      summary: {
        enabled: true,
        automatic: true,
        targetTurnsPerUpdate: 8,
        windowSize: 4,
        maxTokens: 2_048,
      },
    });
  });

  it('moves the old default recall count from five to three without overriding custom counts', () => {
    const extensionSettings: Record<string, unknown> = {
      story_echo: {
        version: 4,
        recall: { maxEvents: 5 },
      },
    };
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ extensionSettings, saveSettingsDebounced: vi.fn() }),
    });

    expect(new SettingsRepository().get()).toMatchObject({
      version: 6,
      recall: { maxEvents: 3 },
    });

    extensionSettings['story_echo'] = {
      version: 4,
      recall: { maxEvents: 7 },
    };
    expect(new SettingsRepository().get().recall.maxEvents).toBe(7);
  });

  it('adds the controlled extraction reference defaults without overriding existing extraction settings', () => {
    const extensionSettings: Record<string, unknown> = {
      story_echo: {
        version: 5,
        extraction: { automatic: false, targetTurnsPerChunk: 8 },
      },
    };
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ extensionSettings, saveSettingsDebounced: vi.fn() }),
    });

    expect(new SettingsRepository().get()).toMatchObject({
      version: 6,
      extraction: {
        automatic: false,
        targetTurnsPerChunk: 8,
        reference: {
          mode: 'character-world-info',
          maxTokens: 3_000,
          maxWorldInfoEntries: 5,
        },
      },
    });
  });
});
