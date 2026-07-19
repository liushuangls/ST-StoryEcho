import { describe, expect, it } from 'vitest';
import {
  MEMORY_PAGE_SIZE,
  memoryManagerTemplate,
  paginateItems,
  toggleMemorySelection,
} from '../src/ui/memory-manager';

describe('memory metadata card selection', () => {
  it('opens a different card and closes the currently open card', () => {
    expect(toggleMemorySelection('', 'memory-a')).toBe('memory-a');
    expect(toggleMemorySelection('memory-a', 'memory-b')).toBe('memory-b');
    expect(toggleMemorySelection('memory-a', 'memory-a')).toBe('');
  });
});

describe('memory metadata pagination', () => {
  const items = Array.from({ length: 33 }, (_, index) => `memory-${index + 1}`);

  it('loads only one bounded page of memories', () => {
    const first = paginateItems(items, 1);
    const last = paginateItems(items, 4);

    expect(MEMORY_PAGE_SIZE).toBe(10);
    expect(first.items).toEqual(items.slice(0, 10));
    expect(first.totalItems).toBe(33);
    expect(first.totalPages).toBe(4);
    expect(last.items).toEqual(items.slice(30));
  });

  it('clamps stale pages after filtering or deletion', () => {
    expect(paginateItems(items, 99).page).toBe(4);
    expect(paginateItems(items.slice(0, 9), 4).page).toBe(1);
    expect(paginateItems([], Number.NaN)).toMatchObject({
      items: [],
      page: 1,
      totalPages: 1,
    });
  });

  it('renders accessible previous and next controls', () => {
    const template = memoryManagerTemplate();

    expect(template).toContain('id="story-echo-memory-pagination"');
    expect(template).toContain('aria-label="剧情记忆分页"');
    expect(template).toContain('id="story-echo-memory-previous"');
    expect(template).toContain('id="story-echo-memory-next"');
    expect(template).toContain('aria-live="polite"');
  });
});
