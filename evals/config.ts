import type { PromptEvalClientConfig } from './openai-compatible-client';
import type { JudgeOutputMode } from './judge-schema';
import type { PairwisePromptLayout } from './pairwise';

export function pairwisePromptLayout(): PairwisePromptLayout {
  const layout = process.env['STORY_ECHO_EVAL_PAIRWISE_LAYOUT']?.trim() || 'segments-json';
  if (layout !== 'segments-json' && layout !== 'full-text-with-index' && layout !== 'inline-segments') throw new Error('未知 A/B 输入布局。');
  return layout;
}

export function judgeOutputMode(): JudgeOutputMode {
  const mode = process.env['STORY_ECHO_EVAL_JUDGE_OUTPUT_MODE']?.trim() || 'text';
  if (mode !== 'text' && mode !== 'json_schema') throw new Error('Judge 输出模式只能是 text 或 json_schema。');
  return mode;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim() ?? '';
  if (!value) throw new Error(`缺少环境变量 ${name}。`);
  return value;
}

export function positiveIntegerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`环境变量 ${name} 必须是正整数。`);
  }
  return value;
}

function normalizedMaxTokenField(
  value: string | undefined,
  fallback: PromptEvalClientConfig['maxTokenField'] = 'max_tokens',
): PromptEvalClientConfig['maxTokenField'] {
  value = value?.trim() || fallback;
  if (value !== 'max_tokens' && value !== 'max_completion_tokens') {
    throw new Error('评测 Token 字段只能是 max_tokens 或 max_completion_tokens。');
  }
  return value;
}

export function clientConfiguration(prefix: '' | 'JUDGE_', fallback?: PromptEvalClientConfig): PromptEvalClientConfig {
  const environmentPrefix = `STORY_ECHO_EVAL_${prefix}`;
  const baseUrl = process.env[`${environmentPrefix}BASE_URL`]?.trim()
    || fallback?.baseUrl || 'https://api.openai.com/v1';
  const explicitKey = process.env[`${environmentPrefix}API_KEY`]?.trim();
  // Never silently send a generator key to a newly configured Judge host.
  if (fallback && !explicitKey && new URL(baseUrl).origin !== new URL(fallback.baseUrl).origin) {
    throw new Error('Judge 使用不同站点时必须显式配置 STORY_ECHO_EVAL_JUDGE_API_KEY。');
  }
  return {
    apiKey: explicitKey || fallback?.apiKey || requiredEnvironment('STORY_ECHO_EVAL_API_KEY'),
    baseUrl,
    model: process.env[`${environmentPrefix}MODEL`]?.trim()
      || fallback?.model || requiredEnvironment('STORY_ECHO_EVAL_MODEL'),
    timeoutMs: positiveIntegerEnvironment(`${environmentPrefix}TIMEOUT_MS`, fallback?.timeoutMs ?? 300_000),
    maxTokenField: normalizedMaxTokenField(process.env[`${environmentPrefix}MAX_TOKEN_FIELD`], fallback?.maxTokenField),
  };
}
