import type { LlmProvider, LlmRequest } from '../core/types';
import { getContext } from '../platform/sillytavern';
import { withInternalGeneration } from './internal-generation';

export class MainLlmProvider implements LlmProvider {
  readonly id = 'main' as const;

  async complete(request: LlmRequest): Promise<string> {
    const context = getContext();
    const options: {
      systemPrompt: string;
      prompt: string;
      jsonSchema?: Record<string, unknown>;
    } = {
      systemPrompt: request.system,
      prompt: request.prompt,
    };

    if (request.jsonSchema) {
      options.jsonSchema = request.jsonSchema;
    }

    return withInternalGeneration(() => context.generateRaw(options));
  }

  async testConnection(): Promise<void> {
    const response = await this.complete({
      system: 'You are a connection test. Follow the user instruction exactly.',
      prompt: 'Reply with exactly: OK',
    });

    if (!response.trim()) {
      throw new Error('主连接返回了空响应。');
    }
  }
}
