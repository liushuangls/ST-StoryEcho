import type { LlmCompletionResult, LlmProvider, LlmRequest } from '../core/types';
import { getConnectionProfile } from '../platform/connection-profiles';
import { getContext } from '../platform/sillytavern';
import { runStoryEchoTaskAbortable } from '../runtime/task-cancellation';
import { summaryRequestForModel } from '../summary/model-prompts';
import { completionMetadataFromPayload } from './completion-metadata';
import { findRetriableUpstreamTimeoutStatus, LlmRequestTimeoutError } from './errors';
import { markInternalGenerationRequest, withInternalGeneration } from './internal-generation';
import { tuneInternalGenerationSettings } from './internal-settings';
import { assertNoLlmRefusal } from './refusal';

const MAX_TIMEOUT_MS = 600_000;

function upstreamTimeoutStatus(error: unknown): number | null {
  for (let depth = 0; depth < 5 && error instanceof Error; depth += 1) {
    const status = findRetriableUpstreamTimeoutStatus(error.message);
    if (status !== null) return status;
    error = error.cause;
  }
  return null;
}

/** Ask the host to resolve saved credentials without switching its active API. */
export class ConnectionProfileLlmProvider implements LlmProvider {
  readonly id = 'connection-profile' as const;

  constructor(private readonly profileId: string) {}

  async complete(request: LlmRequest): Promise<string> {
    return (await this.completeDetailed(request)).text;
  }

  async completeDetailed(request: LlmRequest): Promise<LlmCompletionResult> {
    const context = getContext();
    const profile = getConnectionProfile(this.profileId, context);
    if (!profile) {
      throw new Error('所选连接插头不存在或已删除，请重新选择。');
    }
    if (profile.unavailableReason) {
      throw new Error(`所选连接插头不可用：${profile.unavailableReason}。`);
    }
    const service = context.ConnectionManagerRequestService!;
    request = summaryRequestForModel(request, profile.model);
    const marked = markInternalGenerationRequest(request.system, request.prompt);
    const maxTokens = Number.isFinite(request.maxTokens)
      ? Math.min(16_000, Math.max(16, Math.floor(request.maxTokens!)))
      : 3_000;
    const timeoutMs = Number.isFinite(request.timeoutMs)
      ? Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Math.floor(request.timeoutMs!)))
      : MAX_TIMEOUT_MS;
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(request.signal?.reason);
    if (request.signal?.aborted) onAbort();
    else request.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = globalThis.setTimeout(
      () => controller.abort(new LlmRequestTimeoutError(timeoutMs)), timeoutMs,
    );
    try {
      const payload = await withInternalGeneration(marked, () => runStoryEchoTaskAbortable(
        async () => {
          const overrides: Record<string, unknown> = {
            type: 'quiet',
            temperature: 0,
            top_p: 1,
            reasoning_effort: 'low',
            include_reasoning: false,
            tools: [],
            tool_choice: 'none',
            function_calling_plain_text: false,
          };
          tuneInternalGenerationSettings(overrides, profile.model);
          try {
            return await service.sendRequest(profile.id, [
              { role: 'system', content: marked.systemPrompt },
              { role: 'user', content: marked.prompt },
            ], maxTokens, {
              // The host's shared streaming service has the same missing-state
              // bug on affected Luker versions. Use its raw, non-streaming seam.
              stream: false,
              signal: controller.signal,
              extractData: false,
              includePreset: false,
              includeInstruct: true,
            }, overrides);
          } catch (error) {
            controller.signal.throwIfAborted();
            const status = upstreamTimeoutStatus(error);
            if (status !== null) throw new LlmRequestTimeoutError(timeoutMs, status);
            // Host errors can contain provider URLs/credentials. Do not surface
            // them through saved diagnostics or notifications.
            throw new Error('已配置连接请求失败，请检查该插头的 API、模型与凭据。');
          }
        }, controller.signal,
      ));
      assertNoLlmRefusal(payload);
      const extracted = context.extractMessageFromData!(payload, profile.mainApi);
      if (typeof extracted !== 'string') {
        throw new Error('所选连接插头返回了无效的文本响应。');
      }
      const text = extracted.replaceAll(`[${marked.marker}]`, '').trim();
      return {
        text,
        metadata: completionMetadataFromPayload(payload, {
          provider: this.id,
          requestedMaxTokens: maxTokens,
          responseText: text,
          source: profile.source,
          model: profile.model,
        }),
      };
    } finally {
      globalThis.clearTimeout(timeout);
      request.signal?.removeEventListener('abort', onAbort);
    }
  }

  async testConnection(): Promise<void> {
    const response = await this.complete({
      system: 'You are a connection test. Follow the user instruction exactly.',
      prompt: 'Reply with exactly: OK',
      maxTokens: 128,
    });
    if (!response.trim()) throw new Error('所选连接插头返回了空响应。');
  }
}
