import { backgroundTargetMessageId } from '../background/scheduler';
import { DISPLAY_NAME } from '../core/constants';
import { logger } from '../core/logger';
import type { LlmProviderId, StoryEchoChatState, StoryEchoSettings, WindowUnit } from '../core/types';
import { DIAGNOSTICS_UPDATED_EVENT } from '../debug/events';
import { resetDiagnostics } from '../debug/metrics';
import { buildDebugReport } from '../debug/report';
import { fetchCustomLlmModels } from '../llm/model-list';
import { createLlmProvider } from '../llm/provider-factory';
import { normalizeChatCompletionsBaseUrl } from '../llm/url';
import {
  getContext,
  getCurrentChatId,
  getMainConnectionIdentity,
  showConfirmation,
} from '../platform/sillytavern';
import { selectRecentWindow } from '../prompt/window';
import { storyEchoTaskCoordinator } from '../runtime/task-coordinator';
import { SettingsRepository } from '../settings/repository';
import { StoryStateRepository } from '../state/repository';
import { stageSummaryService } from '../summary/service';
import { storySkeletonService } from '../summary/skeleton-service';
import { EventSubscriptionScope } from './event-subscriptions';
import { notify } from './notifications';
import { promptStatsCardTemplate, promptTokenStatsCard } from './prompt-stats-card';
import {
  StageSummaryMetadataManager,
  stageSummaryManagerTemplate,
} from './summary-manager';
import { isElementRendered } from './visibility';

const PANEL_ID = 'story-echo-settings';
const settingsRepository = new SettingsRepository();
const stateRepository = new StoryStateRepository();
const stageSummaryMetadataManager = new StageSummaryMetadataManager(stateRepository);

let registeredPanel: HTMLElement | undefined;
let settingsPanelCleanup: (() => void) | undefined;
let panelRegistrationPromise: Promise<void> | undefined;
let panelLifecycleGeneration = 0;
let refreshScheduled = false;
let refreshRunning = false;
let refreshAgain = false;
let promptStatsScheduled = false;

function element<T extends HTMLElement>(panel: HTMLElement, selector: string): T {
  const found = panel.querySelector<T>(selector);
  if (!found) {
    throw new Error(`StoryEcho设置控件不存在：${selector}`);
  }
  return found;
}

function numberValue(input: HTMLInputElement, fallback: number): number {
  const value = Number(input.value);
  return Number.isFinite(value) ? value : fallback;
}

function panelIsRendered(panel: HTMLElement): boolean {
  if (panel !== registeredPanel) {
    return false;
  }
  const body = panel.querySelector<HTMLElement>('.story-echo-panel-body');
  return Boolean(body && isElementRendered(body));
}

function schedulePromptStats(panel: HTMLElement): void {
  if (promptStatsScheduled || !promptTokenStatsCard.canRender(panel)) {
    return;
  }
  promptStatsScheduled = true;
  globalThis.setTimeout(() => {
    promptStatsScheduled = false;
    if (panel === registeredPanel && promptTokenStatsCard.canRender(panel)) {
      void promptTokenStatsCard.render(panel);
    }
  }, 100);
}

function requestRefresh(panel: HTMLElement): void {
  if (!panelIsRendered(panel)) {
    return;
  }
  schedulePromptStats(panel);
  if (refreshRunning) {
    refreshAgain = true;
    return;
  }
  if (refreshScheduled) {
    return;
  }
  refreshScheduled = true;
  globalThis.setTimeout(() => {
    refreshScheduled = false;
    if (panel !== registeredPanel || !panelIsRendered(panel)) {
      return;
    }
    refreshRunning = true;
    void refreshStatus(panel).finally(() => {
      refreshRunning = false;
      if (refreshAgain) {
        refreshAgain = false;
        requestRefresh(panel);
      }
    });
  }, 0);
}

function panelTemplate(): HTMLElement {
  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.className = 'extension_container';
  panel.innerHTML = `
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>${DISPLAY_NAME}</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content story-echo-panel-body">
        <div class="story-echo-switch-row story-echo-switch-primary">
          <div class="story-echo-switch-copy">
            <span class="story-echo-switch-title">启用 StoryEcho 上下文管理</span>
            <p class="story-echo-hint">用最近原文、阶段总结与全局剧情骨架管理长对话上下文。</p>
          </div>
          <span class="story-echo-toggle">
            <input id="story-echo-enabled" class="story-echo-toggle-input" type="checkbox">
            <label class="story-echo-toggle-label" for="story-echo-enabled" aria-label="启用 StoryEcho 上下文管理"></label>
          </span>
        </div>

        <section class="story-echo-section story-echo-settings-grid">
          <label class="story-echo-field">
            <span>最近原文窗口</span>
            <input id="story-echo-window-size" class="text_pole" type="number" min="0" max="1000" step="1">
          </label>
          <label class="story-echo-field">
            <span>窗口单位</span>
            <select id="story-echo-window-unit" class="text_pole">
              <option value="turns">轮</option>
              <option value="messages">条消息</option>
            </select>
          </label>
          <label class="story-echo-field">
            <span>每条阶段总结覆盖</span>
            <input id="story-echo-summary-batch" class="text_pole" type="number" min="1" max="100" step="1">
          </label>
          <label class="story-echo-field">
            <span>随请求保留总结数</span>
            <input id="story-echo-summary-window" class="text_pole" type="number" min="1" max="100" step="1">
          </label>
          <label class="story-echo-field">
            <span>阶段总结输出上限</span>
            <input id="story-echo-summary-tokens" class="text_pole" type="number" min="128" max="8192" step="1">
          </label>
          <label class="story-echo-field">
            <span>全局骨架输出上限</span>
            <input id="story-echo-skeleton-tokens" class="text_pole" type="number" min="512" max="10000" step="1">
          </label>
        </section>

        <section class="story-echo-section">
          <div class="story-echo-switch-row">
            <div class="story-echo-switch-copy">
              <span class="story-echo-switch-title">总结时参考世界书</span>
              <p class="story-echo-hint">读取蓝灯常驻条目，以及由当前总结批次命中的绿灯条目。</p>
            </div>
            <span class="story-echo-toggle">
              <input id="story-echo-world-info-reference" class="story-echo-toggle-input" type="checkbox">
              <label class="story-echo-toggle-label" for="story-echo-world-info-reference" aria-label="总结时参考世界书"></label>
            </span>
          </div>
          <label class="story-echo-field">
            <span>每批最多匹配绿灯条目</span>
            <input id="story-echo-reference-world-info" class="text_pole" type="number" min="0" max="20" step="1">
          </label>
        </section>

        <details id="story-echo-llm-settings" class="story-echo-section story-echo-collapsible" open>
          <summary class="story-echo-section-summary">
            <span class="story-echo-section-summary-main">
              <i class="fa-solid fa-brain" aria-hidden="true"></i>
              <span class="story-echo-section-summary-copy">
                <span class="story-echo-section-summary-title">阶段总结与骨架模型</span>
                <span class="story-echo-section-summary-description">默认复用当前主连接</span>
              </span>
            </span>
            <i class="fa-solid fa-chevron-right story-echo-section-chevron" aria-hidden="true"></i>
          </summary>
          <div class="story-echo-section-body">
            <label class="story-echo-field">
              <span>连接来源</span>
              <select id="story-echo-llm-provider" class="text_pole">
                <option value="main">SillyTavern 主连接</option>
                <option value="openai-compatible">自定义 OpenAI 兼容接口</option>
              </select>
            </label>
            <p id="story-echo-main-connection" class="story-echo-hint"></p>
            <div id="story-echo-custom-llm">
              <label class="story-echo-field">
                <span>Base URL</span>
                <input id="story-echo-llm-base-url" class="text_pole" type="url" placeholder="https://api.example.com/v1">
              </label>
              <label class="story-echo-field">
                <span>模型</span>
                <input id="story-echo-llm-model" class="text_pole" type="text" list="story-echo-model-options">
                <datalist id="story-echo-model-options"></datalist>
              </label>
              <button id="story-echo-fetch-models" class="menu_button" type="button">
                <i class="fa-solid fa-list" aria-hidden="true"></i><span>获取模型列表</span>
              </button>
              <label class="story-echo-field">
                <span>API Key</span>
                <input id="story-echo-llm-api-key" class="text_pole" type="password" autocomplete="new-password">
              </label>
              <label class="story-echo-field">
                <span>超时（毫秒）</span>
                <input id="story-echo-llm-timeout" class="text_pole" type="number" min="1000" max="300000" step="1000">
              </label>
              <label class="story-echo-check-row">
                <input id="story-echo-llm-http" type="checkbox">
                <span>允许不安全 HTTP（仅可信内网）</span>
              </label>
              <label class="story-echo-check-row">
                <input id="story-echo-llm-fallback" type="checkbox">
                <span>失败时回退主连接</span>
              </label>
            </div>
            <button id="story-echo-test-llm" class="menu_button story-echo-model-action" type="button">
              <i class="fa-solid fa-plug-circle-check" aria-hidden="true"></i><span>测试模型连接</span>
            </button>
          </div>
        </details>

        <details id="story-echo-summary-settings" class="story-echo-section story-echo-collapsible">
          <summary class="story-echo-section-summary">
            <span class="story-echo-section-summary-main">
              <i class="fa-solid fa-book-open" aria-hidden="true"></i>
              <span class="story-echo-section-summary-copy">
                <span class="story-echo-section-summary-title">全局骨架与阶段总结</span>
                <span class="story-echo-section-summary-description">查看、编辑或重建当前聊天的派生上下文</span>
              </span>
            </span>
            <i class="fa-solid fa-chevron-right story-echo-section-chevron" aria-hidden="true"></i>
          </summary>
          <div class="story-echo-section-body">${stageSummaryManagerTemplate()}</div>
        </details>

        <section class="story-echo-section story-echo-actions">
          <button id="story-echo-process-history" class="menu_button story-echo-action-primary" type="button">
            <i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i><span>处理窗口外历史</span>
          </button>
          <label class="story-echo-check-row">
            <input id="story-echo-debug" type="checkbox">
            <span>开启调试记录</span>
          </label>
          <p id="story-echo-status" class="story-echo-status">正在读取状态…</p>
        </section>

        ${promptStatsCardTemplate()}

        <details id="story-echo-stats-diagnostics" class="story-echo-section story-echo-collapsible">
          <summary class="story-echo-section-summary">
            <span class="story-echo-section-summary-main"><i class="fa-solid fa-gauge-high"></i><span class="story-echo-section-summary-title">运行统计</span></span>
            <i class="fa-solid fa-chevron-right story-echo-section-chevron"></i>
          </summary>
          <div class="story-echo-section-body"><pre id="story-echo-stats" class="story-echo-debug-output">尚无统计数据。</pre></div>
        </details>
        <details id="story-echo-inspection-diagnostics" class="story-echo-section story-echo-collapsible">
          <summary class="story-echo-section-summary">
            <span class="story-echo-section-summary-main"><i class="fa-solid fa-magnifying-glass"></i><span class="story-echo-section-summary-title">最近一次上下文处理</span></span>
            <i class="fa-solid fa-chevron-right story-echo-section-chevron"></i>
          </summary>
          <div class="story-echo-section-body"><pre id="story-echo-inspection" class="story-echo-debug-output">尚无生成记录。</pre></div>
        </details>
        <details id="story-echo-traces-diagnostics" class="story-echo-section story-echo-collapsible">
          <summary class="story-echo-section-summary">
            <span class="story-echo-section-summary-main"><i class="fa-solid fa-bug"></i><span class="story-echo-section-summary-title">调试轨迹</span></span>
            <i class="fa-solid fa-chevron-right story-echo-section-chevron"></i>
          </summary>
          <div class="story-echo-section-body"><pre id="story-echo-traces" class="story-echo-debug-output">调试模式关闭或尚无轨迹。</pre></div>
        </details>

        <div class="story-echo-diagnostics-actions">
          <button id="story-echo-copy-report" class="menu_button" type="button"><i class="fa-solid fa-copy"></i><span>复制诊断报告</span></button>
          <button id="story-echo-reset-stats" class="menu_button" type="button"><i class="fa-solid fa-eraser"></i><span>清空统计与轨迹</span></button>
        </div>
      </div>
    </div>
  `;
  return panel;
}

function syncVisibility(panel: HTMLElement, settings: StoryEchoSettings): void {
  element<HTMLElement>(panel, '#story-echo-custom-llm').hidden =
    settings.llm.provider !== 'openai-compatible';
  element<HTMLInputElement>(panel, '#story-echo-reference-world-info').disabled =
    !settings.summary.reference.enabled;
}

function syncForm(panel: HTMLElement, settings: StoryEchoSettings): void {
  element<HTMLInputElement>(panel, '#story-echo-enabled').checked = settings.enabled;
  element<HTMLInputElement>(panel, '#story-echo-debug').checked = settings.debug;
  element<HTMLInputElement>(panel, '#story-echo-window-size').value =
    String(settings.recentWindow.size);
  element<HTMLSelectElement>(panel, '#story-echo-window-unit').value =
    settings.recentWindow.unit;
  element<HTMLInputElement>(panel, '#story-echo-summary-batch').value =
    String(settings.summary.targetTurnsPerUpdate);
  element<HTMLInputElement>(panel, '#story-echo-summary-window').value =
    String(settings.summary.windowSize);
  element<HTMLInputElement>(panel, '#story-echo-summary-tokens').value =
    String(settings.summary.maxTokens);
  element<HTMLInputElement>(panel, '#story-echo-skeleton-tokens').value =
    String(settings.summary.skeletonMaxTokens);
  element<HTMLInputElement>(panel, '#story-echo-world-info-reference').checked =
    settings.summary.reference.enabled;
  element<HTMLInputElement>(panel, '#story-echo-reference-world-info').value =
    String(settings.summary.reference.maxWorldInfoEntries);
  element<HTMLSelectElement>(panel, '#story-echo-llm-provider').value = settings.llm.provider;
  element<HTMLInputElement>(panel, '#story-echo-llm-base-url').value = settings.llm.custom.baseUrl;
  element<HTMLInputElement>(panel, '#story-echo-llm-model').value = settings.llm.custom.model;
  element<HTMLInputElement>(panel, '#story-echo-llm-api-key').value = settings.llm.custom.apiKey;
  element<HTMLInputElement>(panel, '#story-echo-llm-timeout').value =
    String(settings.llm.custom.timeoutMs);
  element<HTMLInputElement>(panel, '#story-echo-llm-http').checked =
    settings.llm.custom.allowInsecureHttp;
  element<HTMLInputElement>(panel, '#story-echo-llm-fallback').checked =
    settings.llm.custom.fallbackToMain;
  let identity = '主连接尚未就绪';
  try {
    const current = getMainConnectionIdentity();
    identity = [current.source || current.mainApi, current.model].filter(Boolean).join(' / ') || identity;
  } catch {
    // The settings panel can mount before the main connection is ready.
  }
  element<HTMLElement>(panel, '#story-echo-main-connection').textContent = `当前主连接：${identity}`;
  syncVisibility(panel, settings);
}

function update(
  panel: HTMLElement,
  mutator: (settings: StoryEchoSettings) => void,
): StoryEchoSettings {
  const settings = settingsRepository.update(mutator);
  syncForm(panel, settings);
  promptTokenStatsCard.invalidate();
  requestRefresh(panel);
  return settings;
}

function bindSettings(panel: HTMLElement): void {
  element<HTMLInputElement>(panel, '#story-echo-enabled').addEventListener('change', (event) => {
    update(panel, (settings) => {
      settings.enabled = (event.currentTarget as HTMLInputElement).checked;
    });
  });
  element<HTMLInputElement>(panel, '#story-echo-debug').addEventListener('change', (event) => {
    update(panel, (settings) => {
      settings.debug = (event.currentTarget as HTMLInputElement).checked;
    });
  });
  element<HTMLInputElement>(panel, '#story-echo-window-size').addEventListener('change', (event) => {
    update(panel, (settings) => {
      settings.recentWindow.size = numberValue(event.currentTarget as HTMLInputElement, 10);
    });
  });
  element<HTMLSelectElement>(panel, '#story-echo-window-unit').addEventListener('change', (event) => {
    update(panel, (settings) => {
      settings.recentWindow.unit = (event.currentTarget as HTMLSelectElement).value as WindowUnit;
    });
  });
  element<HTMLInputElement>(panel, '#story-echo-summary-batch').addEventListener('change', (event) => {
    update(panel, (settings) => {
      settings.summary.targetTurnsPerUpdate = numberValue(event.currentTarget as HTMLInputElement, 10);
    });
  });
  element<HTMLInputElement>(panel, '#story-echo-summary-window').addEventListener('change', (event) => {
    update(panel, (settings) => {
      settings.summary.windowSize = numberValue(event.currentTarget as HTMLInputElement, 4);
    });
  });
  element<HTMLInputElement>(panel, '#story-echo-summary-tokens').addEventListener('change', (event) => {
    update(panel, (settings) => {
      settings.summary.maxTokens = numberValue(event.currentTarget as HTMLInputElement, 1_600);
    });
  });
  element<HTMLInputElement>(panel, '#story-echo-skeleton-tokens').addEventListener('change', (event) => {
    update(panel, (settings) => {
      settings.summary.skeletonMaxTokens = numberValue(event.currentTarget as HTMLInputElement, 5_000);
    });
  });
  element<HTMLInputElement>(panel, '#story-echo-world-info-reference').addEventListener('change', (event) => {
    update(panel, (settings) => {
      settings.summary.reference.enabled = (event.currentTarget as HTMLInputElement).checked;
    });
  });
  element<HTMLInputElement>(panel, '#story-echo-reference-world-info').addEventListener('change', (event) => {
    update(panel, (settings) => {
      settings.summary.reference.maxWorldInfoEntries =
        numberValue(event.currentTarget as HTMLInputElement, 5);
    });
  });
  element<HTMLSelectElement>(panel, '#story-echo-llm-provider').addEventListener('change', (event) => {
    update(panel, (settings) => {
      settings.llm.provider = (event.currentTarget as HTMLSelectElement).value as LlmProviderId;
    });
  });
  element<HTMLInputElement>(panel, '#story-echo-llm-base-url').addEventListener('change', (event) => {
    const input = event.currentTarget as HTMLInputElement;
    try {
      update(panel, (settings) => {
        settings.llm.custom.baseUrl = input.value.trim()
          ? normalizeChatCompletionsBaseUrl(input.value, {
              allowInsecureHttp: settings.llm.custom.allowInsecureHttp,
            })
          : '';
      });
    } catch (error) {
      input.value = settingsRepository.get().llm.custom.baseUrl;
      notify.error(error instanceof Error ? error.message : 'Base URL 无效。');
    }
  });
  element<HTMLInputElement>(panel, '#story-echo-llm-model').addEventListener('change', (event) => {
    update(panel, (settings) => {
      settings.llm.custom.model = (event.currentTarget as HTMLInputElement).value.trim();
    });
  });
  element<HTMLInputElement>(panel, '#story-echo-llm-api-key').addEventListener('change', (event) => {
    update(panel, (settings) => {
      settings.llm.custom.apiKey = (event.currentTarget as HTMLInputElement).value;
    });
  });
  element<HTMLInputElement>(panel, '#story-echo-llm-timeout').addEventListener('change', (event) => {
    update(panel, (settings) => {
      settings.llm.custom.timeoutMs = numberValue(event.currentTarget as HTMLInputElement, 180_000);
    });
  });
  element<HTMLInputElement>(panel, '#story-echo-llm-http').addEventListener('change', (event) => {
    update(panel, (settings) => {
      settings.llm.custom.allowInsecureHttp = (event.currentTarget as HTMLInputElement).checked;
    });
  });
  element<HTMLInputElement>(panel, '#story-echo-llm-fallback').addEventListener('change', (event) => {
    update(panel, (settings) => {
      settings.llm.custom.fallbackToMain = (event.currentTarget as HTMLInputElement).checked;
    });
  });

  element<HTMLButtonElement>(panel, '#story-echo-fetch-models').addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    try {
      const models = await fetchCustomLlmModels(settingsRepository.get().llm.custom);
      const options = element<HTMLDataListElement>(panel, '#story-echo-model-options');
      options.replaceChildren(...models.map((model) => {
        const option = document.createElement('option');
        option.value = model;
        return option;
      }));
      notify.success(`已读取 ${models.length} 个模型。`);
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '获取模型列表失败。');
    } finally {
      button.disabled = false;
    }
  });

  element<HTMLButtonElement>(panel, '#story-echo-test-llm').addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    try {
      await createLlmProvider(settingsRepository.get()).testConnection();
      notify.success('模型连接测试成功。');
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '模型连接测试失败。');
    } finally {
      button.disabled = false;
    }
  });

  element<HTMLButtonElement>(panel, '#story-echo-process-history').addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const requestedChatId = getCurrentChatId();
    button.disabled = true;
    try {
      const result = await storyEchoTaskCoordinator.enqueueManual('处理窗口外历史', async () => {
        if (!requestedChatId || getCurrentChatId() !== requestedChatId) {
          throw new Error('等待处理期间聊天已切换，已取消任务。');
        }
        const settings = settingsRepository.get();
        if (!settings.enabled) {
          throw new Error('请先启用 StoryEcho 上下文管理。');
        }
        const chat = getContext().chat;
        const targetEndMessageId = backgroundTargetMessageId(chat, settings);
        const fallbackWindow = selectRecentWindow(
          chat,
          settings.recentWindow.size,
          settings.recentWindow.unit,
        );
        const target = Math.max(
          targetEndMessageId,
          fallbackWindow && fallbackWindow.retainedStartIndex > 0
            ? fallbackWindow.retainedStartIndex - 1
            : -1,
        );
        if (target < 0) {
          throw new Error('当前没有窗口外历史可处理。');
        }
        let state = await stateRepository.getOrCreate();
        state = await stageSummaryService.reconcileHistory(state ?? undefined);
        state = await storySkeletonService.reconcile(state ?? undefined);
        const summary = await stageSummaryService.processAllThrough(target);
        const skeleton = await storySkeletonService.processAllPending();
        return { summary, skeleton };
      });
      const updates = result.summary.updatedChunks + result.skeleton.updatedChunks;
      notify.success(updates > 0 ? `处理完成，共写入 ${updates} 次更新。` : '已检查，暂时没有达到更新条件。');
      await refreshStatus(panel);
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '处理窗口外历史失败。');
    } finally {
      button.disabled = false;
    }
  });

  element<HTMLButtonElement>(panel, '#story-echo-copy-report').addEventListener('click', async () => {
    const state = stateRepository.getExisting();
    if (!state) {
      notify.info('当前聊天尚无 StoryEcho 状态。');
      return;
    }
    try {
      await copyText(buildDebugReport(state, settingsRepository.get()));
      notify.success('诊断报告已复制。');
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '复制诊断报告失败。');
    }
  });

  element<HTMLButtonElement>(panel, '#story-echo-reset-stats').addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const confirmed = await showConfirmation(
      '清空 StoryEcho 统计',
      '将清空当前聊天的运行统计、最近检查记录和调试轨迹；阶段总结与全局骨架不会改变。',
    );
    if (!confirmed) {
      return;
    }
    button.disabled = true;
    try {
      const state = stateRepository.getExisting();
      if (state) {
        resetDiagnostics(state);
        await stateRepository.save(state);
      }
      await refreshStatus(panel);
      notify.success('统计与调试轨迹已清空。');
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '清空统计失败。');
    } finally {
      button.disabled = false;
    }
  });
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
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

function statsText(state: StoryEchoChatState): string {
  const metrics = state.metrics;
  const averageSummary = metrics.summaryUpdates > 0
    ? Math.round(metrics.totalSummaryMs / metrics.summaryUpdates)
    : 0;
  const averageSkeleton = metrics.skeletonUpdates > 0
    ? Math.round(metrics.totalSkeletonMs / metrics.skeletonUpdates)
    : 0;
  const estimatedNetSaved = Math.max(
    0,
    metrics.estimatedRemovedTokens - metrics.estimatedInjectedTokens,
  );
  const queue = storyEchoTaskCoordinator.snapshot();
  return [
    `全局骨架：更新 ${metrics.skeletonUpdates} 次，失败 ${metrics.skeletonFailures} 次，平均 ${averageSkeleton}ms/次`,
    `阶段总结：更新 ${metrics.summaryUpdates} 次，失败 ${metrics.summaryFailures} 次，覆盖 ${metrics.summaryMessagesCovered} 条消息，平均 ${averageSummary}ms/次`,
    `上下文：尝试 ${metrics.generationAttempts} 次，裁剪 ${metrics.generationsTrimmed} 次，延迟裁剪 ${metrics.generationsDeferred} 次，移除 ${metrics.messagesRemoved} 条原文`,
    `估算 Token：移除 ${metrics.estimatedRemovedTokens}，注入 ${metrics.estimatedInjectedTokens}，累计净节省 ${estimatedNetSaved}`,
    `任务队列：运行 ${queue.runningKind ?? (queue.foregroundLeaseActive ? '等待角色回复' : '空闲')}，排队前台 ${queue.queuedForeground}/手动 ${queue.queuedManual}/后台 ${queue.queuedBackground}，最长等待 ${queue.maximumQueueWaitMs}ms`,
    `最近：骨架 ${metrics.lastSkeletonAt ?? '无'} / 总结 ${metrics.lastSummaryAt ?? '无'} / 生成 ${metrics.lastGenerationAt ?? '无'}`,
    `调试轨迹：${state.debugTraces.length}/50`,
  ].join('\n');
}

function inspectionText(state: StoryEchoChatState): string {
  const inspection = state.lastInspection;
  if (!inspection) {
    return '尚无生成记录。';
  }
  return [
    `时间：${inspection.createdAt}`,
    `生成类型：${inspection.generationType}`,
    `耗时：${inspection.durationMs}ms`,
    `保留范围：${inspection.retainedStartIndex}～${inspection.retainedEndIndex}`,
    `阶段总结覆盖到：${inspection.summaryCoveredThroughMessageId}，估算 ${inspection.estimatedSummaryTokens} Token`,
    `裁剪消息：${inspection.removedMessageCount}`,
    `估算移除/注入/净节省 Token：${inspection.estimatedRemovedTokens} / ${inspection.estimatedInjectedTokens} / ${inspection.estimatedNetSavedTokens}`,
    `警告：\n${inspection.warnings.join('\n') || '（无）'}`,
  ].join('\n\n');
}

function tracesText(state: StoryEchoChatState): string {
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

function runtimeStatusText(): string {
  const queue = storyEchoTaskCoordinator.snapshot();
  const running = queue.runningKind
    ? `${queue.runningKind}/${queue.runningName}`
    : queue.foregroundLeaseActive
      ? '等待角色回复'
      : '空闲';
  return `任务：${running}｜排队：前台 ${queue.queuedForeground}/手动 ${queue.queuedManual}/后台 ${queue.queuedBackground}`;
}

async function refreshStatus(panel: HTMLElement): Promise<void> {
  const status = element<HTMLElement>(panel, '#story-echo-status');
  try {
    const settings = settingsRepository.get();
    syncVisibility(panel, settings);
    const state = stateRepository.getExisting();
    if (!state) {
      status.textContent = [
        getCurrentChatId() ? '当前聊天尚未初始化 StoryEcho 数据。' : '当前没有打开聊天。',
        runtimeStatusText(),
      ].join('｜');
      element<HTMLElement>(panel, '#story-echo-stats').textContent = '尚无统计数据。';
      element<HTMLElement>(panel, '#story-echo-inspection').textContent = '尚无生成记录。';
      element<HTMLElement>(panel, '#story-echo-traces').textContent = '调试模式关闭或尚无轨迹。';
      if (element<HTMLDetailsElement>(panel, '#story-echo-summary-settings').open) {
        stageSummaryMetadataManager.render(panel, null);
      }
      return;
    }
    const activeSummaries = state.stageSummary.entries.filter((entry) => !entry.deleted);
    status.textContent = [
      settings.enabled ? '上下文管理：已启用' : '上下文管理：已关闭',
      `阶段总结：${activeSummaries.length} 条 / 覆盖到消息 ${state.stageSummary.coveredThroughMessageId}`,
      `全局骨架：${state.storySkeleton.text
        ? state.storySkeleton.stale
          ? '待重建（当前不注入）'
          : `覆盖到消息 ${state.storySkeleton.coveredThroughMessageId}`
        : '尚未生成'}`,
      runtimeStatusText(),
    ].join('｜');
    if (element<HTMLDetailsElement>(panel, '#story-echo-stats-diagnostics').open) {
      element<HTMLElement>(panel, '#story-echo-stats').textContent = statsText(state);
    }
    if (element<HTMLDetailsElement>(panel, '#story-echo-inspection-diagnostics').open) {
      element<HTMLElement>(panel, '#story-echo-inspection').textContent = inspectionText(state);
    }
    if (element<HTMLDetailsElement>(panel, '#story-echo-traces-diagnostics').open) {
      element<HTMLElement>(panel, '#story-echo-traces').textContent = tracesText(state);
    }
    if (element<HTMLDetailsElement>(panel, '#story-echo-summary-settings').open) {
      stageSummaryMetadataManager.render(panel, state);
    }
  } catch (error) {
    logger.warn('刷新 StoryEcho 设置状态失败。', error);
    status.textContent = '状态读取失败。';
  }
}

async function findSettingsHost(generation: number): Promise<HTMLElement | null> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (generation !== panelLifecycleGeneration) {
      return null;
    }
    const host = document.querySelector<HTMLElement>('#extensions_settings2, #extensions_settings');
    if (host) {
      return host;
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
  }
  return null;
}

function resetPanelRefreshState(): void {
  refreshScheduled = false;
  refreshRunning = false;
  refreshAgain = false;
  promptStatsScheduled = false;
  promptTokenStatsCard.invalidate();
}

export function unregisterSettingsPanel(): void {
  panelLifecycleGeneration += 1;
  panelRegistrationPromise = undefined;
  const cleanup = settingsPanelCleanup;
  settingsPanelCleanup = undefined;
  cleanup?.();
  registeredPanel?.remove();
  registeredPanel = undefined;
  resetPanelRefreshState();
}

async function registerSettingsPanelOnce(generation: number): Promise<void> {
  const host = await findSettingsHost(generation);
  if (generation !== panelLifecycleGeneration) {
    return;
  }
  if (!host) {
    logger.warn('找不到 SillyTavern 扩展设置容器。');
    return;
  }

  document.getElementById(PANEL_ID)?.remove();
  const panel = panelTemplate();
  host.append(panel);
  registeredPanel = panel;
  const subscriptions = new EventSubscriptionScope();
  const cleanup = (): void => {
    subscriptions.dispose();
    panel.remove();
    if (registeredPanel === panel) {
      registeredPanel = undefined;
    }
  };
  settingsPanelCleanup = cleanup;

  try {
    syncForm(panel, settingsRepository.get());
    bindSettings(panel);
    stageSummaryMetadataManager.bind(panel, async () => refreshStatus(panel));
    subscriptions.listen(globalThis, DIAGNOSTICS_UPDATED_EVENT, () => requestRefresh(panel));
    panel.querySelector<HTMLElement>('.inline-drawer-toggle')?.addEventListener('click', () => {
      globalThis.setTimeout(() => requestRefresh(panel), 0);
    });
    for (const selector of [
      '#story-echo-summary-settings',
      '#story-echo-stats-diagnostics',
      '#story-echo-inspection-diagnostics',
      '#story-echo-traces-diagnostics',
    ]) {
      element<HTMLDetailsElement>(panel, selector).addEventListener('toggle', (event) => {
        if ((event.currentTarget as HTMLDetailsElement).open) {
          requestRefresh(panel);
        }
      });
    }
    element<HTMLDetailsElement>(panel, '#story-echo-prompt-stats-card').addEventListener('toggle', (event) => {
      if ((event.currentTarget as HTMLDetailsElement).open) {
        schedulePromptStats(panel);
      }
    });

    const context = getContext();
    const eventSource = context.eventSource;
    const refreshEvents = new Set([
      context.event_types?.['CHAT_CHANGED'] ?? context.eventTypes?.['CHAT_CHANGED'],
      context.event_types?.['CHAT_LOADED'] ?? context.eventTypes?.['CHAT_LOADED'],
      context.event_types?.['MESSAGE_RECEIVED'] ?? context.eventTypes?.['MESSAGE_RECEIVED'],
      context.event_types?.['MESSAGE_SWIPED'] ?? context.eventTypes?.['MESSAGE_SWIPED'],
      context.event_types?.['MESSAGE_DELETED'] ?? context.eventTypes?.['MESSAGE_DELETED'],
      context.event_types?.['GENERATION_ENDED'] ?? context.eventTypes?.['GENERATION_ENDED'],
      context.event_types?.['ITEMIZED_PROMPTS_LOADED'] ?? context.eventTypes?.['ITEMIZED_PROMPTS_LOADED'],
    ].filter((eventName): eventName is string => Boolean(eventName)));
    if (eventSource) {
      for (const eventName of refreshEvents) {
        subscriptions.subscribe(eventSource, eventName, () => {
          promptTokenStatsCard.invalidate();
          globalThis.setTimeout(() => requestRefresh(panel), 0);
        });
      }
    }
    requestRefresh(panel);
  } catch (error) {
    if (settingsPanelCleanup === cleanup) {
      settingsPanelCleanup = undefined;
    }
    cleanup();
    resetPanelRefreshState();
    throw error;
  }
}

export function registerSettingsPanel(): Promise<void> {
  if (registeredPanel?.isConnected) {
    return Promise.resolve();
  }
  if (registeredPanel) {
    unregisterSettingsPanel();
  }
  if (panelRegistrationPromise) {
    return panelRegistrationPromise;
  }
  const generation = panelLifecycleGeneration;
  let trackedOperation: Promise<void>;
  trackedOperation = registerSettingsPanelOnce(generation).finally(() => {
    if (panelRegistrationPromise === trackedOperation) {
      panelRegistrationPromise = undefined;
    }
  });
  panelRegistrationPromise = trackedOperation;
  return trackedOperation;
}
