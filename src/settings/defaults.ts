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
  summary: {
    targetTurnsPerUpdate: 10,
    windowSize: 4,
    maxTokens: 1_600,
    skeletonMaxTokens: 5_000,
    reference: {
      enabled: true,
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
    },
  },
} satisfies StoryEchoSettings);
