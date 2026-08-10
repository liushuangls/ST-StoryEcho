import { readResponseTextWithLimit } from '../http/response';
import type {
  MainConnectionIdentity,
  SillyTavernContext,
} from '../platform/sillytavern';
import { StoryEchoTaskCancelledError } from '../runtime/task-cancellation';
import {
  findRetriableUpstreamTimeoutStatus,
  isRetriableUpstreamTimeoutStatus,
  LlmRequestTimeoutError,
} from './errors';
import { tuneInternalGenerationSettings } from './internal-settings';

type FetchLike = typeof fetch;
type RequestHeadersProvider = () => Promise<Record<string, string>>;

const GENERATE_ENDPOINT = '/api/backends/chat-completions/generate';
const MAX_STREAM_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;

interface MainStreamState extends Record<string, unknown> {
  reasoning: string;
  images: string[];
  signature: string;
  toolSignatures: Record<string, string>;
  native: unknown;
}

interface GenerationParametersResult {
  generate_data: unknown;
}

export interface MainStreamingRuntime {
  createGenerationParameters(
    settings: Record<string, unknown>,
    model: string,
    type: string,
    messages: Array<Record<string, unknown>>,
    options: { allowToolCalls: boolean; agentMode: boolean },
  ): Promise<GenerationParametersResult>;
  getStreamingReply(
    data: unknown,
    state: MainStreamState,
    options: {
      chatCompletionSource: string;
      model: string;
      overrideShowThoughts: boolean;
    },
  ): string;
}

export type MainStreamingRuntimeLoader = () => Promise<MainStreamingRuntime>;

export interface MainStreamingCompletion {
  text: string;
  payload: Record<string, unknown>;
}

interface MainStreamingRequest {
  context: SillyTavernContext;
  identity: MainConnectionIdentity;
  systemPrompt: string;
  prompt: string;
  responseLength?: number;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchImpl: FetchLike;
  requestHeaders: RequestHeadersProvider;
  loadRuntime: MainStreamingRuntimeLoader;
}

interface SseEvent {
  event: string;
  data: string;
}

interface StreamMetadata {
  terminal: boolean;
  terminalEvent: boolean;
  finishReason?: string;
  model?: string;
  usage: Record<string, unknown>;
  usageMetadata: Record<string, unknown>;
}

let runtimePromise: Promise<MainStreamingRuntime> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximumLength = 200): string | undefined {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, maximumLength)
    : undefined;
}

function eventName(context: SillyTavernContext, key: string): string | undefined {
  return context.eventTypes?.[key] ?? context.event_types?.[key];
}

export function canStreamMainConnection(
  context: SillyTavernContext,
  identity: MainConnectionIdentity,
): boolean {
  const remove = context.eventSource?.off ?? context.eventSource?.removeListener;
  return identity.mainApi === 'openai'
    && Boolean(context.chatCompletionSettings)
    && Boolean(identity.source)
    && Boolean(identity.model)
    && typeof context.eventSource?.emit === 'function'
    && typeof remove === 'function';
}

export async function loadMainStreamingRuntime(): Promise<MainStreamingRuntime> {
  runtimePromise ??= (async () => {
    const moduleUrl = '/scripts/openai.js';
    const loaded = (await import(/* @vite-ignore */ moduleUrl)) as {
      createGenerationParameters?: MainStreamingRuntime['createGenerationParameters'];
      getStreamingReply?: MainStreamingRuntime['getStreamingReply'];
    };
    if (
      typeof loaded.createGenerationParameters !== 'function'
      || typeof loaded.getStreamingReply !== 'function'
    ) {
      throw new Error('当前SillyTavern版本不支持主连接流式内部请求。');
    }
    return {
      createGenerationParameters: loaded.createGenerationParameters,
      getStreamingReply: loaded.getStreamingReply,
    };
  })().catch((error: unknown) => {
    runtimePromise = undefined;
    throw error;
  });
  return runtimePromise;
}

function parseSseEvent(block: string): SseEvent | null {
  let type = 'message';
  const data: string[] = [];
  for (const line of block.split(/\r\n|\n|\r/u)) {
    if (!line || line.startsWith(':')) {
      continue;
    }
    const separator = line.indexOf(':');
    const field = separator >= 0 ? line.slice(0, separator) : line;
    let value = separator >= 0 ? line.slice(separator + 1) : '';
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    if (field === 'event') {
      type = value || 'message';
    } else if (field === 'data') {
      data.push(value);
    }
  }
  return data.length > 0 ? { event: type, data: data.join('\n') } : null;
}

function takeSseEvents(buffer: string): { events: SseEvent[]; remainder: string } {
  const events: SseEvent[] = [];
  const separator = /\r\n\r\n|\n\n|\r\r/gu;
  let start = 0;
  for (let match = separator.exec(buffer); match; match = separator.exec(buffer)) {
    const parsed = parseSseEvent(buffer.slice(start, match.index));
    if (parsed) {
      events.push(parsed);
    }
    start = match.index + match[0].length;
  }
  return { events, remainder: buffer.slice(start) };
}

function statusFromPayload(value: unknown, depth = 0): number | null {
  if (depth > 4 || !isRecord(value)) {
    return null;
  }
  for (const [key, candidate] of Object.entries(value)) {
    if (/^(?:code|status|statusCode|status_code)$/u.test(key)) {
      const status = Number(candidate);
      if (Number.isInteger(status) && isRetriableUpstreamTimeoutStatus(status)) {
        return status;
      }
    }
    const nested = statusFromPayload(candidate, depth + 1);
    if (nested !== null) {
      return nested;
    }
  }
  return null;
}

function timeoutStatusFromText(value: string): number | null {
  const fromMessage = findRetriableUpstreamTimeoutStatus(value);
  if (fromMessage !== null) {
    return fromMessage;
  }
  try {
    return statusFromPayload(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function streamErrorPayload(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const id = boundedString(value['id']);
  return value['type'] === 'error'
    || value['error'] !== undefined
    || typeof value['message'] === 'string'
    || value['detail'] !== undefined
    || Boolean(id?.startsWith('tauritavern-error-'));
}

function throwStreamPayloadError(
  value: unknown,
  timeoutMs: number,
  eventType = 'message',
): void {
  if (eventType !== 'error' && !streamErrorPayload(value)) {
    return;
  }
  const serialized = JSON.stringify(value).slice(0, MAX_ERROR_RESPONSE_BYTES);
  const upstreamStatus = timeoutStatusFromText(serialized);
  if (upstreamStatus !== null) {
    throw new LlmRequestTimeoutError(timeoutMs, upstreamStatus);
  }
  throw new Error('主连接流式请求返回了错误。');
}

function numericValue(value: unknown): number | null {
  if (
    (typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && !value.trim())
  ) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function mergeUsage(
  target: Record<string, unknown>,
  source: unknown,
  depth = 0,
): void {
  if (!isRecord(source) || depth > 4) {
    return;
  }
  for (const [key, value] of Object.entries(source)) {
    if (isRecord(value)) {
      const nested = isRecord(target[key]) ? target[key] : {};
      target[key] = nested;
      mergeUsage(nested, value, depth + 1);
      continue;
    }
    const numeric = numericValue(value);
    if (numeric !== null) {
      const existing = numericValue(target[key]);
      target[key] = existing === null ? numeric : Math.max(existing, numeric);
    } else if (target[key] === undefined && typeof value !== 'object') {
      target[key] = value;
    }
  }
}

function firstRecord(value: unknown): Record<string, unknown> {
  return Array.isArray(value) && isRecord(value[0]) ? value[0] : {};
}

function inspectChunk(
  value: unknown,
  metadata: StreamMetadata,
  eventType = 'message',
): void {
  if (!isRecord(value)) {
    return;
  }
  const choice = firstRecord(value['choices']);
  const candidate = firstRecord(value['candidates']);
  const delta = isRecord(value['delta']) ? value['delta'] : {};
  const message = isRecord(value['message']) ? value['message'] : {};
  const response = isRecord(value['response']) ? value['response'] : {};
  const finishReason = boundedString(
    choice['finish_reason']
      ?? choice['stop_reason']
      ?? value['finish_reason']
      ?? value['stop_reason']
      ?? value['stopReason']
      ?? delta['stop_reason']
      ?? candidate['finishReason'],
  );
  if (finishReason) {
    metadata.finishReason = finishReason;
    metadata.terminal = true;
  }
  const type = boundedString(value['type']) ?? boundedString(eventType);
  if (
    type === 'message_stop'
    || type === 'message-end'
    || type === 'response.completed'
    || value['done'] === true
  ) {
    metadata.terminal = true;
    metadata.terminalEvent = true;
  }
  if (!metadata.model) {
    const model = boundedString(value['model'] ?? message['model'] ?? response['model']);
    if (model) {
      metadata.model = model;
    }
  }
  mergeUsage(metadata.usage, value['usage']);
  mergeUsage(metadata.usage, message['usage']);
  mergeUsage(metadata.usage, response['usage']);
  mergeUsage(metadata.usageMetadata, value['usageMetadata']);
}

function looksLikeTauriStreamErrorText(value: string): boolean {
  return /^\s*\[(?:API(?:[\s_-]+)?(?:Error|错误|錯誤)|[^\]]*\bAPI)\]/iu.test(value);
}

function makePayload(text: string, metadata: StreamMetadata): Record<string, unknown> {
  const choice: Record<string, unknown> = {
    message: { role: 'assistant', content: text },
  };
  if (metadata.finishReason) {
    choice['finish_reason'] = metadata.finishReason;
  }
  return {
    ...(metadata.model ? { model: metadata.model } : {}),
    choices: [choice],
    ...(Object.keys(metadata.usage).length > 0 ? { usage: metadata.usage } : {}),
    ...(Object.keys(metadata.usageMetadata).length > 0
      ? { usageMetadata: metadata.usageMetadata }
      : {}),
  };
}

async function readStream(
  response: Response,
  runtime: MainStreamingRuntime,
  identity: MainConnectionIdentity,
  timeoutMs: number,
): Promise<MainStreamingCompletion> {
  if (!response.body) {
    throw new Error('主连接没有返回可读取的流式响应。');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const metadata: StreamMetadata = {
    terminal: false,
    terminalEvent: false,
    usage: {},
    usageMetadata: {},
  };
  const state: MainStreamState = {
    reasoning: '',
    images: [],
    signature: '',
    toolSignatures: {},
    native: null,
  };
  let text = '';
  let buffer = '';
  let receivedBytes = 0;
  let sawDoneMarker = false;
  let reachedEof = false;

  const consume = (event: SseEvent): void => {
    if (event.data === '[DONE]') {
      sawDoneMarker = true;
      metadata.terminal = true;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data) as unknown;
    } catch {
      throw new Error('主连接返回了无法解析的流式数据。');
    }
    throwStreamPayloadError(parsed, timeoutMs, event.event);
    inspectChunk(parsed, metadata, event.event);
    const next = runtime.getStreamingReply(parsed, state, {
      chatCompletionSource: identity.source,
      model: identity.model,
      overrideShowThoughts: false,
    });
    if (typeof next !== 'string') {
      throw new Error('主连接返回了无效的流式文本。');
    }
    if (!text && next && looksLikeTauriStreamErrorText(next)) {
      throw new Error('主连接流式请求返回了错误。');
    }
    text += next;
  };

  try {
    readLoop: while (true) {
      const { done, value } = await reader.read();
      if (done) {
        reachedEof = true;
        buffer += decoder.decode();
      } else {
        receivedBytes += value.byteLength;
        if (receivedBytes > MAX_STREAM_BYTES) {
          throw new Error('主连接流式响应过大。');
        }
        buffer += decoder.decode(value, { stream: true });
      }
      const extracted = takeSseEvents(buffer);
      buffer = extracted.remainder;
      for (const event of extracted.events) {
        consume(event);
        if (sawDoneMarker || metadata.terminalEvent) {
          break readLoop;
        }
      }
      if (done) {
        break;
      }
    }

    if (!metadata.terminal) {
      const possibleJson = buffer.trim();
      if (possibleJson.startsWith('{') && possibleJson.endsWith('}')) {
        try {
          throwStreamPayloadError(JSON.parse(possibleJson) as unknown, timeoutMs);
        } catch (error) {
          if (error instanceof SyntaxError) {
            // The incomplete-stream error below is the stable public result.
          } else {
            throw error;
          }
        }
      }
      throw new Error('主连接流式响应未完整结束，已丢弃未完成内容。');
    }
    return { text, payload: makePayload(text, metadata) };
  } finally {
    if (!reachedEof) {
      try {
        await reader.cancel();
      } catch {
        // The completed/error result above is authoritative.
      }
    }
    reader.releaseLock();
  }
}

async function prepareMessages(
  context: SillyTavernContext,
  systemPrompt: string,
  prompt: string,
): Promise<Array<Record<string, unknown>>> {
  const substitute = (value: string): string => context.substituteParams?.(value) ?? value;
  const event = eventName(context, 'CHAT_COMPLETION_PROMPT_READY');
  const data: { chat: Array<Record<string, unknown>>; dryRun: boolean } = {
    chat: [
      { role: 'system', content: substitute(systemPrompt).trim() },
      { role: 'user', content: substitute(prompt.trim()) },
    ],
    dryRun: false,
  };
  if (event) {
    await context.eventSource?.emit?.call(context.eventSource, event, data);
  }
  if (!Array.isArray(data.chat)) {
    throw new Error('主连接提示词处理器返回了无效消息。');
  }
  return data.chat.filter(isRecord);
}

async function throwHttpError(response: Response, timeoutMs: number): Promise<never> {
  let detail = '';
  try {
    detail = await readResponseTextWithLimit(
      response,
      MAX_ERROR_RESPONSE_BYTES,
      '主连接错误响应过大。',
    );
  } catch {
    // Status-based handling below remains safe and deterministic.
  }
  const upstreamStatus = isRetriableUpstreamTimeoutStatus(response.status)
    ? response.status
    : timeoutStatusFromText(detail);
  if (upstreamStatus !== null) {
    throw new LlmRequestTimeoutError(timeoutMs, upstreamStatus);
  }
  throw new Error(`主连接流式请求失败（HTTP ${response.status}）。`);
}

export async function completeMainConnectionStream(
  request: MainStreamingRequest,
): Promise<MainStreamingCompletion> {
  const controller = new AbortController();
  const abortFromSignal = (): void => {
    controller.abort(
      request.signal?.reason ?? new StoryEchoTaskCancelledError('请求已失效'),
    );
  };
  const abortFromStop = (): void => {
    controller.abort(new StoryEchoTaskCancelledError('生成已停止'));
  };
  const stopEvent = eventName(request.context, 'GENERATION_STOPPED');
  const eventSource = request.context.eventSource;
  const remove = eventSource?.off ?? eventSource?.removeListener;
  if (request.signal?.aborted) {
    abortFromSignal();
  } else {
    request.signal?.addEventListener('abort', abortFromSignal, { once: true });
  }
  if (stopEvent) {
    eventSource?.on(stopEvent, abortFromStop);
  }

  try {
    controller.signal.throwIfAborted();
    const runtime = await request.loadRuntime();
    controller.signal.throwIfAborted();
    const messages = await prepareMessages(
      request.context,
      request.systemPrompt,
      request.prompt,
    );
    controller.signal.throwIfAborted();
    const settings = {
      ...request.context.chatCompletionSettings,
      stream_openai: true,
      ...(request.responseLength !== undefined
        ? { openai_max_tokens: request.responseLength }
        : {}),
    };
    const generated = await runtime.createGenerationParameters(
      settings,
      request.identity.model,
      'quiet',
      messages,
      { allowToolCalls: false, agentMode: false },
    );
    if (!isRecord(generated) || !isRecord(generated.generate_data)) {
      throw new Error('SillyTavern生成了无效的主连接请求参数。');
    }
    const body = generated.generate_data;
    body['stream'] = true;
    const settingsEvent = eventName(request.context, 'CHAT_COMPLETION_SETTINGS_READY');
    if (settingsEvent) {
      await eventSource?.emit?.call(eventSource, settingsEvent, body);
    }
    controller.signal.throwIfAborted();
    tuneInternalGenerationSettings(body);
    body['stream'] = true;
    body['type'] = 'quiet';
    delete body['n'];
    delete body['tools'];
    delete body['tool_choice'];

    const response = await request.fetchImpl.call(globalThis, GENERATE_ENDPOINT, {
      method: 'POST',
      headers: {
        ...await request.requestHeaders(),
        'Content-Type': 'application/json',
      },
      cache: 'no-cache',
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      return await throwHttpError(response, request.timeoutMs);
    }
    return await readStream(
      response,
      runtime,
      request.identity,
      request.timeoutMs,
    );
  } catch (error) {
    if (controller.signal.aborted) {
      throw controller.signal.reason ?? error;
    }
    throw error;
  } finally {
    request.signal?.removeEventListener('abort', abortFromSignal);
    if (stopEvent && remove) {
      remove.call(eventSource, stopEvent, abortFromStop);
    }
  }
}
