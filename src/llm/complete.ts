import type {
  LlmProvider,
  LlmRequest,
  StoryEchoSettings,
} from '../core/types';
import { logger } from '../core/logger';
import { MainLlmProvider } from './main-provider';
import { createLlmProvider } from './provider-factory';
import {
  BackgroundYieldForForegroundError,
  storyEchoTaskCoordinator,
} from '../runtime/task-coordinator';
import { throwIfStoryEchoTaskCancelled } from '../runtime/task-cancellation';
import {
  recordBackgroundYield,
  recordLocalJsonRepair,
  recordStructuredAttempt,
  recordStructuredFailure,
  recordStructuredProviderFallback,
  recordStructuredSuccess,
} from './structured-diagnostics';
import { repairedJsonText } from './json-repair';
import { isLlmRequestTimeoutError } from './errors';

const MAX_RETRY_TOKENS = 10_000;
export const MAX_LLM_TIMEOUT_RETRIES = 1;

function withActiveTaskSignal(request: LlmRequest): LlmRequest {
  if (request.signal) {
    return request;
  }
  const signal = storyEchoTaskCoordinator.activeTaskSignal();
  return signal ? { ...request, signal } : request;
}

function yieldBackgroundAtRetryBoundary(): void {
  if (storyEchoTaskCoordinator.shouldYieldBackgroundToForeground()) {
    recordBackgroundYield();
    throw new BackgroundYieldForForegroundError();
  }
}

async function completeNonEmpty(
  provider: LlmProvider,
  request: LlmRequest,
): Promise<string> {
  const first = await provider.complete(request);
  if (first.trim()) {
    return first;
  }
  throwIfStoryEchoTaskCancelled(request.signal);
  yieldBackgroundAtRetryBoundary();

  const initialBudget = Math.max(128, Math.floor(request.maxTokens ?? 1_024));
  const retryBudget = Math.min(MAX_RETRY_TOKENS, initialBudget * 2);
  logger.warn(`内部LLM返回空内容，使用 ${retryBudget} Token预算重试一次。`);
  const second = await provider.complete({
    ...request,
    maxTokens: retryBudget,
  });
  if (!second.trim()) {
    throw new Error('内部LLM连续两次返回空内容。');
  }
  return second;
}

async function completeNonEmptyWithTimeoutRetry(
  provider: LlmProvider,
  request: LlmRequest,
): Promise<string> {
  for (let retry = 0; ; retry += 1) {
    try {
      return await completeNonEmpty(provider, request);
    } catch (error) {
      throwIfStoryEchoTaskCancelled(request.signal);
      if (!isLlmRequestTimeoutError(error) || retry >= MAX_LLM_TIMEOUT_RETRIES) {
        throw error;
      }
      yieldBackgroundAtRetryBoundary();
      logger.warn(
        `内部LLM请求超时，仅重试当前请求（${retry + 1}/${MAX_LLM_TIMEOUT_RETRIES}）。`,
      );
    }
  }
}

function exampleFromSchema(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const schema = value as Record<string, unknown>;
  if (Array.isArray(schema['enum']) && schema['enum'].length > 0) {
    return schema['enum'][0];
  }
  if ('const' in schema) {
    return schema['const'];
  }
  switch (schema['type']) {
    case 'object': {
      const properties = schema['properties'];
      if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
        return {};
      }
      const propertyRecord = properties as Record<string, unknown>;
      const required = Array.isArray(schema['required'])
        ? schema['required'].filter((item): item is string => typeof item === 'string')
        : Object.keys(propertyRecord);
      return Object.fromEntries(required.map((key) => [
        key,
        exampleFromSchema(propertyRecord[key]),
      ]));
    }
    case 'array':
      // A non-empty example communicates the item shape even when the real
      // response is allowed to contain an empty array.
      return [exampleFromSchema(schema['items'])];
    case 'integer':
    case 'number':
      return typeof schema['minimum'] === 'number' ? schema['minimum'] : 0;
    case 'boolean':
      return false;
    case 'string':
      return '示例文本';
    default:
      return null;
  }
}

export function withJsonInstructions(request: LlmRequest): LlmRequest {
  if (!request.jsonSchema) {
    throw new Error('结构化LLM请求缺少JSON Schema。');
  }
  const example = request.jsonExample ?? exampleFromSchema(request.jsonSchema);
  const instructions = [
    '你必须只输出一个合法的 json 值，不得输出Markdown代码围栏或额外解释。',
    '示例只用于说明JSON形状，不得机械复制；是否返回空数组或空结果必须由当前输入和任务规则决定。实际字段必须严格来自当前输入。',
    'JSON SCHEMA:',
    JSON.stringify(request.jsonSchema, null, 2),
    'EXAMPLE JSON OUTPUT:',
    JSON.stringify(example, null, 2),
  ].join('\n');
  return {
    ...request,
    system: `${request.system}\n\n${instructions}`,
  };
}

async function completeStructuredWithProvider<T>(
  provider: LlmProvider,
  request: LlmRequest,
  parse: (raw: string) => T,
): Promise<T> {
  const instructed = withJsonInstructions(request);
  const failures: string[] = [];
  for (const mode of provider.structuredOutputOrder()) {
    yieldBackgroundAtRetryBoundary();
    if (!provider.supportsStructuredOutput(mode)) {
      logger.debug(`${provider.id}不支持${mode}，跳过该结构化层级。`);
      continue;
    }
    try {
      recordStructuredAttempt(provider.id, mode);
      const raw = await completeNonEmptyWithTimeoutRetry(provider, {
        ...instructed,
        structuredOutput: mode,
      });
      let parsed: T;
      try {
        parsed = parse(raw);
      } catch (initialError) {
        try {
          parsed = parse(repairedJsonText(raw));
          recordLocalJsonRepair();
          logger.info(`${provider.id}的${mode}输出已由本地JSON语法修复，无需再次调用LLM。`);
        } catch {
          throw initialError;
        }
      }
      recordStructuredSuccess(provider.id, mode);
      return parsed;
    } catch (error) {
      throwIfStoryEchoTaskCancelled(request.signal);
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${mode}: ${message}`);
      recordStructuredFailure(provider.id, mode);
      logger.warn(`${provider.id}的${mode}结构化输出失败，尝试下一层。`, error);
    }
  }
  throw new Error(`${provider.id}的结构化输出全部失败：${failures.join(' | ')}`);
}

export async function completeStructuredWithConfiguredProvider<T>(
  settings: StoryEchoSettings,
  request: LlmRequest,
  parse: (raw: string) => T,
): Promise<T> {
  request = withActiveTaskSignal(request);
  const provider = createLlmProvider(settings);
  try {
    return await completeStructuredWithProvider(provider, request, parse);
  } catch (error) {
    throwIfStoryEchoTaskCancelled(request.signal);
    if (provider.id !== 'openai-compatible' || !settings.llm.custom.fallbackToMain) {
      throw error;
    }
    yieldBackgroundAtRetryBoundary();
    logger.warn('自定义LLM的三种结构化模式均失败，回退到SillyTavern主连接。', error);
    recordStructuredProviderFallback();
    return completeStructuredWithProvider(new MainLlmProvider(), request, parse);
  }
}

export async function completeWithConfiguredProvider(
  settings: StoryEchoSettings,
  request: LlmRequest,
): Promise<string> {
  request = withActiveTaskSignal(request);
  const provider = createLlmProvider(settings);
  try {
    return await completeNonEmptyWithTimeoutRetry(provider, request);
  } catch (error) {
    throwIfStoryEchoTaskCancelled(request.signal);
    if (provider.id !== 'openai-compatible' || !settings.llm.custom.fallbackToMain) {
      throw error;
    }
    yieldBackgroundAtRetryBoundary();
    logger.warn('自定义LLM调用失败，回退到SillyTavern主连接。', error);
    return completeNonEmptyWithTimeoutRetry(new MainLlmProvider(), request);
  }
}
