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

export class SettingsRepository {
  get(): StoryEchoSettings {
    const context = getContext();
    const stored = context.extensionSettings[MODULE_ID];
    const settings = mergeKnown(cloneDefaults(), stored);
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
