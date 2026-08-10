import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmRequestTimeoutError } from '../src/llm/errors';
import { MainLlmProvider } from '../src/llm/main-provider';
import type { MainStreamingRuntime } from '../src/llm/main-streaming';

function eventStream(frames: string[], splitAt: number[] = []): Response {
  const bytes = new TextEncoder().encode(frames.join(''));
  const boundaries = [...splitAt, bytes.byteLength]
    .filter((value, index, values) => value > 0 && value <= bytes.byteLength
      && (index === 0 || value > values[index - 1]!));
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      let start = 0;
      for (const end of boundaries) {
        controller.enqueue(bytes.slice(start, end));
        start = end;
      }
      controller.close();
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function openEventStream(frames: string[], onCancel: () => void): Response {
  const bytes = new TextEncoder().encode(frames.join(''));
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
    },
    cancel() {
      onCancel();
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function sse(data: unknown): string {
  return `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
}

function streamingRuntime(): MainStreamingRuntime {
  return {
    createGenerationParameters: vi.fn(async (
      settings: Record<string, unknown>,
      model: string,
      type: string,
      messages: Array<Record<string, unknown>>,
    ) => ({
      generate_data: {
        messages,
        model,
        type,
        max_tokens: settings['openai_max_tokens'],
        chat_completion_source: settings['chat_completion_source'],
        custom_api_format: settings['custom_api_format'],
        stream: false,
        temperature: 1,
        top_p: 0.8,
        include_reasoning: true,
        reasoning_effort: 'high',
        enable_thinking: true,
      },
    })),
    getStreamingReply: vi.fn((data: unknown) => {
      const root = data as {
        delta?: { text?: string };
        choices?: Array<{ delta?: { content?: string } }>;
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string; thought?: boolean }> };
        }>;
      };
      const geminiText = root.candidates?.[0]?.content?.parts
        ?.filter((part) => !part.thought && part.text)
        .map((part) => part.text)
        .join('\n\n');
      return root.delta?.text ?? root.choices?.[0]?.delta?.content ?? geminiText ?? '';
    }),
  };
}

function installStreamingContext(
  source: string,
  model: string,
  overrides: Record<string, unknown> = {},
): {
  generateRaw: ReturnType<typeof vi.fn>;
  generateRawData: ReturnType<typeof vi.fn>;
  emitted: Array<{ event: string; data: unknown }>;
  settings: Record<string, unknown>;
} {
  const handlers = new Map<string, Set<(...args: unknown[]) => void | Promise<void>>>();
  const emitted: Array<{ event: string; data: unknown }> = [];
  const settings: Record<string, unknown> = {
    chat_completion_source: source,
    [`${source}_model`]: model,
    openai_max_tokens: 777,
    ...overrides,
  };
  const generateRaw = vi.fn();
  const generateRawData = vi.fn();
  const eventSource = {
    on(event: string, handler: (...args: unknown[]) => void | Promise<void>) {
      const current = handlers.get(event) ?? new Set();
      current.add(handler);
      handlers.set(event, current);
    },
    off(event: string, handler: (...args: unknown[]) => void | Promise<void>) {
      handlers.get(event)?.delete(handler);
    },
    async emit(event: string, data: unknown) {
      emitted.push({ event, data });
      for (const handler of handlers.get(event) ?? []) {
        await handler(data);
      }
    },
  };
  vi.stubGlobal('SillyTavern', {
    getContext: () => ({
      chat: [],
      extensionSettings: {},
      chatMetadata: {},
      saveSettingsDebounced: vi.fn(),
      saveMetadata: vi.fn(),
      generateRaw,
      generateRawData,
      extractMessageFromData: vi.fn(),
      mainApi: 'openai',
      chatCompletionSettings: settings,
      getChatCompletionModel: () => model,
      substituteParams: (value: string) => value.replaceAll('{{user}}', '测试用户'),
      eventSource,
      eventTypes: {
        CHAT_COMPLETION_PROMPT_READY: 'prompt-ready',
        CHAT_COMPLETION_SETTINGS_READY: 'settings-ready',
        GENERATION_STOPPED: 'generation-stopped',
      },
    }),
  });
  return { generateRaw, generateRawData, emitted, settings };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MainLlmProvider streaming', () => {
  it('streams OpenAI main-connection requests and retains finish/usage metadata', async () => {
    const context = installStreamingContext('openai', 'gpt-stream');
    const runtime = streamingRuntime();
    const response = eventStream([
      sse({
        id: 'chunk-1',
        model: 'gpt-stream',
        choices: [{ index: 0, delta: { content: '阶段' }, finish_reason: null }],
      }),
      sse({
        id: 'chunk-2',
        model: 'gpt-stream',
        choices: [{ index: 0, delta: { content: '总结' }, finish_reason: 'length' }],
        usage: {
          prompt_tokens: 900,
          completion_tokens: 128,
          total_tokens: 1_028,
          completion_tokens_details: { reasoning_tokens: 32 },
        },
      }),
      sse('[DONE]'),
    ], [7, 31, 83]);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
    const provider = new MainLlmProvider(
      fetchMock,
      async () => ({ 'X-CSRF-Token': 'csrf' }),
      async () => runtime,
    );

    await expect(provider.completeDetailed({
      system: 'system {{user}}',
      prompt: 'prompt',
      maxTokens: 3_000,
    })).resolves.toEqual({
      text: '阶段总结',
      metadata: {
        provider: 'main',
        requestedMaxTokens: 3_000,
        finishReason: 'length',
        promptTokens: 900,
        completionTokens: 128,
        reasoningTokens: 32,
        totalTokens: 1_028,
        responseCharacters: 4,
        source: 'openai',
        model: 'gpt-stream',
      },
    });

    expect(context.generateRaw).not.toHaveBeenCalled();
    expect(context.generateRawData).not.toHaveBeenCalled();
    expect(context.settings['openai_max_tokens']).toBe(777);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/backends/chat-completions/generate');
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-CSRF-Token': 'csrf',
    });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      stream: true,
      type: 'quiet',
      max_tokens: 3_000,
      temperature: 0,
      top_p: 1,
      include_reasoning: false,
      reasoning_effort: 'low',
      enable_thinking: false,
    });
    expect(runtime.createGenerationParameters).toHaveBeenCalledWith(
      expect.objectContaining({ openai_max_tokens: 3_000 }),
      'gpt-stream',
      'quiet',
      expect.arrayContaining([
        expect.objectContaining({ role: 'system', content: expect.stringContaining('测试用户') }),
        expect.objectContaining({ role: 'user', content: expect.stringContaining('prompt') }),
      ]),
      { allowToolCalls: false, agentMode: false },
    );
    expect(context.emitted.map(({ event }) => event)).toEqual([
      'prompt-ready',
      'settings-ready',
    ]);
  });

  it('accepts a Claude message_stop terminal marker without requiring [DONE]', async () => {
    installStreamingContext('claude', 'claude-stream');
    const runtime = streamingRuntime();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(eventStream([
      sse({
        type: 'message_start',
        message: { model: 'claude-stream', usage: { input_tokens: 600 } },
      }),
      sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: '完整' } }),
      sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: '总结' } }),
      sse({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 99 } }),
      'event: message_stop\ndata: {}\n\n',
    ], [1, 2, 55, 144]));
    const provider = new MainLlmProvider(fetchMock, async () => ({}), async () => runtime);

    await expect(provider.completeDetailed({
      system: 'system',
      prompt: 'prompt',
      maxTokens: 3_000,
    })).resolves.toEqual({
      text: '完整总结',
      metadata: {
        provider: 'main',
        requestedMaxTokens: 3_000,
        finishReason: 'max_tokens',
        promptTokens: 600,
        completionTokens: 99,
        totalTokens: 699,
        responseCharacters: 4,
        source: 'claude',
        model: 'claude-stream',
      },
    });
  });

  it('finishes a Claude stream at message_stop even when the proxy keeps it open', async () => {
    installStreamingContext('claude', 'claude-stream');
    const runtime = streamingRuntime();
    let cancelled = false;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(openEventStream([
      sse({
        type: 'message_start',
        message: { model: 'claude-stream', usage: { input_tokens: 600 } },
      }),
      sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: '完整总结' } }),
      sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 88 } }),
      'event: message_stop\ndata: {}\n\n',
    ], () => {
      cancelled = true;
    }));
    const provider = new MainLlmProvider(fetchMock, async () => ({}), async () => runtime);
    const abort = new AbortController();
    const completion = provider.completeDetailed({
      system: 'system',
      prompt: 'prompt',
      maxTokens: 3_000,
      signal: abort.signal,
    });
    const pending = Symbol('pending');
    const outcome = await Promise.race([
      completion,
      new Promise<typeof pending>((resolve) => globalThis.setTimeout(() => resolve(pending), 50)),
    ]);
    if (outcome === pending) {
      abort.abort();
      await completion.catch(() => undefined);
    }

    expect(outcome).not.toBe(pending);
    expect(outcome).toMatchObject({
      text: '完整总结',
      metadata: {
        finishReason: 'end_turn',
        promptTokens: 600,
        completionTokens: 88,
      },
    });
    expect(cancelled).toBe(true);
  });

  it('streams native Gemini candidates and retains finish/usage metadata', async () => {
    installStreamingContext('makersuite', 'gemini-2.5-pro');
    const runtime = streamingRuntime();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(eventStream([
      sse({
        candidates: [{
          index: 0,
          content: { parts: [{ text: 'Gemini ' }] },
        }],
      }),
      sse({
        candidates: [{
          index: 0,
          content: {
            parts: [
              { text: '不应进入正文的思考', thought: true },
              { text: '阶段总结' },
            ],
          },
          finishReason: 'STOP',
        }],
        usageMetadata: {
          promptTokenCount: 720,
          candidatesTokenCount: 88,
          thoughtsTokenCount: 12,
          totalTokenCount: 820,
        },
      }),
      sse('[DONE]'),
    ], [3, 71, 163]));
    const provider = new MainLlmProvider(fetchMock, async () => ({}), async () => runtime);

    await expect(provider.completeDetailed({
      system: 'system',
      prompt: 'prompt',
      maxTokens: 3_000,
    })).resolves.toEqual({
      text: 'Gemini 阶段总结',
      metadata: {
        provider: 'main',
        requestedMaxTokens: 3_000,
        finishReason: 'STOP',
        promptTokens: 720,
        completionTokens: 88,
        reasoningTokens: 12,
        totalTokens: 820,
        responseCharacters: 11,
        source: 'makersuite',
        model: 'gemini-2.5-pro',
      },
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      chat_completion_source: 'makersuite',
      model: 'gemini-2.5-pro',
      stream: true,
      type: 'quiet',
    });
    expect(runtime.getStreamingReply).toHaveBeenCalledWith(
      expect.objectContaining({ candidates: expect.any(Array) }),
      expect.any(Object),
      {
        chatCompletionSource: 'makersuite',
        model: 'gemini-2.5-pro',
        overrideShowThoughts: false,
      },
    );
  });

  it('streams custom Gemini Interactions after SillyTavern normalization', async () => {
    installStreamingContext('custom', 'gemini-3-pro', {
      custom_api_format: 'gemini_interactions',
      custom_url: 'https://generativelanguage.googleapis.com/v1beta',
    });
    const runtime = streamingRuntime();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(eventStream([
      sse({
        model: 'gemini-3-pro',
        choices: [{ index: 0, delta: { content: '交互' }, finish_reason: null }],
      }),
      sse({
        model: 'gemini-3-pro',
        choices: [{ index: 0, delta: { content: '总结' }, finish_reason: 'stop' }],
        usage: { input_tokens: 640, output_tokens: 76, total_tokens: 716 },
      }),
      sse('[DONE]'),
    ]));
    const provider = new MainLlmProvider(fetchMock, async () => ({}), async () => runtime);

    await expect(provider.completeDetailed({
      system: 'system',
      prompt: 'prompt',
      maxTokens: 3_000,
    })).resolves.toEqual({
      text: '交互总结',
      metadata: {
        provider: 'main',
        requestedMaxTokens: 3_000,
        finishReason: 'stop',
        promptTokens: 640,
        completionTokens: 76,
        totalTokens: 716,
        responseCharacters: 4,
        source: 'custom',
        model: 'gemini-3-pro',
      },
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      chat_completion_source: 'custom',
      custom_api_format: 'gemini_interactions',
      model: 'gemini-3-pro',
      stream: true,
    });
  });

  it('rejects a stream that closes after partial text without a terminal marker', async () => {
    const context = installStreamingContext('claude', 'claude-stream');
    const runtime = streamingRuntime();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(eventStream([
      sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: '半截总结' } }),
    ]));
    const provider = new MainLlmProvider(fetchMock, async () => ({}), async () => runtime);

    await expect(provider.completeDetailed({ system: 'system', prompt: 'prompt' }))
      .rejects.toThrow('主连接流式响应未完整结束');
    expect(context.generateRawData).not.toHaveBeenCalled();
  });

  it('maps an upstream 504 to the existing retriable timeout error', async () => {
    installStreamingContext('claude', 'claude-stream');
    const runtime = streamingRuntime();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: 'gateway timed out' } }),
      { status: 504, headers: { 'Content-Type': 'application/json' } },
    ));
    const provider = new MainLlmProvider(fetchMock, async () => ({}), async () => runtime);

    const error = await provider.completeDetailed({
      system: 'system',
      prompt: 'prompt',
      timeoutMs: 600_000,
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(LlmRequestTimeoutError);
    expect(error).toMatchObject({ timeoutMs: 600_000, upstreamStatus: 504 });
  });
});
