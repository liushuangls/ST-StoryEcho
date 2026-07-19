import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/ui/settings-panel.ts', import.meta.url), 'utf8');
const syncFormSource = source.slice(
  source.indexOf('function syncForm('),
  source.indexOf('function bindSettings('),
);
const bindSettingsSource = source.slice(
  source.indexOf('function bindSettings('),
  source.indexOf('async function refreshStatus('),
);

const EDITABLE_CONTROLS: Readonly<Record<string, 'input' | 'change'>> = {
  'story-echo-enabled': 'change',
  'story-echo-window-size': 'input',
  'story-echo-window-unit': 'change',
  'story-echo-summary-enabled': 'change',
  'story-echo-summary-automatic': 'change',
  'story-echo-summary-turns': 'input',
  'story-echo-summary-window': 'input',
  'story-echo-summary-max-tokens': 'input',
  'story-echo-max-events': 'input',
  'story-echo-max-tokens': 'input',
  'story-echo-threshold': 'input',
  'story-echo-query-mode': 'change',
  'story-echo-provider': 'change',
  'story-echo-auto-extract': 'change',
  'story-echo-extraction-turns': 'input',
  'story-echo-reference-mode': 'change',
  'story-echo-reference-tokens': 'input',
  'story-echo-reference-world-info': 'input',
  'story-echo-debug': 'change',
  'story-echo-base-url': 'change',
  'story-echo-model': 'input',
  'story-echo-model-select': 'change',
  'story-echo-api-key': 'input',
  'story-echo-allow-http': 'change',
  'story-echo-fallback-main': 'change',
  'story-echo-vector-source': 'change',
  'story-echo-embedding-base-url': 'change',
  'story-echo-embedding-model': 'input',
  'story-echo-embedding-api-key': 'input',
  'story-echo-embedding-allow-http': 'change',
  'story-echo-volcengine-base-url': 'change',
  'story-echo-volcengine-model': 'input',
  'story-echo-volcengine-api-key': 'input',
  'story-echo-volcengine-allow-http': 'change',
};

describe('settings panel editable-control contract', () => {
  it('uses each field default while a numeric input is temporarily empty', () => {
    const numberValueSource = source.slice(
      source.indexOf('function numberValue('),
      source.indexOf('function populateCustomModelOptions('),
    );
    expect(numberValueSource).toContain('if (!raw)');
    expect(numberValueSource).toContain('return fallback;');
  });

  it.each(Object.entries(EDITABLE_CONTROLS))(
    'hydrates and persists #%s on %s',
    (controlId, eventName) => {
      expect(syncFormSource).toContain(`'#${controlId}'`);
      const marker = `'#${controlId}'`;
      const bindings: string[] = [];
      let bindingStart = bindSettingsSource.indexOf(marker);
      while (bindingStart >= 0) {
        bindings.push(bindSettingsSource.slice(bindingStart, bindingStart + 220));
        bindingStart = bindSettingsSource.indexOf(marker, bindingStart + marker.length);
      }
      expect(bindings.some((binding) => binding.includes(`addEventListener('${eventName}'`)))
        .toBe(true);
    },
  );

  it('persists extraction batch size while typing and immediately schedules accumulated work', () => {
    const start = bindSettingsSource.indexOf("'#story-echo-extraction-turns'");
    const binding = bindSettingsSource.slice(start, start + 600);

    expect(binding).toContain("addEventListener('input'");
    expect(binding).toContain('settings.extraction.targetTurnsPerChunk');
    expect(binding).toContain('scheduleDerivedUpdate();');
  });
});
