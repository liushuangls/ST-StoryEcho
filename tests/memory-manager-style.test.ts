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

describe('memory manager list layout', () => {
  it('scrolls the list instead of compressing memory rows when entries accumulate', () => {
    const listRule = rule('#story-echo-settings .story-echo-memory-list {');
    const rowRule = rule('#story-echo-settings .story-echo-memory-row {');

    expect(listRule).toContain('overflow-y: auto;');
    expect(rowRule).toContain('flex: 0 0 auto;');
    expect(rowRule).toContain('height: auto;');
    expect(rowRule).toContain('max-height: none;');
  });

  it('keeps long titles and metadata inside their card width', () => {
    const titleRule = rule('#story-echo-settings .story-echo-memory-row-title {');
    const metadataRule = rule('#story-echo-settings .story-echo-memory-row-meta {');

    expect(titleRule).toContain('overflow-wrap: anywhere;');
    expect(metadataRule).toContain('overflow: hidden;');
    expect(metadataRule).toContain('text-overflow: ellipsis;');
    expect(metadataRule).toContain('white-space: nowrap;');
  });

  it('keeps pagination controls outside the scrollable memory list', () => {
    const paginationRule = rule('#story-echo-settings .story-echo-memory-pagination {');
    const hiddenRule = rule('#story-echo-settings .story-echo-memory-pagination[hidden] {');

    expect(paginationRule).toContain('grid-template-columns:');
    expect(hiddenRule).toContain('display: none;');
  });
});

describe('stage summary manager list layout', () => {
  it('uses its own bounded scroll list and non-compressing rows', () => {
    const listRule = rule('#story-echo-settings .story-echo-summary-list {');
    const rowRule = rule('#story-echo-settings .story-echo-summary-row {');

    expect(listRule).toContain('max-height: 18rem;');
    expect(listRule).toContain('overflow-y: auto;');
    expect(rowRule).toContain('flex: 0 0 auto;');
    expect(rowRule).toContain('height: auto;');
    expect(rowRule).toContain('max-height: none;');
  });

  it('keeps long summary previews and metadata inside the card', () => {
    const titleRule = rule('#story-echo-settings .story-echo-summary-row-title {');
    const metadataRule = rule('#story-echo-settings .story-echo-summary-row-meta {');

    expect(titleRule).toContain('overflow-wrap: anywhere;');
    expect(metadataRule).toContain('text-overflow: ellipsis;');
    expect(metadataRule).toContain('white-space: nowrap;');
  });
});
