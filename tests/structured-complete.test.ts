import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoryEchoSettings } from '../src/core/types';
import { completeStructuredWithConfiguredProvider } from '../src/llm/complete';
import {
  resetStructuredOutputDiagnostics,
  structuredOutputDiagnosticsSnapshot,
} from '../src/llm/structured-diagnostics';
import { storyEchoTaskCoordinator } from '../src/runtime/task-coordinator';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: { query: { type: 'string' } },
} as const;

function parseQuery(raw: string): string {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (typeof parsed['query'] !== 'string' || !parsed['query']) {
    throw new Error('missing query');
  }
  return parsed['query'];
}

afterEach(() => {
  storyEchoTaskCoordinator.resetForTests();
  resetStructuredOutputDiagnostics();
  vi.unstubAllGlobals();
});

describe('structured LLM completion', () => {
  it('tries json_object with textual schema/example before json_schema', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
    settings.llm.provider = 'openai-compatible';
    settings.llm.custom.baseUrl = 'https://api.deepseek.com/v1';
    settings.llm.custom.model = 'deepseek-v4-pro';
    settings.llm.custom.fallbackToMain = false;
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: 'not json' } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: '{"query":"银钥匙位置"}' } }],
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ getRequestHeaders: () => ({ 'X-CSRF-Token': 'csrf' }) }),
    });

    await expect(completeStructuredWithConfiguredProvider(settings, {
      system: 'system',
      prompt: 'prompt',
      jsonSchema: SCHEMA,
      jsonExample: { query: '示例查询' },
      maxTokens: 256,
    }, parseQuery)).resolves.toBe('银钥匙位置');

    const first = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const second = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(first.custom_include_body).toBe('response_format:\n  type: json_object');
    expect(first.json_schema).toBeUndefined();
    expect(first.messages[0].content).toContain('JSON SCHEMA:');
    expect(first.messages[0].content).toContain('EXAMPLE JSON OUTPUT:');
    expect(first.messages[0].content).toContain('示例查询');
    expect(first.messages[0].content).toContain('示例只用于说明JSON形状');
    expect(second.custom_include_body).toBe('');
    expect(second.json_schema).toEqual({
      name: 'story_echo_response',
      strict: true,
      value: SCHEMA,
    });
  });

  it('uses plain prompted JSON after json_object and json_schema both fail', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
    settings.llm.provider = 'openai-compatible';
    settings.llm.custom.baseUrl = 'https://example.com/v1';
    settings.llm.custom.model = 'model';
    settings.llm.custom.fallbackToMain = false;
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: '{}' } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: '{}' } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: '{"query":"普通模式成功"}' } }],
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ getRequestHeaders: () => ({}) }),
    });

    const result = await completeStructuredWithConfiguredProvider(settings, {
      system: 'system',
      prompt: 'prompt',
      jsonSchema: SCHEMA,
    }, parseQuery);

    expect(result).toBe('普通模式成功');
    const first = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const second = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    const third = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(first.json_schema).toBeDefined();
    expect(first.custom_include_body).toBe('');
    expect(second.json_schema).toBeUndefined();
    expect(second.custom_include_body).toBe('response_format:\n  type: json_object');
    expect(third.custom_include_body).toBe('');
    expect(third.json_schema).toBeUndefined();
  });

  it('starts at json_schema when an older main context does not expose its model', async () => {
    const generateRaw = vi.fn()
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce('{"query":"主连接普通模式"}');
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ generateRaw }),
    });

    const result = await completeStructuredWithConfiguredProvider(DEFAULT_SETTINGS, {
      system: 'system',
      prompt: 'prompt',
      jsonSchema: SCHEMA,
    }, parseQuery);

    expect(result).toBe('主连接普通模式');
    expect(generateRaw).toHaveBeenNthCalledWith(1, expect.objectContaining({ jsonSchema: SCHEMA }));
    expect(generateRaw).toHaveBeenNthCalledWith(2, expect.not.objectContaining({ jsonSchema: expect.anything() }));
  });

  it('uses json_object first when the SillyTavern main model is DeepSeek', async () => {
    let handler: ((settings: unknown) => void) | undefined;
    let outbound: Record<string, unknown> = {};
    const eventSource = {
      on: vi.fn((_event: string, next: (settings: unknown) => void) => {
        handler = next;
      }),
      off: vi.fn(),
    };
    const generateRaw = vi.fn(async () => {
      outbound = {
        chat_completion_source: 'custom',
        custom_include_body: '',
      };
      handler?.(outbound);
      return '{"query":"主连接DeepSeek"}';
    });
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({
        mainApi: 'openai',
        chatCompletionSettings: {
          chat_completion_source: 'custom',
          custom_model: 'deepseek-v4-flash',
        },
        getChatCompletionModel: () => 'deepseek-v4-flash',
        generateRaw,
        eventSource,
        eventTypes: { CHAT_COMPLETION_SETTINGS_READY: 'settings-ready' },
      }),
    });

    await expect(completeStructuredWithConfiguredProvider(DEFAULT_SETTINGS, {
      system: 'system',
      prompt: 'prompt',
      jsonSchema: SCHEMA,
    }, parseQuery)).resolves.toBe('主连接DeepSeek');

    expect(outbound['custom_include_body']).toBe('response_format:\n  type: json_object');
    expect(generateRaw).toHaveBeenCalledWith(expect.not.objectContaining({ jsonSchema: SCHEMA }));
  });

  it('repairs harmless JSON syntax defects before making another provider call', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
    settings.llm.provider = 'openai-compatible';
    settings.llm.custom.baseUrl = 'https://api.deepseek.com/v1';
    settings.llm.custom.model = 'deepseek-v4-pro';
    settings.llm.custom.fallbackToMain = false;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '结果如下：\n```json\n{"query":"本地修复成功",}\n```' } }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ getRequestHeaders: () => ({}) }),
    });

    await expect(completeStructuredWithConfiguredProvider(settings, {
      system: 'system',
      prompt: 'prompt',
      jsonSchema: SCHEMA,
    }, parseQuery)).resolves.toBe('本地修复成功');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(structuredOutputDiagnosticsSnapshot().localJsonRepairs).toBe(1);
  });

  it('ends a background fallback chain when a foreground generation is waiting', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
    settings.llm.provider = 'openai-compatible';
    settings.llm.custom.baseUrl = 'https://api.deepseek.com/v1';
    settings.llm.custom.model = 'deepseek-v4-pro';
    settings.llm.custom.fallbackToMain = false;
    let releaseResponse!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      releaseResponse = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(response);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({ getRequestHeaders: () => ({}) }),
    });
    const order: string[] = [];
    const background = storyEchoTaskCoordinator.enqueueBackground('structured background', async () => {
      order.push('background');
      return completeStructuredWithConfiguredProvider(settings, {
        system: 'system',
        prompt: 'prompt',
        jsonSchema: SCHEMA,
      }, parseQuery);
    });
    await Promise.resolve();
    await Promise.resolve();
    const foreground = storyEchoTaskCoordinator.enqueueForeground(
      'foreground',
      async () => {
        order.push('foreground');
        return false;
      },
      { holdForegroundLease: (prepared) => prepared },
    );
    const rejected = expect(background).rejects.toThrow(/后台任务已取消/);
    releaseResponse(new Response(JSON.stringify({
      choices: [{ message: { content: 'not json' } }],
    }), { status: 200 }));

    await rejected;
    await foreground;
    expect(order).toEqual(['background', 'foreground']);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(structuredOutputDiagnosticsSnapshot().backgroundYields).toBe(0);
  });
});
