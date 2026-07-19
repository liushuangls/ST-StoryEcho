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

export class SettingsRepository {
  get(): StoryEchoSettings {
    const context = getContext();
    const stored = context.extensionSettings[MODULE_ID];
    const settings = mergeKnown(cloneDefaults(), stored);
    migrateLegacyVolcengineEmbedding(settings, stored);
    migratePerformanceDefaults(settings, stored);
    context.extensionSettings[MODULE_ID] = settings;
    return settings;
  }

  update(mutator: (settings: StoryEchoSettings) => void): StoryEchoSettings {
    const settings = this.get();
    mutator(settings);
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
