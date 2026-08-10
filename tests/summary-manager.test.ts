import { describe, expect, it } from 'vitest';
import type { StageSummaryEntry } from '../src/core/types';
import { paginateItems } from '../src/ui/pagination';
import {
  SUMMARY_PAGE_SIZE,
  stageSummaryDraftConflict,
  stageSummaryDeliveryStatus,
  stageSummaryDeletionMode,
  stageSummaryCharacterCount,
  stageSummaryFullRebuildConfirmation,
  stageSummaryKey,
  stageSummaryManagerTemplate,
  stageSummaryRebuildCheckpointText,
  stageSummaryRegenerationConfirmation,
  toggleSummarySelection,
} from '../src/ui/summary-manager';

function summary(index: number): StageSummaryEntry {
  return {
    text: `阶段${index}的关键剧情与当前状态。`,
    level: 1,
    sourceStartMessageId: index * 10,
    sourceEndMessageId: index * 10 + 9,
    sourceHash: `hash-${index}`,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('stage summary manager selection', () => {
  it('uses the immutable source range as its UI key', () => {
    expect(stageSummaryKey(summary(2))).toBe('1:20:29');
    expect(stageSummaryCharacterCount({ ...summary(2), text: '剧情🎭' })).toBe(3);
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

  it('labels every active frontier entry as request-carried', () => {
    expect(stageSummaryDeliveryStatus()).toBe('随请求携带');
  });

  it('detects when a dirty editor target was replaced or updated', () => {
    const populated = summary(1);

    expect(stageSummaryDraftConflict(populated, populated, false)).toBe(false);
    expect(stageSummaryDraftConflict(populated, populated, true)).toBe(false);
    expect(stageSummaryDraftConflict(undefined, populated, true)).toBe(true);
    expect(stageSummaryDraftConflict({
      ...populated,
      updatedAt: '2026-01-02T00:00:00.000Z',
    }, populated, true)).toBe(true);
  });

  it('warns before a full rebuild discards unsaved editor changes', () => {
    expect(stageSummaryFullRebuildConfirmation(true))
      .toContain('尚未保存的总结修改');
    expect(stageSummaryFullRebuildConfirmation(false))
      .not.toContain('尚未保存的总结修改');
    expect(stageSummaryFullRebuildConfirmation(false, {
      targetEndMessageId: 29,
      targetSourceHash: 'target-source',
      generationSignature: 'generation-signature',
      entries: [summary(0), summary(1)],
      totalDurationMs: 100,
      totalMessagesCovered: 20,
      updatedAt: '2026-01-01T00:00:00.000Z',
    })).toContain('检测到 2 批已保存的 L1 重建草稿');
  });

  it('describes resumable full-rebuild drafts without presenting them as active', () => {
    expect(stageSummaryRebuildCheckpointText()).toContain('全部 L1 成功后一次性替换');
    expect(stageSummaryRebuildCheckpointText({
      targetEndMessageId: 29,
      targetSourceHash: 'target-source',
      generationSignature: 'generation-signature',
      entries: [summary(0), summary(1)],
      totalDurationMs: 100,
      totalMessagesCovered: 20,
      updatedAt: '2026-01-01T00:00:00.000Z',
    })).toBe('已保留 2 批 L1 重建草稿，覆盖消息 0～19；再次重建会校验后继续。');
  });

  it('explains the atomic single-summary regeneration consequences', () => {
    const entry = { ...summary(1), manuallyEdited: true };
    const confirmation = stageSummaryRegenerationConfirmation(entry, true);

    expect(confirmation).toContain('尚未保存的修改');
    expect(confirmation).toContain('包含人工编辑');
    expect(confirmation).toContain('消息 10～19');
    expect(confirmation).toContain('更早和更晚的总结都不会重新生成');
    expect(confirmation).toContain('原子替换');
    expect(confirmation).toContain('失败、中断或聊天切换时保留当前总结');
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

  it('normalizes invalid pagination input to safe defaults', () => {
    const page = paginateItems([1, 2, 3], Number.NaN, 0);

    expect(page).toMatchObject({
      items: [1, 2, 3],
      page: 1,
      pageSize: 10,
      totalPages: 1,
    });
  });

  it('renders hierarchy maintenance and safe summary controls without skeleton UI', () => {
    const template = stageSummaryManagerTemplate();

    expect(template).not.toContain('story-echo-skeleton');
    expect(template).toContain('role="status" aria-live="polite"');
    expect(template).toContain('L1 与 L2+ 分别使用各自的合并条数');
    expect(template).toContain('id="story-echo-summary-search"');
    expect(template).toContain('id="story-echo-summary-compact"');
    expect(template).toContain('id="story-echo-summary-rebuild-all"');
    expect(template).toContain('id="story-echo-summary-rebuild-status"');
    expect(template).toContain('重建全部分层总结');
    expect(template).toContain('id="story-echo-summary-list"');
    expect(template).toContain('aria-label="分层总结分页"');
    expect(template).toContain('id="story-echo-summary-editor-text"');
    expect(template).toContain('id="story-echo-summary-save"');
    expect(template).toContain('id="story-echo-summary-regenerate"');
    expect(template).toContain('重新生成当前总结');
    expect(template).toContain('id="story-echo-summary-delete"');
    expect(template).toContain('删除最新条目会回退覆盖位置');
    expect(template).toContain('删除较老条目只停用该总结');
  });
});
