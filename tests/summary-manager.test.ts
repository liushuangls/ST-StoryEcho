import { describe, expect, it } from 'vitest';
import type { StageSummaryEntry } from '../src/core/types';
import { paginateItems } from '../src/ui/memory-manager';
import {
  SUMMARY_PAGE_SIZE,
  stageSummaryDeliveryStatus,
  stageSummaryDeletionMode,
  stageSummaryFullRebuildConfirmation,
  stageSummaryKey,
  stageSummaryManagerTemplate,
  toggleSummarySelection,
} from '../src/ui/summary-manager';

function summary(index: number): StageSummaryEntry {
  return {
    text: `阶段${index}的关键剧情与当前状态。`,
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

  it('labels recent, absorbed, and pending summaries by their real request path', () => {
    const entries = Array.from({ length: 6 }, (_, index) => summary(index));

    expect(stageSummaryDeliveryStatus(entries[0]!, 0, entries.length, 4, 19, true))
      .toBe('已汇入骨架');
    expect(stageSummaryDeliveryStatus(entries[1]!, 1, entries.length, 4, 9, true))
      .toBe('随请求携带（待汇入骨架）');
    expect(stageSummaryDeliveryStatus(entries[2]!, 2, entries.length, 4, 59, true))
      .toBe('随请求携带');
    expect(stageSummaryDeliveryStatus(entries[0]!, 0, entries.length, 4, 59, false))
      .toBe('随请求携带（待汇入骨架）');
  });

  it('warns before a full rebuild discards unsaved editor changes', () => {
    expect(stageSummaryFullRebuildConfirmation(true))
      .toContain('尚未保存的阶段总结或骨架修改');
    expect(stageSummaryFullRebuildConfirmation(false))
      .not.toContain('尚未保存的阶段总结或骨架修改');
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

  it('renders an editable but non-deletable skeleton plus safe stage-summary controls', () => {
    const template = stageSummaryManagerTemplate();

    expect(template).toContain('<details id="story-echo-skeleton-details"');
    expect(template).not.toMatch(/<details[^>]*id="story-echo-skeleton-details"[^>]*\sopen(?:\s|=|>)/u);
    expect(template).toContain('<summary class="story-echo-summary-editor-heading story-echo-skeleton-summary">');
    expect(template).toContain('点击展开正文');
    expect(template).toContain('点击收起正文');
    expect(template).toContain('id="story-echo-skeleton-text"');
    expect(template).toContain('id="story-echo-skeleton-save"');
    expect(template).toContain('id="story-echo-skeleton-update"');
    expect(template).toContain('id="story-echo-skeleton-rebuild"');
    expect(template).not.toContain('id="story-echo-skeleton-delete"');
    expect(template).toContain('可编辑、不可删除');
    expect(template).toContain('长期重要事件、剧情大纲、关键因果与未决主线');
    expect(template).toContain('不维护角色当前状态或 NPC 档案');
    expect(template).toContain('每有一条尚未覆盖的总结首次进入归档');
    expect(template).toContain('从全部有效阶段总结干净重建');
    expect(template).toContain('每批最多 80000 字符');
    expect(template).toContain('正文可按剧情需要自由分段');
    expect(template).not.toContain('必须保留六个分级标题');
    expect(template).toContain('id="story-echo-summary-search"');
    expect(template).toContain('id="story-echo-summary-rebuild-all"');
    expect(template).toContain('重建全部阶段总结与骨架');
    expect(template).toContain('全部成功后一次性替换');
    expect(template).toContain('id="story-echo-summary-list"');
    expect(template).toContain('aria-label="阶段总结分页"');
    expect(template).toContain('id="story-echo-summary-editor-text"');
    expect(template).toContain('id="story-echo-summary-save"');
    expect(template).toContain('id="story-echo-summary-delete"');
    expect(template).toContain('绝不修改或删除聊天原文');
    expect(template).toContain('删除最新一条会回退覆盖位置');
    expect(template).toContain('删除更老的条目只停用该总结');
    expect(template).not.toContain('请保留五个分级标题');
  });
});
