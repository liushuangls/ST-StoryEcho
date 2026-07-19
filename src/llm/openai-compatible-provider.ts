import type {
  LlmProvider,
  LlmRequest,
  LlmStructuredOutputMode,
  StoryEchoSettings,
} from '../core/types';
import { getRequestHeaders } from '../platform/sillytavern';
import { normalizeChatCompletionsBaseUrl } from './url';

type FetchLike = typeof fetch;
type RequestHeadersProvider = () => Promise<Record<string, string>>;

const GENERATE_ENDPOINT = '/api/backends/chat-completions/generate';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readLimitedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error('自定义LLM响应过大。');
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error('自定义LLM响应过大。');
  }
  return text;
}

function responseContent(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return typeof payload === 'string' ? payload : null;
  }
  const choices = payload['choices'];
  const first = Array.isArray(choices) && isRecord(choices[0]) ? choices[0] : null;
  const message = first && isRecord(first['message']) ? first['message'] : null;
  const content = message?.['content'];
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => isRecord(part) && typeof part['text'] === 'string' ? part['text'] : '')
      .join('');
  }
  if (first && typeof first['text'] === 'string') {
    return first['text'];
  }
  return typeof payload['content'] === 'string' ? payload['content'] : null;
}

function responseError(payload: unknown, fallback: string, apiKey: string): string {
  let message = fallback;
  if (isRecord(payload)) {
    const error = payload['error'];
    if (typeof error === 'string') {
      message = error;
    } else if (isRecord(error) && typeof error['message'] === 'string') {
      message = error['message'];
    } else if (typeof payload['message'] === 'string') {
      message = payload['message'];
    }
  }
  const limited = message.replace(/\s+/g, ' ').slice(0, 500);
  return apiKey ? limited.split(apiKey).join('[REDACTED]') : limited;
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id = 'openai-compatible' as const;

  supportsStructuredOutput(_mode: LlmStructuredOutputMode): boolean {
    return true;
  }

  structuredOutputOrder(): readonly LlmStructuredOutputMode[] {
    const modelName = this.config.model.trim().toLocaleLowerCase().split('/').at(-1) ?? '';
    return modelName.startsWith('deepseek-')
      ? ['json-object', 'json-schema', 'text']
      : ['json-schema', 'json-object', 'text'];
  }

  constructor(
    private readonly config: StoryEchoSettings['llm']['custom'],
    private readonly fetchImpl: FetchLike = fetch,
    private readonly requestHeaders: RequestHeadersProvider = getRequestHeaders,
  ) {}

  async complete(request: LlmRequest): Promise<string> {
    const model = this.config.model.trim();
    if (!model) {
      throw new Error('自定义LLM模型名不能为空。');
    }
    const baseUrl = normalizeChatCompletionsBaseUrl(this.config.baseUrl, {
      allowInsecureHttp: this.config.allowInsecureHttp,
    });
    const apiKey = this.config.apiKey.trim();
    if (apiKey.length > 16_384) {
      throw new Error('自定义LLM API Key过长。');
    }
    if (/[\r\n]/.test(apiKey)) {
      throw new Error('自定义LLM API Key不能包含换行符。');
    }
    const controller = new AbortController();
    const timeoutMs = Math.min(300_000, Math.max(1_000, Math.floor(this.config.timeoutMs)));
    const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort();
    request.signal?.addEventListener('abort', abort, { once: true });
    const structuredOutput = request.structuredOutput
      ?? (this.config.strictJsonSchema && request.jsonSchema ? 'json-schema' : 'text');
    const body = {
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.prompt },
      ],
      model,
      max_tokens: Math.min(8_192, Math.max(16, Math.floor(request.maxTokens ?? 8_192))),
      temperature: 0,
      top_p: 1,
      stream: false,
      chat_completion_source: 'custom',
      group_names: [],
      include_reasoning: false,
      reasoning_effort: 'medium',
      enable_web_search: false,
      request_images: false,
      custom_prompt_post_processing: 'strict',
      reverse_proxy: baseUrl,
      proxy_password: '',
      custom_url: baseUrl,
      custom_include_headers: apiKey ? `Authorization: Bearer ${apiKey}` : '',
      custom_include_body: structuredOutput === 'json-object'
        ? 'response_format:\n  type: json_object'
        : '',
      custom_exclude_body: '',
      ...(structuredOutput === 'json-schema' && request.jsonSchema
        ? {
            json_schema: {
              name: 'story_echo_response',
              strict: true,
              value: request.jsonSchema,
            },
          }
        : {}),
    };

    try {
      const response = await this.fetchImpl.call(globalThis, GENERATE_ENDPOINT, {
        method: 'POST',
        headers: {
          ...await this.requestHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await readLimitedText(response);
      let payload: unknown = null;
      try {
        payload = text ? JSON.parse(text) as unknown : null;
      } catch {
        if (response.ok) {
          throw new Error('SillyTavern后端返回了非JSON的LLM响应。');
        }
      }
      if (!response.ok) {
        const fallback = `自定义LLM请求失败（HTTP ${response.status}）。`;
        const detail = responseError(payload, '', apiKey);
        throw new Error(detail ? `${fallback} ${detail}` : fallback);
      }
      const content = responseContent(payload);
      if (!content?.trim()) {
        throw new Error('自定义LLM没有返回可读取的内容。');
      }
      return content;
    } catch (error) {
      if (request.signal?.aborted) {
        throw error;
      }
      if (controller.signal.aborted) {
        throw new Error(`自定义LLM请求超时（${timeoutMs}ms）。`);
      }
      throw error;
    } finally {
      globalThis.clearTimeout(timeout);
      request.signal?.removeEventListener('abort', abort);
    }
  }

  async testConnection(): Promise<void> {
    const response = await this.complete({
      system: 'You are a connection test. Follow the user instruction exactly.',
      prompt: 'Reply with exactly: OK',
      // Leave enough room for providers that count reasoning tokens against
      // max_tokens before emitting the visible answer.
      maxTokens: 128,
    });
    if (!response.trim()) {
      throw new Error('自定义LLM返回了空响应。');
    }
  }
}
