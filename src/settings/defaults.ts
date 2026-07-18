import { SETTINGS_VERSION } from '../core/constants';
import type { StoryEchoSettings } from '../core/types';

export const DEFAULT_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,
  enabled: false,
  debug: false,
  recentWindow: {
    size: 10,
    unit: 'turns',
  },
  recall: {
    maxEvents: 5,
    maxTokens: 1200,
    scoreThreshold: 0.25,
    queryMode: 'llm',
  },
  extraction: {
    automatic: true,
    targetTurnsPerChunk: 3,
  },
  llm: {
    provider: 'main',
    custom: {
      baseUrl: '',
      model: '',
      apiKey: '',
      timeoutMs: 60_000,
      allowInsecureHttp: false,
      fallbackToMain: true,
      strictJsonSchema: false,
    },
  },
  vector: {
    source: 'inherit',
    model: '',
    custom: {
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      model: '',
      apiKey: '',
      timeoutMs: 60_000,
      allowInsecureHttp: false,
    },
  },
} satisfies StoryEchoSettings);
