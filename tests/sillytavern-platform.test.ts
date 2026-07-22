import { describe, expect, it, vi } from 'vitest';
import {
  getMainConnectionIdentity,
  showConfirmation,
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

describe('SillyTavern confirmation popup', () => {
  it('uses the in-app Popup API and accepts only the affirmative result', async () => {
    const confirm = vi.fn(async () => 1);
    const popupContext = context({
      Popup: { show: { confirm } },
      POPUP_RESULT: {
        AFFIRMATIVE: 1,
        NEGATIVE: 0,
        CANCELLED: null,
      },
    });

    await expect(showConfirmation('重新生成骨架', '确定继续吗？', popupContext))
      .resolves.toBe(true);
    expect(confirm).toHaveBeenCalledWith(
      '重新生成骨架',
      '确定继续吗？',
      { leftAlign: true },
    );

    confirm.mockResolvedValueOnce(0);
    await expect(showConfirmation('重新生成骨架', '确定继续吗？', popupContext))
      .resolves.toBe(false);

    confirm.mockResolvedValueOnce(1);
    await showConfirmation('<删除记忆>', '第一行\n\n<script>', popupContext);
    expect(confirm).toHaveBeenLastCalledWith(
      '&lt;删除记忆&gt;',
      '第一行<br><br>&lt;script&gt;',
      { leftAlign: true },
    );
  });

  it('falls back to the browser confirmation on older compatible builds', async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    try {
      await expect(showConfirmation('删除阶段总结', '确定删除吗？', context({})))
        .resolves.toBe(true);
      expect(confirm).toHaveBeenCalledWith('删除阶段总结\n\n确定删除吗？');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
