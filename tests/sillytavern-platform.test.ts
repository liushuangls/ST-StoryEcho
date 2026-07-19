import { describe, expect, it, vi } from 'vitest';
import {
  getMainConnectionIdentity,
  type SillyTavernContext,
} from '../src/platform/sillytavern';

function context(overrides: Partial<SillyTavernContext>): SillyTavernContext {
  return {
    chat: [],
    extensionSettings: {},
    chatMetadata: {},
    saveSettingsDebounced: vi.fn(),
    saveMetadata: vi.fn(async () => undefined),
    generateRaw: vi.fn(async () => ''),
    ...overrides,
  };
}

describe('SillyTavern main connection identity', () => {
  it('uses the public model resolver exposed by SillyTavern 1.18', () => {
    const getChatCompletionModel = vi.fn(() => 'deepseek-v4-flash');
    const value = getMainConnectionIdentity(context({
      mainApi: 'openai',
      chatCompletionSettings: {
        chat_completion_source: 'deepseek',
        deepseek_model: 'stale-value',
      },
      getChatCompletionModel,
    }));

    expect(value).toEqual({
      mainApi: 'openai',
      source: 'deepseek',
      model: 'deepseek-v4-flash',
    });
    expect(getChatCompletionModel).toHaveBeenCalled();
  });

  it('falls back to the source-specific model field on older compatible builds', () => {
    expect(getMainConnectionIdentity(context({
      mainApi: 'openai',
      chatCompletionSettings: {
        chat_completion_source: 'custom',
        custom_model: 'provider/deepseek-v4-pro',
      },
    }))).toEqual({
      mainApi: 'openai',
      source: 'custom',
      model: 'provider/deepseek-v4-pro',
    });
  });

  it('does not guess a chat-completion model for text-completion APIs', () => {
    expect(getMainConnectionIdentity(context({
      mainApi: 'textgenerationwebui',
      textCompletionSettings: { custom_model: 'unknown-shape' },
    }))).toEqual({
      mainApi: 'textgenerationwebui',
      source: '',
      model: '',
    });
  });
});
