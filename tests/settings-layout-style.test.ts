import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

function rule(selector: string): string {
  const start = stylesheet.indexOf(selector);
  const end = stylesheet.indexOf('}', start);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return stylesheet.slice(start, end + 1);
}

describe('settings panel action layout', () => {
  it('keeps the host drawer stable while derived context is expanded', () => {
    const panelRule = rule(
      '#story-echo-settings .story-echo-panel-body.story-echo-summary-layout-lock {',
    );

    expect(panelRule).toContain('height: var(--story-echo-summary-layout-height);');
    expect(panelRule).toContain('overflow-y: auto;');
    expect(panelRule).toContain('overscroll-behavior-y: contain;');
  });

  it('keeps the model connection button horizontal and full width', () => {
    const buttonRule = rule('#story-echo-settings .story-echo-model-action {');

    expect(buttonRule).toContain('display: flex;');
    expect(buttonRule).toContain('width: 100%;');
    expect(buttonRule).toContain('max-width: none;');
    expect(buttonRule).toContain('min-width: 0;');
    expect(buttonRule).toContain('white-space: nowrap;');
  });

  it('gives both diagnostic buttons a full horizontal grid cell', () => {
    const containerRule = rule('#story-echo-settings .story-echo-diagnostics-actions {');
    const buttonRule = rule(
      '#story-echo-settings .story-echo-diagnostics-actions .menu_button {',
    );

    expect(containerRule).toContain('display: grid;');
    expect(containerRule).toContain('grid-template-columns: repeat(2, minmax(0, 1fr));');
    expect(buttonRule).toContain('width: 100%;');
    expect(buttonRule).toContain('max-width: none;');
    expect(buttonRule).toContain('min-width: 0;');
    expect(buttonRule).toContain('white-space: nowrap;');
  });

  it('stacks diagnostic buttons on narrow screens', () => {
    expect(stylesheet).toContain(
      '#story-echo-settings .story-echo-diagnostics-actions {\n    grid-template-columns: 1fr;',
    );
  });
});
