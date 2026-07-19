import type {
  MemoryStatus,
  MemoryType,
  StoryEchoChatState,
  StoryMemory,
  TruthStatus,
} from '../core/types';
import { MemoryRepository, type StoryMemoryEdit } from '../memory/repository';
import { getCurrentChatId } from '../platform/sillytavern';
import { storyEchoTaskCoordinator } from '../runtime/task-coordinator';
import { notify } from './notifications';

const TYPE_LABELS: Readonly<Record<MemoryType, string>> = {
  event: '事件',
  state_change: '状态变化',
  relationship_change: '关系变化',
  commitment: '承诺/任务',
  revelation: '揭示/秘密',
  clue: '线索',
  conflict: '冲突',
};

const STATUS_LABELS: Readonly<Record<MemoryStatus, string>> = {
  active: '有效',
  resolved: '已解决',
  superseded: '已取代',
  invalid: '无效',
};

const TRUTH_LABELS: Readonly<Record<TruthStatus, string>> = {
  confirmed: '已确认',
  claimed: '角色声称',
  inferred: '推断',
  uncertain: '不确定',
};

export const MEMORY_PAGE_SIZE = 10;

export interface PaginationSlice<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export function paginateItems<T>(
  items: readonly T[],
  requestedPage: number,
  pageSize = MEMORY_PAGE_SIZE,
): PaginationSlice<T> {
  const safePageSize = Number.isFinite(pageSize) && pageSize > 0
    ? Math.max(1, Math.floor(pageSize))
    : MEMORY_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(items.length / safePageSize));
  const safeRequestedPage = Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1;
  const page = Math.min(totalPages, Math.max(1, safeRequestedPage));
  const start = (page - 1) * safePageSize;
  return {
    items: items.slice(start, start + safePageSize),
    page,
    pageSize: safePageSize,
    totalItems: items.length,
    totalPages,
  };
}

export function memoryManagerTemplate(): string {
  return `
    <details id="story-echo-memory-manager" class="story-echo-section story-echo-collapsible">
      <summary class="story-echo-section-summary">
        <span class="story-echo-section-summary-main">
          <i class="fa-solid fa-database" aria-hidden="true"></i>
          <span class="story-echo-section-summary-copy">
            <span class="story-echo-section-summary-title">剧情记忆元数据</span>
            <span class="story-echo-section-summary-description">查看、修改或删除当前聊天的抽取结果</span>
          </span>
        </span>
        <i class="fa-solid fa-chevron-right story-echo-section-chevron" aria-hidden="true"></i>
      </summary>
      <div class="story-echo-section-body story-echo-memory-manager-body">
        <div class="story-echo-memory-toolbar">
          <label class="story-echo-field">
            <span>搜索</span>
            <input id="story-echo-memory-search" class="text_pole" type="search" placeholder="事件、实体、地点或ID">
          </label>
          <label class="story-echo-field">
            <span>状态</span>
            <select id="story-echo-memory-filter" class="text_pole">
              <option value="all">全部</option>
              <option value="active">有效</option>
              <option value="resolved">已解决</option>
              <option value="superseded">已取代</option>
              <option value="invalid">无效</option>
            </select>
          </label>
          <button id="story-echo-memory-reload" class="menu_button" type="button">
            <i class="fa-solid fa-rotate" aria-hidden="true"></i><span>刷新列表</span>
          </button>
          <button id="story-echo-memory-rebuild" class="menu_button" type="button">
            <i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i><span>重建自动元数据</span>
          </button>
        </div>
        <div id="story-echo-memory-count" class="story-echo-memory-count">尚无剧情记忆。</div>
        <div id="story-echo-memory-list" class="story-echo-memory-list"></div>
        <nav id="story-echo-memory-pagination" class="story-echo-memory-pagination" aria-label="剧情记忆分页" hidden>
          <button id="story-echo-memory-previous" class="menu_button" type="button">
            <i class="fa-solid fa-chevron-left" aria-hidden="true"></i><span>上一页</span>
          </button>
          <span id="story-echo-memory-page" class="story-echo-memory-page" aria-live="polite">第 1 / 1 页</span>
          <button id="story-echo-memory-next" class="menu_button" type="button">
            <span>下一页</span><i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
          </button>
        </nav>

        <div id="story-echo-memory-editor" class="story-echo-memory-editor" hidden>
          <div class="story-echo-memory-editor-heading">
            <div>
              <strong>编辑剧情记忆</strong>
              <div id="story-echo-memory-editor-id" class="story-echo-memory-editor-id"></div>
            </div>
            <span class="story-echo-memory-manual-hint">保存后标记为人工编辑，自动整理不会覆盖它</span>
          </div>

          <div class="story-echo-grid">
            <label class="story-echo-field">
              <span>类型</span>
              <select id="story-echo-memory-type" class="text_pole">
                <option value="event">事件</option>
                <option value="state_change">状态变化</option>
                <option value="relationship_change">关系变化</option>
                <option value="commitment">承诺/任务</option>
                <option value="revelation">揭示/秘密</option>
                <option value="clue">线索</option>
                <option value="conflict">冲突</option>
              </select>
            </label>
            <label class="story-echo-field">
              <span>状态</span>
              <select id="story-echo-memory-status" class="text_pole">
                <option value="active">有效</option>
                <option value="resolved">已解决</option>
                <option value="superseded">已取代</option>
                <option value="invalid">无效</option>
              </select>
            </label>
            <label class="story-echo-field">
              <span>事实可信度</span>
              <select id="story-echo-memory-truth" class="text_pole">
                <option value="confirmed">已确认</option>
                <option value="claimed">角色声称</option>
                <option value="inferred">推断</option>
                <option value="uncertain">不确定</option>
              </select>
            </label>
            <label class="story-echo-field">
              <span>重要度（0～1）</span>
              <input id="story-echo-memory-importance" class="text_pole" type="number" min="0" max="1" step="0.05">
            </label>
            <label class="story-echo-field story-echo-field-wide">
              <span>事件/事实</span>
              <textarea id="story-echo-memory-event" class="text_pole" rows="3"></textarea>
            </label>
            <label class="story-echo-field story-echo-field-wide">
              <span>检索文本（用于Embedding和关键词检索）</span>
              <textarea id="story-echo-memory-retrieval" class="text_pole" rows="4"></textarea>
            </label>
            <label class="story-echo-field story-echo-field-wide">
              <span>注入文本（召回后发送给角色模型）</span>
              <textarea id="story-echo-memory-injection" class="text_pole" rows="4"></textarea>
            </label>
            <label class="story-echo-field">
              <span>场景地点</span>
              <input id="story-echo-memory-location" class="text_pole" type="text">
            </label>
            <label class="story-echo-field">
              <span>场景时间</span>
              <input id="story-echo-memory-time" class="text_pole" type="text">
            </label>
            <label class="story-echo-field">
              <span>原因</span>
              <textarea id="story-echo-memory-cause" class="text_pole" rows="2"></textarea>
            </label>
            <label class="story-echo-field">
              <span>结果</span>
              <textarea id="story-echo-memory-consequence" class="text_pole" rows="2"></textarea>
            </label>
            <label class="story-echo-field">
              <span>实体（每行一个）</span>
              <textarea id="story-echo-memory-entities" class="text_pole" rows="3"></textarea>
            </label>
            <label class="story-echo-field">
              <span>别名（每行一个）</span>
              <textarea id="story-echo-memory-aliases" class="text_pole" rows="3"></textarea>
            </label>
            <label class="story-echo-field">
              <span>参与者（每行一个）</span>
              <textarea id="story-echo-memory-participants" class="text_pole" rows="3"></textarea>
            </label>
            <label class="story-echo-field">
              <span>知情者（每行一个）</span>
              <textarea id="story-echo-memory-known-by" class="text_pole" rows="3"></textarea>
            </label>
            <label class="story-echo-field story-echo-field-wide">
              <span>未解决事项（每行一个）</span>
              <textarea id="story-echo-memory-unresolved" class="text_pole" rows="3"></textarea>
            </label>
            <label class="story-echo-field story-echo-field-wide">
              <span>状态变化（JSON数组）</span>
              <textarea id="story-echo-memory-state-changes" class="text_pole story-echo-memory-json" rows="7" spellcheck="false"></textarea>
            </label>
            <label class="story-echo-memory-check">
              <input id="story-echo-memory-pinned" type="checkbox">
              <span>置顶（排序时优先）</span>
            </label>
            <label class="story-echo-memory-check">
              <input id="story-echo-memory-excluded" type="checkbox">
              <span>排除（不参与召回）</span>
            </label>
            <div class="story-echo-field story-echo-field-wide">
              <span>只读来源与内部信息</span>
              <pre id="story-echo-memory-source" class="story-echo-memory-source"></pre>
            </div>
          </div>
          <div class="story-echo-memory-editor-actions">
            <button id="story-echo-memory-save" class="menu_button story-echo-action-primary" type="button">
              <i class="fa-solid fa-floppy-disk" aria-hidden="true"></i><span>保存修改</span>
            </button>
            <button id="story-echo-memory-delete" class="menu_button story-echo-memory-delete" type="button">
              <i class="fa-solid fa-trash" aria-hidden="true"></i><span>删除记忆</span>
            </button>
          </div>
        </div>
      </div>
    </details>
  `;
}

function element<T extends HTMLElement>(panel: HTMLElement, selector: string): T {
  const found = panel.querySelector<T>(selector);
  if (!found) {
    throw new Error(`记忆管理控件不存在：${selector}`);
  }
  return found;
}

function lines(value: readonly string[]): string {
  return value.join('\n');
}

function parseLines(value: string): string[] {
  return [...new Set(value
    .split(/[\n,，]+/u)
    .map((item) => item.trim())
    .filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStateChanges(value: string): StoryMemoryEdit['stateChanges'] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.trim() || '[]');
  } catch (error) {
    throw new Error('状态变化不是有效JSON。', { cause: error });
  }
  if (!Array.isArray(parsed)) {
    throw new Error('状态变化必须是JSON数组。');
  }
  return parsed.map((item) => {
    if (!isRecord(item)) {
      throw new Error('每条状态变化必须是JSON对象。');
    }
    const entity = String(item['entity'] ?? '').trim();
    const attribute = String(item['attribute'] ?? '').trim();
    const before = String(item['before'] ?? '').trim();
    const after = String(item['after'] ?? '').trim();
    if (!entity || !attribute || !after) {
      throw new Error('状态变化必须包含非空的entity、attribute和after。');
    }
    return { entity, attribute, ...(before ? { before } : {}), after };
  });
}

function searchableMemory(memory: StoryMemory): string {
  return [
    memory.id,
    memory.logicalKey,
    memory.event,
    memory.retrievalText,
    memory.injectionText,
    memory.scene.location ?? '',
    memory.scene.time ?? '',
    ...memory.scene.participants,
    ...memory.entities,
    ...memory.aliases,
    ...memory.knownBy,
  ].join('\n').toLocaleLowerCase();
}

function sourceText(memory: StoryMemory): string {
  return JSON.stringify({
    id: memory.id,
    logicalKey: memory.logicalKey,
    sourceMessageIds: memory.sourceMessageIds,
    evidenceRole: memory.evidenceRole,
    source: memory.source,
    sourceHistory: memory.sourceHistory,
    vectorHash: memory.vectorHash,
    retrievalHash: memory.retrievalHash,
    manuallyEdited: memory.manuallyEdited,
    supersedesMemoryIds: memory.supersedesMemoryIds,
    replacedByMemoryId: memory.replacedByMemoryId ?? null,
    lastOperation: memory.lastOperation,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  }, null, 2);
}

export function toggleMemorySelection(currentMemoryId: string, clickedMemoryId: string): string {
  return currentMemoryId === clickedMemoryId ? '' : clickedMemoryId;
}

export class MemoryMetadataManager {
  private selectedMemoryId = '';
  private populatedMemoryId = '';
  private populatedUpdatedAt = '';
  private editorDirty = false;
  private editorRevision = 0;
  private currentPage = 1;
  private renderedChatUuid = '';

  constructor(
    private readonly repository: MemoryRepository,
    private readonly syncVectors: (state: StoryEchoChatState) => Promise<unknown>,
    private readonly rebuildAutomaticMemories: () => Promise<unknown>,
  ) {}

  bind(panel: HTMLElement, onChanged: () => Promise<void>): void {
    const editor = element<HTMLElement>(panel, '#story-echo-memory-editor');
    for (const control of editor.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      'input, textarea, select',
    )) {
      const markDirty = (): void => {
        this.editorDirty = true;
        this.editorRevision += 1;
      };
      control.addEventListener('input', markDirty);
      control.addEventListener('change', markDirty);
    }
    element<HTMLInputElement>(panel, '#story-echo-memory-search').addEventListener('input', () => {
      this.currentPage = 1;
      this.render(panel, this.repository.getExisting());
    });
    element<HTMLSelectElement>(panel, '#story-echo-memory-filter').addEventListener('change', () => {
      this.currentPage = 1;
      this.render(panel, this.repository.getExisting());
    });
    element<HTMLButtonElement>(panel, '#story-echo-memory-reload').addEventListener('click', () => {
      this.currentPage = 1;
      this.render(panel, this.repository.getExisting());
    });
    element<HTMLButtonElement>(panel, '#story-echo-memory-previous').addEventListener('click', () => {
      this.changePage(panel, this.currentPage - 1);
    });
    element<HTMLButtonElement>(panel, '#story-echo-memory-next').addEventListener('click', () => {
      this.changePage(panel, this.currentPage + 1);
    });
    element<HTMLButtonElement>(panel, '#story-echo-memory-rebuild').addEventListener('click', async (event) => {
      if (!globalThis.confirm(
        `重新抽取当前窗口外的自动剧情元数据？\n\n人工修改过的记忆会保留；自动抽取结果会删除后重建。长聊天会重新调用多次LLM和Embedding并产生相应用量。${this.editorDirty ? '\n当前编辑器中未保存的修改会丢失。' : ''}`,
      )) {
        return;
      }
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      try {
        await this.rebuildAutomaticMemories();
        this.selectedMemoryId = '';
        this.editorDirty = false;
        this.populatedMemoryId = '';
        this.populatedUpdatedAt = '';
        this.currentPage = 1;
        await onChanged();
        notify.success('自动剧情元数据已重建。');
      } catch (error) {
        notify.error(error instanceof Error ? error.message : '重建剧情元数据失败。');
      } finally {
        button.disabled = false;
      }
    });
    element<HTMLElement>(panel, '#story-echo-memory-list').addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const button = target.closest<HTMLButtonElement>('button[data-memory-id]');
      if (!button?.dataset.memoryId) {
        return;
      }
      const nextMemoryId = toggleMemorySelection(
        this.selectedMemoryId,
        button.dataset.memoryId,
      );
      if (
        this.editorDirty &&
        !globalThis.confirm('当前元数据有尚未保存的修改，确定放弃并关闭或切换吗？')
      ) {
        return;
      }
      this.selectedMemoryId = nextMemoryId;
      this.editorDirty = false;
      this.populatedMemoryId = '';
      this.render(panel, this.repository.getExisting());
    });
    element<HTMLButtonElement>(panel, '#story-echo-memory-save').addEventListener('click', async (event) => {
      if (!this.selectedMemoryId) {
        return;
      }
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      try {
        const memoryId = this.selectedMemoryId;
        const edit = this.readEdit(panel);
        const submittedRevision = this.editorRevision;
        const requestedChatId = getCurrentChatId();
        const { syncError } = await storyEchoTaskCoordinator.enqueueManual(
          '保存剧情记忆元数据',
          async () => {
            if (!requestedChatId || getCurrentChatId() !== requestedChatId) {
              throw new Error('等待保存期间聊天已切换，已取消修改。');
            }
            const state = await this.repository.updateMemory(memoryId, edit);
            try {
              await this.syncVectors(state);
              return { syncError: null };
            } catch (error) {
              return { syncError: error };
            }
          },
        );
        if (this.selectedMemoryId === memoryId && this.editorRevision === submittedRevision) {
          this.editorDirty = false;
          // Saving refreshes updatedAt and normally moves the row to the front
          // of the sorted list. Return to the first page so the saved row does
          // not appear to vanish from a later page.
          this.currentPage = 1;
        }
        if (syncError) {
          notify.info(`修改已保存；向量同步将在稍后重试：${syncError instanceof Error ? syncError.message : String(syncError)}`);
        }
        await onChanged();
        notify.success('剧情记忆元数据已保存。');
      } catch (error) {
        notify.error(error instanceof Error ? error.message : '保存剧情记忆失败。');
      } finally {
        button.disabled = false;
      }
    });
    element<HTMLButtonElement>(panel, '#story-echo-memory-delete').addEventListener('click', async (event) => {
      if (!this.selectedMemoryId) {
        return;
      }
      const current = this.repository.getExisting()?.memories.find(
        (memory) => memory.id === this.selectedMemoryId,
      );
      if (!current) {
        this.selectedMemoryId = '';
        this.editorDirty = false;
        this.populatedMemoryId = '';
        this.populatedUpdatedAt = '';
        this.render(panel, this.repository.getExisting());
        return;
      }
      if (!globalThis.confirm(`删除这条剧情记忆？\n\n${current.event}`)) {
        return;
      }
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      try {
        const requestedChatId = getCurrentChatId();
        const { syncError } = await storyEchoTaskCoordinator.enqueueManual(
          '删除剧情记忆元数据',
          async () => {
            if (!requestedChatId || getCurrentChatId() !== requestedChatId) {
              throw new Error('等待删除期间聊天已切换，已取消操作。');
            }
            const state = await this.repository.removeMemory(current.id);
            try {
              await this.syncVectors(state);
              return { syncError: null };
            } catch (error) {
              return { syncError: error };
            }
          },
        );
        if (this.selectedMemoryId === current.id) {
          this.selectedMemoryId = '';
          this.editorDirty = false;
          this.populatedMemoryId = '';
          this.populatedUpdatedAt = '';
        }
        if (syncError) {
          notify.info(`记忆已删除；旧向量清理将在稍后重试：${syncError instanceof Error ? syncError.message : String(syncError)}`);
        }
        await onChanged();
        notify.success('剧情记忆已删除。');
      } catch (error) {
        notify.error(error instanceof Error ? error.message : '删除剧情记忆失败。');
      } finally {
        button.disabled = false;
      }
    });
  }

  render(panel: HTMLElement, state: StoryEchoChatState | null): void {
    const list = element<HTMLElement>(panel, '#story-echo-memory-list');
    const count = element<HTMLElement>(panel, '#story-echo-memory-count');
    const editor = element<HTMLElement>(panel, '#story-echo-memory-editor');
    const pagination = element<HTMLElement>(panel, '#story-echo-memory-pagination');
    const previous = element<HTMLButtonElement>(panel, '#story-echo-memory-previous');
    const next = element<HTMLButtonElement>(panel, '#story-echo-memory-next');
    const pageLabel = element<HTMLElement>(panel, '#story-echo-memory-page');
    const chatUuid = state?.chatUuid ?? '';
    if (chatUuid !== this.renderedChatUuid) {
      this.renderedChatUuid = chatUuid;
      this.currentPage = 1;
      this.selectedMemoryId = '';
      this.editorDirty = false;
      this.populatedMemoryId = '';
      this.populatedUpdatedAt = '';
    }
    const memories = state?.memories ?? [];
    const selected = memories.find((memory) => memory.id === this.selectedMemoryId);
    if (this.selectedMemoryId && !selected) {
      this.selectedMemoryId = '';
      this.editorDirty = false;
      this.populatedMemoryId = '';
      this.populatedUpdatedAt = '';
    }
    const search = element<HTMLInputElement>(panel, '#story-echo-memory-search')
      .value.trim().toLocaleLowerCase();
    const status = element<HTMLSelectElement>(panel, '#story-echo-memory-filter').value;
    const filtered = [...memories]
      .filter((memory) => status === 'all' || memory.status === status)
      .filter((memory) => !search || searchableMemory(memory).includes(search))
      .sort((left, right) => {
        if (left.pinned !== right.pinned) {
          return left.pinned ? -1 : 1;
        }
        return right.updatedAt.localeCompare(left.updatedAt);
      });
    const page = paginateItems(filtered, this.currentPage);
    this.currentPage = page.page;

    list.replaceChildren();
    const hasActiveFilter = status !== 'all' || Boolean(search);
    const pageDescription = `第 ${page.page} / ${page.totalPages} 页，本页加载 ${page.items.length} 条。`;
    if (memories.length === 0) {
      count.textContent = '当前聊天尚无剧情记忆。';
    } else if (filtered.length === 0) {
      count.textContent = `共 ${memories.length} 条，筛选后 0 条。`;
    } else if (hasActiveFilter) {
      count.textContent = `共 ${memories.length} 条，筛选后 ${filtered.length} 条；${pageDescription}`;
    } else {
      count.textContent = `共 ${memories.length} 条；${pageDescription}`;
    }
    pagination.hidden = filtered.length <= page.pageSize;
    previous.disabled = page.page <= 1;
    next.disabled = page.page >= page.totalPages;
    pageLabel.textContent = `第 ${page.page} / ${page.totalPages} 页`;
    if (filtered.length === 0 && memories.length > 0) {
      const empty = document.createElement('div');
      empty.className = 'story-echo-memory-empty';
      empty.textContent = '没有符合筛选条件的记忆。';
      list.append(empty);
    }
    for (const memory of page.items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'menu_button story-echo-memory-row';
      button.dataset.memoryId = memory.id;
      button.classList.toggle('story-echo-memory-row-selected', memory.id === this.selectedMemoryId);
      button.setAttribute('aria-expanded', String(memory.id === this.selectedMemoryId));
      button.setAttribute('aria-controls', 'story-echo-memory-editor');
      const title = document.createElement('span');
      title.className = 'story-echo-memory-row-title';
      title.textContent = memory.event;
      const metadata = document.createElement('span');
      metadata.className = 'story-echo-memory-row-meta';
      metadata.textContent = [
        memory.pinned ? '置顶' : '',
        STATUS_LABELS[memory.status],
        TYPE_LABELS[memory.type],
        TRUTH_LABELS[memory.truthStatus],
        `来源 #${memory.sourceMessageIds.join(', #')}`,
        memory.manuallyEdited ? '人工编辑' : '',
      ].filter(Boolean).join(' · ');
      button.append(title, metadata);
      list.append(button);
    }

    if (
      this.selectedMemoryId &&
      !page.items.some((memory) => memory.id === this.selectedMemoryId) &&
      !this.editorDirty
    ) {
      this.selectedMemoryId = '';
      this.populatedMemoryId = '';
      this.populatedUpdatedAt = '';
    }

    const current = memories.find((memory) => memory.id === this.selectedMemoryId);
    editor.hidden = !current;
    if (
      current &&
      (current.id !== this.populatedMemoryId ||
        (!this.editorDirty && current.updatedAt !== this.populatedUpdatedAt))
    ) {
      this.populateEditor(panel, current);
      this.populatedMemoryId = current.id;
      this.populatedUpdatedAt = current.updatedAt;
      this.editorDirty = false;
    }
  }

  private changePage(panel: HTMLElement, requestedPage: number): void {
    if (requestedPage === this.currentPage) {
      return;
    }
    if (
      this.editorDirty &&
      !globalThis.confirm('当前元数据有尚未保存的修改，确定放弃并翻页吗？')
    ) {
      return;
    }
    this.currentPage = requestedPage;
    this.selectedMemoryId = '';
    this.editorDirty = false;
    this.populatedMemoryId = '';
    this.populatedUpdatedAt = '';
    this.render(panel, this.repository.getExisting());
  }

  private populateEditor(panel: HTMLElement, memory: StoryMemory): void {
    element<HTMLElement>(panel, '#story-echo-memory-editor-id').textContent = memory.id;
    element<HTMLSelectElement>(panel, '#story-echo-memory-type').value = memory.type;
    element<HTMLSelectElement>(panel, '#story-echo-memory-status').value = memory.status;
    element<HTMLSelectElement>(panel, '#story-echo-memory-truth').value = memory.truthStatus;
    element<HTMLInputElement>(panel, '#story-echo-memory-importance').value = String(memory.importance);
    element<HTMLTextAreaElement>(panel, '#story-echo-memory-event').value = memory.event;
    element<HTMLTextAreaElement>(panel, '#story-echo-memory-retrieval').value = memory.retrievalText;
    element<HTMLTextAreaElement>(panel, '#story-echo-memory-injection').value = memory.injectionText;
    element<HTMLInputElement>(panel, '#story-echo-memory-location').value = memory.scene.location ?? '';
    element<HTMLInputElement>(panel, '#story-echo-memory-time').value = memory.scene.time ?? '';
    element<HTMLTextAreaElement>(panel, '#story-echo-memory-cause').value = memory.cause ?? '';
    element<HTMLTextAreaElement>(panel, '#story-echo-memory-consequence').value = memory.consequence ?? '';
    element<HTMLTextAreaElement>(panel, '#story-echo-memory-entities').value = lines(memory.entities);
    element<HTMLTextAreaElement>(panel, '#story-echo-memory-aliases').value = lines(memory.aliases);
    element<HTMLTextAreaElement>(panel, '#story-echo-memory-participants').value = lines(
      memory.scene.participants,
    );
    element<HTMLTextAreaElement>(panel, '#story-echo-memory-known-by').value = lines(memory.knownBy);
    element<HTMLTextAreaElement>(panel, '#story-echo-memory-unresolved').value = lines(
      memory.unresolvedThreads,
    );
    element<HTMLTextAreaElement>(panel, '#story-echo-memory-state-changes').value = JSON.stringify(
      memory.stateChanges,
      null,
      2,
    );
    element<HTMLInputElement>(panel, '#story-echo-memory-pinned').checked = memory.pinned;
    element<HTMLInputElement>(panel, '#story-echo-memory-excluded').checked = memory.excluded;
    element<HTMLElement>(panel, '#story-echo-memory-source').textContent = sourceText(memory);
  }

  private readEdit(panel: HTMLElement): StoryMemoryEdit {
    return {
      type: element<HTMLSelectElement>(panel, '#story-echo-memory-type').value as MemoryType,
      status: element<HTMLSelectElement>(panel, '#story-echo-memory-status').value as MemoryStatus,
      truthStatus: element<HTMLSelectElement>(panel, '#story-echo-memory-truth').value as TruthStatus,
      importance: Number(element<HTMLInputElement>(panel, '#story-echo-memory-importance').value),
      event: element<HTMLTextAreaElement>(panel, '#story-echo-memory-event').value,
      cause: element<HTMLTextAreaElement>(panel, '#story-echo-memory-cause').value,
      consequence: element<HTMLTextAreaElement>(panel, '#story-echo-memory-consequence').value,
      scene: {
        location: element<HTMLInputElement>(panel, '#story-echo-memory-location').value,
        time: element<HTMLInputElement>(panel, '#story-echo-memory-time').value,
        participants: parseLines(
          element<HTMLTextAreaElement>(panel, '#story-echo-memory-participants').value,
        ),
      },
      entities: parseLines(element<HTMLTextAreaElement>(panel, '#story-echo-memory-entities').value),
      aliases: parseLines(element<HTMLTextAreaElement>(panel, '#story-echo-memory-aliases').value),
      stateChanges: parseStateChanges(
        element<HTMLTextAreaElement>(panel, '#story-echo-memory-state-changes').value,
      ),
      unresolvedThreads: parseLines(
        element<HTMLTextAreaElement>(panel, '#story-echo-memory-unresolved').value,
      ),
      knownBy: parseLines(element<HTMLTextAreaElement>(panel, '#story-echo-memory-known-by').value),
      retrievalText: element<HTMLTextAreaElement>(panel, '#story-echo-memory-retrieval').value,
      injectionText: element<HTMLTextAreaElement>(panel, '#story-echo-memory-injection').value,
      pinned: element<HTMLInputElement>(panel, '#story-echo-memory-pinned').checked,
      excluded: element<HTMLInputElement>(panel, '#story-echo-memory-excluded').checked,
    };
  }
}
