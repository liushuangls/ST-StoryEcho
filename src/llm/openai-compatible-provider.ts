import type { LlmProvider, LlmRequest, StoryEchoSettings } from '../core/types';
import type { SessionSecretVault } from './secret-vault';
import { normalizeChatCompletionsUrl } from './url';

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  error?: {
    message?: string;
  };
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function redactSecret(message: string, secret: string | undefined): string {
  return secret ? message.split(secret).join('[REDACTED]') : message;
}

async function readLimitedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error('自定义LLM响应过大。');
  }
  if (!response.body) {
    return response.text();
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    byteLength += value.byteLength;
    if (byteLength > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('自定义LLM响应过大。');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function readContent(response: ChatCompletionResponse, secret: string | undefined): string {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part) => part.text ?? '').join('');
  }
  const message = response.error?.message || '自定义LLM没有返回可读取的内容。';
  throw new Error(redactSecret(message, secret));
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id = 'openai-compatible' as const;

  constructor(
    private readonly config: StoryEchoSettings['llm']['custom'],
    private readonly secretVault: SessionSecretVault,
  ) {}

  async complete(request: LlmRequest): Promise<string> {
    if (!this.config.model.trim()) {
      throw new Error('自定义LLM模型名不能为空。');
    }

    const url = normalizeChatCompletionsUrl(this.config.baseUrl, {
      allowInsecureHttp: this.config.allowInsecureHttp,
    });
    const key = this.secretVault.getSessionKey();
    const controller = new AbortController();
    const timeoutMs = Math.min(300_000, Math.max(1_000, Math.floor(this.config.timeoutMs)));
    const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener('abort', onAbort, { once: true });

    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (key) {
      headers.set('Authorization', `Bearer ${key}`);
    }

    const body: Record<string, unknown> = {
      model: this.config.model.trim(),
      temperature: 0,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.prompt },
      ],
    };

    if (request.jsonSchema && this.config.strictJsonSchema) {
      body['response_format'] = {
        type: 'json_schema',
        json_schema: {
          name: 'story_echo_response',
          strict: true,
          schema: request.jsonSchema,
        },
      };
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      });

      const text = await readLimitedText(response);
      let parsed: ChatCompletionResponse;
      try {
        parsed = JSON.parse(text) as ChatCompletionResponse;
      } catch {
        throw new Error(`自定义LLM返回了非JSON响应（HTTP ${response.status}）。`);
      }

      if (!response.ok) {
        const message = parsed.error?.message || `自定义LLM请求失败（HTTP ${response.status}）。`;
        throw new Error(redactSecret(message, key));
      }

      return readContent(parsed, key);
    } catch (error) {
      if (controller.signal.aborted && !request.signal?.aborted) {
        throw new Error(`自定义LLM请求超时（${timeoutMs}ms）。`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', onAbort);
    }
  }

  async testConnection(): Promise<void> {
    const response = await this.complete({
      system: 'You are a connection test. Follow the user instruction exactly.',
      prompt: 'Reply with exactly: OK',
    });

    if (!response.trim()) {
      throw new Error('自定义LLM返回了空响应。');
    }
  }
}
