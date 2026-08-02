import type {
  LlmCompletionResult,
  LlmProvider,
  LlmRequest,
} from '../core/types';
import {
  getContext,
  getMainConnectionIdentity,
} from '../platform/sillytavern';
import {
  runStoryEchoTaskAbortable,
  StoryEchoTaskCancelledError,
} from '../runtime/task-cancellation';
import { LlmRequestTimeoutError } from './errors';
import { completionMetadataFromPayload } from './completion-metadata';
import { markInternalGenerationRequest, withInternalGeneration } from './internal-generation';

const MAX_REQUEST_TIMEOUT_MS = 600_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keep background summarization from inheriting an expensive role-play preset. */
export function tuneInternalGenerationSettings(value: unknown): void {
  if (!isRecord(value)) {
    return;
  }
  if ('reasoning_effort' in value) {
    value['reasoning_effort'] = 'low';
  }
  if ('include_reasoning' in value) {
    value['include_reasoning'] = false;
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
}

async function withLightweightMainReasoning<T>(
  context: ReturnType<typeof getContext>,
  operation: () => Promise<T>,
): Promise<T> {
  const eventName = context.eventTypes?.['CHAT_COMPLETION_SETTINGS_READY']
    ?? context.event_types?.['CHAT_COMPLETION_SETTINGS_READY'];
  const eventSource = context.eventSource;
  const remove = eventSource?.off ?? eventSource?.removeListener;
  if (!eventName || !eventSource || !remove) {
    return operation();
  }

  const handler = (settings: unknown): void => tuneInternalGenerationSettings(settings);
  eventSource.on(eventName, handler);
  try {
    return await operation();
  } finally {
    remove.call(eventSource, eventName, handler);
  }
}

export class MainLlmProvider implements LlmProvider {
  readonly id = 'main' as const;

  private async perform(
    request: LlmRequest,
    captureMetadata: boolean,
  ): Promise<{ text: string; payload?: unknown; requestedMaxTokens: number }> {
    const context = getContext();
    const markedRequest = markInternalGenerationRequest(request.system, request.prompt);
    const options: {
      systemPrompt: string;
      prompt: string;
      responseLength?: number;
    } = {
      systemPrompt: markedRequest.systemPrompt,
      prompt: markedRequest.prompt,
    };
    if (request.maxTokens) {
      options.responseLength = Math.min(10_000, Math.max(16, Math.floor(request.maxTokens)));
    }

    const requestedTimeoutMs = typeof request.timeoutMs === 'number'
      && Number.isFinite(request.timeoutMs)
      ? Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(1_000, Math.floor(request.timeoutMs)))
      : null;
    const timeoutController = requestedTimeoutMs === null ? null : new AbortController();
    const onRequestAbort = (): void => {
      timeoutController?.abort(
        request.signal?.reason ?? new StoryEchoTaskCancelledError('请求已失效'),
      );
    };
    if (timeoutController && request.signal) {
      if (request.signal.aborted) {
        onRequestAbort();
      } else {
        request.signal.addEventListener('abort', onRequestAbort, { once: true });
      }
    }
    const timeout = timeoutController && requestedTimeoutMs !== null
      ? globalThis.setTimeout(
        () => timeoutController.abort(new LlmRequestTimeoutError(requestedTimeoutMs)),
        requestedTimeoutMs,
      )
      : null;
    let result: { text: string; payload?: unknown };
    try {
      result = await withInternalGeneration(markedRequest, () => withLightweightMainReasoning(
        context,
        () => runStoryEchoTaskAbortable(
          async () => {
            if (
              captureMetadata &&
              context.generateRawData &&
              context.extractMessageFromData
            ) {
              const payload = await context.generateRawData(options);
              return {
                text: context.extractMessageFromData(payload, context.mainApi),
                payload,
              };
            }
            return { text: await context.generateRaw(options) };
          },
          timeoutController?.signal ?? request.signal,
        ),
      ));
    } finally {
      if (timeout !== null) {
        globalThis.clearTimeout(timeout);
      }
      request.signal?.removeEventListener('abort', onRequestAbort);
    }
    return {
      text: result.text.replaceAll(`[${markedRequest.marker}]`, '').trim(),
      ...(result.payload !== undefined ? { payload: result.payload } : {}),
      requestedMaxTokens: options.responseLength ?? 0,
    };
  }

  async complete(request: LlmRequest): Promise<string> {
    return (await this.perform(request, false)).text;
  }

  async completeDetailed(request: LlmRequest): Promise<LlmCompletionResult> {
    const context = getContext();
    const result = await this.perform(request, true);
    const identity = getMainConnectionIdentity(context);
    return {
      text: result.text,
      metadata: completionMetadataFromPayload(result.payload, {
        provider: this.id,
        requestedMaxTokens: result.requestedMaxTokens,
        responseText: result.text,
        ...(identity.source ? { source: identity.source } : {}),
        ...(identity.model ? { model: identity.model } : {}),
      }),
    };
  }

  async testConnection(): Promise<void> {
    const response = await this.complete({
      system: 'You are a connection test. Follow the user instruction exactly.',
      prompt: 'Reply with exactly: OK',
      maxTokens: 128,
    });
    if (!response.trim()) {
      throw new Error('主连接返回了空响应。');
    }
  }
}
