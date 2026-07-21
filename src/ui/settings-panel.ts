import {
  backgroundProcessingScheduler,
  backgroundTargetMessageId,
} from '../background/scheduler';
import { logger } from '../core/logger';
import type {
  ExtractionReferenceMode,
  LlmProviderId,
  RetrievalQueryMode,
  StoryEchoSettings,
  VectorSourceMode,
  WindowUnit,
} from '../core/types';
import { DIAGNOSTICS_UPDATED_EVENT } from '../debug/events';
import { resetDiagnostics } from '../debug/metrics';
import { buildDebugReport } from '../debug/report';
import { countCompletedTurns } from '../extraction/chunk-planner';
import { extractionService } from '../extraction/service';
import { fetchCustomLlmModels } from '../llm/model-list';
import { createLlmProvider } from '../llm/provider-factory';
import {
  resetStructuredOutputDiagnostics,
  structuredOutputDiagnosticsSnapshot,
} from '../llm/structured-diagnostics';
import { normalizeChatCompletionsBaseUrl } from '../llm/url';
import { MemoryRepository } from '../memory/repository';
import {
  getContext,
  getCurrentChatId,
  getMainConnectionIdentity,
} from '../platform/sillytavern';
import { renderCurrentStateCoordinationBlock, renderMemoryEntry } from '../prompt/render';
import { selectRecentWindow } from '../prompt/window';
import { SettingsRepository } from '../settings/repository';
import { stageSummaryService } from '../summary/service';
import { storySkeletonService } from '../summary/skeleton-service';
import {
  pendingArchivedStageSummaryEntries,
  storySkeletonIsUsable,
} from '../summary/skeleton-state';
import { storyEchoTaskCoordinator } from '../runtime/task-coordinator';
import { resolveVectorConfig } from '../vector/config';
import { resolveEmbeddingClient } from '../vector/embedding-providers';
import { SillyTavernVectorStore } from '../vector/sillytavern-vector-store';
import { normalizeEmbeddingsUrl, normalizeVolcengineMultimodalEmbeddingsUrl } from '../vector/url';
import { MemoryMetadataManager, memoryManagerTemplate } from './memory-manager';
import { notify } from './notifications';
import { promptStatsCardTemplate, promptTokenStatsCard } from './prompt-stats-card';
import {
  StageSummaryMetadataManager,
  stageSummaryManagerTemplate,
} from './summary-manager';
import { isElementRendered } from './visibility';

const PANEL_ID = 'story-echo-settings';
const settingsRepository = new SettingsRepository();
const memoryRepository = new MemoryRepository();
const vectorStore = new SillyTavernVectorStore();
const stageSummaryMetadataManager = new StageSummaryMetadataManager(memoryRepository);
const memoryMetadataManager = new MemoryMetadataManager(
  memoryRepository,
  async (state) => settingsRepository.get().memory.enabled
    ? extractionService.syncPendingVectors(state)
    : state,
  async () => {
    const requestedChatId = getCurrentChatId();
    return storyEchoTaskCoordinator.enqueueManual('重建自动剧情元数据', async () => {
      if (!requestedChatId || getCurrentChatId() !== requestedChatId) {
        throw new Error('等待重建期间聊天已切换，已取消任务。');
      }
      const settings = settingsRepository.get();
      if (!settings.memory.enabled) {
        throw new Error('请先启用“剧情记忆与召回”再重建自动元数据。');
      }
      const chat = getContext().chat;
      const window = selectRecentWindow(chat, settings.recentWindow.size, settings.recentWindow.unit);
      if (!window || window.retainedStartIndex <= 0) {
        throw new Error('当前没有窗口外历史可供重建。');
      }
      await extractionService.rebuildThrough(window.retainedStartIndex - 1);
    });
  },
);
let cachedVectorCollectionId = '';
let cachedVectorCountText = '未读取';
let cachedVectorRevision = '';
let statusRefreshScheduled = false;
let statusRefreshRunning = false;
let statusRefreshAgain = false;
let statusVectorRefreshRequested = false;
let promptStatsRenderScheduled = false;
let promptStatsRenderRunning = false;
let promptStatsRenderAgain = false;

function scheduleUiTask(operation: () => void): void {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    globalThis.requestAnimationFrame(() => operation());
    return;
  }
  globalThis.setTimeout(operation, 0);
}

function scheduleUiIdleTask(operation: () => void): void {
  if (typeof globalThis.requestIdleCallback === 'function') {
    globalThis.requestIdleCallback(() => operation(), { timeout: 1_500 });
    return;
  }
  // Safari/iOS has no requestIdleCallback. Let the newly rendered chat frame
  // paint before tokenizing a potentially very large final prompt.
  globalThis.setTimeout(operation, 250);
}

function panelIsRendered(panel: HTMLElement): boolean {
  const body = panel.querySelector<HTMLElement>('.story-echo-panel-body');
  return Boolean(body && isElementRendered(body));
}

function requestStatusRefresh(panel: HTMLElement, refreshVectorCount = false): void {
  statusVectorRefreshRequested ||= refreshVectorCount;
  if (!panelIsRendered(panel)) {
    return;
  }
  if (statusRefreshRunning) {
    statusRefreshAgain = true;
    return;
  }
  if (statusRefreshScheduled) {
    return;
  }
  statusRefreshScheduled = true;
  scheduleUiTask(() => {
    statusRefreshScheduled = false;
    if (!panelIsRendered(panel)) {
      return;
    }
    const refreshVectors = statusVectorRefreshRequested;
    statusVectorRefreshRequested = false;
    statusRefreshRunning = true;
    void refreshStatus(panel, refreshVectors).finally(() => {
      statusRefreshRunning = false;
      if (statusRefreshAgain) {
        statusRefreshAgain = false;
        requestStatusRefresh(panel);
      }
    });
  });
}

function requestPromptStatsRender(panel: HTMLElement): void {
  if (!promptTokenStatsCard.canRender(panel)) {
    return;
  }
  if (promptStatsRenderRunning) {
    promptStatsRenderAgain = true;
    return;
  }
  if (promptStatsRenderScheduled) {
    return;
  }
  promptStatsRenderScheduled = true;
  scheduleUiIdleTask(() => {
    promptStatsRenderScheduled = false;
    if (!promptTokenStatsCard.canRender(panel)) {
      return;
    }
    promptStatsRenderRunning = true;
    void promptTokenStatsCard.render(panel).finally(() => {
      promptStatsRenderRunning = false;
      if (promptStatsRenderAgain) {
        promptStatsRenderAgain = false;
        requestPromptStatsRender(panel);
      }
    });
  });
}

function requestVisiblePanelRefresh(panel: HTMLElement, refreshVectorCount = false): void {
  requestStatusRefresh(panel, refreshVectorCount);
  requestPromptStatsRender(panel);
}

function vectorRevision(state: NonNullable<ReturnType<MemoryRepository['getExisting']>>): string {
  return [
    state.vectorCollectionId,
    state.vectorFingerprint,
    state.pendingVectorHashes.length,
    state.pendingVectorDeleteHashes.length,
    state.metrics.vectorItemsInserted,
    state.metrics.vectorItemsDeleted,
    state.metrics.vectorRebuilds,
  ].join(':');
}

function panelTemplate(): HTMLElement {
  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.className = 'extension_container';
  panel.innerHTML = `
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>StoryEcho · 剧情回响</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content story-echo-panel-body">
        <div class="story-echo-switch-row story-echo-switch-primary">
          <div class="story-echo-switch-copy">
            <span class="story-echo-switch-title">启用 StoryEcho 上下文管理</span>
            <span class="story-echo-switch-description">使用 LLM 维护最小原文窗口、阶段总结与长期剧情骨架</span>
          </div>
          <div class="story-echo-toggle">
            <input id="story-echo-enabled" class="story-echo-toggle-input" type="checkbox">
            <label class="story-echo-toggle-label" for="story-echo-enabled" aria-label="启用 StoryEcho 上下文管理"></label>
          </div>
        </div>

        <div class="story-echo-switch-row story-echo-switch-primary">
          <div class="story-echo-switch-copy">
            <span class="story-echo-switch-title">启用剧情记忆与召回</span>
            <span class="story-echo-switch-description">自动提取窗口外剧情、生成向量，并在需要时动态召回注入</span>
          </div>
          <div class="story-echo-toggle">
            <input id="story-echo-memory-enabled" class="story-echo-toggle-input" type="checkbox">
            <label class="story-echo-toggle-label" for="story-echo-memory-enabled" aria-label="启用剧情记忆与召回"></label>
          </div>
        </div>

        <details class="story-echo-section story-echo-collapsible">
          <summary class="story-echo-section-summary">
            <span class="story-echo-section-summary-main">
              <i class="fa-solid fa-sliders" aria-hidden="true"></i>
              <span class="story-echo-section-summary-copy">
                <span class="story-echo-section-summary-title">上下文窗口</span>
                <span class="story-echo-section-summary-description">最小原文与计数方式</span>
              </span>
            </span>
            <i class="fa-solid fa-chevron-right story-echo-section-chevron" aria-hidden="true"></i>
          </summary>
          <div class="story-echo-grid story-echo-section-body">
          <label class="story-echo-field">
            <span>最小保留原文</span>
            <input id="story-echo-window-size" class="text_pole" type="number" min="0" max="1000" step="1">
          </label>
          <label class="story-echo-field">
            <span>计数单位</span>
            <select id="story-echo-window-unit" class="text_pole">
              <option value="turns">轮次（用户 + AI）</option>
              <option value="messages">消息条数</option>
            </select>
          </label>
          <div class="story-echo-switch-row story-echo-field-wide">
            <div class="story-echo-switch-copy">
              <span class="story-echo-switch-title">调试模式</span>
              <span class="story-echo-switch-description">在当前聊天中保留最近 50 条有界运行轨迹</span>
            </div>
            <div class="story-echo-toggle">
              <input id="story-echo-debug" class="story-echo-toggle-input" type="checkbox">
              <label class="story-echo-toggle-label" for="story-echo-debug" aria-label="调试模式"></label>
            </div>
          </div>
          <p class="story-echo-hint story-echo-field-wide">
            最近窗口是最小保留量；阶段总结尚未覆盖的原文会继续保留，不会为了满足窗口大小而丢失历史。
          </p>
          </div>
        </details>

        <details class="story-echo-section story-echo-collapsible" data-story-echo-memory-only>
          <summary class="story-echo-section-summary">
            <span class="story-echo-section-summary-main">
              <i class="fa-solid fa-brain" aria-hidden="true"></i>
              <span class="story-echo-section-summary-copy">
                <span class="story-echo-section-summary-title">剧情记忆参数</span>
                <span class="story-echo-section-summary-description">自动抽取、查询与动态注入</span>
              </span>
            </span>
            <i class="fa-solid fa-chevron-right story-echo-section-chevron" aria-hidden="true"></i>
          </summary>
          <div class="story-echo-grid story-echo-section-body">
            <label class="story-echo-field">
              <span>最多召回事件</span>
              <input id="story-echo-max-events" class="text_pole" type="number" min="0" max="50" step="1">
            </label>
            <label class="story-echo-field">
              <span>召回 Token预算</span>
              <input id="story-echo-max-tokens" class="text_pole" type="number" min="0" max="32000" step="50">
            </label>
            <label class="story-echo-field">
              <span>向量相关性阈值</span>
              <input id="story-echo-threshold" class="text_pole" type="number" min="0" max="1" step="0.01">
            </label>
            <label class="story-echo-field">
              <span>检索查询构造</span>
              <select id="story-echo-query-mode" class="text_pole">
                <option value="llm">LLM上下文改写（推荐）</option>
                <option value="local">本地快速规则</option>
              </select>
            </label>
            <label class="story-echo-field">
              <span>每批抽取轮数</span>
              <input id="story-echo-extraction-turns" class="text_pole" type="number" min="1" max="20" step="1">
            </label>
            <p class="story-echo-hint story-echo-field-wide">
              开启后自动完成抽取、整理、向量同步、检索与请求级注入。LLM查询改写失败时回退本地规则；已有元数据在关闭后仍会保留。
            </p>
          </div>
        </details>

        <details class="story-echo-section story-echo-collapsible">
          <summary class="story-echo-section-summary">
            <span class="story-echo-section-summary-main">
              <i class="fa-solid fa-book-atlas" aria-hidden="true"></i>
              <span class="story-echo-section-summary-copy">
                <span class="story-echo-section-summary-title">剧情处理参考</span>
                <span class="story-echo-section-summary-description">角色卡、蓝灯常驻与本批命中世界书</span>
              </span>
            </span>
            <i class="fa-solid fa-chevron-right story-echo-section-chevron" aria-hidden="true"></i>
          </summary>
          <div class="story-echo-grid story-echo-section-body">
            <label class="story-echo-field">
              <span>参考模式</span>
              <select id="story-echo-reference-mode" class="text_pole">
                <option value="character-world-info">抽取使用角色卡与命中世界书；总结/骨架使用蓝灯与本批绿灯（推荐）</option>
                <option value="character">仅抽取使用角色卡</option>
                <option value="off">关闭</option>
              </select>
            </label>
            <label class="story-echo-field">
              <span>每次参考 Token预算</span>
              <input id="story-echo-reference-tokens" class="text_pole" type="number" min="256" max="16000" step="100">
            </label>
            <label class="story-echo-field">
              <span>世界书最多条目</span>
              <input id="story-echo-reference-world-info" class="text_pole" type="number" min="0" max="20" step="1">
            </label>
            <p class="story-echo-hint story-echo-field-wide">
              只读取角色精简信息和当前处理文本直接命中的世界书，不传入预设、system、jailbreak、示例对话或欢迎语。阶段总结与长期剧情骨架都会携带蓝灯常驻条目（最多 20000 字符）及各自当前来源命中的绿灯条目（最多 10000 字符）；两项完整条目字符上限不受上面的参考 Token 预算二次压缩。总结和骨架不使用角色卡，世界书只作为背景设定，不作为已发生剧情或当前状态的证据。
            </p>
          </div>
        </details>

        <details id="story-echo-summary-settings" class="story-echo-section story-echo-collapsible">
          <summary class="story-echo-section-summary">
            <span class="story-echo-section-summary-main">
              <i class="fa-solid fa-book-open" aria-hidden="true"></i>
              <span class="story-echo-section-summary-copy">
                <span class="story-echo-section-summary-title">历史总结与长期骨架</span>
                <span class="story-echo-section-summary-description">总结间隔 N、携带窗口 S 与两级输出预算</span>
              </span>
            </span>
            <i class="fa-solid fa-chevron-right story-echo-section-chevron" aria-hidden="true"></i>
          </summary>
          <div class="story-echo-grid story-echo-section-body">
            <label class="story-echo-field">
              <span>总结间隔 N（用户 + AI 轮次）</span>
              <input id="story-echo-summary-turns" class="text_pole" type="number" min="1" max="100" step="1">
            </label>
            <label class="story-echo-field">
              <span>总结窗口 S（最多携带条数）</span>
              <input id="story-echo-summary-window" class="text_pole" type="number" min="1" max="100" step="1">
            </label>
            <label class="story-echo-field">
              <span>每条总结最大输出 Token</span>
              <input id="story-echo-summary-max-tokens" class="text_pole" type="number" min="128" max="8192" step="128">
            </label>
            <label class="story-echo-field">
              <span>长期剧情骨架最大 Token</span>
              <input id="story-echo-skeleton-max-tokens" class="text_pole" type="number" min="512" max="10000" step="128">
            </label>
            <p class="story-echo-hint story-echo-field-wide">
              总开关开启后自动维护阶段总结。最小窗口 W 内原文始终保留；窗口外每满 N 轮生成一条独立总结，单批原文最多约 100000 字符，未满 N 轮继续保留原文。较老总结会汇入记录重要历史事件与剧情大纲的长期骨架，请求同时携带最近 S 条阶段总结；当前状态和人物档案由近期上下文、MVU变量与世界书承担。骨架默认上限为 5000 Token，可在 512～10000 之间调整。
            </p>
            <div class="story-echo-field-wide">
              ${stageSummaryManagerTemplate()}
            </div>
          </div>
        </details>

        <details class="story-echo-section story-echo-collapsible" open>
          <summary class="story-echo-section-summary">
            <span class="story-echo-section-summary-main">
              <i class="fa-solid fa-cloud" aria-hidden="true"></i>
              <span class="story-echo-section-summary-copy">
                <span class="story-echo-section-summary-title">模型来源</span>
                <span class="story-echo-section-summary-description">主连接或自定义 OpenAI 兼容接口</span>
              </span>
            </span>
            <i class="fa-solid fa-chevron-right story-echo-section-chevron" aria-hidden="true"></i>
          </summary>
          <div class="story-echo-model-source-body story-echo-section-body">
            <label class="story-echo-field story-echo-model-source-select">
              <span>模型来源</span>
              <select id="story-echo-provider" class="text_pole">
                <option value="main">SillyTavern 主连接（默认）</option>
                <option value="openai-compatible">自定义</option>
              </select>
            </label>

            <div id="story-echo-custom-provider" class="story-echo-model-provider-fields">
              <label class="story-echo-model-card">
                <span class="story-echo-model-card-title">API 地址</span>
                <input id="story-echo-base-url" class="text_pole" type="url" maxlength="2048" placeholder="https://example.com/v1">
              </label>

              <label class="story-echo-model-card">
                <span class="story-echo-model-card-title">API 密钥</span>
                <span class="story-echo-model-card-description">随酒馆扩展设置同步；无 Key 接口可留空</span>
                <input id="story-echo-api-key" class="text_pole" type="password" maxlength="16384" autocomplete="off" spellcheck="false" placeholder="无 Key 接口可留空">
              </label>

              <div class="story-echo-model-card">
                <label class="story-echo-field">
                  <span class="story-echo-model-card-title">模型名称</span>
                  <input id="story-echo-model" class="text_pole" type="text" maxlength="200" placeholder="model-name">
                </label>
                <div class="story-echo-model-picker">
                  <select id="story-echo-model-select" class="text_pole" aria-label="从模型列表选择">
                    <option value="">（从列表选择）</option>
                  </select>
                  <button id="story-echo-fetch-models" class="menu_button story-echo-action-primary" type="button">
                    <i class="fa-solid fa-cloud-arrow-down" aria-hidden="true"></i><span>获取模型</span>
                  </button>
                </div>
              </div>

              <details class="story-echo-model-advanced story-echo-collapsible">
                <summary class="story-echo-section-summary">
                  <span class="story-echo-section-summary-main">
                    <i class="fa-solid fa-sliders" aria-hidden="true"></i>
                    <span class="story-echo-section-summary-title">高级参数</span>
                  </span>
                  <i class="fa-solid fa-chevron-right story-echo-section-chevron" aria-hidden="true"></i>
                </summary>
                <div class="story-echo-grid story-echo-section-body">
                  <div class="story-echo-switch-row story-echo-field-wide">
                    <div class="story-echo-switch-copy">
                      <span class="story-echo-switch-title">允许不安全 HTTP</span>
                      <span class="story-echo-switch-description">仅建议用于可信的局域网服务</span>
                    </div>
                    <div class="story-echo-toggle">
                      <input id="story-echo-allow-http" class="story-echo-toggle-input" type="checkbox">
                      <label class="story-echo-toggle-label" for="story-echo-allow-http" aria-label="允许自定义 LLM 使用不安全 HTTP"></label>
                    </div>
                  </div>
                  <div class="story-echo-switch-row story-echo-field-wide">
                    <div class="story-echo-switch-copy">
                      <span class="story-echo-switch-title">失败时回退主连接</span>
                      <span class="story-echo-switch-description">自定义 LLM 请求失败后尝试 SillyTavern 主连接</span>
                    </div>
                    <div class="story-echo-toggle">
                      <input id="story-echo-fallback-main" class="story-echo-toggle-input" type="checkbox">
                      <label class="story-echo-toggle-label" for="story-echo-fallback-main" aria-label="自定义 LLM 失败时回退主连接"></label>
                    </div>
                  </div>
                </div>
              </details>

              <p class="story-echo-hint">
                LLM Key以明文保存在当前用户的扩展设置中并随酒馆同步；模型列表和生成请求均由SillyTavern后端转发，浏览器不会直接连接LLM接口。
              </p>
            </div>
          </div>
        </details>

        <details class="story-echo-section story-echo-collapsible" data-story-echo-memory-only>
          <summary class="story-echo-section-summary">
            <span class="story-echo-section-summary-main">
              <i class="fa-solid fa-database" aria-hidden="true"></i>
              <span class="story-echo-section-summary-copy">
                <span class="story-echo-section-summary-title">Embedding 与 Vector Storage</span>
                <span class="story-echo-section-summary-description">选择向量来源与服务端存储方式</span>
              </span>
            </span>
            <i class="fa-solid fa-chevron-right story-echo-section-chevron" aria-hidden="true"></i>
          </summary>
          <div class="story-echo-grid story-echo-section-body">
          <label class="story-echo-field story-echo-field-wide">
            <span>Embedding来源</span>
            <select id="story-echo-vector-source" class="text_pole">
              <option value="inherit">酒馆Vector Storage当前向量源（默认）</option>
              <option value="openai-compatible">自定义OpenAI兼容接口</option>
              <option value="volcengine-multimodal">火山方舟多模态Embedding</option>
            </select>
          </label>
          <p class="story-echo-hint story-echo-field-wide">
            自定义模式只替换向量生成器；向量仍由酒馆Vector Storage保存并在服务端检索。
          </p>
          </div>
        </details>

        <details id="story-echo-volcengine-embedding" class="story-echo-subsection story-echo-collapsible" data-story-echo-memory-only>
          <summary class="story-echo-section-summary">
            <span class="story-echo-section-summary-main">
              <i class="fa-solid fa-fire" aria-hidden="true"></i>
              <span class="story-echo-section-summary-copy">
                <span class="story-echo-section-summary-title">火山方舟多模态 Embedding</span>
                <span class="story-echo-section-summary-description">方舟接口、Endpoint 与连接测试</span>
              </span>
            </span>
            <i class="fa-solid fa-chevron-right story-echo-section-chevron" aria-hidden="true"></i>
          </summary>
          <div class="story-echo-grid story-echo-section-body">
          <label class="story-echo-field story-echo-field-wide">
            <span>方舟 Base URL</span>
            <input id="story-echo-volcengine-base-url" class="text_pole" type="url" maxlength="2048" placeholder="https://ark.cn-beijing.volces.com/api/v3">
          </label>
          <label class="story-echo-field">
            <span>模型或Endpoint ID</span>
            <input id="story-echo-volcengine-model" class="text_pole" type="text" maxlength="200" placeholder="doubao-embedding-vision-251215 或 ep-m-…">
          </label>
          <label class="story-echo-field">
            <span>方舟 API Key（随酒馆设置同步）</span>
            <input id="story-echo-volcengine-api-key" class="text_pole" type="password" maxlength="16384" autocomplete="off" spellcheck="false">
          </label>
          <div class="story-echo-switch-row story-echo-field-wide">
            <div class="story-echo-switch-copy">
              <span class="story-echo-switch-title">允许不安全 HTTP</span>
              <span class="story-echo-switch-description">仅建议用于可信的局域网兼容服务</span>
            </div>
            <div class="story-echo-toggle">
              <input id="story-echo-volcengine-allow-http" class="story-echo-toggle-input" type="checkbox">
              <label class="story-echo-toggle-label" for="story-echo-volcengine-allow-http" aria-label="允许火山方舟兼容接口使用不安全 HTTP"></label>
            </div>
          </div>
          <div class="story-echo-field-wide story-echo-subsection-actions">
            <button id="story-echo-test-volcengine-embedding" class="menu_button" type="button">
              <i class="fa-solid fa-vial" aria-hidden="true"></i><span>测试火山Embedding连接</span>
            </button>
          </div>
          <p class="story-echo-hint story-echo-field-wide">
            自动调用 /embeddings/multimodal；每段剧情文本独立生成一个向量，最多4个请求并发。请求仍经酒馆服务端代理，向量仍由Vector Storage保存和检索。
          </p>
          </div>
        </details>

        <details id="story-echo-custom-embedding" class="story-echo-subsection story-echo-collapsible" data-story-echo-memory-only>
          <summary class="story-echo-section-summary">
            <span class="story-echo-section-summary-main">
              <i class="fa-solid fa-vector-square" aria-hidden="true"></i>
              <span class="story-echo-section-summary-copy">
                <span class="story-echo-section-summary-title">自定义 OpenAI 兼容 Embedding</span>
                <span class="story-echo-section-summary-description">地址、模型、密钥与连接测试</span>
              </span>
            </span>
            <i class="fa-solid fa-chevron-right story-echo-section-chevron" aria-hidden="true"></i>
          </summary>
          <div class="story-echo-grid story-echo-section-body">
          <label class="story-echo-field story-echo-field-wide">
            <span>Embedding Base URL</span>
            <input id="story-echo-embedding-base-url" class="text_pole" type="url" maxlength="2048" placeholder="https://ark.cn-beijing.volces.com/api/v3">
          </label>
          <label class="story-echo-field">
            <span>Embedding模型或Endpoint ID</span>
            <input id="story-echo-embedding-model" class="text_pole" type="text" maxlength="200" placeholder="doubao-embedding-text-… 或 ep-…">
          </label>
          <label class="story-echo-field">
            <span>Embedding API Key（随酒馆设置同步）</span>
            <input id="story-echo-embedding-api-key" class="text_pole" type="password" maxlength="16384" autocomplete="off" spellcheck="false" placeholder="无Key接口可留空">
          </label>
          <div class="story-echo-switch-row story-echo-field-wide">
            <div class="story-echo-switch-copy">
              <span class="story-echo-switch-title">允许不安全 HTTP</span>
              <span class="story-echo-switch-description">仅建议用于可信的局域网 Embedding 服务</span>
            </div>
            <div class="story-echo-toggle">
              <input id="story-echo-embedding-allow-http" class="story-echo-toggle-input" type="checkbox">
              <label class="story-echo-toggle-label" for="story-echo-embedding-allow-http" aria-label="允许自定义 Embedding 使用不安全 HTTP"></label>
            </div>
          </div>
          <div class="story-echo-field-wide story-echo-subsection-actions">
            <button id="story-echo-test-embedding" class="menu_button" type="button">
              <i class="fa-solid fa-vial" aria-hidden="true"></i><span>测试Embedding连接</span>
            </button>
          </div>
          <p class="story-echo-hint story-echo-field-wide">
            外部Embedding请求会自动经酒馆服务端代理；需在config.yaml启用enableCorsProxy并重启。Key仍以明文随酒馆设置同步，向量继续由Vector Storage保存和检索。
          </p>
          </div>
        </details>

        ${memoryManagerTemplate()}

        <div class="story-echo-actions story-echo-actions-primary" role="group" aria-label="主要操作">
          <button id="story-echo-test-llm" class="menu_button story-echo-action-primary" type="button">
            <i class="fa-solid fa-plug" aria-hidden="true"></i><span>测试LLM连接</span>
          </button>
          <button id="story-echo-process-history" class="menu_button story-echo-action-primary" type="button">
            <i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i><span>处理窗口外历史</span>
          </button>
        </div>
        <div class="story-echo-actions story-echo-actions-secondary" role="group" aria-label="诊断操作">
          <button id="story-echo-refresh-status" class="menu_button" type="button">
            <i class="fa-solid fa-rotate" aria-hidden="true"></i><span>刷新状态</span>
          </button>
          <button id="story-echo-copy-debug" class="menu_button" type="button">
            <i class="fa-solid fa-copy" aria-hidden="true"></i><span>复制调试报告</span>
          </button>
          <button id="story-echo-reset-stats" class="menu_button" type="button">
            <i class="fa-solid fa-arrow-rotate-left" aria-hidden="true"></i><span>重置统计</span>
          </button>
        </div>

        <div id="story-echo-status" class="story-echo-status">正在读取当前聊天状态……</div>
        ${promptStatsCardTemplate()}
        <details id="story-echo-summary-diagnostics" class="story-echo-diagnostics">
          <summary>当前骨架与阶段总结</summary>
          <pre id="story-echo-summary">尚无全局骨架或阶段总结。</pre>
        </details>
        <details id="story-echo-stats-diagnostics" class="story-echo-diagnostics" open>
          <summary>测试统计</summary>
          <pre id="story-echo-stats">尚无统计数据。</pre>
        </details>
        <details id="story-echo-inspection-diagnostics" class="story-echo-diagnostics">
          <summary>最近一次上下文检查</summary>
          <pre id="story-echo-inspection">尚无生成记录。</pre>
        </details>
        <details id="story-echo-traces-diagnostics" class="story-echo-diagnostics">
          <summary>最近调试轨迹</summary>
          <pre id="story-echo-traces">调试模式关闭或尚无轨迹。</pre>
        </details>
        <p class="story-echo-hint">调试报告不包含API Key，但会包含全局剧情骨架、有界剧情处理参考预览、阶段总结、检索查询和被召回的剧情文本。</p>
      </div>
    </div>
  `;
  return panel;
}

function element<T extends HTMLElement>(panel: HTMLElement, selector: string): T {
  const found = panel.querySelector<T>(selector);
  if (!found) {
    throw new Error(`设置控件不存在：${selector}`);
  }
  return found;
}

function numberValue(input: HTMLInputElement, fallback: number): number {
  const raw = input.value.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function populateCustomModelOptions(
  panel: HTMLElement,
  models: readonly string[],
  currentModel: string,
): void {
  const select = element<HTMLSelectElement>(panel, '#story-echo-model-select');
  select.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '（从列表选择）';
  select.append(placeholder);
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = model;
    select.append(option);
  }
  if (currentModel && !models.includes(currentModel)) {
    const current = document.createElement('option');
    current.value = currentModel;
    current.textContent = `${currentModel}（当前设置）`;
    select.append(current);
  }
  select.value = currentModel || '';
}

function syncVisibility(panel: HTMLElement, settings: StoryEchoSettings): void {
  const custom = element<HTMLElement>(panel, '#story-echo-custom-provider');
  custom.hidden = settings.llm.provider !== 'openai-compatible';

  for (const memoryOnly of panel.querySelectorAll<HTMLElement>('[data-story-echo-memory-only]')) {
    memoryOnly.hidden = !settings.memory.enabled;
  }

  const customEmbedding = element<HTMLElement>(panel, '#story-echo-custom-embedding');
  customEmbedding.hidden = !settings.memory.enabled || settings.vector.source !== 'openai-compatible';

  const volcengineEmbedding = element<HTMLElement>(panel, '#story-echo-volcengine-embedding');
  volcengineEmbedding.hidden = !settings.memory.enabled || settings.vector.source !== 'volcengine-multimodal';

  const rebuildMemories = element<HTMLButtonElement>(panel, '#story-echo-memory-rebuild');
  rebuildMemories.disabled = !settings.memory.enabled;
  rebuildMemories.title = settings.memory.enabled
    ? ''
    : '启用“剧情记忆与召回”后才能重建自动元数据';
}

function syncForm(panel: HTMLElement, settings: StoryEchoSettings): void {
  element<HTMLInputElement>(panel, '#story-echo-enabled').checked = settings.enabled;
  element<HTMLInputElement>(panel, '#story-echo-memory-enabled').checked = settings.memory.enabled;
  element<HTMLInputElement>(panel, '#story-echo-window-size').value = String(settings.recentWindow.size);
  element<HTMLSelectElement>(panel, '#story-echo-window-unit').value = settings.recentWindow.unit;
  element<HTMLInputElement>(panel, '#story-echo-summary-turns').value =
    String(settings.summary.targetTurnsPerUpdate);
  element<HTMLInputElement>(panel, '#story-echo-summary-window').value =
    String(settings.summary.windowSize);
  element<HTMLInputElement>(panel, '#story-echo-summary-max-tokens').value =
    String(settings.summary.maxTokens);
  element<HTMLInputElement>(panel, '#story-echo-skeleton-max-tokens').value =
    String(settings.summary.skeletonMaxTokens);
  element<HTMLInputElement>(panel, '#story-echo-max-events').value = String(settings.recall.maxEvents);
  element<HTMLInputElement>(panel, '#story-echo-max-tokens').value = String(settings.recall.maxTokens);
  element<HTMLInputElement>(panel, '#story-echo-threshold').value = String(settings.recall.scoreThreshold);
  element<HTMLSelectElement>(panel, '#story-echo-query-mode').value = settings.recall.queryMode;
  element<HTMLSelectElement>(panel, '#story-echo-provider').value = settings.llm.provider;
  element<HTMLInputElement>(panel, '#story-echo-extraction-turns').value =
    String(settings.extraction.targetTurnsPerChunk);
  element<HTMLSelectElement>(panel, '#story-echo-reference-mode').value =
    settings.extraction.reference.mode;
  element<HTMLInputElement>(panel, '#story-echo-reference-tokens').value =
    String(settings.extraction.reference.maxTokens);
  element<HTMLInputElement>(panel, '#story-echo-reference-world-info').value =
    String(settings.extraction.reference.maxWorldInfoEntries);
  element<HTMLInputElement>(panel, '#story-echo-debug').checked = settings.debug;
  element<HTMLInputElement>(panel, '#story-echo-base-url').value = settings.llm.custom.baseUrl;
  element<HTMLInputElement>(panel, '#story-echo-model').value = settings.llm.custom.model;
  element<HTMLSelectElement>(panel, '#story-echo-model-select').value = '';
  element<HTMLInputElement>(panel, '#story-echo-allow-http').checked = settings.llm.custom.allowInsecureHttp;
  element<HTMLInputElement>(panel, '#story-echo-fallback-main').checked = settings.llm.custom.fallbackToMain;
  element<HTMLInputElement>(panel, '#story-echo-api-key').value = settings.llm.custom.apiKey;
  element<HTMLSelectElement>(panel, '#story-echo-vector-source').value = settings.vector.source;
  element<HTMLInputElement>(panel, '#story-echo-embedding-base-url').value = settings.vector.custom.baseUrl;
  element<HTMLInputElement>(panel, '#story-echo-embedding-model').value = settings.vector.custom.model;
  element<HTMLInputElement>(panel, '#story-echo-embedding-allow-http').checked =
    settings.vector.custom.allowInsecureHttp;
  element<HTMLInputElement>(panel, '#story-echo-embedding-api-key').value = settings.vector.custom.apiKey;
  element<HTMLInputElement>(panel, '#story-echo-volcengine-base-url').value =
    settings.vector.volcengine.baseUrl;
  element<HTMLInputElement>(panel, '#story-echo-volcengine-model').value =
    settings.vector.volcengine.model;
  element<HTMLInputElement>(panel, '#story-echo-volcengine-allow-http').checked =
    settings.vector.volcengine.allowInsecureHttp;
  element<HTMLInputElement>(panel, '#story-echo-volcengine-api-key').value =
    settings.vector.volcengine.apiKey;
  syncVisibility(panel, settings);
}

function bindSettings(panel: HTMLElement): void {
  const scheduleDerivedUpdate = (): void => {
    backgroundProcessingScheduler.schedule();
    requestStatusRefresh(panel);
  };
  element<HTMLInputElement>(panel, '#story-echo-enabled').addEventListener('change', (event) => {
    settingsRepository.update((settings) => {
      settings.enabled = (event.currentTarget as HTMLInputElement).checked;
    });
    scheduleDerivedUpdate();
  });

  element<HTMLInputElement>(panel, '#story-echo-memory-enabled').addEventListener('change', (event) => {
    const settings = settingsRepository.update((current) => {
      current.memory.enabled = (event.currentTarget as HTMLInputElement).checked;
    });
    syncVisibility(panel, settings);
    scheduleDerivedUpdate();
  });

  element<HTMLInputElement>(panel, '#story-echo-window-size').addEventListener('input', (event) => {
    settingsRepository.update((settings) => {
      settings.recentWindow.size = Math.max(0, Math.floor(numberValue(event.currentTarget as HTMLInputElement, 10)));
    });
    scheduleDerivedUpdate();
  });

  element<HTMLSelectElement>(panel, '#story-echo-window-unit').addEventListener('change', (event) => {
    settingsRepository.update((settings) => {
      settings.recentWindow.unit = (event.currentTarget as HTMLSelectElement).value as WindowUnit;
    });
    scheduleDerivedUpdate();
  });

  element<HTMLInputElement>(panel, '#story-echo-summary-turns').addEventListener('input', (event) => {
    settingsRepository.update((settings) => {
      const value = Math.floor(numberValue(event.currentTarget as HTMLInputElement, 10));
      settings.summary.targetTurnsPerUpdate = Math.min(100, Math.max(1, value));
    });
    scheduleDerivedUpdate();
  });

  element<HTMLInputElement>(panel, '#story-echo-summary-window').addEventListener('input', (event) => {
    settingsRepository.update((settings) => {
      const value = Math.floor(numberValue(event.currentTarget as HTMLInputElement, 4));
      settings.summary.windowSize = Math.min(100, Math.max(1, value));
    });
    scheduleDerivedUpdate();
  });

  element<HTMLInputElement>(panel, '#story-echo-summary-max-tokens').addEventListener('input', (event) => {
    settingsRepository.update((settings) => {
      const value = Math.floor(numberValue(event.currentTarget as HTMLInputElement, 1_600));
      settings.summary.maxTokens = Math.min(8_192, Math.max(128, value));
    });
  });

  element<HTMLInputElement>(panel, '#story-echo-skeleton-max-tokens').addEventListener('input', (event) => {
    settingsRepository.update((settings) => {
      const value = Math.floor(numberValue(event.currentTarget as HTMLInputElement, 5_000));
      settings.summary.skeletonMaxTokens = Math.min(10_000, Math.max(512, value));
    });
    scheduleDerivedUpdate();
  });

  element<HTMLInputElement>(panel, '#story-echo-max-events').addEventListener('input', (event) => {
    settingsRepository.update((settings) => {
      settings.recall.maxEvents = Math.max(0, Math.floor(numberValue(event.currentTarget as HTMLInputElement, 3)));
    });
  });

  element<HTMLInputElement>(panel, '#story-echo-max-tokens').addEventListener('input', (event) => {
    settingsRepository.update((settings) => {
      settings.recall.maxTokens = Math.max(0, Math.floor(numberValue(event.currentTarget as HTMLInputElement, 1200)));
    });
  });

  element<HTMLInputElement>(panel, '#story-echo-threshold').addEventListener('input', (event) => {
    settingsRepository.update((settings) => {
      const value = numberValue(event.currentTarget as HTMLInputElement, 0.25);
      settings.recall.scoreThreshold = Math.min(1, Math.max(0, value));
    });
  });

  element<HTMLSelectElement>(panel, '#story-echo-query-mode').addEventListener('change', (event) => {
    settingsRepository.update((settings) => {
      settings.recall.queryMode = (event.currentTarget as HTMLSelectElement).value as RetrievalQueryMode;
    });
  });

  element<HTMLSelectElement>(panel, '#story-echo-provider').addEventListener('change', (event) => {
    const settings = settingsRepository.update((current) => {
      current.llm.provider = (event.currentTarget as HTMLSelectElement).value as LlmProviderId;
    });
    syncVisibility(panel, settings);
  });

  element<HTMLInputElement>(panel, '#story-echo-extraction-turns').addEventListener('input', (event) => {
    settingsRepository.update((settings) => {
      const value = Math.floor(numberValue(event.currentTarget as HTMLInputElement, 5));
      settings.extraction.targetTurnsPerChunk = Math.min(20, Math.max(1, value));
    });
    scheduleDerivedUpdate();
  });

  element<HTMLSelectElement>(panel, '#story-echo-reference-mode').addEventListener('change', (event) => {
    settingsRepository.update((settings) => {
      settings.extraction.reference.mode =
        (event.currentTarget as HTMLSelectElement).value as ExtractionReferenceMode;
    });
  });

  element<HTMLInputElement>(panel, '#story-echo-reference-tokens').addEventListener('input', (event) => {
    settingsRepository.update((settings) => {
      const value = Math.floor(numberValue(event.currentTarget as HTMLInputElement, 3_000));
      settings.extraction.reference.maxTokens = Math.min(16_000, Math.max(256, value));
    });
  });

  element<HTMLInputElement>(panel, '#story-echo-reference-world-info').addEventListener('input', (event) => {
    settingsRepository.update((settings) => {
      const value = Math.floor(numberValue(event.currentTarget as HTMLInputElement, 5));
      settings.extraction.reference.maxWorldInfoEntries = Math.min(20, Math.max(0, value));
    });
  });

  element<HTMLInputElement>(panel, '#story-echo-debug').addEventListener('change', (event) => {
    settingsRepository.update((settings) => {
      settings.debug = (event.currentTarget as HTMLInputElement).checked;
    });
  });

  element<HTMLInputElement>(panel, '#story-echo-base-url').addEventListener('change', (event) => {
    const input = event.currentTarget as HTMLInputElement;
    const current = settingsRepository.get();
    const value = input.value.trim();
    if (!value) {
      settingsRepository.update((settings) => {
        settings.llm.custom.baseUrl = '';
      });
      return;
    }
    try {
      const normalized = normalizeChatCompletionsBaseUrl(value, {
        allowInsecureHttp: current.llm.custom.allowInsecureHttp,
      });
      settingsRepository.update((settings) => {
        settings.llm.custom.baseUrl = normalized;
      });
      input.value = normalized;
    } catch (error) {
      input.value = current.llm.custom.baseUrl;
      notify.error(error instanceof Error ? error.message : 'Base URL无效。');
    }
  });

  element<HTMLInputElement>(panel, '#story-echo-model').addEventListener('input', (event) => {
    const model = (event.currentTarget as HTMLInputElement).value.trim();
    settingsRepository.update((settings) => {
      settings.llm.custom.model = model;
    });
    const select = element<HTMLSelectElement>(panel, '#story-echo-model-select');
    select.value = [...select.options].some((option) => option.value === model) ? model : '';
  });

  element<HTMLSelectElement>(panel, '#story-echo-model-select').addEventListener('change', (event) => {
    const model = (event.currentTarget as HTMLSelectElement).value;
    if (!model) {
      return;
    }
    element<HTMLInputElement>(panel, '#story-echo-model').value = model;
    settingsRepository.update((settings) => {
      settings.llm.custom.model = model;
    });
  });

  element<HTMLButtonElement>(panel, '#story-echo-fetch-models').addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const label = button.querySelector<HTMLElement>('span');
    button.disabled = true;
    if (label) {
      label.textContent = '获取中…';
    }
    try {
      const settings = settingsRepository.get();
      const models = await fetchCustomLlmModels(settings.llm.custom);
      populateCustomModelOptions(panel, models, settings.llm.custom.model.trim());
      notify.success(`已获取 ${models.length} 个模型。`);
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '获取模型列表失败。');
    } finally {
      button.disabled = false;
      if (label) {
        label.textContent = '获取模型';
      }
    }
  });

  element<HTMLInputElement>(panel, '#story-echo-api-key').addEventListener('input', (event) => {
    settingsRepository.update((settings) => {
      settings.llm.custom.apiKey = (event.currentTarget as HTMLInputElement).value;
    });
  });

  element<HTMLInputElement>(panel, '#story-echo-allow-http').addEventListener('change', (event) => {
    settingsRepository.update((settings) => {
      settings.llm.custom.allowInsecureHttp = (event.currentTarget as HTMLInputElement).checked;
    });
  });

  element<HTMLInputElement>(panel, '#story-echo-fallback-main').addEventListener('change', (event) => {
    settingsRepository.update((settings) => {
      settings.llm.custom.fallbackToMain = (event.currentTarget as HTMLInputElement).checked;
    });
  });

  element<HTMLSelectElement>(panel, '#story-echo-vector-source').addEventListener('change', (event) => {
    const settings = settingsRepository.update((current) => {
      current.vector.source = (event.currentTarget as HTMLSelectElement).value as VectorSourceMode;
    });
    syncVisibility(panel, settings);
    requestStatusRefresh(panel, true);
  });

  element<HTMLInputElement>(panel, '#story-echo-embedding-base-url').addEventListener('change', (event) => {
    const input = event.currentTarget as HTMLInputElement;
    const current = settingsRepository.get();
    const value = input.value.trim();
    if (!value) {
      settingsRepository.update((settings) => {
        settings.vector.custom.baseUrl = '';
      });
      return;
    }
    try {
      const normalized = normalizeEmbeddingsUrl(value, {
        allowInsecureHttp: current.vector.custom.allowInsecureHttp,
      });
      const baseUrl = normalized.replace(/\/embeddings\/?$/, '');
      settingsRepository.update((settings) => {
        settings.vector.custom.baseUrl = baseUrl;
      });
      input.value = baseUrl;
    } catch (error) {
      input.value = current.vector.custom.baseUrl;
      notify.error(error instanceof Error ? error.message : 'Embedding Base URL无效。');
    }
  });

  element<HTMLInputElement>(panel, '#story-echo-embedding-model').addEventListener('input', (event) => {
    settingsRepository.update((settings) => {
      settings.vector.custom.model = (event.currentTarget as HTMLInputElement).value.trim();
    });
  });

  element<HTMLInputElement>(panel, '#story-echo-embedding-api-key').addEventListener('input', (event) => {
    settingsRepository.update((settings) => {
      settings.vector.custom.apiKey = (event.currentTarget as HTMLInputElement).value;
    });
  });

  element<HTMLInputElement>(panel, '#story-echo-embedding-allow-http').addEventListener('change', (event) => {
    settingsRepository.update((settings) => {
      settings.vector.custom.allowInsecureHttp = (event.currentTarget as HTMLInputElement).checked;
    });
  });

  element<HTMLInputElement>(panel, '#story-echo-volcengine-base-url').addEventListener('change', (event) => {
    const input = event.currentTarget as HTMLInputElement;
    const current = settingsRepository.get();
    const value = input.value.trim();
    if (!value) {
      settingsRepository.update((settings) => {
        settings.vector.volcengine.baseUrl = '';
      });
      return;
    }
    try {
      const normalized = normalizeVolcengineMultimodalEmbeddingsUrl(value, {
        allowInsecureHttp: current.vector.volcengine.allowInsecureHttp,
      });
      const baseUrl = normalized.replace(/\/embeddings\/multimodal\/?$/, '');
      settingsRepository.update((settings) => {
        settings.vector.volcengine.baseUrl = baseUrl;
      });
      input.value = baseUrl;
    } catch (error) {
      input.value = current.vector.volcengine.baseUrl;
      notify.error(error instanceof Error ? error.message : '火山方舟 Base URL无效。');
    }
  });

  element<HTMLInputElement>(panel, '#story-echo-volcengine-model').addEventListener('input', (event) => {
    settingsRepository.update((settings) => {
      settings.vector.volcengine.model = (event.currentTarget as HTMLInputElement).value.trim();
    });
  });

  element<HTMLInputElement>(panel, '#story-echo-volcengine-api-key').addEventListener('input', (event) => {
    settingsRepository.update((settings) => {
      settings.vector.volcengine.apiKey = (event.currentTarget as HTMLInputElement).value;
    });
  });

  element<HTMLInputElement>(panel, '#story-echo-volcengine-allow-http').addEventListener('change', (event) => {
    settingsRepository.update((settings) => {
      settings.vector.volcengine.allowInsecureHttp = (event.currentTarget as HTMLInputElement).checked;
    });
  });

  const bindEmbeddingTest = (selector: string): void => {
    element<HTMLButtonElement>(panel, selector).addEventListener('click', async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      try {
        const config = resolveVectorConfig(settingsRepository.get());
        if (!config.precomputed) {
          throw new Error('请先选择一个外部Embedding来源。');
        }
        const vectors = await resolveEmbeddingClient(config.precomputed.provider).embed({
          ...config.precomputed,
          texts: ['StoryEcho剧情记忆向量连接测试'],
        });
        notify.success(`Embedding连接测试成功（${vectors[0]?.length ?? 0}维）。`);
      } catch (error) {
        notify.error(error instanceof Error ? error.message : 'Embedding连接测试失败。');
      } finally {
        button.disabled = false;
      }
    });
  };
  bindEmbeddingTest('#story-echo-test-embedding');
  bindEmbeddingTest('#story-echo-test-volcengine-embedding');

  element<HTMLButtonElement>(panel, '#story-echo-test-llm').addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    try {
      await storyEchoTaskCoordinator.enqueueManual(
        '测试LLM连接',
        () => createLlmProvider(settingsRepository.get()).testConnection(),
      );
      notify.success('LLM连接测试成功。');
    } catch (error) {
      notify.error(error instanceof Error ? error.message : 'LLM连接测试失败。');
    } finally {
      button.disabled = false;
    }
  });

  element<HTMLButtonElement>(panel, '#story-echo-process-history').addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const status = element<HTMLElement>(panel, '#story-echo-status');
    button.disabled = true;
    try {
      const requestedChatId = getCurrentChatId();
      const processed = await storyEchoTaskCoordinator.enqueueManual('主动处理窗口外历史', async () => {
        if (!requestedChatId || getCurrentChatId() !== requestedChatId) {
          throw new Error('等待处理期间聊天已切换，已取消任务。');
        }
        const settings = settingsRepository.get();
        const chat = getContext().chat;
        const window = selectRecentWindow(chat, settings.recentWindow.size, settings.recentWindow.unit);
        if (!window || window.retainedStartIndex <= 0) {
          return false;
        }
        const target = window.retainedStartIndex - 1;
        const indexedBefore = memoryRepository.getExisting()?.indexedThroughMessageId ?? -1;
        let indexedAfter = indexedBefore;
        if (settings.memory.enabled) {
          const extractionState = await extractionService.processThrough(target, (progress) => {
            status.textContent = `正在抽取消息 ${progress.startMessageId}～${progress.endMessageId} / ${progress.targetEndMessageId}，新增 ${progress.newMemoryCount} 条、更新 ${progress.changedMemoryCount} 条事件……`;
          });
          indexedAfter = extractionState?.indexedThroughMessageId ?? indexedBefore;
        }
        const summaryResult = await stageSummaryService.processAllThrough(target, (progress) => {
          status.textContent = `正在更新阶段总结：消息 ${progress.startMessageId}～${progress.endMessageId} / ${progress.targetEndMessageId}……`;
        });
        const skeletonResult = await storySkeletonService.processAllPending((progress) => {
          status.textContent = `正在更新全局剧情骨架：已合并到消息 ${progress.sourceEndMessageId}，剩余 ${progress.pendingEntries} 条阶段总结……`;
        });
        return {
          summaryChunks: summaryResult.updatedChunks,
          skeletonChunks: skeletonResult.updatedChunks,
          extractionAdvanced: indexedAfter > indexedBefore,
        };
      });
      if (!processed) {
        notify.info('当前没有窗口外历史需要处理。');
        return;
      }
      if (processed.summaryChunks > 0 || processed.skeletonChunks > 0) {
        notify.success(`窗口外历史处理完成：生成 ${processed.summaryChunks} 条阶段总结，更新全局剧情骨架 ${processed.skeletonChunks} 次；不足所配置批次的尾部原文会继续保留。`);
      } else if (processed.extractionAdvanced) {
        notify.info('窗口外剧情记忆已处理；历史尚不足一个阶段总结批次，尾部原文会继续保留。');
      } else {
        notify.info('窗口外历史尚不足一个阶段总结批次，尾部原文会继续保留。');
      }
      await refreshStatus(panel, true);
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '历史处理失败。');
      await refreshStatus(panel, true);
    } finally {
      button.disabled = false;
    }
  });

  element<HTMLButtonElement>(panel, '#story-echo-refresh-status').addEventListener('click', async () => {
    await refreshStatus(panel, true);
  });

  element<HTMLButtonElement>(panel, '#story-echo-copy-debug').addEventListener('click', async () => {
    const state = memoryRepository.getExisting();
    if (!state) {
      notify.info('当前聊天还没有StoryEcho调试数据。');
      return;
    }
    const settings = settingsRepository.get();
    let vectorCount: number | string = settings.memory.enabled ? 'unavailable' : 'memory-disabled';
    if (settings.memory.enabled) {
      try {
        vectorCount = (await vectorStore.list(
          state.vectorCollectionId,
          resolveVectorConfig(settings),
        )).length;
      } catch {
        // The report still has useful local diagnostics when Vector Storage is unavailable.
      }
    }
    try {
      await copyText(buildDebugReport(state, settings, vectorCount));
      notify.success('调试报告已复制。');
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '复制调试报告失败。');
    }
  });

  element<HTMLButtonElement>(panel, '#story-echo-reset-stats').addEventListener('click', async (event) => {
    const state = memoryRepository.getExisting();
    if (!state) {
      notify.info('当前聊天还没有统计数据。');
      return;
    }
    if (!globalThis.confirm('重置当前聊天的StoryEcho统计、调试轨迹和最近检查记录？')) {
      return;
    }
    const button = event.currentTarget as HTMLButtonElement;
    const requestedChatId = getCurrentChatId();
    button.disabled = true;
    try {
      await storyEchoTaskCoordinator.enqueueManual('重置当前聊天统计', async () => {
        if (!requestedChatId || getCurrentChatId() !== requestedChatId) {
          throw new Error('等待重置期间聊天已切换，已取消任务。');
        }
        const current = memoryRepository.getExisting();
        if (!current) {
          throw new Error('当前聊天的StoryEcho数据已不可用。');
        }
        resetDiagnostics(current);
        resetStructuredOutputDiagnostics();
        await memoryRepository.save(current);
      });
      await refreshStatus(panel);
      notify.success('当前聊天统计已重置。');
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '重置统计失败。');
    } finally {
      button.disabled = false;
    }
  });
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall back to execCommand for HTTP deployments and restricted clipboard permissions.
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) {
    throw new Error('浏览器拒绝访问剪贴板。');
  }
}

function statsText(state: NonNullable<ReturnType<MemoryRepository['getExisting']>>): string {
  const statusCount = (status: string) => state.memories.filter((memory) => memory.status === status).length;
  const metrics = state.metrics;
  const averageExtraction = metrics.extractionChunks > 0
    ? Math.round(metrics.totalExtractionMs / metrics.extractionChunks)
    : 0;
  const averageSummary = metrics.summaryUpdates > 0
    ? Math.round(metrics.totalSummaryMs / metrics.summaryUpdates)
    : 0;
  const averageSkeleton = metrics.skeletonUpdates > 0
    ? Math.round(metrics.totalSkeletonMs / metrics.skeletonUpdates)
    : 0;
  const averageConsolidation = metrics.consolidationCalls > 0
    ? Math.round(metrics.totalConsolidationMs / metrics.consolidationCalls)
    : 0;
  const completedQueryRewrites = Math.max(
    0,
    metrics.queryRewriteRequests - metrics.queryRewriteFailures - metrics.queryRewriteCacheHits,
  );
  const averageQueryRewrite = completedQueryRewrites > 0
    ? Math.round(metrics.totalQueryRewriteMs / completedQueryRewrites)
    : 0;
  const estimatedNetSaved = Math.max(
    0,
    metrics.estimatedRemovedTokens - metrics.estimatedInjectedTokens,
  );
  const structured = structuredOutputDiagnosticsSnapshot();
  const queue = storyEchoTaskCoordinator.snapshot();
  return [
    `记忆：active ${statusCount('active')} / resolved ${statusCount('resolved')} / superseded ${statusCount('superseded')} / invalid ${statusCount('invalid')}`,
    `全局骨架：更新${metrics.skeletonUpdates}次，失败${metrics.skeletonFailures}次，平均${averageSkeleton}ms/次`,
    `阶段总结：更新${metrics.summaryUpdates}次，失败${metrics.summaryFailures}次，覆盖${metrics.summaryMessagesCovered}条消息，平均${averageSummary}ms/次`,
    `抽取：${metrics.extractionChunks}块，${metrics.candidatesExtracted}候选，失败${metrics.extractionFailures}次，平均${averageExtraction}ms/块`,
    `抽取参考：构建${metrics.referenceContextBuilds}次，部分失败${metrics.referenceContextPartialFailures}次，累计${metrics.referenceContextTokens} Token，命中世界书${metrics.referenceWorldInfoEntries}条`,
    `整理：调用${metrics.consolidationCalls}次，失败回退${metrics.consolidationFailures}次，平均${averageConsolidation}ms`,
    `查询改写：请求${metrics.queryRewriteRequests}次，缓存命中${metrics.queryRewriteCacheHits}次，失败回退${metrics.queryRewriteFailures}次，平均${averageQueryRewrite}ms`,
    `结构化输出：Object ${structured.successes['json-object']}/${structured.attempts['json-object']}（失败${structured.failures['json-object']}）｜Schema ${structured.successes['json-schema']}/${structured.attempts['json-schema']}（失败${structured.failures['json-schema']}）｜明文 ${structured.successes.text}/${structured.attempts.text}（失败${structured.failures.text}）`,
    `结构化降级：本地JSON修复${structured.localJsonRepairs}次，后台让行${structured.backgroundYields}次，Provider回退${structured.providerFallbacks}次，自适应拆批${structured.adaptiveSplits}次，自动冷却跳过${structured.extractionCooldownSkips}次，最近${structured.lastProvider ?? '-'} / ${structured.lastMode ?? '-'} / ${structured.lastOutcome ?? '-'}`,
    `任务队列：运行${queue.runningKind ?? (queue.foregroundLeaseActive ? '等待角色回复' : '空闲')}，排队前台${queue.queuedForeground}/手动${queue.queuedManual}/后台${queue.queuedBackground}，最长等待${queue.maximumQueueWaitMs}ms`,
    `动作：CREATE ${metrics.actions.CREATE} / MERGE ${metrics.actions.MERGE} / UPDATE ${metrics.actions.UPDATE} / RESOLVE ${metrics.actions.RESOLVE} / SUPERSEDE ${metrics.actions.SUPERSEDE} / IGNORE ${metrics.actions.IGNORE}`,
    `向量：查询${metrics.vectorQueries}次，查询失败${metrics.vectorQueryFailures}次，同步失败${metrics.vectorSyncFailures}次，写入${metrics.vectorItemsInserted}，删除${metrics.vectorItemsDeleted}，重建${metrics.vectorRebuilds}次`,
    `上下文：尝试${metrics.generationAttempts}次，裁剪${metrics.generationsTrimmed}次，延迟裁剪${metrics.generationsDeferred}次，移除${metrics.messagesRemoved}条原文，注入${metrics.memoriesInjected}条记忆`,
    `估算Token：移除${metrics.estimatedRemovedTokens}，注入${metrics.estimatedInjectedTokens}，累计净节省${estimatedNetSaved}`,
    `最近：骨架 ${metrics.lastSkeletonAt ?? '无'} / 总结 ${metrics.lastSummaryAt ?? '无'} / 抽取 ${metrics.lastExtractionAt ?? '无'} / 生成 ${metrics.lastGenerationAt ?? '无'}`,
    `调试轨迹：${state.debugTraces.length}/50`,
  ].join('\n');
}

function inspectionText(state: NonNullable<ReturnType<MemoryRepository['getExisting']>>): string {
  const inspection = state.lastInspection;
  if (!inspection) {
    return '尚无生成记录。';
  }
  const selected = new Set(inspection.selectedMemoryIds);
  const selectedLines = state.memories
    .filter((memory) => selected.has(memory.id))
    .map((memory) => `[${memory.lastOperation}/${memory.status}/${memory.evidenceRole}]\n${renderMemoryEntry(memory)}`);
  return [
    `时间：${inspection.createdAt}`,
    `耗时：${inspection.durationMs}ms`,
    `保留范围：${inspection.retainedStartIndex}～${inspection.retainedEndIndex}`,
    `阶段总结覆盖到：${inspection.summaryCoveredThroughMessageId}，估算${inspection.estimatedSummaryTokens} Token`,
    `裁剪消息：${inspection.removedMessageCount}`,
    `向量候选：${inspection.vectorResultCount}，排序候选：${inspection.candidateMemoryIds.length}，最终注入：${inspection.selectedMemoryIds.length}`,
    `估算召回Token：${inspection.estimatedRecallTokens}`,
    `估算移除/注入/净节省Token：${inspection.estimatedRemovedTokens} / ${inspection.estimatedInjectedTokens} / ${inspection.estimatedNetSavedTokens}`,
    `查询：\n${inspection.query || '（无）'}`,
    `注入记忆：\n${selectedLines.join('\n') || '（无）'}`,
    `警告：\n${inspection.warnings.join('\n') || '（无）'}`,
  ].join('\n\n');
}

function tracesText(state: NonNullable<ReturnType<MemoryRepository['getExisting']>>): string {
  if (state.debugTraces.length === 0) {
    return '调试模式关闭或尚无轨迹。';
  }
  return [...state.debugTraces]
    .slice(-15)
    .reverse()
    .map((trace) => [
      `${trace.createdAt} [${trace.stage}] ${trace.message}`,
      trace.details ? JSON.stringify(trace.details, null, 2) : '',
    ].filter(Boolean).join('\n'))
    .join('\n\n');
}

function runtimeStatusText(): string[] {
  const queue = storyEchoTaskCoordinator.snapshot();
  const background = backgroundProcessingScheduler.snapshot();
  const queued = queue.queuedForeground + queue.queuedManual + queue.queuedBackground;
  const running = queue.runningKind
    ? `${queue.runningKind}/${queue.runningName}`
    : queue.foregroundLeaseActive ? '等待角色回复' : '空闲';
  let identityText = '未识别';
  try {
    const identity = getMainConnectionIdentity();
    identityText = [identity.source || identity.mainApi, identity.model].filter(Boolean).join('/') || '未识别';
  } catch {
    // The panel can render before SillyTavern has finished publishing context.
  }
  return [
    `主连接：${identityText}`,
    `任务：${running}`,
    `排队：前台${queue.queuedForeground}/手动${queue.queuedManual}/后台${queue.queuedBackground}（共${queued}）`,
    `最长等待：${queue.maximumQueueWaitMs}ms`,
    ...(background.extractionCooldownActive
      ? [`自动抽取退避：${Math.ceil(background.extractionCooldownRemainingMs / 1_000)}秒（连续失败${background.extractionCooldownFailures}次）`]
      : []),
  ];
}

async function refreshStatus(panel: HTMLElement, refreshVectorCount = false): Promise<void> {
  const target = element<HTMLElement>(panel, '#story-echo-status');
  const stageSummaryTarget = element<HTMLElement>(panel, '#story-echo-summary');
  const stats = element<HTMLElement>(panel, '#story-echo-stats');
  const inspection = element<HTMLElement>(panel, '#story-echo-inspection');
  const traces = element<HTMLElement>(panel, '#story-echo-traces');
  const summarySettingsOpen = element<HTMLDetailsElement>(panel, '#story-echo-summary-settings').open;
  const memoryManagerOpen = element<HTMLDetailsElement>(panel, '#story-echo-memory-manager').open;
  const summaryDiagnosticsOpen = element<HTMLDetailsElement>(panel, '#story-echo-summary-diagnostics').open;
  const statsOpen = element<HTMLDetailsElement>(panel, '#story-echo-stats-diagnostics').open;
  const inspectionOpen = element<HTMLDetailsElement>(panel, '#story-echo-inspection-diagnostics').open;
  const tracesOpen = element<HTMLDetailsElement>(panel, '#story-echo-traces-diagnostics').open;
  try {
    const currentSettings = settingsRepository.get();
    syncVisibility(panel, currentSettings);
    const state = memoryRepository.getExisting();
    if (!state) {
      cachedVectorCollectionId = '';
      cachedVectorCountText = '未读取';
      cachedVectorRevision = '';
      target.textContent = [
        getCurrentChatId()
          ? '当前聊天尚未初始化StoryEcho数据。'
          : '当前没有打开聊天。',
        ...runtimeStatusText(),
      ].join('｜');
      if (statsOpen) stats.textContent = '尚无统计数据。';
      if (summaryDiagnosticsOpen) stageSummaryTarget.textContent = '尚无全局骨架或阶段总结。';
      if (inspectionOpen) inspection.textContent = '尚无生成记录。';
      if (tracesOpen) traces.textContent = '调试模式关闭或尚无轨迹。';
      if (summarySettingsOpen) stageSummaryMetadataManager.render(panel, null);
      if (memoryManagerOpen) memoryMetadataManager.render(panel, null);
      return;
    }

    if (cachedVectorCollectionId !== state.vectorCollectionId) {
      cachedVectorCollectionId = state.vectorCollectionId;
      cachedVectorCountText = '未读取';
      cachedVectorRevision = '';
    }
    const currentVectorRevision = vectorRevision(state);
    if (!currentSettings.memory.enabled) {
      cachedVectorRevision = currentVectorRevision;
      cachedVectorCountText = '未读取（记忆已关闭）';
    } else if (refreshVectorCount || cachedVectorRevision !== currentVectorRevision) {
      // Mark before awaiting so the many diagnostics events emitted by one
      // background batch do not start duplicate collection-list requests.
      cachedVectorRevision = currentVectorRevision;
      try {
        const hashes = await vectorStore.list(
          state.vectorCollectionId,
          resolveVectorConfig(currentSettings),
        );
        cachedVectorCountText = String(hashes.length);
      } catch (error) {
        cachedVectorCountText = 'Vector Storage不可用';
        logger.debug('读取向量状态失败。', error);
      }
    }

    const context = getContext();
    const backgroundTarget = backgroundTargetMessageId(context.chat, currentSettings);
    const pendingExtractionTurns = currentSettings.memory.enabled && backgroundTarget > state.indexedThroughMessageId
      ? countCompletedTurns(context.chat.slice(
          state.indexedThroughMessageId + 1,
          backgroundTarget + 1,
        ))
      : 0;
    const activeSummaries = state.stageSummary.entries.filter((entry) => !entry.deleted);
    target.textContent = [
      currentSettings.memory.enabled ? '模式：全局骨架 + 阶段总结 + 剧情记忆' : '模式：上下文窗口 + 全局骨架 + 阶段总结',
      ...(currentSettings.memory.enabled
        ? [
            `剧情事件：${state.memories.length}`,
            `向量：${cachedVectorCountText}`,
            `待同步向量：${state.pendingVectorHashes.length}`,
            `待删除向量：${state.pendingVectorDeleteHashes.length}`,
            `已处理到消息：${state.indexedThroughMessageId}`,
            `抽取批次：每${currentSettings.extraction.targetTurnsPerChunk}轮（窗口外待处理${pendingExtractionTurns}轮）`,
            `集合：${state.vectorCollectionId}`,
          ]
        : [
            `剧情记忆：已关闭（保留 ${state.memories.length} 条）`,
            `向量：${cachedVectorCountText}`,
          ]),
      `阶段总结：${activeSummaries.length}条 / 覆盖到消息 ${state.stageSummary.coveredThroughMessageId}`,
      `全局骨架：${state.storySkeleton.text
        ? state.storySkeleton.stale
          ? '待重建（当前不注入）'
          : `覆盖到消息 ${state.storySkeleton.coveredThroughMessageId}`
        : '尚未生成'}`,
      ...runtimeStatusText(),
    ].join('｜');
    if (summaryDiagnosticsOpen) {
      const summaryWindowSize = Math.max(1, Math.floor(currentSettings.summary.windowSize));
      const visibleSummaries = activeSummaries.slice(-summaryWindowSize);
      const pendingArchived = pendingArchivedStageSummaryEntries(state, summaryWindowSize);
      const skeletonUsable = storySkeletonIsUsable(state);
      const currentStateCorrection = currentSettings.memory.enabled
        ? renderCurrentStateCoordinationBlock(state.memories)
        : '';
      stageSummaryTarget.textContent = skeletonUsable || activeSummaries.length > 0
        ? [
            skeletonUsable
              ? `全局剧情骨架（覆盖到消息 ${state.storySkeleton.coveredThroughMessageId}）：\n${state.storySkeleton.text}`
              : state.storySkeleton.text
                ? '全局剧情骨架来源已失效，重建成功前不会注入。'
                : '全局剧情骨架尚未生成。',
            ...(pendingArchived.length > 0 ? [
              `待汇入骨架但当前仍会直接携带的阶段总结 ${pendingArchived.length} 条：`,
              ...pendingArchived.map((entry) => [
                `消息 ${entry.sourceStartMessageId}～${entry.sourceEndMessageId}`,
                entry.text,
              ].join('\n')),
            ] : []),
            `已保存 ${activeSummaries.length} 条；一般请求另携带最近 ${visibleSummaries.length} 条。`,
            ...visibleSummaries.map((entry, index) => [
              `#${activeSummaries.length - visibleSummaries.length + index + 1}｜消息 ${entry.sourceStartMessageId}～${entry.sourceEndMessageId}`,
              entry.text,
            ].join('\n')),
            ...(currentStateCorrection
              ? [`请求还会在总结后附加以下当前状态校正：\n${currentStateCorrection}`]
              : []),
          ].join('\n\n')
        : '尚无全局骨架或阶段总结。';
    }
    if (statsOpen) stats.textContent = statsText(state);
    if (inspectionOpen) inspection.textContent = inspectionText(state);
    if (tracesOpen) traces.textContent = tracesText(state);
    if (summarySettingsOpen) stageSummaryMetadataManager.render(panel, state);
    if (memoryManagerOpen) memoryMetadataManager.render(panel, state);
  } catch (error) {
    const message = error instanceof Error ? error.message : '读取当前聊天状态失败。';
    target.textContent = message;
    if (summaryDiagnosticsOpen) stageSummaryTarget.textContent = '读取失败。';
    if (statsOpen) stats.textContent = `读取失败：${message}`;
    if (inspectionOpen) inspection.textContent = '读取失败。';
    if (tracesOpen) traces.textContent = '读取失败。';
    if (summarySettingsOpen) stageSummaryMetadataManager.render(panel, null);
    if (memoryManagerOpen) memoryMetadataManager.render(panel, null);
  }
}

async function findSettingsHost(): Promise<HTMLElement | null> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const host = document.querySelector<HTMLElement>('#extensions_settings2, #extensions_settings');
    if (host) {
      return host;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

export async function registerSettingsPanel(): Promise<void> {
  if (document.getElementById(PANEL_ID)) {
    return;
  }
  const host = await findSettingsHost();
  if (!host) {
    logger.warn('找不到SillyTavern扩展设置容器。');
    return;
  }

  const panel = panelTemplate();
  host.append(panel);
  const settings = settingsRepository.get();
  syncForm(panel, settings);
  bindSettings(panel);
  stageSummaryMetadataManager.bind(panel, async () => refreshStatus(panel));
  memoryMetadataManager.bind(panel, async () => refreshStatus(panel, true));
  globalThis.addEventListener(DIAGNOSTICS_UPDATED_EVENT, () => {
    requestStatusRefresh(panel);
  });
  panel.querySelector<HTMLElement>('.inline-drawer-toggle')?.addEventListener('click', () => {
    // SillyTavern toggles the drawer after the click handlers have run. Defer
    // the visibility check until the updated display state is observable.
    globalThis.setTimeout(() => requestVisiblePanelRefresh(panel, true), 0);
  });
  for (const selector of [
    '#story-echo-summary-settings',
    '#story-echo-memory-manager',
    '#story-echo-summary-diagnostics',
    '#story-echo-stats-diagnostics',
    '#story-echo-inspection-diagnostics',
    '#story-echo-traces-diagnostics',
  ]) {
    element<HTMLDetailsElement>(panel, selector).addEventListener('toggle', (event) => {
      if ((event.currentTarget as HTMLDetailsElement).open) {
        requestStatusRefresh(panel);
      }
    });
  }
  element<HTMLDetailsElement>(panel, '#story-echo-prompt-stats-card').addEventListener('toggle', (event) => {
    if ((event.currentTarget as HTMLDetailsElement).open) {
      requestPromptStatsRender(panel);
    }
  });
  const context = getContext();
  const chatRefreshEvents = new Set([
    context.event_types?.['CHAT_CHANGED'],
    context.event_types?.['CHAT_LOADED'],
  ].filter((eventName): eventName is string => Boolean(eventName)));
  for (const eventName of chatRefreshEvents) {
    context.eventSource?.on(eventName, () => {
      promptTokenStatsCard.invalidate();
      globalThis.setTimeout(() => requestVisiblePanelRefresh(panel, true), 0);
    });
  }
  const promptRefreshEvents = new Set([
    context.event_types?.['MESSAGE_RECEIVED'],
    context.event_types?.['MESSAGE_SWIPED'],
    context.event_types?.['MESSAGE_DELETED'],
    context.event_types?.['MESSAGE_SWIPE_DELETED'],
    context.event_types?.['GENERATION_STOPPED'],
    context.event_types?.['GENERATION_ENDED'],
    context.event_types?.['ITEMIZED_PROMPTS_LOADED'],
    context.event_types?.['ITEMIZED_PROMPTS_SAVED'],
    context.event_types?.['ITEMIZED_PROMPTS_DELETED'],
  ].filter((eventName): eventName is string => Boolean(eventName)));
  for (const eventName of promptRefreshEvents) {
    context.eventSource?.on(eventName, () => {
      requestPromptStatsRender(panel);
    });
  }
  requestVisiblePanelRefresh(panel, true);
}
