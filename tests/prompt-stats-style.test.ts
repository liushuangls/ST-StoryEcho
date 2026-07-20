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

describe('latest prompt token card layout', () => {
  it('wraps its header instead of truncating the title and subtitle', () => {
    const cardRule = rule('#story-echo-settings .story-echo-prompt-stats-card {');
    const headerCopyRule = rule(
      '#story-echo-settings .story-echo-prompt-stats-card > .story-echo-section-summary .story-echo-section-summary-title,',
    );
    const totalRule = rule('#story-echo-settings .story-echo-token-total {');

    expect(cardRule).toContain('container-type: inline-size;');
    expect(headerCopyRule).toContain('overflow-wrap: anywhere;');
    expect(headerCopyRule).toContain('white-space: normal;');
    expect(headerCopyRule).not.toContain('text-overflow: ellipsis;');
    expect(totalRule).toContain('max-width: none;');
    expect(totalRule).not.toContain('text-overflow: ellipsis;');
  });

  it('keeps StoryEcho values, metadata and category names fully readable', () => {
    const valueRule = rule('#story-echo-settings .story-echo-token-story-stat > strong {');
    const detailRule = rule('#story-echo-settings .story-echo-token-story-stat > small {');
    const categoryRule = rule('#story-echo-settings .story-echo-token-row-label > span:last-child {');
    const headingMetadataRule = rule(
      '#story-echo-settings .story-echo-token-story-heading > span,',
    );

    for (const wrappedRule of [valueRule, detailRule, categoryRule, headingMetadataRule]) {
      expect(wrappedRule).toContain('overflow-wrap: anywhere;');
      expect(wrappedRule).toContain('white-space: normal;');
      expect(wrappedRule).not.toContain('text-overflow: ellipsis;');
    }
  });

  it('responds to the card width rather than the browser viewport width', () => {
    expect(stylesheet).toContain('@container story-echo-prompt-stats (max-width: 46rem)');
    expect(stylesheet).toContain('@container story-echo-prompt-stats (max-width: 32rem)');
    expect(stylesheet).toContain('@container story-echo-prompt-stats (max-width: 17rem)');
    expect(stylesheet).toContain(
      '#story-echo-settings .story-echo-token-story-stat:last-child {\n    grid-column: 1 / -1;',
    );
    expect(stylesheet).toContain(
      '#story-echo-settings .story-echo-token-rows {\n    grid-template-columns: 1fr;',
    );
  });
});
