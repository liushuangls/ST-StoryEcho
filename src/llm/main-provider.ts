import type { LlmProvider, LlmRequest, LlmStructuredOutputMode } from '../core/types';
import {
  getContext,
  getMainConnectionIdentity,
  type MainConnectionIdentity,
} from '../platform/sillytavern';
import { markInternalGenerationRequest, withInternalGeneration } from './internal-generation';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Background memory work should not inherit an expensive role-play reasoning
 * preset. Some reasoning models otherwise spend the entire response budget on
 * hidden thoughts and return no answer at all. Only fields already supplied by
 * SillyTavern are changed, so providers without reasoning controls are left
 * untouched.
 */
function jsonObjectBody(current: unknown): string {
  const existing = typeof current === 'string' ? current.trim() : '';
  if (/^\s*response_format\s*:/m.test(existing)) {
    return existing;
  }
  return [existing, 'response_format:\n  type: json_object'].filter(Boolean).join('\n');
}

function enableJsonObjectMode(value: unknown): void {
  if (!isRecord(value)) {
    return;
  }
  const source = typeof value['chat_completion_source'] === 'string'
    ? value['chat_completion_source']
    : '';
  if (source === 'custom') {
    value['custom_include_body'] = jsonObjectBody(value['custom_include_body']);
    return;
  }
  if (source === 'deepseek') {
    // SillyTavern's DeepSeek backend converts json_schema into
    // response_format.type=json_object. The full schema/example already lives
    // in the prompt, so a minimal value avoids duplicating it in the request.
    value['json_schema'] = {
      name: 'story_echo_response',
      strict: false,
      value: { type: 'object' },
    };
  }
}

export function tuneInternalGenerationSettings(
  value: unknown,
  structuredOutput?: LlmStructuredOutputMode,
): void {
  if (!isRecord(value)) {
    return;
  }
  if ('reasoning_effort' in value) {
    value['reasoning_effort'] = 'low';
  }
  if (isRecord(value['thinking']) && 'type' in value['thinking']) {
    value['thinking'] = { ...value['thinking'], type: 'disabled' };
  }
  if ('enable_thinking' in value) {
    value['enable_thinking'] = false;
  }
  if ('temperature' in value) {
    value['temperature'] = 0;
  }
  if ('top_p' in value) {
    value['top_p'] = 1;
  }
  if (structuredOutput === 'json-object') {
    enableJsonObjectMode(value);
  }
}

async function withLightweightMainReasoning<T>(
  context: ReturnType<typeof getContext>,
  request: LlmRequest,
  operation: () => Promise<T>,
): Promise<T> {
  const eventName = context.eventTypes?.['CHAT_COMPLETION_SETTINGS_READY']
    ?? context.event_types?.['CHAT_COMPLETION_SETTINGS_READY'];
  const eventSource = context.eventSource;
  const remove = eventSource?.off ?? eventSource?.removeListener;
  if (!eventName || !eventSource || !remove) {
    return operation();
  }

  const handler = (settings: unknown): void => tuneInternalGenerationSettings(
    settings,
    request.structuredOutput,
  );
  eventSource.on(eventName, handler);
  try {
    return await operation();
  } finally {
    remove.call(eventSource, eventName, handler);
  }
}

function currentIdentity(): MainConnectionIdentity {
  try {
    return getMainConnectionIdentity();
  } catch {
    return { mainApi: '', source: '', model: '' };
  }
}

export function isDeepSeekConnection(identity: MainConnectionIdentity): boolean {
  const model = identity.model.toLocaleLowerCase().split('/').at(-1) ?? '';
  return identity.source === 'deepseek' || model.startsWith('deepseek-');
}

function hasSettingsReadyHook(context: ReturnType<typeof getContext>): boolean {
  const eventName = context.eventTypes?.['CHAT_COMPLETION_SETTINGS_READY']
    ?? context.event_types?.['CHAT_COMPLETION_SETTINGS_READY'];
  const remove = context.eventSource?.off ?? context.eventSource?.removeListener;
  return Boolean(eventName && context.eventSource && remove);
}

export class MainLlmProvider implements LlmProvider {
  readonly id = 'main' as const;

  supportsStructuredOutput(mode: LlmStructuredOutputMode): boolean {
    if (mode === 'text') {
      return true;
    }
    const identity = currentIdentity();
    const isChatCompletion = !identity.mainApi || identity.mainApi === 'openai';
    if (!isChatCompletion) {
      return false;
    }
    if (mode === 'json-schema') {
      // Native DeepSeek only offers JSON Object mode. Repeating the same request
      // under a json-schema label would waste a paid retry.
      return identity.source !== 'deepseek';
    }
    const context = getContext();
    return hasSettingsReadyHook(context)
      && (identity.source === 'custom' || identity.source === 'deepseek');
  }

  structuredOutputOrder(): readonly LlmStructuredOutputMode[] {
    return isDeepSeekConnection(currentIdentity())
      ? ['json-object', 'json-schema', 'text']
      : ['json-schema', 'json-object', 'text'];
  }

  async complete(request: LlmRequest): Promise<string> {
    const context = getContext();
    const markedRequest = markInternalGenerationRequest(request.system, request.prompt);
    const options: {
      systemPrompt: string;
      prompt: string;
      jsonSchema?: Record<string, unknown>;
      responseLength?: number;
    } = {
      systemPrompt: markedRequest.systemPrompt,
      prompt: markedRequest.prompt,
    };

    if (request.structuredOutput === 'json-schema' && request.jsonSchema) {
      options.jsonSchema = request.jsonSchema;
    }
    if (request.maxTokens) {
      options.responseLength = Math.min(10_000, Math.max(16, Math.floor(request.maxTokens)));
    }

    const response = await withInternalGeneration(markedRequest, () => withLightweightMainReasoning(
      context,
      request,
      () => context.generateRaw(options),
    ));
    // The marker exists only for request routing. A model may occasionally
    // echo the final prompt line, so strip the exact request nonce before any
    // parser or stage-summary storage sees it.
    return response.replaceAll(`[${markedRequest.marker}]`, '').trim();
  }

  async testConnection(): Promise<void> {
    const response = await this.complete({
      system: 'You are a connection test. Follow the user instruction exactly.',
      prompt: 'Reply with exactly: OK',
      // Reasoning models can spend a small output budget entirely on hidden
      // thoughts and return no visible text, which looks like a broken
      // connection even though the request succeeded.
      maxTokens: 128,
    });

    if (!response.trim()) {
      throw new Error('主连接返回了空响应。');
    }
  }
}
