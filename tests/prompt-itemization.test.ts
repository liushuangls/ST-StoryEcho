import { describe, expect, it, vi } from 'vitest';
import { PromptItemizationService } from '../src/prompt/itemization';
import type { SillyTavernContext } from '../src/platform/sillytavern';

function context(overrides: Partial<SillyTavernContext> = {}): SillyTavernContext {
  return {
    chat: Array.from({ length: 5 }, (_, index) => ({
      is_user: index % 2 === 1,
      mes: `message-${index}`,
      ...(index === 4 ? { extra: { model: 'deepseek-v4-flash', api: 'custom' } } : {}),
    })),
    chatId: 'chat-id',
    extensionSettings: {},
    chatMetadata: {},
    saveSettingsDebounced: vi.fn(),
    saveMetadata: vi.fn(async () => undefined),
    generateRaw: vi.fn(async () => ''),
    getTokenCountAsync: vi.fn(async (text: string) => text.trim().length),
    ...overrides,
  };
}

function tokenSum(value: Awaited<ReturnType<PromptItemizationService['latest']>>): number {
  return value?.categories.reduce((total, category) => total + category.tokens, 0) ?? 0;
}

describe('latest SillyTavern prompt itemization', () => {
  it('uses the latest completed chat message and separates StoryEcho payloads', async () => {
    const skeleton = '<story_echo_skeleton>SKELETON</story_echo_skeleton>';
    const summary = '<story_echo_summary>SUM</story_echo_summary>';
    const state = '<story_echo_current_state>STATE</story_echo_current_state>';
    const recall = '<story_echo_recall>RECALL</story_echo_recall>';
    const record = {
      mesId: 4,
      main_api: 'openai',
      tokenizer: 'DeepSeek tokenizer',
      presetName: 'default',
      rawPrompt: [
        { role: 'system', content: skeleton },
        { role: 'system', content: summary },
        { role: 'system', content: state },
        { role: 'system', content: recall },
        { role: 'user', content: 'continue' },
      ],
      charDescription: 'character description',
      charPersonality: 'character personality',
      scenarioText: 'scenario',
      userPersona: 'persona',
      worldInfoString: 'world information',
      examplesString: 'example dialogue',
      allAnchors: '',
      oaiStartTokens: 80,
      oaiMainTokens: 70,
      oaiPromptTokens: 300,
      oaiExamplesTokens: 50,
      oaiConversationTokens: 500,
      oaiTotalTokens: 1_000,
    };
    const pendingStoppedRequest = { ...record, mesId: 5, rawPrompt: 'must not be selected' };
    const service = new PromptItemizationService(async () => ({
      itemizedPrompts: [record, pendingStoppedRequest],
    }));

    const result = await service.latest(context());

    expect(result).not.toBeNull();
    expect(result?.messageId).toBe(4);
    expect(result?.totalTokens).toBe(1_000);
    expect(tokenSum(result)).toBe(1_000);
    expect(result?.storyEcho.summaryTokens).toBe(`${skeleton}\n${summary}`.length);
    expect(result?.storyEcho.currentStateTokens).toBe(state.length);
    expect(result?.storyEcho.recallTokens).toBe(recall.length);
    expect(result?.storyEcho.metadataTokens).toBe(state.length + recall.length);
    expect(result?.storyEcho.contextTokens).toBe(
      500 - `${skeleton}\n${summary}`.length - state.length - recall.length,
    );
    expect(result?.model).toBe('deepseek-v4-flash');
    expect(result?.tokenizer).toBe('DeepSeek tokenizer');
    expect(result?.preset).toBe('default');
    expect(result?.detailed).toBe(true);
  });

  it('reuses in-flight and completed tokenization while the latest prompt is unchanged', async () => {
    const prompt = [{ role: 'user', content: 'hello' }];
    const itemizedPrompts = [{
      mesId: 4,
      main_api: 'openai',
      rawPrompt: prompt,
      oaiConversationTokens: 10,
      oaiTotalTokens: 10,
    }];
    const tokenCounter = vi.fn(async (text: string) => text.trim().length);
    const service = new PromptItemizationService(async () => ({ itemizedPrompts }));
    const tavernContext = context({ getTokenCountAsync: tokenCounter });

    await Promise.all([
      service.latest(tavernContext),
      service.latest(tavernContext),
    ]);
    const callsAfterFirstRead = tokenCounter.mock.calls.length;
    await service.latest(tavernContext);

    expect(callsAfterFirstRead).toBeGreaterThan(0);
    expect(tokenCounter).toHaveBeenCalledTimes(callsAfterFirstRead);
  });

  it('falls back to visible tagged text without pretending it can split recent chat', async () => {
    const summary = '<story_echo_summary>older plot</story_echo_summary>';
    const rawPrompt = [{ role: 'system', content: summary }, { role: 'user', content: 'go on' }];
    const service = new PromptItemizationService(async () => ({
      itemizedPrompts: [{ mesId: 4, main_api: 'openai', rawPrompt }],
    }));

    const result = await service.latest(context());

    expect(result?.detailed).toBe(false);
    expect(result?.estimated).toBe(true);
    expect(result?.storyEcho.contextTokens).toBeNull();
    expect(result?.storyEcho.summaryTokens).toBe(summary.length);
    expect(tokenSum(result)).toBe(result?.totalTokens);
  });

  it('derives a separable recent-context bucket for text completion prompts', async () => {
    const summary = '<story_echo_summary>older</story_echo_summary>';
    const storyString = 'character and world';
    const examplesString = 'example';
    const mesSendString = `${summary}\nrecent dialogue`;
    const service = new PromptItemizationService(async () => ({
      itemizedPrompts: [{
        mesId: 4,
        main_api: 'textgenerationwebui',
        rawPrompt: `${storyString}${examplesString}${mesSendString}`,
        storyString,
        examplesString,
        mesSendString,
        charDescription: 'character',
        worldInfoString: 'world',
      }],
    }));

    const result = await service.latest(context());

    expect(result?.detailed).toBe(true);
    expect(result?.storyEcho.contextTokens).not.toBeNull();
    expect(result?.storyEcho.contextTokens).toBeGreaterThan(0);
    expect(result?.storyEcho.summaryTokens).toBeGreaterThan(0);
    expect(tokenSum(result)).toBe(result?.totalTokens);
  });

  it('returns no card data before a completed request exists', async () => {
    const service = new PromptItemizationService(async () => ({ itemizedPrompts: [] }));
    await expect(service.latest(context())).resolves.toBeNull();
  });
});
