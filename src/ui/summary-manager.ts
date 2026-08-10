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
import { stageSummaryService } from '../summary/service';
import { storySkeletonService } from '../summary/skeleton-service';
import { storySkeletonIsUsable } from '../summary/skeleton-state';
import { paginateItems } from './pagination';
import { notify } from './notifications';

export const SUMMARY_PAGE_SIZE = 10;

export function stageSummaryKey(entry: StageSummaryEntry): string {
  return `${entry.sourceStartMessageId}:${entry.sourceEndMessageId}`;
}

export function stageSummaryCharacterCount(entry: StageSummaryEntry): number {
  return Array.from(entry.text).length;
}

export function toggleSummarySelection(currentKey: string, clickedKey: string): string {
  return currentKey === clickedKey ? '' : clickedKey;
}

export function stageSummaryDeletionMode(
  entries: readonly StageSummaryEntry[],
  entry: StageSummaryEntry,
): 'restore-raw-tail' | 'keep-covered-tombstone' {
  return entries.at(-1)?.sourceStartMessageId === entry.sourceStartMessageId
    ? 'restore-raw-tail'
    : 'keep-covered-tombstone';
}

export type StageSummaryDeliveryStatus =
  | '已汇入骨架'
  | '随请求携带'
  | '随请求携带（待汇入骨架）';

export function stageSummaryDeliveryStatus(
  entry: StageSummaryEntry,
  activeIndex: number,
  activeEntryCount: number,
  windowSize: number,
  skeletonCoverage: number,
  skeletonUsable: boolean,
): StageSummaryDeliveryStatus {
  const retained = Math.max(1, Math.floor(windowSize));
  const recentStartIndex = Math.max(0, activeEntryCount - retained);
  if (activeIndex >= recentStartIndex) {
    return '随请求携带';
  }
  if (skeletonUsable && entry.sourceEndMessageId <= skeletonCoverage) {
    return '已汇入骨架';
  }
  return '随请求携带（待汇入骨架）';
}

export function stageSummaryFullRebuildConfirmation(
  hasUnsavedChanges: boolean,
  checkpoint?: StageSummaryRebuildCheckpoint,
): string {
  return [
    ...(hasUnsavedChanges
      ? ['当前还有尚未保存的阶段总结或骨架修改，继续会放弃这些修改。']
      : []),
    '将依据当前聊天原文重新生成全部可归档阶段总结，再用新总结干净重建全局剧情骨架。',
    ...(checkpoint
      ? [`检测到 ${checkpoint.entries.length} 批已保存的重建草稿；原文与设置校验通过后将从消息 ${(checkpoint.entries.at(-1)?.sourceEndMessageId ?? -1) + 1} 继续，否则自动从头开始。`]
      : []),
    '现有阶段总结的人工修改会被替换；聊天原文不会改变。阶段总结会在全部成功后一次性替换，骨架重建失败时新总结仍会保留且旧骨架停止注入。',
    '这可能需要多次 LLM 请求，确定继续吗？',
  ].join('\n\n');
}

export function stageSummaryRebuildCheckpointText(
  checkpoint?: StageSummaryRebuildCheckpoint,
): string {
  if (!checkpoint) {
    return '全量重建中断时会保留已完成批次；正式总结仍在全部成功后一次性替换。';
  }
  const latest = checkpoint.entries.at(-1);
  return `已保留 ${checkpoint.entries.length} 批重建草稿，覆盖消息 0～${latest?.sourceEndMessageId ?? -1}；再次重建会校验后继续。`;
}

export function stageSummaryRegenerationConfirmation(
  entry: StageSummaryEntry,
  hasUnsavedChanges: boolean,
  invalidatesSkeleton: boolean,
): string {
  return [
    ...(hasUnsavedChanges
      ? ['当前编辑框有尚未保存的修改；继续会放弃这些修改。']
      : []),
    ...(entry.manuallyEdited
      ? ['当前总结包含人工编辑；重新生成会用模型结果替换这些修改。']
      : []),
    `将只依据消息 ${entry.sourceStartMessageId}～${entry.sourceEndMessageId} 的当前原文重新生成这一条总结，来源范围不会改变。`,
    '更早和更晚的阶段总结都不会重新生成。',
    '模型请求全部成功并通过来源校验后才会一次性替换；失败、中断或聊天切换时保留当前总结。',
    ...(invalidatesSkeleton
      ? ['这条总结已经被全局骨架覆盖。替换后旧骨架会标记为待重建，并在重建前停止注入。']
      : []),
    '确定继续吗？',
  ].join('\n\n');
}

export type StorySkeletonGenerationMode = 'update' | 'rebuild';

export function storySkeletonGenerationStatusText(
  mode: StorySkeletonGenerationMode,
  progress?: { sourceEndMessageId: number; pendingEntries: number },
): string {
  const action = mode === 'rebuild' ? '重新生成' : '更新';
  if (!progress) {
    return `正在${action}全局剧情骨架…`;
  }
  if (progress.pendingEntries > 0) {
    return `正在${action}全局剧情骨架：已处理到消息 ${progress.sourceEndMessageId}，剩余 ${progress.pendingEntries} 条阶段总结…`;
  }
  return '全局剧情骨架内容已生成，正在保存并刷新界面…';
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
  if (!Number.isFinite(date.getTime())) {
    return value || '未知时间';
  }
  return date.toLocaleString();
}

function searchableSummary(entry: StageSummaryEntry, index: number): string {
  return [
    String(index + 1),
    `${entry.sourceStartMessageId}-${entry.sourceEndMessageId}`,
    entry.sourceHash,
    entry.updatedAt,
    entry.text,
  ].join('\n').toLocaleLowerCase();
}

function sourceText(entry: StageSummaryEntry): string {
  return JSON.stringify({
    sourceStartMessageId: entry.sourceStartMessageId,
    sourceEndMessageId: entry.sourceEndMessageId,
    sourceHash: entry.sourceHash,
    characterCount: stageSummaryCharacterCount(entry),
    generation: entry.generation ?? null,
    manuallyEdited: Boolean(entry.manuallyEdited),
    updatedAt: entry.updatedAt,
  }, null, 2);
}

export function stageSummaryManagerTemplate(): string {
  return `
    <div class="story-echo-summary-manager">
      <details id="story-echo-skeleton-details" class="story-echo-summary-editor story-echo-skeleton-editor">
        <summary class="story-echo-summary-editor-heading story-echo-skeleton-summary">
          <div>
            <strong>全局剧情骨架</strong>
            <div id="story-echo-skeleton-status" class="story-echo-summary-editor-range story-echo-skeleton-status" role="status" aria-live="polite">达到归档条件后自动生成</div>
          </div>
          <span class="story-echo-summary-manual-hint story-echo-skeleton-summary-hint">
            <span>可编辑、不可删除；人工修改会成为后续更新基线</span>
            <span class="story-echo-skeleton-toggle-copy">
              <span class="story-echo-skeleton-toggle-collapsed">点击展开正文</span>
              <span class="story-echo-skeleton-toggle-expanded">点击收起正文</span>
              <i class="fa-solid fa-chevron-right story-echo-skeleton-chevron" aria-hidden="true"></i>
            </span>
          </span>
        </summary>
        <div class="story-echo-skeleton-body">
          <label class="story-echo-field">
            <span>骨架正文</span>
            <textarea id="story-echo-skeleton-text" class="text_pole" rows="16" maxlength="96000" disabled placeholder="最近阶段总结超过 S 条后自动生成"></textarea>
          </label>
          <p class="story-echo-hint">
            骨架记录长期重要事件、剧情大纲、关键因果与未决主线，不维护角色当前状态或 NPC 档案；最新情况由最近阶段总结、近期原文、MVU变量与世界书承担。新聊天在第 S+1 条阶段总结归档时首次生成，并从旧到新读取当时全部阶段总结；之后每有一条尚未覆盖的总结首次进入归档，就与旧骨架一起增量更新。“重新生成”会丢弃旧骨架并从全部有效阶段总结干净重建，阶段总结按每批最多 80000 字符顺序处理，所有批次成功后才替换旧骨架。正文可按剧情需要自由分段，空白内容不能保存，界面不提供删除操作。
          </p>
          <div class="story-echo-summary-editor-actions">
            <button id="story-echo-skeleton-save" class="menu_button story-echo-action-primary" type="button" disabled>
              <i class="fa-solid fa-floppy-disk" aria-hidden="true"></i><span>保存骨架修改</span>
            </button>
            <button id="story-echo-skeleton-update" class="menu_button" type="button">
              <i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i><span>立即更新骨架</span>
            </button>
            <button id="story-echo-skeleton-rebuild" class="menu_button story-echo-skeleton-rebuild" type="button">
              <i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i><span>重新生成骨架</span>
            </button>
          </div>
        </div>
      </details>

      <div class="story-echo-summary-manager-heading">
        <strong>已生成的阶段总结</strong>
        <span>保存在当前聊天元数据中</span>
      </div>
      <div class="story-echo-summary-toolbar">
        <label class="story-echo-field">
          <span>搜索</span>
          <input id="story-echo-summary-search" class="text_pole" type="search" placeholder="总结正文、消息范围或来源哈希">
        </label>
        <button id="story-echo-summary-reload" class="menu_button" type="button">
          <i class="fa-solid fa-rotate" aria-hidden="true"></i><span>刷新列表</span>
        </button>
      </div>
      <div class="story-echo-summary-maintenance-actions">
        <button id="story-echo-summary-rebuild-all" class="menu_button story-echo-summary-rebuild-all" type="button">
          <i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i><span>重建全部阶段总结与骨架</span>
        </button>
      </div>
      <div id="story-echo-summary-rebuild-status" class="story-echo-summary-count" role="status" aria-live="polite">
        ${stageSummaryRebuildCheckpointText()}
      </div>
      <p class="story-echo-hint">
        最近 S 条会随请求携带；更老的总结在骨架吸收后标记为“已汇入骨架”。全部重建会依据当前聊天原文重新生成所有可归档阶段总结，阶段总结会在全部成功后一次性替换，再从新总结干净重建骨架。
      </p>
      <div id="story-echo-summary-count" class="story-echo-summary-count">尚无阶段总结。</div>
      <div id="story-echo-summary-list" class="story-echo-summary-list"></div>
      <nav id="story-echo-summary-pagination" class="story-echo-summary-pagination" aria-label="阶段总结分页" hidden>
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
            <strong>编辑阶段总结</strong>
            <div id="story-echo-summary-editor-range" class="story-echo-summary-editor-range"></div>
          </div>
          <span class="story-echo-summary-manual-hint">保存后保留来源范围和哈希，并标记为人工编辑</span>
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
          正文可按剧情需要自由分段，保存时只校验非空和长度。“重新生成当前总结”只重做这一条并在成功后原子替换，失败时保留旧内容。删除绝不修改或删除聊天原文：删除最新一条会回退覆盖位置，让该段原文重新参与后续请求；删除更老的条目只停用该总结，不重新发送很老的原文，也不影响后续总结。
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
    throw new Error(`阶段总结管理控件不存在：${selector}`);
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
  private editorDirty = false;
  private editorRevision = 0;
  private currentPage = 1;
  private renderedChatUuid = '';
  private skeletonDirty = false;
  private skeletonRevision = 0;
  private populatedSkeletonUpdatedAt: string | null = null;
  private skeletonActivityStatus = '';
  private summaryRegenerationActive = false;
  private readonly settingsRepository = new SettingsRepository();

  constructor(private readonly repository: StoryStateRepository) {}

  bind(panel: HTMLElement, onChanged: () => Promise<void>): void {
    const editor = element<HTMLElement>(panel, '#story-echo-summary-editor');
    const editorText = element<HTMLTextAreaElement>(panel, '#story-echo-summary-editor-text');
    const markDirty = (): void => {
      this.editorDirty = true;
      this.editorRevision += 1;
    };
    editorText.addEventListener('input', markDirty);
    editorText.addEventListener('change', markDirty);
    const skeletonText = element<HTMLTextAreaElement>(panel, '#story-echo-skeleton-text');
    const markSkeletonDirty = (): void => {
      this.skeletonDirty = true;
      this.skeletonRevision += 1;
    };
    skeletonText.addEventListener('input', markSkeletonDirty);
    skeletonText.addEventListener('change', markSkeletonDirty);

    element<HTMLButtonElement>(panel, '#story-echo-skeleton-save').addEventListener('click', async (event) => {
      const state = this.repository.getExisting();
      if (!state?.storySkeleton.text) {
        return;
      }
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      try {
        const requestedChatId = getCurrentChatId();
        const text = skeletonText.value;
        const submittedRevision = this.skeletonRevision;
        await storyEchoTaskCoordinator.enqueueManual('保存全局剧情骨架', async () => {
          if (!requestedChatId || getCurrentChatId() !== requestedChatId) {
            throw new Error('等待保存骨架期间聊天已切换，已取消修改。');
          }
          return this.repository.updateStorySkeleton({ text });
        });
        if (this.skeletonRevision === submittedRevision) {
          this.skeletonDirty = false;
        }
        await onChanged();
        notify.success('全局剧情骨架已保存，并将作为后续自动更新基线。');
      } catch (error) {
        notify.error(error instanceof Error ? error.message : '保存全局剧情骨架失败。');
      } finally {
        button.disabled = !this.repository.getExisting()?.storySkeleton.text;
      }
    });

    element<HTMLButtonElement>(panel, '#story-echo-skeleton-update').addEventListener('click', async (event) => {
      // Event.currentTarget is cleared as soon as an async event handler yields.
      // Capture it before awaiting SillyTavern's confirmation popup.
      const button = event.currentTarget as HTMLButtonElement;
      const label = button.querySelector<HTMLElement>('span');
      const idleLabel = label?.textContent ?? '立即更新骨架';
      if (
        this.skeletonDirty &&
        !await showConfirmation(
          '放弃未保存的骨架修改',
          '全局剧情骨架有尚未保存的修改，立即更新会放弃这些修改。确定继续吗？',
        )
      ) {
        return;
      }
      button.disabled = true;
      if (label) {
        label.textContent = '正在更新骨架…';
      }
      this.setSkeletonActivityStatus(panel, '正在排队更新全局剧情骨架…');
      try {
        const requestedChatId = getCurrentChatId();
        const result = await storyEchoTaskCoordinator.enqueueManual('立即更新全局剧情骨架', async () => {
          if (!requestedChatId || getCurrentChatId() !== requestedChatId) {
            throw new Error('等待更新骨架期间聊天已切换，已取消任务。');
          }
          this.setSkeletonActivityStatus(
            panel,
            storySkeletonGenerationStatusText('update'),
          );
          return storySkeletonService.processAllPending((progress) => {
            this.setSkeletonActivityStatus(
              panel,
              storySkeletonGenerationStatusText('update', progress),
            );
          });
        });
        this.skeletonDirty = false;
        await onChanged();
        if (result.updatedChunks > 0) {
          notify.success(`全局剧情骨架已更新 ${result.updatedChunks} 次，待合并阶段总结 ${result.pendingEntries} 条。`);
        } else {
          notify.info('当前没有可归档到全局剧情骨架的阶段总结。');
        }
      } catch (error) {
        notify.error(error instanceof Error ? error.message : '更新全局剧情骨架失败。');
      } finally {
        this.setSkeletonActivityStatus(panel, '');
        if (label) {
          label.textContent = idleLabel;
        }
        this.render(panel, this.repository.getExisting());
      }
    });

    element<HTMLButtonElement>(panel, '#story-echo-skeleton-rebuild').addEventListener('click', async (event) => {
      // Preserve the button across the asynchronous popup boundary.
      const button = event.currentTarget as HTMLButtonElement;
      const label = button.querySelector<HTMLElement>('span');
      const idleLabel = label?.textContent ?? '重新生成骨架';
      const confirmation = this.skeletonDirty
        ? '骨架有尚未保存的修改。重新生成会放弃这些修改，并从当前聊天全部有效阶段总结由旧到新干净重建。确定继续吗？'
        : '将丢弃现有骨架基线，从当前聊天全部有效阶段总结由旧到新分批重建；所有批次成功后才替换现有骨架。确定继续吗？';
      if (!await showConfirmation('重新生成全局剧情骨架', confirmation)) {
        return;
      }
      button.disabled = true;
      if (label) {
        label.textContent = '正在生成骨架…';
      }
      this.setSkeletonActivityStatus(panel, '正在排队重新生成全局剧情骨架…');
      try {
        const requestedChatId = getCurrentChatId();
        const result = await storyEchoTaskCoordinator.enqueueManual('重新生成全局剧情骨架', async () => {
          if (!requestedChatId || getCurrentChatId() !== requestedChatId) {
            throw new Error('等待重新生成骨架期间聊天已切换，已取消任务。');
          }
          this.setSkeletonActivityStatus(
            panel,
            storySkeletonGenerationStatusText('rebuild'),
          );
          return storySkeletonService.rebuildAll((progress) => {
            this.setSkeletonActivityStatus(
              panel,
              storySkeletonGenerationStatusText('rebuild', progress),
            );
          });
        });
        this.skeletonDirty = false;
        await onChanged();
        if (result.updatedChunks > 0) {
          notify.success(`全局剧情骨架已从全部有效阶段总结重新生成，共处理 ${result.updatedChunks} 批。`);
        } else {
          notify.info('当前聊天还没有可用于重新生成骨架的阶段总结。');
        }
      } catch (error) {
        notify.error(error instanceof Error ? error.message : '重新生成全局剧情骨架失败。');
      } finally {
        this.setSkeletonActivityStatus(panel, '');
        if (label) {
          label.textContent = idleLabel;
        }
        this.render(panel, this.repository.getExisting());
      }
    });

    element<HTMLInputElement>(panel, '#story-echo-summary-search').addEventListener('input', () => {
      this.currentPage = 1;
      this.render(panel, this.repository.getExisting());
    });
    element<HTMLButtonElement>(panel, '#story-echo-summary-reload').addEventListener('click', () => {
      this.currentPage = 1;
      this.render(panel, this.repository.getExisting());
    });
    element<HTMLButtonElement>(panel, '#story-echo-summary-rebuild-all').addEventListener('click', async (event) => {
      // Preserve the button across the asynchronous popup boundary.
      const button = event.currentTarget as HTMLButtonElement;
      const label = button.querySelector<HTMLElement>('span');
      const idleLabel = label?.textContent ?? '重建全部阶段总结与骨架';
      const stateBeforeRebuild = this.repository.getExisting();
      const confirmation = stageSummaryFullRebuildConfirmation(
        this.editorDirty || this.skeletonDirty,
        stateBeforeRebuild?.stageSummary.rebuildCheckpoint,
      );
      if (!await showConfirmation('重建全部阶段总结与骨架', confirmation)) {
        return;
      }
      let summariesRebuilt = false;
      button.disabled = true;
      if (label) {
        label.textContent = '正在重建…';
      }
      this.setSkeletonActivityStatus(
        panel,
        '正在排队重建阶段总结，随后将重新生成全局剧情骨架…',
      );
      try {
        const requestedChatId = getCurrentChatId();
        const result = await storyEchoTaskCoordinator.enqueueManual(
          '重建全部阶段总结与骨架',
          async () => {
            if (!requestedChatId || getCurrentChatId() !== requestedChatId) {
              throw new Error('等待全部重建期间聊天已切换，已取消任务。');
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
              Math.max(
                outsideWindowTarget,
                state?.stageSummary.coveredThroughMessageId ?? -1,
              ),
            );
            if (targetEndMessageId < 0) {
              throw new Error('当前聊天还没有可用于重建阶段总结的窗口外历史。');
            }
            this.setSkeletonActivityStatus(
              panel,
              '正在重建阶段总结，完成后将重新生成全局剧情骨架…',
            );
            const summaryResult = await stageSummaryService.rebuildAllThrough(
              targetEndMessageId,
              (progress) => {
                if (label) {
                  label.textContent = progress.resumed
                    ? `已恢复 ${progress.completedChunks ?? 0} 批，继续重建…`
                    : `阶段总结：已完成 ${progress.endMessageId + 1}/${progress.targetEndMessageId + 1}`;
                }
                this.setSkeletonActivityStatus(
                  panel,
                  progress.resumed
                    ? `已恢复 ${progress.completedChunks ?? 0} 批草稿，将从消息 ${progress.endMessageId + 1} 继续；完成后重新生成全局剧情骨架…`
                    : `正在重建阶段总结：已完成 ${progress.endMessageId + 1}/${progress.targetEndMessageId + 1}；完成后将重新生成全局剧情骨架…`,
                );
              },
            );
            if (summaryResult.updatedChunks === 0) {
              throw new Error('窗口外历史尚不足一个完整阶段总结批次，未替换现有结果。');
            }
            summariesRebuilt = true;
            if (label) {
              label.textContent = '正在重建全局骨架…';
            }
            this.setSkeletonActivityStatus(
              panel,
              storySkeletonGenerationStatusText('rebuild'),
            );
            const skeletonResult = await storySkeletonService.rebuildAll((progress) => {
              if (label) {
                label.textContent = progress.pendingEntries > 0
                  ? `全局骨架：剩余 ${progress.pendingEntries} 条总结`
                  : '正在保存全局骨架…';
              }
              this.setSkeletonActivityStatus(
                panel,
                storySkeletonGenerationStatusText('rebuild', progress),
              );
            });
            return { summaryResult, skeletonResult };
          },
        );
        this.resetSelection();
        this.skeletonDirty = false;
        notify.success(
          `全部重建完成：生成 ${result.summaryResult.updatedChunks} 条阶段总结，骨架处理 ${result.skeletonResult.updatedChunks} 批。`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : '全部重建失败。';
        if (summariesRebuilt) {
          this.resetSelection();
          this.skeletonDirty = false;
        }
        const checkpoint = this.repository.getExisting()?.stageSummary.rebuildCheckpoint;
        notify.error(summariesRebuilt
          ? `阶段总结已重建，但骨架重建失败并已停止注入：${message}`
          : checkpoint
            ? `${message}；已保留 ${checkpoint.entries.length} 批草稿，再次点击可从消息 ${(checkpoint.entries.at(-1)?.sourceEndMessageId ?? -1) + 1} 继续。`
            : message);
      } finally {
        try {
          await onChanged();
        } catch {
          // The operation result is already persisted; a later panel refresh
          // will render it if the current refresh is interrupted.
        }
        this.setSkeletonActivityStatus(panel, '');
        if (label) {
          label.textContent = idleLabel;
        }
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
      if (this.summaryRegenerationActive) {
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
        !await showConfirmation(
          '放弃未保存的阶段总结修改',
          '当前阶段总结有尚未保存的修改，确定放弃并关闭或切换吗？',
        )
      ) {
        return;
      }
      this.selectedSummaryKey = nextKey;
      this.editorDirty = false;
      this.populatedSummaryKey = '';
      this.render(panel, this.repository.getExisting());
    });

    element<HTMLButtonElement>(panel, '#story-echo-summary-save').addEventListener('click', async (event) => {
      const current = this.currentSummary();
      if (!current) {
        return;
      }
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      try {
        const text = editorText.value;
        const submittedRevision = this.editorRevision;
        const requestedChatId = getCurrentChatId();
        const sourceStartMessageId = current.sourceStartMessageId;
        await storyEchoTaskCoordinator.enqueueManual('保存阶段总结', async () => {
          if (!requestedChatId || getCurrentChatId() !== requestedChatId) {
            throw new Error('等待保存期间聊天已切换，已取消修改。');
          }
          return this.repository.updateStageSummaryEntry(sourceStartMessageId, { text });
        });
        if (this.editorRevision === submittedRevision) {
          this.editorDirty = false;
        }
        await onChanged();
        notify.success('阶段总结已保存。');
      } catch (error) {
        notify.error(error instanceof Error ? error.message : '保存阶段总结失败。');
      } finally {
        button.disabled = false;
      }
    });

    element<HTMLButtonElement>(panel, '#story-echo-summary-regenerate').addEventListener('click', async (event) => {
      // Capture the button before awaiting SillyTavern's confirmation popup.
      const button = event.currentTarget as HTMLButtonElement;
      const label = button.querySelector<HTMLElement>('span');
      const idleLabel = label?.textContent ?? '重新生成当前总结';
      const state = this.repository.getExisting();
      const current = this.currentSummary(state);
      if (!state || !current) {
        this.resetSelection();
        this.render(panel, state);
        return;
      }
      const invalidatesSkeleton = Boolean(
        state.storySkeleton.text &&
        current.sourceEndMessageId <= state.storySkeleton.coveredThroughMessageId,
      );
      if (!await showConfirmation(
        '重新生成当前阶段总结',
        stageSummaryRegenerationConfirmation(
          current,
          this.editorDirty,
          invalidatesSkeleton,
        ),
      )) {
        return;
      }
      const requestedChatId = getCurrentChatId();
      const sourceStartMessageId = current.sourceStartMessageId;
      const expectedUpdatedAt = current.updatedAt;
      this.summaryRegenerationActive = true;
      if (label) {
        label.textContent = '正在重新生成…';
      }
      this.render(panel, state);
      try {
        const result = await storyEchoTaskCoordinator.enqueueManual(
          '重新生成当前阶段总结',
          async () => {
            if (!requestedChatId || getCurrentChatId() !== requestedChatId) {
              throw new Error('等待重新生成阶段总结期间聊天已切换，已取消任务。');
            }
            return stageSummaryService.regenerateEntry(
              sourceStartMessageId,
              expectedUpdatedAt,
            );
          },
        );
        this.editorDirty = false;
        this.populatedSummaryKey = '';
        this.populatedUpdatedAt = '';
        await onChanged();
        notify.success(
          `阶段总结已重新生成：${result.previousCharacterCount} 字 → ${stageSummaryCharacterCount(result.entry)} 字。`,
        );
      } catch (error) {
        notify.error(error instanceof Error ? error.message : '重新生成阶段总结失败，已保留原有结果。');
      } finally {
        this.summaryRegenerationActive = false;
        if (label) {
          label.textContent = idleLabel;
        }
        this.render(panel, this.repository.getExisting());
      }
    });

    element<HTMLButtonElement>(panel, '#story-echo-summary-delete').addEventListener('click', async (event) => {
      // Preserve the button across the asynchronous popup boundary.
      const button = event.currentTarget as HTMLButtonElement;
      const state = this.repository.getExisting();
      const current = this.currentSummary(state);
      if (!state || !current) {
        this.resetSelection();
        this.render(panel, state);
        return;
      }
      const deletionMode = stageSummaryDeletionMode(state.stageSummary.entries, current);
      const consequence = deletionMode === 'restore-raw-tail'
        ? '这是最新一条总结。删除后覆盖位置会回退，这一段原文将重新参与后续请求。'
        : '这是较老的总结。删除后只会停用该总结；它覆盖的旧原文不会重新发送，后续总结与覆盖位置保持不变。';
      if (!await showConfirmation(
        '删除阶段总结',
        `删除消息 ${current.sourceStartMessageId}～${current.sourceEndMessageId} 的阶段总结？\n\n${consequence}\n\n任何聊天原文都不会被修改或删除。若等待期间后台新增了总结，将以实际执行时的位置采用上述规则。`,
      )) {
        return;
      }
      button.disabled = true;
      try {
        const requestedChatId = getCurrentChatId();
        const result = await storyEchoTaskCoordinator.enqueueManual('删除阶段总结', async () => {
          if (!requestedChatId || getCurrentChatId() !== requestedChatId) {
            throw new Error('等待删除期间聊天已切换，已取消操作。');
          }
          return this.repository.deleteStageSummaryEntry(current.sourceStartMessageId);
        });
        const restoredRaw = !result.stageSummary.entries.some((entry) => (
          entry.sourceStartMessageId === current.sourceStartMessageId
        ));
        this.resetSelection();
        await onChanged();
        notify.success(restoredRaw
          ? '最新阶段总结已删除，对应原文将重新参与后续请求。'
          : '较老阶段总结已停用，对应原文仍保持压缩。');
      } catch (error) {
        notify.error(error instanceof Error ? error.message : '删除阶段总结失败。');
      } finally {
        button.disabled = false;
      }
    });

    // Keep the unused local variable intentional: resolving it during bind
    // verifies the editor exists before listeners are installed.
    void editor;
  }

  render(panel: HTMLElement, state: StoryEchoChatState | null): void {
    const list = element<HTMLElement>(panel, '#story-echo-summary-list');
    const count = element<HTMLElement>(panel, '#story-echo-summary-count');
    const editor = element<HTMLElement>(panel, '#story-echo-summary-editor');
    const pagination = element<HTMLElement>(panel, '#story-echo-summary-pagination');
    const previous = element<HTMLButtonElement>(panel, '#story-echo-summary-previous');
    const next = element<HTMLButtonElement>(panel, '#story-echo-summary-next');
    const pageLabel = element<HTMLElement>(panel, '#story-echo-summary-page');
    const chatUuid = state?.chatUuid ?? '';
    if (chatUuid !== this.renderedChatUuid) {
      this.renderedChatUuid = chatUuid;
      this.currentPage = 1;
      this.resetSelection();
      this.skeletonDirty = false;
      this.populatedSkeletonUpdatedAt = null;
      this.skeletonActivityStatus = '';
      this.summaryRegenerationActive = false;
    }

    const skeleton = state?.storySkeleton;
    const skeletonText = element<HTMLTextAreaElement>(panel, '#story-echo-skeleton-text');
    const skeletonSave = element<HTMLButtonElement>(panel, '#story-echo-skeleton-save');
    const skeletonUpdate = element<HTMLButtonElement>(panel, '#story-echo-skeleton-update');
    const skeletonRebuild = element<HTMLButtonElement>(panel, '#story-echo-skeleton-rebuild');
    const summaryRebuildAll = element<HTMLButtonElement>(panel, '#story-echo-summary-rebuild-all');
    const summaryRebuildStatus = element<HTMLElement>(panel, '#story-echo-summary-rebuild-status');
    const skeletonStatus = element<HTMLElement>(panel, '#story-echo-skeleton-status');
    const skeletonBusy = Boolean(this.skeletonActivityStatus) ||
      this.summaryRegenerationActive;
    skeletonText.disabled = !skeleton?.text || skeletonBusy;
    skeletonSave.disabled = !skeleton?.text || skeletonBusy;
    skeletonUpdate.disabled = !state || skeletonBusy;
    skeletonRebuild.disabled = !state || skeletonBusy;
    summaryRebuildAll.disabled = !state || skeletonBusy;
    summaryRebuildStatus.textContent = stageSummaryRebuildCheckpointText(
      state?.stageSummary.rebuildCheckpoint,
    );
    skeletonStatus.classList.toggle(
      'story-echo-skeleton-status-active',
      Boolean(this.skeletonActivityStatus),
    );
    skeletonStatus.textContent = this.skeletonActivityStatus || (skeleton?.text
      ? [
          skeleton.stale ? '待重建，当前不会注入' : `覆盖到消息 ${skeleton.coveredThroughMessageId}`,
          formattedTime(skeleton.updatedAt ?? ''),
          skeleton.manuallyEdited ? '含人工编辑' : '',
        ].filter(Boolean).join(' · ')
      : '尚未生成：最近阶段总结超过 S 条后自动创建');
    if (!this.skeletonDirty && (skeleton?.updatedAt ?? '') !== this.populatedSkeletonUpdatedAt) {
      skeletonText.value = skeleton?.text ?? '';
      this.populatedSkeletonUpdatedAt = skeleton?.updatedAt ?? '';
    }

    const entries = (state?.stageSummary.entries ?? []).filter((entry) => !entry.deleted);
    const summaryWindowSize = this.settingsRepository.get().summary.windowSize;
    const skeletonUsable = Boolean(state && storySkeletonIsUsable(state));
    const selected = entries.find((entry) => stageSummaryKey(entry) === this.selectedSummaryKey);
    if (this.selectedSummaryKey && !selected) {
      this.resetSelection();
    }
    const search = element<HTMLInputElement>(panel, '#story-echo-summary-search')
      .value.trim().toLocaleLowerCase();
    const filtered: RenderedSummary[] = entries
      .map((entry, index) => ({ entry, index, key: stageSummaryKey(entry) }))
      .filter(({ entry, index }) => !search || searchableSummary(entry, index).includes(search))
      .reverse();
    const page = paginateItems(filtered, this.currentPage, SUMMARY_PAGE_SIZE);
    this.currentPage = page.page;

    list.replaceChildren();
    const pageDescription = `第 ${page.page} / ${page.totalPages} 页，本页加载 ${page.items.length} 条。`;
    if (entries.length === 0) {
      count.textContent = '当前聊天尚无阶段总结。';
    } else if (filtered.length === 0) {
      count.textContent = `共 ${entries.length} 条，筛选后 0 条。`;
    } else if (search) {
      count.textContent = `共 ${entries.length} 条，筛选后 ${filtered.length} 条；${pageDescription}`;
    } else {
      count.textContent = `共 ${entries.length} 条；${pageDescription}`;
    }
    pagination.hidden = filtered.length <= page.pageSize;
    previous.disabled = page.page <= 1 || skeletonBusy;
    next.disabled = page.page >= page.totalPages || skeletonBusy;
    pageLabel.textContent = `第 ${page.page} / ${page.totalPages} 页`;

    if (filtered.length === 0 && entries.length > 0) {
      const empty = document.createElement('div');
      empty.className = 'story-echo-summary-empty';
      empty.textContent = '没有符合搜索条件的阶段总结。';
      list.append(empty);
    }
    for (const item of page.items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'menu_button story-echo-summary-row';
      button.dataset.summaryKey = item.key;
      button.disabled = skeletonBusy;
      button.classList.toggle(
        'story-echo-summary-row-selected',
        item.key === this.selectedSummaryKey,
      );
      button.setAttribute('aria-expanded', String(item.key === this.selectedSummaryKey));
      button.setAttribute('aria-controls', 'story-echo-summary-editor');
      const title = document.createElement('span');
      title.className = 'story-echo-summary-row-title';
      title.textContent = summaryPreview(item.entry.text);
      const metadata = document.createElement('span');
      metadata.className = 'story-echo-summary-row-meta';
      metadata.textContent = [
        `#${item.index + 1}`,
        `消息 ${item.entry.sourceStartMessageId}～${item.entry.sourceEndMessageId}`,
        `${stageSummaryCharacterCount(item.entry)} 字`,
        stageSummaryDeliveryStatus(
          item.entry,
          item.index,
          entries.length,
          summaryWindowSize,
          skeleton?.coveredThroughMessageId ?? -1,
          skeletonUsable,
        ),
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
    editor.hidden = !current;
    const summaryEditorText = element<HTMLTextAreaElement>(
      panel,
      '#story-echo-summary-editor-text',
    );
    const summarySave = element<HTMLButtonElement>(panel, '#story-echo-summary-save');
    const summaryRegenerate = element<HTMLButtonElement>(
      panel,
      '#story-echo-summary-regenerate',
    );
    const summaryDelete = element<HTMLButtonElement>(panel, '#story-echo-summary-delete');
    summaryEditorText.disabled = !current || skeletonBusy;
    summarySave.disabled = !current || skeletonBusy;
    summaryRegenerate.disabled = !current || skeletonBusy;
    summaryDelete.disabled = !current || skeletonBusy;
    if (
      current &&
      (stageSummaryKey(current) !== this.populatedSummaryKey ||
        (!this.editorDirty && current.updatedAt !== this.populatedUpdatedAt))
    ) {
      const currentIndex = entries.indexOf(current);
      this.populateEditor(panel, current, currentIndex);
      this.populatedSummaryKey = stageSummaryKey(current);
      this.populatedUpdatedAt = current.updatedAt;
      this.editorDirty = false;
    }
  }

  private currentSummary(
    state = this.repository.getExisting(),
  ): StageSummaryEntry | undefined {
    return state?.stageSummary.entries.find(
      (entry) => !entry.deleted && stageSummaryKey(entry) === this.selectedSummaryKey,
    );
  }

  private setSkeletonActivityStatus(panel: HTMLElement, status: string): void {
    this.skeletonActivityStatus = status;
    const busy = Boolean(status) || this.summaryRegenerationActive;
    const state = this.repository.getExisting();
    const skeletonStatus = element<HTMLElement>(panel, '#story-echo-skeleton-status');
    skeletonStatus.classList.toggle('story-echo-skeleton-status-active', busy);
    if (busy) {
      skeletonStatus.textContent = status;
    }
    element<HTMLTextAreaElement>(panel, '#story-echo-skeleton-text').disabled =
      busy || !state?.storySkeleton.text;
    element<HTMLButtonElement>(panel, '#story-echo-skeleton-save').disabled =
      busy || !state?.storySkeleton.text;
    element<HTMLButtonElement>(panel, '#story-echo-skeleton-update').disabled =
      busy || !state;
    element<HTMLButtonElement>(panel, '#story-echo-skeleton-rebuild').disabled =
      busy || !state;
    element<HTMLButtonElement>(panel, '#story-echo-summary-rebuild-all').disabled =
      busy || !state;
    const current = this.currentSummary(state);
    element<HTMLTextAreaElement>(panel, '#story-echo-summary-editor-text').disabled =
      busy || !current;
    element<HTMLButtonElement>(panel, '#story-echo-summary-save').disabled =
      busy || !current;
    element<HTMLButtonElement>(panel, '#story-echo-summary-regenerate').disabled =
      busy || !current;
    element<HTMLButtonElement>(panel, '#story-echo-summary-delete').disabled =
      busy || !current;
  }

  private async changePage(panel: HTMLElement, requestedPage: number): Promise<void> {
    if (requestedPage === this.currentPage || this.summaryRegenerationActive) {
      return;
    }
    if (
      this.editorDirty &&
      !await showConfirmation(
        '放弃未保存的阶段总结修改',
        '当前阶段总结有尚未保存的修改，确定放弃并翻页吗？',
      )
    ) {
      return;
    }
    this.currentPage = requestedPage;
    this.resetSelection();
    this.render(panel, this.repository.getExisting());
  }

  private populateEditor(
    panel: HTMLElement,
    entry: StageSummaryEntry,
    index: number,
  ): void {
    element<HTMLElement>(panel, '#story-echo-summary-editor-range').textContent =
      `#${index + 1}｜消息 ${entry.sourceStartMessageId}～${entry.sourceEndMessageId}｜${stageSummaryCharacterCount(entry)} 字`;
    element<HTMLTextAreaElement>(panel, '#story-echo-summary-editor-text').value = entry.text;
    element<HTMLElement>(panel, '#story-echo-summary-source').textContent = sourceText(entry);
  }

  private resetSelection(): void {
    this.selectedSummaryKey = '';
    this.populatedSummaryKey = '';
    this.populatedUpdatedAt = '';
    this.editorDirty = false;
  }
}
