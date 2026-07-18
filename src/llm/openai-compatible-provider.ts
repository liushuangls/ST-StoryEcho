import type { LlmProvider, LlmRequest, StoryEchoSettings } from '../core/types';
import { storyEchoServerClient, type StoryEchoServerClient } from '../server/client';
import { normalizeChatCompletionsUrl } from './url';

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id = 'openai-compatible' as const;

  constructor(
    private readonly config: StoryEchoSettings['llm']['custom'],
    private readonly serverClient: StoryEchoServerClient = storyEchoServerClient,
  ) {}

  async complete(request: LlmRequest): Promise<string> {
    const model = this.config.model.trim();
    if (!model) {
      throw new Error('自定义LLM模型名不能为空。');
    }
    const endpoint = normalizeChatCompletionsUrl(this.config.baseUrl, {
      allowInsecureHttp: this.config.allowInsecureHttp,
    });
    return this.serverClient.complete({
      endpoint,
      model,
      timeoutMs: this.config.timeoutMs,
      strictJsonSchema: this.config.strictJsonSchema,
      system: request.system,
      prompt: request.prompt,
      ...(request.jsonSchema ? { jsonSchema: request.jsonSchema } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });
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
