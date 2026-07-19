import type { LlmProvider, LlmRequest } from '../core/types';
import { getContext } from '../platform/sillytavern';
import { withInternalGeneration } from './internal-generation';

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
export function tuneInternalGenerationSettings(value: unknown): void {
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
}

async function withLightweightMainReasoning<T>(
  context: ReturnType<typeof getContext>,
  operation: () => Promise<T>,
): Promise<T> {
  const eventName = context.event_types?.['CHAT_COMPLETION_SETTINGS_READY'];
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

  async complete(request: LlmRequest): Promise<string> {
    const context = getContext();
    const options: {
      systemPrompt: string;
      prompt: string;
      responseLength?: number;
    } = {
      systemPrompt: request.system,
      prompt: request.prompt,
    };

    // Main-connection providers vary widely in JSON Schema support. Several
    // SillyTavern backends return an empty object when structured generation
    // is requested even though the model produced useful text. StoryEcho's
    // prompts and parsers already enforce and normalize JSON, so the main
    // connection deliberately uses prompt-only JSON mode. Custom providers
    // can still opt into strict schemas through their dedicated setting.
    if (request.maxTokens) {
      options.responseLength = Math.min(8_192, Math.max(16, Math.floor(request.maxTokens)));
    }

    return withInternalGeneration(() => withLightweightMainReasoning(
      context,
      () => context.generateRaw(options),
    ));
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
