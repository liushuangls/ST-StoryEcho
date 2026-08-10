import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODULE_ID } from '../src/core/constants';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { SettingsRepository } from '../src/settings/repository';

function installContext(initial?: unknown): {
  extensionSettings: Record<string, unknown>;
  saveSettingsDebounced: ReturnType<typeof vi.fn>;
} {
  const extensionSettings: Record<string, unknown> = {};
  if (initial !== undefined) {
    extensionSettings[MODULE_ID] = initial;
  }
  const saveSettingsDebounced = vi.fn();
  vi.stubGlobal('SillyTavern', {
    getContext: () => ({ extensionSettings, saveSettingsDebounced }),
  });
  return { extensionSettings, saveSettingsDebounced };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SettingsRepository', () => {
  it('starts with one disabled context-management feature', () => {
    installContext();
    expect(new SettingsRepository().get()).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.summary.reference.maxWorldInfoEntries).toBe(20);
  });

  it('persists context settings and the only remaining API credential', () => {
    const { extensionSettings, saveSettingsDebounced } = installContext();
    const repository = new SettingsRepository();
    repository.update((settings) => {
      settings.enabled = true;
      settings.recentWindow.size = 12;
      settings.summary.targetTurnsPerUpdate = 8;
      settings.llm.custom.apiKey = 'llm-secret';
    });

    expect(extensionSettings[MODULE_ID]).toMatchObject({
      version: 12,
      enabled: true,
      recentWindow: { size: 12 },
      summary: { targetTurnsPerUpdate: 8 },
      llm: { custom: { apiKey: 'llm-secret' } },
    });
    expect(saveSettingsDebounced).toHaveBeenCalledOnce();
  });

  it('migrates the old world-book policy and drops obsolete feature fields', () => {
    const { extensionSettings } = installContext({
      version: 9,
      enabled: true,
      memory: { enabled: false },
      recall: { maxEvents: 8 },
      extraction: {
        reference: {
          mode: 'character-world-info',
          maxWorldInfoEntries: 13,
        },
      },
      vector: {
        custom: { apiKey: 'unused-embedding-secret' },
      },
    });

    const settings = new SettingsRepository().get();
    expect(settings.summary.reference).toEqual({
      enabled: true,
      maxWorldInfoEntries: 13,
    });
    expect(settings).not.toHaveProperty('memory');
    expect(settings).not.toHaveProperty('recall');
    expect(settings).not.toHaveProperty('extraction');
    expect(settings).not.toHaveProperty('vector');
    expect(JSON.stringify(extensionSettings[MODULE_ID])).not.toContain('unused-embedding-secret');
  });

  it('normalizes out-of-range and invalid stored values', () => {
    installContext({
      version: 10,
      recentWindow: { size: -4, unit: 'invalid' },
      summary: {
        targetTurnsPerUpdate: 999,
        windowSize: 0,
        maxTokens: 1,
        skeletonMaxTokens: 99_999,
        reference: { enabled: true, maxWorldInfoEntries: 999 },
      },
      llm: {
        provider: 'unknown',
        custom: {
          baseUrl: '  https://example.com/v1  ',
          model: '  model-a  ',
          timeoutMs: 2,
        },
      },
    });
    const settings = new SettingsRepository().get();

    expect(settings.recentWindow).toEqual({ size: 0, unit: 'turns' });
    expect(settings.summary).toMatchObject({
      targetTurnsPerUpdate: 100,
      level1EntriesPerGroup: 2,
      higherLevelEntriesPerGroup: 5,
      level1MaxTokens: 128,
      higherLevelMaxTokens: 16_000,
      reference: { maxWorldInfoEntries: 100 },
    });
    expect(settings.llm.provider).toBe('main');
    expect(settings.llm.custom).toMatchObject({
      baseUrl: 'https://example.com/v1',
      model: 'model-a',
      timeoutMs: 1_000,
    });
  });

  it('resets settings to a fresh default object', () => {
    const { extensionSettings, saveSettingsDebounced } = installContext({ enabled: true });
    const reset = new SettingsRepository().reset();
    expect(reset).toEqual(DEFAULT_SETTINGS);
    expect(extensionSettings[MODULE_ID]).toEqual(DEFAULT_SETTINGS);
    expect(saveSettingsDebounced).toHaveBeenCalledOnce();
  });
});
