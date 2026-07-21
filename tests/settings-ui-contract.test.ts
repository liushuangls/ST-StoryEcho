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
  'story-echo-memory-enabled': 'change',
  'story-echo-window-size': 'input',
  'story-echo-window-unit': 'change',
  'story-echo-summary-turns': 'input',
  'story-echo-summary-window': 'input',
  'story-echo-summary-max-tokens': 'input',
  'story-echo-skeleton-max-tokens': 'input',
  'story-echo-max-events': 'input',
  'story-echo-max-tokens': 'input',
  'story-echo-threshold': 'input',
  'story-echo-query-mode': 'change',
  'story-echo-provider': 'change',
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
  it('places both feature switches together above the collapsible settings', () => {
    const masterSwitch = source.indexOf('id="story-echo-enabled"');
    const memorySwitch = source.indexOf('id="story-echo-memory-enabled"');
    const contextWindow = source.indexOf('>上下文窗口</span>');

    expect(masterSwitch).toBeGreaterThan(0);
    expect(memorySwitch).toBeGreaterThan(masterSwitch);
    expect(memorySwitch).toBeLessThan(contextWindow);
  });

  it('keeps story-processing reference controls visible when memory retrieval is disabled', () => {
    const referenceTitle = source.indexOf('>剧情处理参考</span>');
    const sectionStart = source.lastIndexOf('<details', referenceTitle);
    const sectionEnd = source.indexOf('</details>', referenceTitle);
    const referenceSection = source.slice(sectionStart, sectionEnd);

    expect(referenceTitle).toBeGreaterThan(0);
    expect(referenceSection).toContain('id="story-echo-reference-mode"');
    expect(referenceSection).toContain('id="story-echo-reference-tokens"');
    expect(referenceSection).toContain('id="story-echo-reference-world-info"');
    expect(referenceSection).not.toContain('data-story-echo-memory-only');
  });

  it('places the memory metadata manager above the action and status blocks', () => {
    const manager = source.indexOf('${memoryManagerTemplate()}');
    const actions = source.indexOf('<div class="story-echo-actions story-echo-actions-primary"');
    const status = source.indexOf('<div id="story-echo-status"');

    expect(manager).toBeGreaterThan(0);
    expect(manager).toBeLessThan(actions);
    expect(actions).toBeLessThan(status);
  });

  it('places the editable summary manager inside the historical-summary section', () => {
    const historySection = source.indexOf('>历史总结与全局骨架</span>');
    const manager = source.indexOf('${stageSummaryManagerTemplate()}');
    const modelSection = source.indexOf('>模型来源</span>');

    expect(historySection).toBeGreaterThan(0);
    expect(manager).toBeGreaterThan(historySection);
    expect(manager).toBeLessThan(modelSection);
  });

  it('places the latest prompt token card beside the runtime diagnostics', () => {
    const status = source.indexOf('<div id="story-echo-status"');
    const tokenCard = source.indexOf('${promptStatsCardTemplate()}');
    const summaryDiagnostics = source.indexOf('<summary>当前骨架与阶段总结</summary>');

    expect(tokenCard).toBeGreaterThan(status);
    expect(tokenCard).toBeLessThan(summaryDiagnostics);
  });

  it('refreshes prompt statistics after completed, stopped, swiped and loaded generations', () => {
    for (const eventName of [
      'MESSAGE_RECEIVED',
      'MESSAGE_SWIPED',
      'MESSAGE_DELETED',
      'GENERATION_STOPPED',
      'GENERATION_ENDED',
      'ITEMIZED_PROMPTS_LOADED',
      'ITEMIZED_PROMPTS_SAVED',
    ]) {
      expect(source).toContain(`context.event_types?.['${eventName}']`);
    }
    expect(source).toContain('promptTokenStatsCard.render(panel)');
  });

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
