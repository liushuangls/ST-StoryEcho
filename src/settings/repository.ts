import { MODULE_ID } from '../core/constants';
import type { StoryEchoSettings } from '../core/types';
import { getContext } from '../platform/sillytavern';
import { MAX_SUMMARY_MATCHED_WORLD_INFO_ENTRIES } from '../summary/constants';
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
  return Object.fromEntries(Object.entries(defaults).map(([key, defaultValue]) => [
    key,
    mergeKnown(defaultValue, source[key]),
  ])) as T;
}

/**
 * 0.20.x stored the world-book policy under extraction.reference because it
 * was shared with the removed memory extractor. Preserve only the settings
 * that still affect the retained summary hierarchy.
 */
function migrateContextSettings(settings: StoryEchoSettings, stored: unknown): void {
  const root = isRecord(stored) ? stored : {};
  const storedSummary = isRecord(root['summary']) ? root['summary'] : {};
  if (typeof storedSummary['level1EntriesPerGroup'] !== 'number') {
    const legacyCapacity = typeof storedSummary['entriesPerLevel'] === 'number'
      ? storedSummary['entriesPerLevel']
      : storedSummary['windowSize'];
    if (typeof legacyCapacity === 'number') {
      settings.summary.level1EntriesPerGroup = legacyCapacity;
    }
  }
  if (
    typeof storedSummary['level1MaxTokens'] !== 'number' &&
    typeof storedSummary['maxTokens'] === 'number'
  ) {
    settings.summary.level1MaxTokens = storedSummary['maxTokens'];
  }
  if (
    typeof storedSummary['higherLevelMaxTokens'] !== 'number' &&
    typeof storedSummary['skeletonMaxTokens'] === 'number'
  ) {
    settings.summary.higherLevelMaxTokens = storedSummary['skeletonMaxTokens'];
  }
  if (!isRecord(storedSummary['reference'])) {
    const extraction = isRecord(root['extraction']) ? root['extraction'] : {};
    const reference = isRecord(extraction['reference']) ? extraction['reference'] : {};
    if (typeof reference['mode'] === 'string') {
      settings.summary.reference.enabled = reference['mode'] === 'character-world-info';
    }
    if (typeof reference['maxWorldInfoEntries'] === 'number') {
      settings.summary.reference.maxWorldInfoEntries = reference['maxWorldInfoEntries'];
    }
  }

  const storedVersion = Number(root['version']);
  const storedLlm = isRecord(root['llm']) ? root['llm'] : {};
  const storedCustom = isRecord(storedLlm['custom']) ? storedLlm['custom'] : {};
  if (
    (!Number.isFinite(storedVersion) || storedVersion < 9) &&
    Number(storedCustom['timeoutMs']) === 60_000
  ) {
    settings.llm.custom.timeoutMs = DEFAULT_SETTINGS.llm.custom.timeoutMs;
  }
  settings.version = DEFAULT_SETTINGS.version;
}

function boundedInteger(value: number, minimum: number, maximum: number, fallback: number): number {
  return Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.floor(value)))
    : fallback;
}

function normalizeSettings(settings: StoryEchoSettings): void {
  settings.recentWindow.size = boundedInteger(
    settings.recentWindow.size,
    0,
    1_000,
    DEFAULT_SETTINGS.recentWindow.size,
  );
  if (settings.recentWindow.unit !== 'turns' && settings.recentWindow.unit !== 'messages') {
    settings.recentWindow.unit = DEFAULT_SETTINGS.recentWindow.unit;
  }
  settings.summary.targetTurnsPerUpdate = boundedInteger(
    settings.summary.targetTurnsPerUpdate,
    1,
    100,
    DEFAULT_SETTINGS.summary.targetTurnsPerUpdate,
  );
  settings.summary.level1EntriesPerGroup = boundedInteger(
    settings.summary.level1EntriesPerGroup,
    2,
    100,
    DEFAULT_SETTINGS.summary.level1EntriesPerGroup,
  );
  settings.summary.higherLevelEntriesPerGroup = boundedInteger(
    settings.summary.higherLevelEntriesPerGroup,
    2,
    100,
    DEFAULT_SETTINGS.summary.higherLevelEntriesPerGroup,
  );
  settings.summary.level1MaxTokens = boundedInteger(
    settings.summary.level1MaxTokens,
    128,
    16_000,
    DEFAULT_SETTINGS.summary.level1MaxTokens,
  );
  settings.summary.higherLevelMaxTokens = boundedInteger(
    settings.summary.higherLevelMaxTokens,
    512,
    16_000,
    DEFAULT_SETTINGS.summary.higherLevelMaxTokens,
  );
  settings.summary.reference.maxWorldInfoEntries = boundedInteger(
    settings.summary.reference.maxWorldInfoEntries,
    0,
    MAX_SUMMARY_MATCHED_WORLD_INFO_ENTRIES,
    DEFAULT_SETTINGS.summary.reference.maxWorldInfoEntries,
  );
  if (settings.llm.provider !== 'main' && settings.llm.provider !== 'openai-compatible') {
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
}

export class SettingsRepository {
  get(): StoryEchoSettings {
    const context = getContext();
    const stored = context.extensionSettings[MODULE_ID];
    const settings = mergeKnown(cloneDefaults(), stored);
    migrateContextSettings(settings, stored);
    normalizeSettings(settings);
    // Replacing the object intentionally removes obsolete memory, recall and
    // embedding settings (including unused embedding credentials).
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
