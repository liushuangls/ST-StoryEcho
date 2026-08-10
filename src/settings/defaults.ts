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
    level1EntriesPerGroup: 10,
    higherLevelEntriesPerGroup: 5,
    level1MaxTokens: 3_000,
    higherLevelMaxTokens: 8_000,
    reference: {
      enabled: true,
      maxWorldInfoEntries: 20,
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
