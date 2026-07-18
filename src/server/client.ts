import { sha256 } from '../core/hash';
import type { LlmRequest } from '../core/types';
import { getRequestHeaders } from '../platform/sillytavern';

type FetchLike = typeof fetch;
type RequestHeadersProvider = () => Promise<Record<string, string>>;

const SERVER_BASE_PATH = '/api/plugins/story-echo';
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export type ServerProfileKind = 'llm' | 'embedding';

export interface ServerProfileStatus {
  configured: boolean;
  endpointFingerprint?: string;
  updatedAt?: string;
  hasApiKey?: boolean;
}

export interface StoryEchoServerStatus {
  available: true;
  version: string;
  profiles: Record<ServerProfileKind, ServerProfileStatus>;
}

interface ServerErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
  };
}

interface ServerEmbeddingResponse {
  vectors?: unknown;
}

export interface ServerLlmRequest extends LlmRequest {
  endpoint: string;
  model: string;
  timeoutMs: number;
  strictJsonSchema: boolean;
}

export interface ServerEmbeddingRequest {
  endpoint: string;
  model: string;
  texts: string[];
  timeoutMs: number;
  signal?: AbortSignal;
}

async function readLimitedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error('StoryEcho服务端响应过大。');
  }
  if (!response.body) {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new Error('StoryEcho服务端响应过大。');
    }
    return text;
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
      throw new Error('StoryEcho服务端响应过大。');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function unavailableMessage(status: number): string {
  return status === 404
    ? 'StoryEcho服务端插件未安装或未启用。请安装服务端插件并重启SillyTavern。'
    : `StoryEcho服务端请求失败（HTTP ${status}）。`;
}

function parseServerError(text: string, status: number): Error {
  try {
    const parsed = JSON.parse(text) as ServerErrorBody;
    if (typeof parsed.error?.message === 'string' && parsed.error.message) {
      return new Error(parsed.error.message);
    }
  } catch {
    // Use the generic status error below.
  }
  return new Error(unavailableMessage(status));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function serverEndpointFingerprint(endpoint: string): Promise<string> {
  return sha256(endpoint.trim());
}

export class StoryEchoServerClient {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly requestHeaders: RequestHeadersProvider = getRequestHeaders,
  ) {}

  async getStatus(): Promise<StoryEchoServerStatus> {
    const data = await this.request('/status', { method: 'GET' });
    if (
      !isRecord(data)
      || data['available'] !== true
      || typeof data['version'] !== 'string'
      || !isRecord(data['profiles'])
    ) {
      throw new Error('StoryEcho服务端状态响应无效。');
    }
    const profiles = data['profiles'];
    return {
      available: true,
      version: data['version'],
      profiles: {
        llm: this.parseProfileStatus(profiles['llm']),
        embedding: this.parseProfileStatus(profiles['embedding']),
      },
    };
  }

  async saveProfile(
    kind: ServerProfileKind,
    endpoint: string,
    apiKey: string,
    allowInsecureHttp: boolean,
  ): Promise<ServerProfileStatus> {
    const data = await this.request(`/profiles/${kind}`, {
      method: 'PUT',
      body: { endpoint, apiKey, allowInsecureHttp },
    });
    return this.parseProfileStatus(data);
  }

  async deleteProfile(kind: ServerProfileKind): Promise<void> {
    await this.request(`/profiles/${kind}`, { method: 'DELETE' });
  }

  async complete(request: ServerLlmRequest): Promise<string> {
    const data = await this.request('/llm/chat-completions', {
      method: 'POST',
      body: {
        endpointFingerprint: await serverEndpointFingerprint(request.endpoint),
        model: request.model,
        timeoutMs: request.timeoutMs,
        strictJsonSchema: request.strictJsonSchema,
        system: request.system,
        prompt: request.prompt,
        ...(request.jsonSchema ? { jsonSchema: request.jsonSchema } : {}),
      },
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (!isRecord(data) || typeof data['content'] !== 'string') {
      throw new Error('StoryEcho服务端没有返回有效的LLM内容。');
    }
    return data['content'];
  }

  async embed(request: ServerEmbeddingRequest): Promise<unknown> {
    const data = await this.request('/embedding/embeddings', {
      method: 'POST',
      body: {
        endpointFingerprint: await serverEndpointFingerprint(request.endpoint),
        model: request.model,
        texts: request.texts,
        timeoutMs: request.timeoutMs,
      },
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (!isRecord(data)) {
      throw new Error('StoryEcho服务端没有返回有效的Embedding响应。');
    }
    return (data as ServerEmbeddingResponse).vectors;
  }

  private parseProfileStatus(value: unknown): ServerProfileStatus {
    if (!isRecord(value) || typeof value['configured'] !== 'boolean') {
      throw new Error('StoryEcho服务端配置状态无效。');
    }
    const result: ServerProfileStatus = { configured: value['configured'] };
    if (typeof value['endpointFingerprint'] === 'string') {
      result.endpointFingerprint = value['endpointFingerprint'];
    }
    if (typeof value['updatedAt'] === 'string') {
      result.updatedAt = value['updatedAt'];
    }
    if (typeof value['hasApiKey'] === 'boolean') {
      result.hasApiKey = value['hasApiKey'];
    }
    return result;
  }

  private async request(
    path: string,
    options: {
      method: 'GET' | 'POST' | 'PUT' | 'DELETE';
      body?: Record<string, unknown>;
      signal?: AbortSignal;
    },
  ): Promise<unknown> {
    const headers = {
      ...await this.requestHeaders(),
      'Content-Type': 'application/json',
    };
    let response: Response;
    try {
      response = await this.fetchImpl(`${SERVER_BASE_PATH}${path}`, {
        method: options.method,
        headers,
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (options.signal?.aborted) {
        throw error;
      }
      throw new Error('无法连接StoryEcho服务端插件。');
    }
    if (response.status === 204) {
      return {};
    }
    const text = await readLimitedText(response);
    if (!response.ok) {
      throw parseServerError(text, response.status);
    }
    if (!text) {
      return {};
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error('StoryEcho服务端返回了非JSON响应。');
    }
  }
}

export const storyEchoServerClient = new StoryEchoServerClient();
