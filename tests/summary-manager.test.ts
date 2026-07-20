import { describe, expect, it } from 'vitest';
import type { StageSummaryEntry } from '../src/core/types';
import { paginateItems } from '../src/ui/memory-manager';
import {
  SUMMARY_PAGE_SIZE,
  stageSummaryDeletionMode,
  stageSummaryKey,
  stageSummaryManagerTemplate,
  toggleSummarySelection,
} from '../src/ui/summary-manager';

function summary(index: number): StageSummaryEntry {
  return {
    text: `【已确认剧情】\n阶段${index}\n【当前状态】\n无\n【未解决线索】\n无\n【角色主张与推测】\n无\n【已失效或否定事实】\n无`,
    sourceStartMessageId: index * 10,
    sourceEndMessageId: index * 10 + 9,
    sourceHash: `hash-${index}`,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('stage summary manager selection', () => {
  it('uses the immutable source range as its UI key', () => {
    expect(stageSummaryKey(summary(2))).toBe('20:29');
  });

  it('opens a different row and closes the selected row', () => {
    expect(toggleSummarySelection('', '0:9')).toBe('0:9');
    expect(toggleSummarySelection('0:9', '10:19')).toBe('10:19');
    expect(toggleSummarySelection('0:9', '0:9')).toBe('');
  });

  it('restores raw only when deleting the physical latest summary', () => {
    const entries = [summary(0), summary(1), summary(2)];

    expect(stageSummaryDeletionMode(entries, entries[2]!)).toBe('restore-raw-tail');
    expect(stageSummaryDeletionMode(entries, entries[0]!)).toBe('keep-covered-tombstone');
  });
});

describe('stage summary manager pagination and template', () => {
  it('loads only ten summaries per page', () => {
    const summaries = Array.from({ length: 23 }, (_, index) => summary(index));
    const first = paginateItems(summaries, 1, SUMMARY_PAGE_SIZE);
    const last = paginateItems(summaries, 3, SUMMARY_PAGE_SIZE);

    expect(SUMMARY_PAGE_SIZE).toBe(10);
    expect(first.items).toHaveLength(10);
    expect(first.totalPages).toBe(3);
    expect(last.items).toHaveLength(3);
  });

  it('renders search, bounded pagination, editor, save, and safe deletion controls', () => {
    const template = stageSummaryManagerTemplate();

    expect(template).toContain('id="story-echo-summary-search"');
    expect(template).toContain('id="story-echo-summary-list"');
    expect(template).toContain('aria-label="阶段总结分页"');
    expect(template).toContain('id="story-echo-summary-editor-text"');
    expect(template).toContain('id="story-echo-summary-save"');
    expect(template).toContain('id="story-echo-summary-delete"');
    expect(template).toContain('绝不修改或删除聊天原文');
    expect(template).toContain('删除最新一条会回退覆盖位置');
    expect(template).toContain('删除更老的条目只停用该总结');
  });
});
