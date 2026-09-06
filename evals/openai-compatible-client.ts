import { readResponseTextWithLimit } from '../src/http/response';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface PromptEvalClientConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxTokenField: 'max_tokens' | 'max_completion_tokens';
}

export interface PromptEvalCompletion {
  text: string;
  finishReason: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  durationMs: number;
}

type FetchLike = typeof fetch;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteTokenCount(value: unknown): number | undefined {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : undefined;
}

function isDeepSeekTarget(model: string, baseUrl: string): boolean {
  if (/(?:^|[/:._-])deepseek(?:$|[/:._-])/iu.test(model)) {
    return true;
  }
  return new URL(baseUrl).hostname.toLowerCase() === 'api.deepseek.com';
}

function completionContent(payload: unknown): string {
  if (!isRecord(payload)) {
    return '';
  }
  const choices = Array.isArray(payload['choices']) ? payload['choices'] : [];
  const choice = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(choice['message']) ? choice['message'] : {};
  const content = message['content'];
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => isRecord(part) && typeof part['text'] === 'string' ? part['text'] : '')
      .join('')
      .trim();
  }
  return typeof choice['text'] === 'string' ? choice['text'].trim() : '';
}

export function promptEvalChatCompletionsUrl(baseUrl: string): string {
  const url = new URL(baseUrl.trim());
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new Error('评测 Base URL 只支持 HTTP(S)。');
  }
  if (url.username || url.password) {
    throw new Error('评测 Base URL 不能包含用户名或密码。');
  }
  const localHttp = ['localhost', '127.0.0.1', '::1', '[::1]']
    .includes(url.hostname.toLowerCase());
  if (url.protocol === 'http:' && !localHttp) {
    throw new Error('非本机评测接口必须使用 HTTPS，避免泄露 API Key。');
  }
  const path = url.pathname.replace(/\/+$/u, '');
  url.pathname = path.endsWith('/chat/completions')
    ? path
    : `${path || ''}/chat/completions`;
  url.hash = '';
  return url.toString();
}

function safeErrorDetail(text: string, apiKey: string): string {
  // Redact before truncating so a key straddling the output limit cannot leak a prefix.
  const redacted = apiKey ? text.split(apiKey).join('[REDACTED]') : text;
  return redacted.replace(/\s+/gu, ' ').trim().slice(0, 1_000);
}

export async function requestPromptEvalCompletion(
  config: PromptEvalClientConfig,
  request: {
    system: string;
    prompt: string;
    maxTokens: number;
  },
  fetchImpl: FetchLike = fetch,
): Promise<PromptEvalCompletion> {
  const apiKey = config.apiKey.trim();
  if (!apiKey) {
    throw new Error('评测 API Key 不能为空。');
  }
  if (apiKey.length > 16_384 || /[\r\n]/u.test(apiKey)) {
    throw new Error('评测 API Key 格式无效。');
  }
  if (!config.model.trim()) {
    throw new Error('评测模型名不能为空。');
  }
  const controller = new AbortController();
  const timeoutMs = Math.min(900_000, Math.max(1_000, Math.floor(config.timeoutMs)));
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  const maxTokens = Math.min(16_000, Math.max(16, Math.floor(request.maxTokens)));
  const body: Record<string, unknown> = {
    model: config.model.trim(),
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.prompt },
    ],
    temperature: 0,
    stream: false,
    [config.maxTokenField]: maxTokens,
  };
  // DeepSeek V4 enables thinking by default and counts those tokens against
  // max_tokens. Match StoryEcho's production request so this harness measures
  // the summary prompts instead of occasionally exhausting the budget before
  // any visible content is emitted.
  if (isDeepSeekTarget(config.model, config.baseUrl)) {
    body['thinking'] = { type: 'disabled' };
  }
  try {
    const response = await fetchImpl(promptEvalChatCompletionsUrl(config.baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const responseText = await readResponseTextWithLimit(
      response,
      MAX_RESPONSE_BYTES,
      '评测接口响应过大。',
    );
    let payload: unknown;
    try {
      payload = responseText ? JSON.parse(responseText) as unknown : null;
    } catch {
      throw new Error(response.ok
        ? '评测接口返回了无法解析的非 JSON 响应。'
        : `评测请求失败（HTTP ${response.status}）。`);
    }
    if (!response.ok) {
      const detail = safeErrorDetail(responseText, apiKey);
      throw new Error(`评测请求失败（HTTP ${response.status}）。${detail ? ` ${detail}` : ''}`);
    }
    const root = isRecord(payload) ? payload : {};
    const choices = Array.isArray(root['choices']) ? root['choices'] : [];
    const choice = isRecord(choices[0]) ? choices[0] : {};
    const usage = isRecord(root['usage']) ? root['usage'] : {};
    const promptTokens = finiteTokenCount(usage['prompt_tokens']);
    const completionTokens = finiteTokenCount(usage['completion_tokens']);
    const totalTokens = finiteTokenCount(usage['total_tokens']);
    const finishReason = typeof choice['finish_reason'] === 'string'
      ? choice['finish_reason']
      : '';
    const text = completionContent(payload);
    if (!text) {
      const diagnostic = [
        finishReason ? `finish_reason=${finishReason}` : '',
        completionTokens !== undefined ? `completion_tokens=${completionTokens}` : '',
      ].filter(Boolean).join(', ');
      throw new Error(
        `评测模型没有返回可读取的内容。${diagnostic ? `（${diagnostic}）` : ''}`,
      );
    }
    return {
      text,
      finishReason,
      ...(promptTokens !== undefined ? { promptTokens } : {}),
      ...(completionTokens !== undefined ? { completionTokens } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`评测请求在 ${timeoutMs}ms 后超时。`);
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}
