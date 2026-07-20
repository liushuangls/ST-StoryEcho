import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsRepository } from '../src/settings/repository';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SettingsRepository credential persistence', () => {
  it('starts new installs in LLM-only mode with summaries always active', () => {
    const extensionSettings: Record<string, unknown> = {};
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ extensionSettings, saveSettingsDebounced: vi.fn() }),
    });

    expect(new SettingsRepository().get()).toMatchObject({
      version: 8,
      enabled: false,
      memory: { enabled: false },
      summary: { enabled: true, automatic: true },
      extraction: { automatic: false },
    });
  });

  it('maps the memory switch onto legacy fields without exposing extra feature switches', () => {
    const extensionSettings: Record<string, unknown> = {};
    const saveSettingsDebounced = vi.fn();
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ extensionSettings, saveSettingsDebounced }),
    });
    const repository = new SettingsRepository();

    const enabled = repository.update((settings) => {
      settings.memory.enabled = true;
    });
    expect(enabled).toMatchObject({
      memory: { enabled: true },
      summary: { enabled: true, automatic: true },
      extraction: { automatic: true },
    });

    const disabled = repository.update((settings) => {
      settings.memory.enabled = false;
    });
    expect(disabled).toMatchObject({
      memory: { enabled: false },
      summary: { enabled: true, automatic: true },
      extraction: { automatic: false },
    });
    expect(saveSettingsDebounced).toHaveBeenCalledTimes(2);
  });

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

  it('round-trips every user-editable setting without silently replacing values', () => {
    const extensionSettings: Record<string, unknown> = {};
    const saveSettingsDebounced = vi.fn();
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ extensionSettings, saveSettingsDebounced }),
    });
    const repository = new SettingsRepository();

    const written = repository.update((settings) => {
      settings.enabled = true;
      settings.memory.enabled = true;
      settings.debug = true;
      settings.recentWindow = { size: 37, unit: 'messages' };
      settings.summary = {
        enabled: true,
        automatic: true,
        targetTurnsPerUpdate: 7,
        windowSize: 9,
        maxTokens: 2_304,
        skeletonMaxTokens: 7_500,
      };
      settings.recall = {
        maxEvents: 11,
        maxTokens: 4_500,
        scoreThreshold: 0.41,
        queryMode: 'local',
      };
      settings.extraction = {
        automatic: true,
        targetTurnsPerChunk: 3,
        reference: {
          mode: 'character',
          maxTokens: 2_700,
          maxWorldInfoEntries: 8,
        },
      };
      settings.llm = {
        provider: 'openai-compatible',
        custom: {
          baseUrl: 'http://sub2api:8080/v1',
          model: 'deepseek-v4-flash',
          apiKey: 'llm-key',
          timeoutMs: 75_000,
          allowInsecureHttp: true,
          fallbackToMain: false,
          strictJsonSchema: true,
        },
      };
      settings.vector = {
        source: 'volcengine-multimodal',
        model: 'inherited-model',
        custom: {
          baseUrl: 'http://embedding:8080/v1',
          model: 'custom-embedding',
          apiKey: 'embedding-key',
          timeoutMs: 76_000,
          allowInsecureHttp: true,
        },
        volcengine: {
          baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
          model: 'ep-m-test',
          apiKey: 'ark-key',
          timeoutMs: 77_000,
          allowInsecureHttp: false,
        },
      };
    });

    expect(written.extraction.targetTurnsPerChunk).toBe(3);
    expect(repository.get()).toEqual(written);
    expect(saveSettingsDebounced).toHaveBeenCalledOnce();
  });

  it('normalizes corrupted or out-of-range persisted values before services consume them', () => {
    const extensionSettings: Record<string, unknown> = {
      story_echo: {
        version: 6,
        recentWindow: { size: -12, unit: 'floors' },
        summary: {
          targetTurnsPerUpdate: 0,
          windowSize: 999,
          maxTokens: 12,
          skeletonMaxTokens: 99_999,
        },
        recall: {
          maxEvents: 999,
          maxTokens: -1,
          scoreThreshold: 9,
          queryMode: 'magic',
        },
        extraction: {
          targetTurnsPerChunk: 99,
          reference: {
            mode: 'everything',
            maxTokens: 1,
            maxWorldInfoEntries: 99,
          },
        },
        llm: {
          provider: 'unknown',
          custom: {
            baseUrl: '  https://example.com/v1  ',
            model: '  model-name  ',
            timeoutMs: 1,
          },
        },
        vector: {
          source: '   ',
          model: '  inherited  ',
          custom: { timeoutMs: 999_999 },
          volcengine: { timeoutMs: 0 },
        },
      },
    };
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ extensionSettings, saveSettingsDebounced: vi.fn() }),
    });

    const settings = new SettingsRepository().get();

    expect(settings).toMatchObject({
      recentWindow: { size: 0, unit: 'turns' },
      summary: {
        targetTurnsPerUpdate: 1,
        windowSize: 100,
        maxTokens: 128,
        skeletonMaxTokens: 10_000,
      },
      recall: { maxEvents: 50, maxTokens: 0, scoreThreshold: 1, queryMode: 'llm' },
      extraction: {
        targetTurnsPerChunk: 20,
        reference: {
          mode: 'character-world-info',
          maxTokens: 256,
          maxWorldInfoEntries: 20,
        },
      },
      llm: {
        provider: 'main',
        custom: {
          baseUrl: 'https://example.com/v1',
          model: 'model-name',
          timeoutMs: 1_000,
        },
      },
      vector: {
        source: 'inherit',
        model: 'inherited',
        custom: { timeoutMs: 300_000 },
        volcengine: { timeoutMs: 1_000 },
      },
    });
  });

  it('normalizes edits before saving so UI and background services share one effective value', () => {
    const extensionSettings: Record<string, unknown> = {};
    const saveSettingsDebounced = vi.fn();
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ extensionSettings, saveSettingsDebounced }),
    });

    const settings = new SettingsRepository().update((current) => {
      current.extraction.targetTurnsPerChunk = 3.9;
      current.recall.scoreThreshold = -2;
      current.summary.maxTokens = 99_999;
      current.summary.skeletonMaxTokens = 511;
    });

    expect(settings.extraction.targetTurnsPerChunk).toBe(3);
    expect(settings.recall.scoreThreshold).toBe(0);
    expect(settings.summary.maxTokens).toBe(8_192);
    expect(settings.summary.skeletonMaxTokens).toBe(512);
    expect(extensionSettings['story_echo']).toBe(settings);
    expect(saveSettingsDebounced).toHaveBeenCalledOnce();
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
      version: 8,
      memory: { enabled: true },
      extraction: { automatic: true, targetTurnsPerChunk: 5 },
      summary: {
        enabled: true,
        automatic: true,
        targetTurnsPerUpdate: 10,
        windowSize: 4,
        maxTokens: 1_600,
        skeletonMaxTokens: 5_000,
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
      version: 8,
      memory: { enabled: true },
      recentWindow: { size: 12, unit: 'turns' },
      summary: {
        enabled: true,
        automatic: true,
        targetTurnsPerUpdate: 8,
        windowSize: 4,
        maxTokens: 2_048,
        skeletonMaxTokens: 5_000,
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
      version: 8,
      memory: { enabled: true },
      recall: { maxEvents: 3 },
    });

    extensionSettings['story_echo'] = {
      version: 4,
      recall: { maxEvents: 7 },
    };
    expect(new SettingsRepository().get().recall.maxEvents).toBe(7);
  });

  it('adds extraction reference defaults and preserves effective legacy recall behavior', () => {
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
      version: 8,
      memory: { enabled: true },
      extraction: {
        automatic: true,
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
