import type { StoryEchoSettings } from '../core/types';
import { sha256 } from '../core/hash';
import { getContext } from '../platform/sillytavern';
import type { VectorRequestConfig } from './adapter';

const MODEL_SETTING_KEYS: Record<string, string> = {
  openai: 'openai_model',
  togetherai: 'togetherai_model',
  electronhub: 'electronhub_model',
  openrouter: 'openrouter_model',
  cohere: 'cohere_model',
  ollama: 'ollama_model',
  vllm: 'vllm_model',
  webllm: 'webllm_model',
  palm: 'google_model',
  vertexai: 'google_model',
  chutes: 'chutes_model',
  nanogpt: 'nanogpt_model',
  siliconflow: 'siliconflow_model',
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

export function vectorConfigFingerprint(config: VectorRequestConfig): Promise<string> {
  return sha256(JSON.stringify(canonicalize(config)));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export function resolveVectorConfig(settings: StoryEchoSettings): VectorRequestConfig {
  const vectorSettings = asRecord(getContext().extensionSettings['vectors']);
  const inheritedSource =
    typeof vectorSettings['source'] === 'string' ? vectorSettings['source'] : 'transformers';
  const source = settings.vector.source === 'inherit' ? inheritedSource : settings.vector.source;
  if (source === 'webllm' || source === 'koboldcpp') {
    throw new Error(`StoryEcho当前不支持${source}，因为该来源需要浏览器先生成向量。`);
  }
  const modelKey = MODEL_SETTING_KEYS[source];
  const inheritedModel = modelKey && typeof vectorSettings[modelKey] === 'string' ? vectorSettings[modelKey] : '';
  const model = settings.vector.model.trim() || inheritedModel;

  const sourceSettings: Record<string, unknown> = {};
  if (source === 'ollama' || source === 'vllm' || source === 'llamacpp') {
    const useAlternateEndpoint = vectorSettings['use_alt_endpoint'] === true;
    const alternateEndpoint =
      typeof vectorSettings['alt_endpoint_url'] === 'string'
        ? vectorSettings['alt_endpoint_url'].trim()
        : '';
    if (!useAlternateEndpoint || !alternateEndpoint) {
      throw new Error(
        `StoryEcho使用${source}时，当前版本需要在Vector Storage中启用并填写替代端点。`,
      );
    }
    sourceSettings['apiUrl'] = alternateEndpoint;
    if (source === 'ollama') {
      sourceSettings['keep'] = vectorSettings['ollama_keep'] === true;
    }
  }

  return {
    source,
    ...(model ? { model } : {}),
    ...(Object.keys(sourceSettings).length > 0 ? { sourceSettings } : {}),
  };
}
