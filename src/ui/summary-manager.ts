import type {
  StageSummaryEntry,
  StageSummaryRebuildCheckpoint,
  StoryEchoChatState,
} from '../core/types';
import {
  getContext,
  getCurrentChatId,
  showConfirmation,
} from '../platform/sillytavern';
import { selectRecentWindow } from '../prompt/window';
import { storyEchoTaskCoordinator } from '../runtime/task-coordinator';
import { SettingsRepository } from '../settings/repository';
import { StoryStateRepository } from '../state/repository';
import { summaryCompactionService } from '../summary/compaction-service';
import {
  configuredSummaryCompactionThresholds,
  summaryCompactionDue,
  summaryLevelCounts,
} from '../summary/compaction-state';
import { stageSummaryService } from '../summary/service';
import { notify } from './notifications';
import { paginateItems } from './pagination';

export const SUMMARY_PAGE_SIZE = 10;

export function stageSummaryKey(entry: StageSummaryEntry): string {
  return `${entry.level}:${entry.sourceStartMessageId}:${entry.sourceEndMessageId}`;
}

export function stageSummaryCharacterCount(entry: StageSummaryEntry): number {
  return Array.from(entry.text).length;
}

const TRUNCATED_SUMMARY_FINISH_REASONS = new Set([
  'length',
  'max_token',
  'max_tokens',
  'max_output_tokens',
  'token_limit',
  'output_token_limit',
]);

/** True when the provider stopped because its visible output budget was exhausted. */
export function stageSummaryOutputTruncated(entry: StageSummaryEntry): boolean {
  if (entry.manuallyEdited) {
    return false;
  }
  const finishReason = entry.generation?.finishReason
    ?.trim()
    .toLocaleLowerCase()
    .replace(/[\s-]+/gu, '_');
  return Boolean(finishReason && TRUNCATED_SUMMARY_FINISH_REASONS.has(finishReason));
}

export function toggleSummarySelection(currentKey: string, clickedKey: string): string {
  return currentKey === clickedKey ? '' : clickedKey;
}

export function stageSummaryDraftConflict(
  current: StageSummaryEntry | undefined,
  populated: StageSummaryEntry | undefined,
  editorDirty: boolean,
): boolean {
  if (!editorDirty || !populated) {
    return false;
  }
  return !current ||
    stageSummaryKey(current) !== stageSummaryKey(populated) ||
    current.updatedAt !== populated.updatedAt;
}

export function stageSummaryDeletionMode(
  entries: readonly StageSummaryEntry[],
  entry: StageSummaryEntry,
): 'restore-raw-tail' | 'keep-covered-tombstone' {
  return entries.at(-1)?.sourceStartMessageId === entry.sourceStartMessageId
    ? 'restore-raw-tail'
    : 'keep-covered-tombstone';
}

export type StageSummaryDeliveryStatus = '随请求携带';

export function stageSummaryDeliveryStatus(): StageSummaryDeliveryStatus {
  return '随请求携带';
}

export function stageSummaryFullRebuildConfirmation(
  hasUnsavedChanges: boolean,
  checkpoint?: StageSummaryRebuildCheckpoint,
): string {
  return [
    ...(hasUnsavedChanges ? ['当前还有尚未保存的总结修改，继续会放弃这些修改。'] : []),
    '将依据当前聊天原文重新生成全部可归档的 L1 总结，再按当前阈值从低层到高层递归压缩。',
    ...(checkpoint
      ? [`检测到 ${checkpoint.entries.length} 批已保存的 L1 重建草稿；原文与设置校验通过后将从消息 ${(checkpoint.entries.at(-1)?.sourceEndMessageId ?? -1) + 1} 继续，否则自动从头开始。`]
      : []),
    '现有各层总结及人工修改会被替换，聊天原文不会改变。L1 会在全部成功后一次性替换；后续高层压缩逐批原子提交，失败时已完成结果仍然有效。',
    '这可能需要多次 LLM 请求，确定继续吗？',
  ].join('\n\n');
}

export function stageSummaryRebuildCheckpointText(
  checkpoint?: StageSummaryRebuildCheckpoint,
): string {
  if (!checkpoint) {
    return '全量重建中断时会保留已完成的 L1 草稿；正式总结仍在全部 L1 成功后一次性替换。';
  }
  const latest = checkpoint.entries.at(-1);
  return `已保留 ${checkpoint.entries.length} 批 L1 重建草稿，覆盖消息 0～${latest?.sourceEndMessageId ?? -1}；再次重建会校验后继续。`;
}

export function stageSummaryRegenerationConfirmation(
  entry: StageSummaryEntry,
  hasUnsavedChanges: boolean,
): string {
  const sourceDescription = entry.level === 1
    ? `只依据消息 ${entry.sourceStartMessageId}～${entry.sourceEndMessageId} 的当前原文重新生成这一条 L1 总结`
    : `依据保存的 ${entry.compaction?.sourceEntryCount ?? 0} 条 L${entry.level - 1} 直接来源重新生成这一条 L${entry.level} 总结`;
  return [
    ...(hasUnsavedChanges ? ['当前编辑框有尚未保存的修改；继续会放弃这些修改。'] : []),
    ...(entry.manuallyEdited ? ['当前总结包含人工编辑；重新生成会用模型结果替换这些修改。'] : []),
    `${sourceDescription}，来源范围不会改变。`,
    '更早和更晚的总结都不会重新生成；成功并通过来源校验后才会原子替换，失败、中断或聊天切换时保留当前总结。',
    '确定继续吗？',
  ].join('\n\n');
}

function summaryPreview(text: string): string {
  const heading = /^【[^】]+】$/u;
  return text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !heading.test(line) && line !== '无') ?? '（空段落）';
}

function formattedTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value || '未知时间';
}

function searchableSummary(entry: StageSummaryEntry, index: number): string {
  return [
    String(index + 1),
    `l${entry.level}`,
    `${entry.sourceStartMessageId}-${entry.sourceEndMessageId}`,
    entry.sourceHash,
    entry.updatedAt,
    entry.text,
  ].join('\n').toLocaleLowerCase();
}

function sourceText(entry: StageSummaryEntry): string {
  return JSON.stringify({
    level: entry.level,
    sourceStartMessageId: entry.sourceStartMessageId,
    sourceEndMessageId: entry.sourceEndMessageId,
    sourceHash: entry.sourceHash,
    characterCount: stageSummaryCharacterCount(entry),
    generation: entry.generation ?? null,
    compaction: entry.compaction ? {
      sourceLevel: entry.compaction.sourceLevel,
      sourceEntryCount: entry.compaction.sourceEntryCount,
      inputHash: entry.compaction.inputHash,
      sources: entry.compaction.sources.map((source) => ({
        level: source.level,
        sourceStartMessageId: source.sourceStartMessageId,
        sourceEndMessageId: source.sourceEndMessageId,
        sourceHash: source.sourceHash,
        characterCount: Array.from(source.text).length,
        manuallyEdited: Boolean(source.manuallyEdited),
        deleted: Boolean(source.deleted),
      })),
    } : null,
    manuallyEdited: Boolean(entry.manuallyEdited),
    updatedAt: entry.updatedAt,
  }, null, 2);
}

function levelCountsText(entries: readonly StageSummaryEntry[]): string {
  return [...summaryLevelCounts(entries).entries()]
    .sort(([left], [right]) => left - right)
    .map(([level, count]) => `L${level} ${count}`)
    .join(' / ') || '无';
}

export function stageSummaryManagerTemplate(): string {
  return `
    <div class="story-echo-summary-manager">
      <div class="story-echo-summary-manager-heading">
        <strong>已生成的分层总结</strong>
        <span>保存在当前聊天元数据中</span>
      </div>
      <p class="story-echo-hint">
        原文生成 L1；L1 与 L2+ 分别使用各自的合并条数。当某层出现第 N+1 条时，最老的 N 条会合并为一条更高层总结并继续向上递归。所有当前有效条目都会随请求携带。
      </p>
      <div class="story-echo-summary-toolbar">
        <label class="story-echo-field">
          <span>搜索</span>
          <input id="story-echo-summary-search" class="text_pole" type="search" placeholder="正文、层级、消息范围或来源哈希">
        </label>
        <button id="story-echo-summary-reload" class="menu_button" type="button">
          <i class="fa-solid fa-rotate" aria-hidden="true"></i><span>刷新列表</span>
        </button>
      </div>
      <div class="story-echo-summary-maintenance-actions">
        <button id="story-echo-summary-compact" class="menu_button" type="button">
          <i class="fa-solid fa-layer-group" aria-hidden="true"></i><span>立即整理总结层级</span>
        </button>
        <button id="story-echo-summary-rebuild-all" class="menu_button story-echo-summary-rebuild-all" type="button">
          <i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i><span>重建全部分层总结</span>
        </button>
      </div>
      <div id="story-echo-summary-activity-status" class="story-echo-summary-count" role="status" aria-live="polite"></div>
      <div id="story-echo-summary-rebuild-status" class="story-echo-summary-count" role="status" aria-live="polite">
        ${stageSummaryRebuildCheckpointText()}
      </div>
      <div id="story-echo-summary-count" class="story-echo-summary-count">尚无总结。</div>
      <div id="story-echo-summary-list" class="story-echo-summary-list"></div>
      <nav id="story-echo-summary-pagination" class="story-echo-summary-pagination" aria-label="分层总结分页" hidden>
        <button id="story-echo-summary-previous" class="menu_button" type="button">
          <i class="fa-solid fa-chevron-left" aria-hidden="true"></i><span>上一页</span>
        </button>
        <span id="story-echo-summary-page" class="story-echo-summary-page" aria-live="polite">第 1 / 1 页</span>
        <button id="story-echo-summary-next" class="menu_button" type="button">
          <span>下一页</span><i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
        </button>
      </nav>

      <div id="story-echo-summary-editor" class="story-echo-summary-editor" hidden>
        <div class="story-echo-summary-editor-heading">
          <div>
            <strong>编辑分层总结</strong>
            <div id="story-echo-summary-editor-range" class="story-echo-summary-editor-range"></div>
          </div>
          <span class="story-echo-summary-manual-hint">保存后保留层级、来源范围和哈希，并标记为人工编辑</span>
        </div>
        <label class="story-echo-field">
          <span>总结正文</span>
          <textarea id="story-echo-summary-editor-text" class="text_pole" rows="14" maxlength="64000"></textarea>
        </label>
        <div class="story-echo-field story-echo-summary-source-field">
          <span>只读来源与生成信息</span>
          <pre id="story-echo-summary-source" class="story-echo-summary-source"></pre>
        </div>
        <p class="story-echo-hint">
          重新生成 L1 时读取当前原文；重新生成 L2+ 时读取该条目保存的直接子总结。删除最新条目会回退覆盖位置，让其原文重新参与后续处理；删除较老条目只停用该总结并保留覆盖。
        </p>
        <div class="story-echo-summary-editor-actions">
          <button id="story-echo-summary-save" class="menu_button story-echo-action-primary" type="button">
            <i class="fa-solid fa-floppy-disk" aria-hidden="true"></i><span>保存修改</span>
          </button>
          <button id="story-echo-summary-regenerate" class="menu_button" type="button">
            <i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i><span>重新生成当前总结</span>
          </button>
          <button id="story-echo-summary-delete" class="menu_button story-echo-summary-delete" type="button">
            <i class="fa-solid fa-trash" aria-hidden="true"></i><span>删除总结</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

function element<T extends HTMLElement>(panel: HTMLElement, selector: string): T {
  const found = panel.querySelector<T>(selector);
  if (!found) {
    throw new Error(`分层总结管理控件不存在：${selector}`);
  }
  return found;
}

interface RenderedSummary {
  entry: StageSummaryEntry;
  index: number;
  key: string;
}

export class StageSummaryMetadataManager {
  private selectedSummaryKey = '';
  private populatedSummaryKey = '';
  private populatedUpdatedAt = '';
  private populatedEntry: StageSummaryEntry | undefined;
  private editorDirty = false;
  private editorRevision = 0;
  private currentPage = 1;
  private renderedChatUuid = '';
  private activityStatus = '';
  private operationActive = false;
  private readonly settingsRepository = new SettingsRepository();

  constructor(private readonly repository: StoryStateRepository) {}

  bind(panel: HTMLElement, onChanged: () => Promise<void>): void {
    const editorText = element<HTMLTextAreaElement>(panel, '#story-echo-summary-editor-text');
    const markDirty = (): void => {
      this.editorDirty = true;
      this.editorRevision += 1;
    };
    editorText.addEventListener('input', markDirty);
    editorText.addEventListener('change', markDirty);

    element<HTMLInputElement>(panel, '#story-echo-summary-search').addEventListener('input', () => {
      this.currentPage = 1;
      this.render(panel, this.repository.getExisting());
    });
    element<HTMLButtonElement>(panel, '#story-echo-summary-reload').addEventListener('click', () => {
      this.currentPage = 1;
      this.render(panel, this.repository.getExisting());
    });
    element<HTMLButtonElement>(panel, '#story-echo-summary-compact').addEventListener('click', async () => {
      if (
        this.editorDirty &&
        !await showConfirmation(
          '放弃未保存的总结修改',
          '整理层级可能会用高层总结替换当前条目。当前编辑框还有尚未保存的修改，确定放弃并继续吗？',
        )
      ) {
        return;
      }
      if (this.editorDirty) {
        this.resetSelection();
      }
      const requestedChatId = getCurrentChatId();
      this.setActivity(panel, '正在排队整理总结层级…');
      try {
        const result = await storyEchoTaskCoordinator.enqueueManual('整理分层总结', async () => {
          if (!requestedChatId || getCurrentChatId() !== requestedChatId) {
            throw new Error('等待整理总结层级期间聊天发生切换，已取消任务。');
          }
          return summaryCompactionService.processAllPending((progress) => {
            this.setActivity(
              panel,
              `正在压缩 L${progress.sourceLevel} → L${progress.targetLevel}，来源消息 ${progress.sourceStartMessageId}～${progress.sourceEndMessageId}…`,
            );
          });
        });
        await onChanged();
        if (result.compactedChunks > 0) {
          notify.success(`总结层级整理完成，共压缩 ${result.compactedChunks} 批。`);
        } else {
          notify.info('当前各层总结均未超过保留阈值。');
        }
      } catch (error) {
        notify.error(error instanceof Error ? error.message : '整理总结层级失败。');
      } finally {
        this.setActivity(panel, '');
        this.render(panel, this.repository.getExisting());
      }
    });
    element<HTMLButtonElement>(panel, '#story-echo-summary-rebuild-all').addEventListener('click', async () => {
      const before = this.repository.getExisting();
      if (!await showConfirmation(
        '重建全部分层总结',
        stageSummaryFullRebuildConfirmation(
          this.editorDirty,
          before?.stageSummary.rebuildCheckpoint,
        ),
      )) {
        return;
      }
      this.resetSelection();
      const requestedChatId = getCurrentChatId();
      let l1Rebuilt = false;
      this.setActivity(panel, '正在排队重建全部 L1 总结…');
      try {
        const result = await storyEchoTaskCoordinator.enqueueManual('重建全部分层总结', async () => {
          if (!requestedChatId || getCurrentChatId() !== requestedChatId) {
            throw new Error('等待全部重建期间聊天发生切换，已取消任务。');
          }
          const settings = this.settingsRepository.get();
          const chat = getContext().chat;
          const state = this.repository.getExisting();
          const recent = selectRecentWindow(
            chat,
            settings.recentWindow.size,
            settings.recentWindow.unit,
          );
          const outsideWindowTarget = recent && recent.retainedStartIndex > 0
            ? recent.retainedStartIndex - 1
            : -1;
          const targetEndMessageId = Math.min(
            chat.length - 1,
            Math.max(outsideWindowTarget, state?.stageSummary.coveredThroughMessageId ?? -1),
          );
          if (targetEndMessageId < 0) {
            throw new Error('当前聊天还没有可用于重建 L1 总结的窗口外历史。');
          }
          const summaryResult = await stageSummaryService.rebuildAllThrough(
            targetEndMessageId,
            (progress) => {
              this.setActivity(panel, progress.resumed
                ? `已恢复 ${progress.completedChunks ?? 0} 批 L1 草稿，将从消息 ${progress.endMessageId + 1} 继续…`
                : `正在重建 L1：已完成 ${progress.endMessageId + 1}/${progress.targetEndMessageId + 1}…`);
            },
          );
          if (summaryResult.updatedChunks === 0) {
            throw new Error('窗口外历史尚不足一个完整 L1 批次，未替换现有结果。');
          }
          l1Rebuilt = true;
          this.setActivity(panel, 'L1 已原子替换，正在递归压缩高层总结…');
          const compactionResult = await summaryCompactionService.processAllPending((progress) => {
            this.setActivity(panel, `正在压缩 L${progress.sourceLevel} → L${progress.targetLevel}…`);
          });
          return { summaryResult, compactionResult };
        });
        this.resetSelection();
        notify.success(
          `全部重建完成：生成 ${result.summaryResult.updatedChunks} 条 L1，总结压缩 ${result.compactionResult.compactedChunks} 批。`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : '全部重建失败。';
        const checkpoint = this.repository.getExisting()?.stageSummary.rebuildCheckpoint;
        notify.error(l1Rebuilt
          ? `L1 已重建；高层压缩中断，已提交结果均保留：${message}`
          : checkpoint
            ? `${message}；已保留 ${checkpoint.entries.length} 批草稿，再次点击可从消息 ${(checkpoint.entries.at(-1)?.sourceEndMessageId ?? -1) + 1} 继续。`
            : message);
      } finally {
        try {
          await onChanged();
        } catch {
          // Persisted state will appear on the next panel refresh.
        }
        this.setActivity(panel, '');
        this.render(panel, this.repository.getExisting());
      }
    });
    element<HTMLButtonElement>(panel, '#story-echo-summary-previous').addEventListener('click', async () => {
      await this.changePage(panel, this.currentPage - 1);
    });
    element<HTMLButtonElement>(panel, '#story-echo-summary-next').addEventListener('click', async () => {
      await this.changePage(panel, this.currentPage + 1);
    });
    element<HTMLElement>(panel, '#story-echo-summary-list').addEventListener('click', async (event) => {
      if (this.operationActive) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const button = target.closest<HTMLButtonElement>('button[data-summary-key]');
      if (!button?.dataset.summaryKey) {
        return;
      }
      const nextKey = toggleSummarySelection(this.selectedSummaryKey, button.dataset.summaryKey);
      if (
        this.editorDirty &&
        !await showConfirmation('放弃未保存的总结修改', '当前总结有尚未保存的修改，确定放弃并关闭或切换吗？')
      ) {
        return;
      }
      this.selectedSummaryKey = nextKey;
      this.editorDirty = false;
      this.populatedSummaryKey = '';
      this.render(panel, this.repository.getExisting());
    });
    element<HTMLButtonElement>(panel, '#story-echo-summary-save').addEventListener('click', async () => {
      const current = this.currentSummary();
      if (!current || !this.populatedUpdatedAt) {
        return;
      }
      const target = { ...current, updatedAt: this.populatedUpdatedAt };
      const text = editorText.value;
      const submittedRevision = this.editorRevision;
      const requestedChatId = getCurrentChatId();
      this.setActivity(panel, `正在保存 L${current.level} 总结…`);
      try {
        await storyEchoTaskCoordinator.enqueueManual('保存分层总结', async () => {
          if (!requestedChatId || getCurrentChatId() !== requestedChatId) {
            throw new Error('等待保存期间聊天发生切换，已取消修改。');
          }
          return this.repository.updateStageSummaryEntry(target, { text });
        });
        if (this.editorRevision === submittedRevision) {
          this.editorDirty = false;
        }
        await onChanged();
        notify.success(`L${current.level} 总结已保存。`);
      } catch (error) {
        notify.error(error instanceof Error ? error.message : '保存总结失败。');
      } finally {
        this.setActivity(panel, '');
        this.render(panel, this.repository.getExisting());
      }
    });
    element<HTMLButtonElement>(panel, '#story-echo-summary-regenerate').addEventListener('click', async () => {
      const current = this.currentSummary();
      if (!current) {
        return;
      }
      if (!await showConfirmation(
        `重新生成 L${current.level} 总结`,
        stageSummaryRegenerationConfirmation(current, this.editorDirty),
      )) {
        return;
      }
      const requestedChatId = getCurrentChatId();
      this.setActivity(panel, `正在重新生成 L${current.level} 总结…`);
      try {
        const result = await storyEchoTaskCoordinator.enqueueManual('重新生成当前总结', async () => {
          if (!requestedChatId || getCurrentChatId() !== requestedChatId) {
            throw new Error('等待重新生成总结期间聊天发生切换，已取消任务。');
          }
          return current.level === 1
            ? stageSummaryService.regenerateEntry(current.sourceStartMessageId, current.updatedAt)
            : summaryCompactionService.regenerateEntry(current.sourceStartMessageId, current.updatedAt);
        });
        this.editorDirty = false;
        this.populatedSummaryKey = '';
        await onChanged();
        notify.success(
          `L${current.level} 总结已重新生成：${result.previousCharacterCount} 字 → ${stageSummaryCharacterCount(result.entry)} 字。`,
        );
      } catch (error) {
        notify.error(error instanceof Error ? error.message : '重新生成总结失败，已保留原结果。');
      } finally {
        this.setActivity(panel, '');
        this.render(panel, this.repository.getExisting());
      }
    });
    element<HTMLButtonElement>(panel, '#story-echo-summary-delete').addEventListener('click', async () => {
      const state = this.repository.getExisting();
      const current = this.currentSummary(state);
      if (!state || !current) {
        return;
      }
      const deletionMode = stageSummaryDeletionMode(state.stageSummary.entries, current);
      const consequence = deletionMode === 'restore-raw-tail'
        ? '这是最新一条总结。删除后覆盖位置会回退，该范围原文将重新参与后续处理。'
        : '这是较老的总结。删除后只会停用该总结；旧原文不会重新发送，覆盖位置保持不变。';
      if (!await showConfirmation(
        `删除 L${current.level} 总结`,
        `删除消息 ${current.sourceStartMessageId}～${current.sourceEndMessageId} 的 L${current.level} 总结？\n\n${consequence}\n\n聊天原文不会被修改或删除。`,
      )) {
        return;
      }
      const requestedChatId = getCurrentChatId();
      this.setActivity(panel, `正在删除 L${current.level} 总结…`);
      try {
        const result = await storyEchoTaskCoordinator.enqueueManual('删除分层总结', async () => {
          if (!requestedChatId || getCurrentChatId() !== requestedChatId) {
            throw new Error('等待删除期间聊天发生切换，已取消操作。');
          }
          return this.repository.deleteStageSummaryEntry(current);
        });
        const restoredRaw = !result.stageSummary.entries.some((entry) => (
          entry.sourceStartMessageId === current.sourceStartMessageId
        ));
        this.resetSelection();
        await onChanged();
        notify.success(restoredRaw
          ? '最新总结已删除，对应原文将重新参与后续处理。'
          : '较老总结已停用，对应原文仍保持压缩。');
      } catch (error) {
        notify.error(error instanceof Error ? error.message : '删除总结失败。');
      } finally {
        this.setActivity(panel, '');
        this.render(panel, this.repository.getExisting());
      }
    });
  }

  render(panel: HTMLElement, state: StoryEchoChatState | null): void {
    const chatUuid = state?.chatUuid ?? '';
    if (chatUuid !== this.renderedChatUuid) {
      this.renderedChatUuid = chatUuid;
      this.currentPage = 1;
      this.resetSelection();
      this.activityStatus = '';
      this.operationActive = false;
    }
    const allEntries = state?.stageSummary.entries ?? [];
    const entries = allEntries.filter((entry) => !entry.deleted);
    const selected = entries.find((entry) => stageSummaryKey(entry) === this.selectedSummaryKey);
    const draftConflict = stageSummaryDraftConflict(
      selected,
      this.populatedEntry,
      this.editorDirty,
    );
    const missingDirtySelection = draftConflict && !selected;
    if (this.selectedSummaryKey && !selected && !missingDirtySelection) {
      this.resetSelection();
    }
    const settings = this.settingsRepository.get();
    const pending = summaryCompactionDue(
      allEntries,
      configuredSummaryCompactionThresholds(settings.summary),
    );
    element<HTMLElement>(panel, '#story-echo-summary-activity-status').textContent =
      this.activityStatus || (draftConflict
        ? '选中的总结已在后台被压缩、删除或更新；未保存文字仍保留在编辑框，请先复制后再切换或刷新。'
        : pending
        ? `有层级超过阈值（L1 ${settings.summary.level1EntriesPerGroup} 条 / L2+ ${settings.summary.higherLevelEntriesPerGroup} 条），等待整理。`
        : `合并阈值：L1 ${settings.summary.level1EntriesPerGroup} 条，L2+ ${settings.summary.higherLevelEntriesPerGroup} 条；当前层级 ${levelCountsText(allEntries)}。`);
    element<HTMLElement>(panel, '#story-echo-summary-rebuild-status').textContent =
      stageSummaryRebuildCheckpointText(state?.stageSummary.rebuildCheckpoint);
    element<HTMLButtonElement>(panel, '#story-echo-summary-compact').disabled =
      !state || this.operationActive;
    element<HTMLButtonElement>(panel, '#story-echo-summary-rebuild-all').disabled =
      !state || this.operationActive;

    const search = element<HTMLInputElement>(panel, '#story-echo-summary-search')
      .value.trim().toLocaleLowerCase();
    const filtered: RenderedSummary[] = entries
      .map((entry, index) => ({ entry, index, key: stageSummaryKey(entry) }))
      .filter(({ entry, index }) => !search || searchableSummary(entry, index).includes(search))
      .reverse();
    const page = paginateItems(filtered, this.currentPage, SUMMARY_PAGE_SIZE);
    this.currentPage = page.page;
    const count = element<HTMLElement>(panel, '#story-echo-summary-count');
    const pageDescription = `第 ${page.page} / ${page.totalPages} 页，本页加载 ${page.items.length} 条。`;
    if (entries.length === 0) {
      count.textContent = '当前聊天尚无总结。';
    } else if (filtered.length === 0) {
      count.textContent = `共 ${entries.length} 条（${levelCountsText(allEntries)}），筛选后 0 条。`;
    } else {
      count.textContent = `共 ${entries.length} 条（${levelCountsText(allEntries)}）；${pageDescription}`;
    }
    const pagination = element<HTMLElement>(panel, '#story-echo-summary-pagination');
    pagination.hidden = filtered.length <= page.pageSize;
    element<HTMLButtonElement>(panel, '#story-echo-summary-previous').disabled =
      page.page <= 1 || this.operationActive;
    element<HTMLButtonElement>(panel, '#story-echo-summary-next').disabled =
      page.page >= page.totalPages || this.operationActive;
    element<HTMLElement>(panel, '#story-echo-summary-page').textContent =
      `第 ${page.page} / ${page.totalPages} 页`;

    const list = element<HTMLElement>(panel, '#story-echo-summary-list');
    list.replaceChildren();
    if (filtered.length === 0 && entries.length > 0) {
      const empty = document.createElement('div');
      empty.className = 'story-echo-summary-empty';
      empty.textContent = '没有符合搜索条件的总结。';
      list.append(empty);
    }
    for (const item of page.items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'menu_button story-echo-summary-row';
      button.dataset.summaryKey = item.key;
      button.disabled = this.operationActive;
      button.classList.toggle('story-echo-summary-row-selected', item.key === this.selectedSummaryKey);
      const outputTruncated = stageSummaryOutputTruncated(item.entry);
      button.classList.toggle('story-echo-summary-row-truncated', outputTruncated);
      if (outputTruncated) {
        button.title = '该总结达到模型输出上限，内容可能在末尾截断。';
      }
      button.setAttribute('aria-expanded', String(item.key === this.selectedSummaryKey));
      button.setAttribute('aria-controls', 'story-echo-summary-editor');
      const title = document.createElement('span');
      title.className = 'story-echo-summary-row-title';
      title.textContent = summaryPreview(item.entry.text);
      const metadata = document.createElement('span');
      metadata.className = 'story-echo-summary-row-meta';
      metadata.textContent = [
        `L${item.entry.level}`,
        `#${item.index + 1}`,
        `消息 ${item.entry.sourceStartMessageId}～${item.entry.sourceEndMessageId}`,
        `${stageSummaryCharacterCount(item.entry)} 字`,
        outputTruncated ? '输出截断' : '',
        stageSummaryDeliveryStatus(),
        formattedTime(item.entry.updatedAt),
        item.entry.manuallyEdited ? '人工编辑' : '',
      ].filter(Boolean).join(' · ');
      button.append(title, metadata);
      list.append(button);
    }

    if (
      this.selectedSummaryKey &&
      !page.items.some((item) => item.key === this.selectedSummaryKey) &&
      !this.editorDirty
    ) {
      this.resetSelection();
    }
    const current = this.currentSummary(state);
    const displayed = current ?? (missingDirtySelection ? this.populatedEntry : undefined);
    const editor = element<HTMLElement>(panel, '#story-echo-summary-editor');
    editor.hidden = !displayed;
    element<HTMLTextAreaElement>(panel, '#story-echo-summary-editor-text').disabled =
      !displayed || this.operationActive;
    element<HTMLButtonElement>(panel, '#story-echo-summary-save').disabled =
      !current || this.operationActive || draftConflict;
    element<HTMLButtonElement>(panel, '#story-echo-summary-regenerate').disabled =
      !current || this.operationActive || draftConflict || (current.level > 1 && !current.compaction);
    element<HTMLButtonElement>(panel, '#story-echo-summary-delete').disabled =
      !current || this.operationActive || draftConflict;
    if (
      current &&
      (stageSummaryKey(current) !== this.populatedSummaryKey ||
        (!this.editorDirty && current.updatedAt !== this.populatedUpdatedAt))
    ) {
      this.populateEditor(panel, current, entries.indexOf(current));
      this.populatedSummaryKey = stageSummaryKey(current);
      this.populatedUpdatedAt = current.updatedAt;
      this.populatedEntry = structuredClone(current);
      this.editorDirty = false;
    }
  }

  private currentSummary(state = this.repository.getExisting()): StageSummaryEntry | undefined {
    return state?.stageSummary.entries.find(
      (entry) => !entry.deleted && stageSummaryKey(entry) === this.selectedSummaryKey,
    );
  }

  private setActivity(panel: HTMLElement, status: string): void {
    this.activityStatus = status;
    this.operationActive = Boolean(status);
    const target = panel.querySelector<HTMLElement>('#story-echo-summary-activity-status');
    if (target) {
      target.textContent = status;
    }
    this.render(panel, this.repository.getExisting());
  }

  private async changePage(panel: HTMLElement, requestedPage: number): Promise<void> {
    if (requestedPage === this.currentPage || this.operationActive) {
      return;
    }
    if (
      this.editorDirty &&
      !await showConfirmation('放弃未保存的总结修改', '当前总结有尚未保存的修改，确定放弃并翻页吗？')
    ) {
      return;
    }
    this.currentPage = requestedPage;
    this.resetSelection();
    this.render(panel, this.repository.getExisting());
  }

  private populateEditor(panel: HTMLElement, entry: StageSummaryEntry, index: number): void {
    element<HTMLElement>(panel, '#story-echo-summary-editor-range').textContent =
      `L${entry.level}｜#${index + 1}｜消息 ${entry.sourceStartMessageId}～${entry.sourceEndMessageId}｜${stageSummaryCharacterCount(entry)} 字`;
    element<HTMLTextAreaElement>(panel, '#story-echo-summary-editor-text').value = entry.text;
    element<HTMLElement>(panel, '#story-echo-summary-source').textContent = sourceText(entry);
  }

  private resetSelection(): void {
    this.selectedSummaryKey = '';
    this.populatedSummaryKey = '';
    this.populatedUpdatedAt = '';
    this.populatedEntry = undefined;
    this.editorDirty = false;
  }
}
