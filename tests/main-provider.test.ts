import { afterEach, describe, expect, it, vi } from 'vitest';
import { MainLlmProvider, tuneInternalGenerationSettings } from '../src/llm/main-provider';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MainLlmProvider', () => {
  it('uses a bounded SillyTavern response length for internal tasks', async () => {
    const generateRaw = vi.fn().mockResolvedValue('{"query":"银钥匙位置"}');
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ generateRaw }),
    });

    await new MainLlmProvider().complete({
      system: 'system',
      prompt: 'prompt',
      jsonSchema: { type: 'object' },
      maxTokens: 320,
    });

    expect(generateRaw).toHaveBeenCalledWith({
      systemPrompt: 'system',
      prompt: 'prompt',
      responseLength: 320,
    });
  });

  it('gives reasoning models enough room to finish the connection test', async () => {
    const generateRaw = vi.fn().mockResolvedValue('OK');
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ generateRaw }),
    });

    await new MainLlmProvider().testConnection();

    expect(generateRaw).toHaveBeenCalledWith(expect.objectContaining({ responseLength: 128 }));
  });

  it('temporarily lowers main-connection reasoning for background work', async () => {
    let handler: ((settings: unknown) => void) | undefined;
    const eventSource = {
      on: vi.fn((_event: string, next: (settings: unknown) => void) => {
        handler = next;
      }),
      off: vi.fn(),
    };
    const generateRaw = vi.fn(async () => {
      const settings = {
        reasoning_effort: 'max',
        thinking: { type: 'enabled', budget_tokens: 8_000 },
        enable_thinking: true,
        temperature: 1.1,
        top_p: 0.85,
      };
      handler?.(settings);
      expect(settings).toEqual({
        reasoning_effort: 'low',
        thinking: { type: 'disabled', budget_tokens: 8_000 },
        enable_thinking: false,
        temperature: 0,
        top_p: 1,
      });
      return '{"memories":[]}';
    });
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({
        generateRaw,
        eventSource,
        event_types: { CHAT_COMPLETION_SETTINGS_READY: 'settings-ready' },
      }),
    });

    await new MainLlmProvider().complete({ system: 'system', prompt: 'prompt' });

    expect(eventSource.on).toHaveBeenCalledWith('settings-ready', expect.any(Function));
    expect(eventSource.off).toHaveBeenCalledWith('settings-ready', expect.any(Function));
  });

  it('uses deterministic sampling even when reasoning controls are absent', () => {
    const settings = { temperature: 0.4 };
    tuneInternalGenerationSettings(settings);
    expect(settings).toEqual({ temperature: 0 });
  });
});
