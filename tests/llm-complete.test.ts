import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoryEchoSettings } from '../src/core/types';
import {
  completeWithConfiguredProvider,
  completeWithConfiguredProviderDetailed,
  MAX_LLM_TIMEOUT_RETRIES,
} from '../src/llm/complete';
import { LlmRequestTimeoutError } from '../src/llm/errors';
import { isInternalGeneration } from '../src/llm/internal-generation';
import { storyEchoTaskCoordinator } from '../src/runtime/task-coordinator';
import { StoryEchoTaskCancelledError } from '../src/runtime/task-cancellation';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { STAGE_SUMMARY_SYSTEM_PROMPT } from '../src/summary/prompts';
import { GEMINI_L1_DELIVERY_GUIDANCE } from '../src/summary/model-prompts';

afterEach(() => {
  storyEchoTaskCoordinator.resetForTests();
  vi.unstubAllGlobals();
});

describe('completeWithConfiguredProvider', () => {
  it.each([
    ['gemini-3.8-flash', 'deepseek-v4-flash', false],
    ['deepseek-v4-flash', 'gemini-3.8-flash', true],
  ])('selects the actual receiving model profile on fallback from %s to %s', async (customModel, mainModel, geminiMain) => {
    const settings: StoryEchoSettings = structuredClone(DEFAULT_SETTINGS);
    settings.llm.provider = 'openai-compatible';
    settings.llm.custom.baseUrl = 'https://example.com/v1';
    settings.llm.custom.model = customModel;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'test custom connection failure' },
    }), { status: 400 }));
    const generateRaw = vi.fn().mockResolvedValue('主连接总结');
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({
        mainApi: 'openai', generateRaw,
        chatCompletionSettings: { chat_completion_source: 'custom', custom_model: mainModel },
        getRequestHeaders: () => ({}),
      }),
    });

    await expect(completeWithConfiguredProviderDetailed(settings, {
      system: STAGE_SUMMARY_SYSTEM_PROMPT, prompt: '原始剧情', summaryLevel: 1, maxTokens: 3_000,
    })).resolves.toMatchObject({ text: '主连接总结', metadata: { fallbackFrom: 'openai-compatible' } });
    const options = generateRaw.mock.calls[0]?.[0];
    expect(options.prompt.includes(GEMINI_L1_DELIVERY_GUIDANCE)).toBe(geminiMain);
    expect(options.systemPrompt).not.toContain('主动追求高压缩率');
    expect(options.systemPrompt).toContain('优先完整覆盖独有重要事实');
    expect(options.responseLength).toBe(3_000);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(generateRaw).toHaveBeenCalledOnce();
  });

  it.each([
    { promptFeedback: { blockReason: 'SAFETY' } },
    { choices: [{ message: { content: '', refusal: 'private refusal body' } }] },
  ])('does not retry an explicit block as an empty response: %j', async (payload) => {
    const generateRawData = vi.fn().mockResolvedValue(payload);
    const extractMessageFromData = vi.fn().mockReturnValue('');
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({
        generateRaw: vi.fn(), generateRawData, extractMessageFromData,
      }),
    });

    await expect(completeWithConfiguredProviderDetailed(DEFAULT_SETTINGS, {
      system: 'system', prompt: 'prompt', maxTokens: 3_000,
    })).rejects.toThrow('内容过滤');
    expect(generateRawData).toHaveBeenCalledOnce();
    expect(extractMessageFromData).not.toHaveBeenCalled();
  });

  it('releases a hanging main-provider background request for foreground generation', async () => {
    const generateRaw = vi.fn(() => new Promise<string>(() => undefined));
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ generateRaw }),
    });

    const background = storyEchoTaskCoordinator.enqueueBackground(
      'hanging summary',
      () => completeWithConfiguredProvider(DEFAULT_SETTINGS, {
        system: 'system',
        prompt: 'prompt',
      }),
    );
    const backgroundOutcome = background.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(generateRaw).toHaveBeenCalledOnce());

    const foreground = storyEchoTaskCoordinator.enqueueForeground(
      'new branch generation',
      async () => false,
      { holdForegroundLease: (prepared) => prepared },
    );

    expect(await backgroundOutcome).toBeInstanceOf(StoryEchoTaskCancelledError);
    await foreground;
    expect(isInternalGeneration()).toBe(false);
    expect(storyEchoTaskCoordinator.snapshot().runningKind).toBeNull();
  });

  it('retries one empty internal response with a larger bounded budget', async () => {
    const generateRaw = vi.fn()
      .mockResolvedValueOnce('  ')
      .mockResolvedValueOnce('{"query":"银钥匙位置"}');
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ generateRaw }),
    });

    const response = await completeWithConfiguredProvider(DEFAULT_SETTINGS, {
      system: 'system',
      prompt: 'prompt',
      maxTokens: 320,
    });

    expect(response).toBe('{"query":"银钥匙位置"}');
    expect(generateRaw).toHaveBeenNthCalledWith(1, expect.objectContaining({ responseLength: 320 }));
    expect(generateRaw).toHaveBeenNthCalledWith(2, expect.objectContaining({ responseLength: 640 }));
  });

  it('retries an empty detailed response and keeps metadata from the accepted attempt', async () => {
    const generateRawData = vi.fn()
      .mockResolvedValueOnce({
        choices: [{ finish_reason: 'stop', message: { content: '  ' } }],
      })
      .mockResolvedValueOnce({
        choices: [{ finish_reason: 'length', message: { content: '可见总结' } }],
        usage: { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 },
      });
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({
        generateRaw: vi.fn(),
        generateRawData,
        extractMessageFromData: (payload: {
          choices: Array<{ message: { content: string } }>;
        }) => payload.choices[0]?.message.content ?? '',
        mainApi: 'openai',
      }),
    });

    const result = await completeWithConfiguredProviderDetailed(DEFAULT_SETTINGS, {
      system: 'system',
      prompt: 'prompt',
      maxTokens: 320,
    });

    expect(generateRawData).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ responseLength: 320 }),
    );
    expect(generateRawData).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ responseLength: 640 }),
    );
    expect(result).toMatchObject({
      text: '可见总结',
      metadata: {
        provider: 'main',
        requestedMaxTokens: 640,
        finishReason: 'length',
        promptTokens: 200,
        completionTokens: 40,
        totalTokens: 240,
        responseCharacters: 4,
      },
    });
  });

  it('stops after one retry when the provider remains empty', async () => {
    const generateRaw = vi.fn().mockResolvedValue('');
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ generateRaw }),
    });

    await expect(completeWithConfiguredProvider(DEFAULT_SETTINGS, {
      system: 'system',
      prompt: 'prompt',
      maxTokens: 8_192,
    })).rejects.toThrow(/连续两次返回空内容/);
    expect(generateRaw).toHaveBeenCalledTimes(2);
    expect(generateRaw).toHaveBeenLastCalledWith(expect.objectContaining({ responseLength: 16_000 }));
  });

  it('retries only the current LLM request after a timeout', async () => {
    const generateRaw = vi.fn()
      .mockRejectedValueOnce(new LlmRequestTimeoutError(300_000))
      .mockResolvedValueOnce('当前批次重试成功');
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ generateRaw }),
    });

    await expect(completeWithConfiguredProvider(DEFAULT_SETTINGS, {
      system: 'same-system',
      prompt: 'same-current-batch',
      maxTokens: 1_600,
    })).resolves.toBe('当前批次重试成功');

    expect(MAX_LLM_TIMEOUT_RETRIES).toBe(1);
    expect(generateRaw).toHaveBeenCalledTimes(2);
    for (const [options] of generateRaw.mock.calls) {
      expect(options).toMatchObject({ responseLength: 1_600 });
      expect(options.systemPrompt).toContain('same-system');
      expect(options.prompt).toContain('same-current-batch');
    }
  });

  it('stops the current operation after its bounded timeout retry also fails', async () => {
    const generateRaw = vi.fn().mockRejectedValue(new LlmRequestTimeoutError(300_000));
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ generateRaw }),
    });

    await expect(completeWithConfiguredProvider(DEFAULT_SETTINGS, {
      system: 'system',
      prompt: 'current-batch',
    })).rejects.toThrow(/300000ms/);
    expect(generateRaw).toHaveBeenCalledTimes(2);
  });

  it('preserves both the first timeout and the retry failure', async () => {
    const generateRaw = vi.fn()
      .mockRejectedValueOnce(new LlmRequestTimeoutError(300_000))
      .mockRejectedValueOnce(new Error('主连接流式请求返回了错误。'));
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ generateRaw }),
    });

    const error = await completeWithConfiguredProvider(DEFAULT_SETTINGS, {
      system: 'system',
      prompt: 'current-batch',
    }).then(() => null, (reason: unknown) => reason);

    expect(error).toMatchObject({
      attemptErrors: [
        'LLM请求超时（300000ms）。',
        '主连接流式请求返回了错误。',
      ],
    });
    expect(error).toHaveProperty(
      'message',
      expect.stringContaining('当前批次重试失败'),
    );
  });
});
