import { MODULE_ID } from '../core/constants';
import type { StoryEchoSettings } from '../core/types';
import { getContext } from '../platform/sillytavern';
import { DEFAULT_SETTINGS } from './defaults';

function cloneDefaults(): StoryEchoSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as StoryEchoSettings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeKnown<T>(defaults: T, stored: unknown): T {
  if (Array.isArray(defaults)) {
    return (Array.isArray(stored) ? stored : defaults) as T;
  }
  if (!isRecord(defaults)) {
    if (typeof defaults === 'number') {
      return (typeof stored === 'number' && Number.isFinite(stored) ? stored : defaults) as T;
    }
    return (typeof stored === typeof defaults ? stored : defaults) as T;
  }

  const source = isRecord(stored) ? stored : {};
  const result: Record<string, unknown> = {};

  for (const [key, defaultValue] of Object.entries(defaults)) {
    result[key] = mergeKnown(defaultValue, source[key]);
  }

  return result as T;
}

function migrateLegacyVolcengineEmbedding(settings: StoryEchoSettings, stored: unknown): void {
  const storedRoot = isRecord(stored) ? stored : {};
  const storedVector = isRecord(storedRoot['vector']) ? storedRoot['vector'] : {};
  if (isRecord(storedVector['volcengine'])) {
    return;
  }
  const custom = isRecord(storedVector['custom']) ? storedVector['custom'] : {};
  const baseUrl = typeof custom['baseUrl'] === 'string' ? custom['baseUrl'].trim() : '';
  try {
    if (!baseUrl || new URL(baseUrl).hostname !== 'ark.cn-beijing.volces.com') {
      return;
    }
  } catch {
    return;
  }

  settings.vector.volcengine.baseUrl = baseUrl;
  if (typeof custom['apiKey'] === 'string') {
    settings.vector.volcengine.apiKey = custom['apiKey'];
  }
  if (typeof custom['timeoutMs'] === 'number' && Number.isFinite(custom['timeoutMs'])) {
    settings.vector.volcengine.timeoutMs = custom['timeoutMs'];
  }
  settings.vector.volcengine.allowInsecureHttp = custom['allowInsecureHttp'] === true;
  const model = typeof custom['model'] === 'string' ? custom['model'].trim() : '';
  if (model.includes('embedding-vision') || model.startsWith('ep-m-')) {
    settings.vector.volcengine.model = model;
  }
}

function migratePerformanceDefaults(settings: StoryEchoSettings, stored: unknown): void {
  const storedRoot = isRecord(stored) ? stored : {};
  const storedVersion = Number(storedRoot['version']);
  if (!Number.isFinite(storedVersion) || storedVersion < 2) {
    settings.extraction.targetTurnsPerChunk = DEFAULT_SETTINGS.extraction.targetTurnsPerChunk;
  }
  const storedRecall = isRecord(storedRoot['recall']) ? storedRoot['recall'] : {};
  if (
    (!Number.isFinite(storedVersion) || storedVersion < 5) &&
    Number(storedRecall['maxEvents']) === 5
  ) {
    settings.recall.maxEvents = DEFAULT_SETTINGS.recall.maxEvents;
  }
  settings.version = DEFAULT_SETTINGS.version;
}

function boundedInteger(value: number, minimum: number, maximum: number, fallback: number): number {
  return Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.floor(value)))
    : fallback;
}

function boundedNumber(value: number, minimum: number, maximum: number, fallback: number): number {
  return Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function normalizeSettings(settings: StoryEchoSettings): void {
  settings.recentWindow.size = boundedInteger(
    settings.recentWindow.size,
    0,
    1_000,
    DEFAULT_SETTINGS.recentWindow.size,
  );
  if (!['turns', 'messages'].includes(settings.recentWindow.unit)) {
    settings.recentWindow.unit = DEFAULT_SETTINGS.recentWindow.unit;
  }
  settings.summary.targetTurnsPerUpdate = boundedInteger(
    settings.summary.targetTurnsPerUpdate,
    1,
    100,
    DEFAULT_SETTINGS.summary.targetTurnsPerUpdate,
  );
  settings.summary.windowSize = boundedInteger(
    settings.summary.windowSize,
    1,
    100,
    DEFAULT_SETTINGS.summary.windowSize,
  );
  settings.summary.maxTokens = boundedInteger(
    settings.summary.maxTokens,
    128,
    8_192,
    DEFAULT_SETTINGS.summary.maxTokens,
  );
  settings.recall.maxEvents = boundedInteger(
    settings.recall.maxEvents,
    0,
    50,
    DEFAULT_SETTINGS.recall.maxEvents,
  );
  settings.recall.maxTokens = boundedInteger(
    settings.recall.maxTokens,
    0,
    32_000,
    DEFAULT_SETTINGS.recall.maxTokens,
  );
  settings.recall.scoreThreshold = boundedNumber(
    settings.recall.scoreThreshold,
    0,
    1,
    DEFAULT_SETTINGS.recall.scoreThreshold,
  );
  if (!['llm', 'local'].includes(settings.recall.queryMode)) {
    settings.recall.queryMode = DEFAULT_SETTINGS.recall.queryMode;
  }
  settings.extraction.targetTurnsPerChunk = boundedInteger(
    settings.extraction.targetTurnsPerChunk,
    1,
    20,
    DEFAULT_SETTINGS.extraction.targetTurnsPerChunk,
  );
  if (!['off', 'character', 'character-world-info'].includes(settings.extraction.reference.mode)) {
    settings.extraction.reference.mode = DEFAULT_SETTINGS.extraction.reference.mode;
  }
  settings.extraction.reference.maxTokens = boundedInteger(
    settings.extraction.reference.maxTokens,
    256,
    16_000,
    DEFAULT_SETTINGS.extraction.reference.maxTokens,
  );
  settings.extraction.reference.maxWorldInfoEntries = boundedInteger(
    settings.extraction.reference.maxWorldInfoEntries,
    0,
    20,
    DEFAULT_SETTINGS.extraction.reference.maxWorldInfoEntries,
  );
  if (!['main', 'openai-compatible'].includes(settings.llm.provider)) {
    settings.llm.provider = DEFAULT_SETTINGS.llm.provider;
  }
  settings.llm.custom.baseUrl = settings.llm.custom.baseUrl.trim();
  settings.llm.custom.model = settings.llm.custom.model.trim();
  settings.llm.custom.timeoutMs = boundedInteger(
    settings.llm.custom.timeoutMs,
    1_000,
    300_000,
    DEFAULT_SETTINGS.llm.custom.timeoutMs,
  );
  for (const [embedding, defaults] of [
    [settings.vector.custom, DEFAULT_SETTINGS.vector.custom],
    [settings.vector.volcengine, DEFAULT_SETTINGS.vector.volcengine],
  ] as const) {
    embedding.baseUrl = embedding.baseUrl.trim();
    embedding.model = embedding.model.trim();
    embedding.timeoutMs = boundedInteger(
      embedding.timeoutMs,
      1_000,
      300_000,
      defaults.timeoutMs,
    );
  }
  settings.vector.model = settings.vector.model.trim();
  if (!settings.vector.source.trim()) {
    settings.vector.source = DEFAULT_SETTINGS.vector.source;
  }
}

export class SettingsRepository {
  get(): StoryEchoSettings {
    const context = getContext();
    const stored = context.extensionSettings[MODULE_ID];
    const settings = mergeKnown(cloneDefaults(), stored);
    migrateLegacyVolcengineEmbedding(settings, stored);
    migratePerformanceDefaults(settings, stored);
    normalizeSettings(settings);
    context.extensionSettings[MODULE_ID] = settings;
    return settings;
  }

  update(mutator: (settings: StoryEchoSettings) => void): StoryEchoSettings {
    const settings = this.get();
    mutator(settings);
    normalizeSettings(settings);
    getContext().saveSettingsDebounced();
    return settings;
  }

  reset(): StoryEchoSettings {
    const context = getContext();
    const settings = cloneDefaults();
    context.extensionSettings[MODULE_ID] = settings;
    context.saveSettingsDebounced();
    return settings;
  }
}
