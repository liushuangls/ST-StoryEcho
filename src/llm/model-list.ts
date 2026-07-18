import type { StoryEchoSettings } from '../core/types';
import { getRequestHeaders } from '../platform/sillytavern';
import { normalizeChatCompletionsBaseUrl } from './url';

type FetchLike = typeof fetch;
type RequestHeadersProvider = () => Promise<Record<string, string>>;

const STATUS_ENDPOINT = '/api/backends/chat-completions/status';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readLimitedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error('模型列表响应过大。');
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error('模型列表响应过大。');
  }
  return text;
}

function errorMessage(payload: unknown, response: Response, apiKey: string): string {
  let detail = '';
  if (isRecord(payload)) {
    const error = payload['error'];
    if (typeof error === 'string') {
      detail = error;
    } else if (isRecord(error) && typeof error['message'] === 'string') {
      detail = error['message'];
    } else if (typeof payload['message'] === 'string') {
      detail = payload['message'];
    }
  }
  const redacted = apiKey ? detail.split(apiKey).join('[REDACTED]') : detail;
  const suffix = redacted.trim().replace(/\s+/g, ' ').slice(0, 500);
  const base = `获取模型列表失败（HTTP ${response.status}）。`;
  return suffix ? `${base} ${suffix}` : base;
}

export function parseCustomModelList(payload: unknown): string[] {
  const root = isRecord(payload) ? payload : null;
  const candidates = Array.isArray(root?.['models'])
    ? root['models']
    : Array.isArray(root?.['data'])
      ? root['data']
      : Array.isArray(payload)
        ? payload
        : [];
  const names = candidates
    .map((candidate) => {
      if (typeof candidate === 'string') {
        return candidate.trim();
      }
      if (!isRecord(candidate)) {
        return '';
      }
      const value = candidate['id'] ?? candidate['model'] ?? candidate['name'];
      return typeof value === 'string' ? value.trim() : '';
    })
    .filter((name) => name.length > 0 && name.length <= 200);
  return [...new Set(names)].sort((left, right) => left.localeCompare(right));
}

export async function fetchCustomLlmModels(
  config: StoryEchoSettings['llm']['custom'],
  fetchImpl: FetchLike = fetch,
  requestHeaders: RequestHeadersProvider = getRequestHeaders,
): Promise<string[]> {
  const baseUrl = normalizeChatCompletionsBaseUrl(config.baseUrl, {
    allowInsecureHttp: config.allowInsecureHttp,
  });
  const apiKey = config.apiKey.trim();
  if (apiKey.length > 16_384) {
    throw new Error('自定义LLM API Key过长。');
  }
  if (/[\r\n]/.test(apiKey)) {
    throw new Error('自定义LLM API Key不能包含换行符。');
  }

  const controller = new AbortController();
  const timeoutMs = Math.min(300_000, Math.max(1_000, Math.floor(config.timeoutMs)));
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl.call(globalThis, STATUS_ENDPOINT, {
      method: 'POST',
      headers: {
        ...await requestHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        reverse_proxy: baseUrl,
        proxy_password: '',
        chat_completion_source: 'custom',
        custom_url: baseUrl,
        custom_include_headers: apiKey ? `Authorization: Bearer ${apiKey}` : '',
      }),
      signal: controller.signal,
    });
    const text = await readLimitedText(response);
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) as unknown : null;
    } catch {
      if (response.ok) {
        throw new Error('SillyTavern后端返回了非JSON的模型列表。');
      }
    }
    if (!response.ok) {
      throw new Error(errorMessage(payload, response, apiKey));
    }
    const models = parseCustomModelList(payload);
    if (models.length === 0) {
      throw new Error('接口返回成功，但没有可用模型。');
    }
    return models;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`获取模型列表超时（${timeoutMs}ms）。`);
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}
