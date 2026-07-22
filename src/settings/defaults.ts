import { SETTINGS_VERSION } from '../core/constants';
import type { StoryEchoSettings } from '../core/types';

export const DEFAULT_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,
  enabled: false,
  memory: {
    enabled: false,
  },
  debug: false,
  recentWindow: {
    size: 10,
    unit: 'turns',
  },
  summary: {
    enabled: true,
    automatic: true,
    targetTurnsPerUpdate: 10,
    windowSize: 4,
    maxTokens: 1_600,
    skeletonMaxTokens: 5_000,
  },
  recall: {
    maxEvents: 3,
    maxTokens: 1200,
    scoreThreshold: 0.25,
    queryMode: 'llm',
  },
  extraction: {
    automatic: false,
    targetTurnsPerChunk: 5,
    reference: {
      mode: 'character-world-info',
      maxTokens: 3_000,
      maxWorldInfoEntries: 5,
    },
  },
  llm: {
    provider: 'main',
    custom: {
      baseUrl: '',
      model: '',
      apiKey: '',
      timeoutMs: 300_000,
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
    volcengine: {
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      model: 'doubao-embedding-vision-251215',
      apiKey: '',
      timeoutMs: 60_000,
      allowInsecureHttp: false,
    },
  },
} satisfies StoryEchoSettings);
