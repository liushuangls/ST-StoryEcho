import type {
  LatestPromptTokenBreakdown,
  PromptTokenCategory,
  PromptTokenCategoryId,
} from '../prompt/itemization';
import { promptItemizationService } from '../prompt/itemization';
import { getContext, getCurrentChatId } from '../platform/sillytavern';
import { isElementRendered } from './visibility';

const CATEGORY_PRESENTATION: Record<PromptTokenCategoryId, { label: string; className: string }> = {
  system: { label: '系统提示与预设', className: 'system' },
  character: { label: '角色卡与 Persona', className: 'character' },
  'world-info': { label: '世界书', className: 'world-info' },
  examples: { label: '示例对话', className: 'examples' },
  'recent-context': { label: '最近原文上下文', className: 'recent-context' },
  'story-echo-summary': { label: 'StoryEcho 分层总结', className: 'story-echo-summary' },
  'other-prompts': { label: '其他提示与扩展注入', className: 'other-prompts' },
  unclassified: { label: '未分类与消息开销', className: 'unclassified' },
};

export function promptStatsCardTemplate(): string {
  return `
    <details id="story-echo-prompt-stats-card" class="story-echo-section story-echo-collapsible story-echo-prompt-stats-card" open>
      <summary class="story-echo-section-summary">
        <span class="story-echo-section-summary-main">
          <i class="fa-solid fa-chart-pie" aria-hidden="true"></i>
          <span class="story-echo-section-summary-copy">
            <span class="story-echo-section-summary-title">最近一次请求输入 Token 构成</span>
            <span id="story-echo-prompt-stats-subtitle" class="story-echo-section-summary-description">发送一条消息后显示</span>
          </span>
        </span>
        <span class="story-echo-prompt-stats-summary-side">
          <span id="story-echo-prompt-stats-total" class="story-echo-token-total">—</span>
          <i class="fa-solid fa-chevron-right story-echo-section-chevron" aria-hidden="true"></i>
        </span>
      </summary>
      <div class="story-echo-section-body story-echo-prompt-stats-body">
        <div id="story-echo-prompt-stats-empty" class="story-echo-token-empty">
          当前聊天还没有可读取的提示词明细。完成一次角色回复后会自动更新。
        </div>
        <div id="story-echo-prompt-stats-content" hidden>
          <div class="story-echo-token-story-heading">
            <strong>StoryEcho 本轮发送</strong>
            <span>最近原文与分层剧情总结</span>
          </div>
          <div class="story-echo-token-story-grid">
            <div class="story-echo-token-story-stat">
              <span>最近原文上下文</span>
              <strong id="story-echo-token-context">—</strong>
            </div>
            <div class="story-echo-token-story-stat">
              <span>分层剧情总结</span>
              <strong id="story-echo-token-summary">—</strong>
            </div>
          </div>

          <div class="story-echo-token-composition-heading">
            <strong>完整请求构成</strong>
            <span id="story-echo-prompt-stats-meta"></span>
          </div>
          <div id="story-echo-token-bar" class="story-echo-token-bar" role="img" aria-label="最近一次请求 Token 构成"></div>
          <div id="story-echo-token-rows" class="story-echo-token-rows"></div>
          <p id="story-echo-prompt-stats-note" class="story-echo-hint story-echo-token-note"></p>
        </div>
      </div>
    </details>
  `;
}

function element<T extends HTMLElement>(panel: HTMLElement, selector: string): T {
  const found = panel.querySelector<T>(selector);
  if (!found) {
    throw new Error(`Token统计控件不存在：${selector}`);
  }
  return found;
}

function formatTokens(tokens: number | null): string {
  return tokens === null ? '—' : `${Math.max(0, Math.round(tokens)).toLocaleString()} Token`;
}

function formatPercentage(percentage: number): string {
  if (percentage > 0 && percentage < 0.1) {
    return '<0.1%';
  }
  return `${percentage.toFixed(1)}%`;
}

function categorySegment(category: PromptTokenCategory): HTMLElement {
  const presentation = CATEGORY_PRESENTATION[category.id];
  const segment = document.createElement('span');
  segment.className = `story-echo-token-segment story-echo-token-color-${presentation.className}`;
  segment.style.width = `${Math.max(0, Math.min(100, category.percentage))}%`;
  segment.title = `${presentation.label}：${formatTokens(category.tokens)}（${formatPercentage(category.percentage)}）`;
  return segment;
}

function categoryRow(category: PromptTokenCategory): HTMLElement {
  const presentation = CATEGORY_PRESENTATION[category.id];
  const row = document.createElement('div');
  row.className = 'story-echo-token-row';

  const label = document.createElement('span');
  label.className = 'story-echo-token-row-label';
  const dot = document.createElement('span');
  dot.className = `story-echo-token-dot story-echo-token-color-${presentation.className}`;
  dot.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.textContent = presentation.label;
  label.append(dot, text);

  const value = document.createElement('span');
  value.className = 'story-echo-token-row-value';
  const tokens = document.createElement('strong');
  tokens.textContent = category.tokens.toLocaleString();
  const percentage = document.createElement('span');
  percentage.textContent = formatPercentage(category.percentage);
  value.append(tokens, percentage);
  row.append(label, value);
  return row;
}

function connectionText(value: LatestPromptTokenBreakdown): string {
  return [
    `消息 #${value.messageId}`,
    value.api ? `API：${value.api}` : '',
    value.model,
    value.preset ? `预设：${value.preset}` : '',
    value.agentProfile ? `Agent Profile：${value.agentProfile}` : '',
    value.tokenizer ? `Tokenizer：${value.tokenizer}` : '',
  ].filter(Boolean).join(' · ');
}

export class PromptTokenStatsCard {
  private renderSequence = 0;

  canRender(panel: HTMLElement): boolean {
    const card = panel.querySelector<HTMLDetailsElement>('#story-echo-prompt-stats-card');
    return Boolean(card?.open && isElementRendered(card));
  }

  async render(panel: HTMLElement): Promise<void> {
    if (!this.canRender(panel)) {
      return;
    }
    const sequence = ++this.renderSequence;
    const requestedChatId = getCurrentChatId() ?? '';
    let breakdown: LatestPromptTokenBreakdown | null = null;
    let errorMessage = '';
    try {
      breakdown = await promptItemizationService.latest(getContext());
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : '读取提示词明细失败。';
    }
    if (sequence !== this.renderSequence || (getCurrentChatId() ?? '') !== requestedChatId) {
      return;
    }
    if (!breakdown) {
      this.renderEmpty(panel, errorMessage);
      return;
    }
    this.renderBreakdown(panel, breakdown);
  }

  invalidate(): void {
    this.renderSequence += 1;
    promptItemizationService.clearCache();
  }

  private renderEmpty(panel: HTMLElement, errorMessage: string): void {
    element<HTMLElement>(panel, '#story-echo-prompt-stats-subtitle').textContent = errorMessage
      ? '提示词明细暂不可用'
      : '发送一条消息后显示';
    element<HTMLElement>(panel, '#story-echo-prompt-stats-total').textContent = '—';
    const empty = element<HTMLElement>(panel, '#story-echo-prompt-stats-empty');
    empty.textContent = errorMessage || '当前聊天还没有可读取的提示词明细。完成一次角色回复后会自动更新。';
    empty.hidden = false;
    element<HTMLElement>(panel, '#story-echo-prompt-stats-content').hidden = true;
  }

  private renderBreakdown(panel: HTMLElement, breakdown: LatestPromptTokenBreakdown): void {
    const agentPrompt = breakdown.origin === 'tauritavern-agent';
    const standardTauriPrompt = breakdown.origin === 'tauritavern-standard';
    element<HTMLElement>(panel, '#story-echo-prompt-stats-subtitle').textContent = agentPrompt
      ? `消息 #${breakdown.messageId} · Agent 首轮${
          breakdown.totalMeasured ? '实测总量 / 分类估算' : '可识别文本估算'
        }`
      : standardTauriPrompt
        ? `消息 #${breakdown.messageId} · TauriTavern 普通请求文本估算`
        : `消息 #${breakdown.messageId} · ${breakdown.detailed
        ? `酒馆分类明细${breakdown.estimated ? '（部分估算）' : ''}`
        : '可识别文本估算'}`;
    element<HTMLElement>(panel, '#story-echo-prompt-stats-total').textContent =
      `${breakdown.totalTokens.toLocaleString()} Token`;
    element<HTMLElement>(panel, '#story-echo-prompt-stats-empty').hidden = true;
    element<HTMLElement>(panel, '#story-echo-prompt-stats-content').hidden = false;
    element<HTMLElement>(panel, '#story-echo-token-context').textContent =
      formatTokens(breakdown.storyEcho.contextTokens);
    element<HTMLElement>(panel, '#story-echo-token-summary').textContent =
      formatTokens(breakdown.storyEcho.summaryTokens);
    element<HTMLElement>(panel, '#story-echo-prompt-stats-meta').textContent = connectionText(breakdown);

    const bar = element<HTMLElement>(panel, '#story-echo-token-bar');
    bar.replaceChildren(...breakdown.categories.map(categorySegment));
    bar.setAttribute(
      'aria-label',
      breakdown.categories.map((category) => {
        const label = CATEGORY_PRESENTATION[category.id].label;
        return `${label}${formatPercentage(category.percentage)}`;
      }).join('，'),
    );
    const rows = element<HTMLElement>(panel, '#story-echo-token-rows');
    rows.replaceChildren(...breakdown.categories.map(categoryRow));
    const note = element<HTMLElement>(panel, '#story-echo-prompt-stats-note');
    if (agentPrompt) {
      const warning = breakdown.agentContextTrimmed
        ? '警告：Agent 启动前的二次组装移除了 StoryEcho 分层总结；若 Profile 限制了“初始聊天历史楼数”，请设为 -1。'
        : '';
      const measurement = breakdown.totalMeasured
        ? '总量取自 TauriTavern Agent 首轮模型调用的 provider usage；分类按启动前的最终消息与工具定义快照估算，差额归入“未分类”。'
        : 'TauriTavern 尚未提供首轮 provider usage，当前只估算启动前最终消息与工具定义中的可识别文本。';
      note.textContent = [
        warning,
        measurement,
        '这里只统计首次模型调用，不包含后续工具循环或子代理调用。',
      ].filter(Boolean).join(' ');
    } else if (standardTauriPrompt) {
      note.textContent =
        '当前总量与分类按 TauriTavern 普通生成最终消息和工具定义快照估算；消息角色、模板及序列化开销可能产生少量差异。';
    } else {
      note.textContent = breakdown.detailed
        ? `总量取自 SillyTavern 最近一次提示词明细；StoryEcho 标签${breakdown.estimated
          ? '在酒馆 Tokenizer 不可用时采用本地估算'
          : '使用酒馆当前 Tokenizer 计数'}。消息角色、模板和少量无法标注的开销会归入所属大类或“未分类”。`
        : 'SillyTavern 未保存这一轮的完整分类计数，当前按最终提示词中的可识别文本估算；“—”表示最近原文无法从合并请求中可靠分离。';
    }
  }
}

export const promptTokenStatsCard = new PromptTokenStatsCard();
