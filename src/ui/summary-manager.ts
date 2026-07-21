import type { StageSummaryEntry, StoryEchoChatState } from '../core/types';
import { MemoryRepository } from '../memory/repository';
import { getCurrentChatId } from '../platform/sillytavern';
import { storyEchoTaskCoordinator } from '../runtime/task-coordinator';
import { storySkeletonService } from '../summary/skeleton-service';
import { paginateItems } from './memory-manager';
import { notify } from './notifications';

export const SUMMARY_PAGE_SIZE = 10;

export function stageSummaryKey(entry: StageSummaryEntry): string {
  return `${entry.sourceStartMessageId}:${entry.sourceEndMessageId}`;
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
            <div id="story-echo-skeleton-status" class="story-echo-summary-editor-range">达到归档条件后自动生成</div>
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
          <span>只读来源信息</span>
          <pre id="story-echo-summary-source" class="story-echo-summary-source"></pre>
        </div>
        <p class="story-echo-hint">
          正文可按剧情需要自由分段，保存时只校验非空和长度。删除绝不修改或删除聊天原文：删除最新一条会回退覆盖位置，让该段原文重新参与后续请求；删除更老的条目只停用该总结，不重新发送很老的原文，也不影响后续总结。
        </p>
        <div class="story-echo-summary-editor-actions">
          <button id="story-echo-summary-save" class="menu_button story-echo-action-primary" type="button">
            <i class="fa-solid fa-floppy-disk" aria-hidden="true"></i><span>保存修改</span>
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

  constructor(private readonly repository: MemoryRepository) {}

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
      if (
        this.skeletonDirty &&
        !globalThis.confirm('全局剧情骨架有尚未保存的修改，立即更新会放弃这些修改。确定继续吗？')
      ) {
        return;
      }
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      try {
        const requestedChatId = getCurrentChatId();
        const result = await storyEchoTaskCoordinator.enqueueManual('立即更新全局剧情骨架', async () => {
          if (!requestedChatId || getCurrentChatId() !== requestedChatId) {
            throw new Error('等待更新骨架期间聊天已切换，已取消任务。');
          }
          return storySkeletonService.processAllPending();
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
        button.disabled = false;
      }
    });

    element<HTMLButtonElement>(panel, '#story-echo-skeleton-rebuild').addEventListener('click', async (event) => {
      const confirmation = this.skeletonDirty
        ? '骨架有尚未保存的修改。重新生成会放弃这些修改，并从当前聊天全部有效阶段总结由旧到新干净重建。确定继续吗？'
        : '将丢弃现有骨架基线，从当前聊天全部有效阶段总结由旧到新分批重建；所有批次成功后才替换现有骨架。确定继续吗？';
      if (!globalThis.confirm(confirmation)) {
        return;
      }
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      try {
        const requestedChatId = getCurrentChatId();
        const result = await storyEchoTaskCoordinator.enqueueManual('重新生成全局剧情骨架', async () => {
          if (!requestedChatId || getCurrentChatId() !== requestedChatId) {
            throw new Error('等待重新生成骨架期间聊天已切换，已取消任务。');
          }
          return storySkeletonService.rebuildAll();
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
        button.disabled = false;
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
    element<HTMLButtonElement>(panel, '#story-echo-summary-previous').addEventListener('click', () => {
      this.changePage(panel, this.currentPage - 1);
    });
    element<HTMLButtonElement>(panel, '#story-echo-summary-next').addEventListener('click', () => {
      this.changePage(panel, this.currentPage + 1);
    });
    element<HTMLElement>(panel, '#story-echo-summary-list').addEventListener('click', (event) => {
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
        !globalThis.confirm('当前阶段总结有尚未保存的修改，确定放弃并关闭或切换吗？')
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

    element<HTMLButtonElement>(panel, '#story-echo-summary-delete').addEventListener('click', async (event) => {
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
      if (!globalThis.confirm(
        `删除消息 ${current.sourceStartMessageId}～${current.sourceEndMessageId} 的阶段总结？\n\n${consequence}\n\n任何聊天原文都不会被修改或删除。若等待期间后台新增了总结，将以实际执行时的位置采用上述规则。`,
      )) {
        return;
      }
      const button = event.currentTarget as HTMLButtonElement;
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
    }

    const skeleton = state?.storySkeleton;
    const skeletonText = element<HTMLTextAreaElement>(panel, '#story-echo-skeleton-text');
    const skeletonSave = element<HTMLButtonElement>(panel, '#story-echo-skeleton-save');
    const skeletonUpdate = element<HTMLButtonElement>(panel, '#story-echo-skeleton-update');
    const skeletonRebuild = element<HTMLButtonElement>(panel, '#story-echo-skeleton-rebuild');
    const skeletonStatus = element<HTMLElement>(panel, '#story-echo-skeleton-status');
    skeletonText.disabled = !skeleton?.text;
    skeletonSave.disabled = !skeleton?.text;
    skeletonUpdate.disabled = !state;
    skeletonRebuild.disabled = !state;
    skeletonStatus.textContent = skeleton?.text
      ? [
          skeleton.stale ? '待重建，当前不会注入' : `覆盖到消息 ${skeleton.coveredThroughMessageId}`,
          formattedTime(skeleton.updatedAt ?? ''),
          skeleton.manuallyEdited ? '含人工编辑' : '',
        ].filter(Boolean).join(' · ')
      : '尚未生成：最近阶段总结超过 S 条后自动创建';
    if (!this.skeletonDirty && (skeleton?.updatedAt ?? '') !== this.populatedSkeletonUpdatedAt) {
      skeletonText.value = skeleton?.text ?? '';
      this.populatedSkeletonUpdatedAt = skeleton?.updatedAt ?? '';
    }

    const entries = (state?.stageSummary.entries ?? []).filter((entry) => !entry.deleted);
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
    previous.disabled = page.page <= 1;
    next.disabled = page.page >= page.totalPages;
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

  private changePage(panel: HTMLElement, requestedPage: number): void {
    if (requestedPage === this.currentPage) {
      return;
    }
    if (
      this.editorDirty &&
      !globalThis.confirm('当前阶段总结有尚未保存的修改，确定放弃并翻页吗？')
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
      `#${index + 1}｜消息 ${entry.sourceStartMessageId}～${entry.sourceEndMessageId}`;
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
