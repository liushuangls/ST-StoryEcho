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
    });

    expect(extensionSettings['story_echo']).toMatchObject({
      llm: { custom: { apiKey: 'llm-secret' } },
      vector: { custom: { apiKey: 'embedding-secret' } },
    });
    expect(saveSettingsDebounced).toHaveBeenCalledOnce();

    expect(new SettingsRepository().get()).toMatchObject({
      llm: { custom: { apiKey: 'llm-secret' } },
      vector: { custom: { apiKey: 'embedding-secret' } },
    });
  });
});
