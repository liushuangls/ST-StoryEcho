import { logger } from '../core/logger';
import type { LlmProviderId, StoryEchoSettings, WindowUnit } from '../core/types';
import { extractionService } from '../extraction/service';
import { createLlmProvider } from '../llm/provider-factory';
import { sessionSecretVault } from '../llm/secret-vault';
import { normalizeChatCompletionsUrl } from '../llm/url';
import { MemoryRepository } from '../memory/repository';
import { getContext, getCurrentChatId } from '../platform/sillytavern';
import { selectRecentWindow } from '../prompt/window';
import { SettingsRepository } from '../settings/repository';
import { resolveVectorConfig } from '../vector/config';
import { SillyTavernVectorStore } from '../vector/sillytavern-vector-store';
import { notify } from './notifications';

const PANEL_ID = 'story-echo-settings';
const settingsRepository = new SettingsRepository();
const memoryRepository = new MemoryRepository();
const vectorStore = new SillyTavernVectorStore();

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
      <div class="inline-drawer-content">
        <label class="checkbox_label story-echo-inline">
          <input id="story-echo-enabled" type="checkbox">
          <span>启用滑动窗口与历史剧情召回</span>
        </label>

        <div class="story-echo-grid">
          <label class="story-echo-field">
            <span>最近窗口</span>
            <input id="story-echo-window-size" class="text_pole" type="number" min="0" max="1000" step="1">
          </label>
          <label class="story-echo-field">
            <span>计数单位</span>
            <select id="story-echo-window-unit" class="text_pole">
              <option value="turns">轮次（用户 + AI）</option>
              <option value="messages">消息条数</option>
            </select>
          </label>
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
            <span>LLM来源</span>
            <select id="story-echo-provider" class="text_pole">
              <option value="main">SillyTavern主连接（默认）</option>
              <option value="openai-compatible">自定义OpenAI兼容接口</option>
            </select>
          </label>
          <label class="checkbox_label story-echo-inline story-echo-field-wide">
            <input id="story-echo-auto-extract" type="checkbox">
            <span>窗口边界需要时自动抽取尚未处理的历史</span>
          </label>
        </div>

        <div id="story-echo-custom-provider" class="story-echo-grid">
          <label class="story-echo-field story-echo-field-wide">
            <span>Base URL</span>
            <input id="story-echo-base-url" class="text_pole" type="url" placeholder="https://example.com/v1">
          </label>
          <label class="story-echo-field">
            <span>模型</span>
            <input id="story-echo-model" class="text_pole" type="text" placeholder="model-name">
          </label>
          <label class="story-echo-field">
            <span>API Key（仅当前页面内存）</span>
            <input id="story-echo-api-key" class="text_pole" type="password" autocomplete="off" placeholder="刷新后需要重新输入">
          </label>
          <label class="checkbox_label story-echo-inline">
            <input id="story-echo-allow-http" type="checkbox">
            <span>允许不安全HTTP（仅建议局域网）</span>
          </label>
          <label class="checkbox_label story-echo-inline">
            <input id="story-echo-fallback-main" type="checkbox">
            <span>自定义接口失败时回退主连接</span>
          </label>
          <div class="story-echo-field-wide story-echo-inline">
            <span id="story-echo-key-status" class="story-echo-secret-empty">API Key未加载</span>
            <button id="story-echo-clear-key" class="menu_button" type="button">清除Key</button>
          </div>
        </div>

        <div class="story-echo-inline">
          <button id="story-echo-test-llm" class="menu_button" type="button">测试LLM连接</button>
          <button id="story-echo-process-history" class="menu_button" type="button">处理窗口外历史</button>
          <button id="story-echo-refresh-status" class="menu_button" type="button">刷新状态</button>
        </div>

        <p class="story-echo-hint">
          自定义Key不会保存到扩展设置。Vector Storage默认复用酒馆当前向量来源和模型。
        </p>
        <div id="story-echo-status" class="story-echo-status">正在读取当前聊天状态……</div>
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
  const value = Number(input.value);
  return Number.isFinite(value) ? value : fallback;
}

function syncVisibility(panel: HTMLElement, settings: StoryEchoSettings): void {
  const custom = element<HTMLElement>(panel, '#story-echo-custom-provider');
  custom.hidden = settings.llm.provider !== 'openai-compatible';

  const keyStatus = element<HTMLElement>(panel, '#story-echo-key-status');
  keyStatus.textContent = sessionSecretVault.hasSessionKey() ? 'API Key已加载到当前页面' : 'API Key未加载';
  keyStatus.classList.toggle('story-echo-secret-loaded', sessionSecretVault.hasSessionKey());
  keyStatus.classList.toggle('story-echo-secret-empty', !sessionSecretVault.hasSessionKey());
}

function syncForm(panel: HTMLElement, settings: StoryEchoSettings): void {
  element<HTMLInputElement>(panel, '#story-echo-enabled').checked = settings.enabled;
  element<HTMLInputElement>(panel, '#story-echo-window-size').value = String(settings.recentWindow.size);
  element<HTMLSelectElement>(panel, '#story-echo-window-unit').value = settings.recentWindow.unit;
  element<HTMLInputElement>(panel, '#story-echo-max-events').value = String(settings.recall.maxEvents);
  element<HTMLInputElement>(panel, '#story-echo-max-tokens').value = String(settings.recall.maxTokens);
  element<HTMLInputElement>(panel, '#story-echo-threshold').value = String(settings.recall.scoreThreshold);
  element<HTMLSelectElement>(panel, '#story-echo-provider').value = settings.llm.provider;
  element<HTMLInputElement>(panel, '#story-echo-auto-extract').checked = settings.extraction.automatic;
  element<HTMLInputElement>(panel, '#story-echo-base-url').value = settings.llm.custom.baseUrl;
  element<HTMLInputElement>(panel, '#story-echo-model').value = settings.llm.custom.model;
  element<HTMLInputElement>(panel, '#story-echo-allow-http').checked = settings.llm.custom.allowInsecureHttp;
  element<HTMLInputElement>(panel, '#story-echo-fallback-main').checked = settings.llm.custom.fallbackToMain;
  element<HTMLInputElement>(panel, '#story-echo-api-key').value = '';
  syncVisibility(panel, settings);
}

function bindSettings(panel: HTMLElement): void {
  element<HTMLInputElement>(panel, '#story-echo-enabled').addEventListener('change', (event) => {
    settingsRepository.update((settings) => {
      settings.enabled = (event.currentTarget as HTMLInputElement).checked;
    });
  });

  element<HTMLInputElement>(panel, '#story-echo-window-size').addEventListener('change', (event) => {
    settingsRepository.update((settings) => {
      settings.recentWindow.size = Math.max(0, Math.floor(numberValue(event.currentTarget as HTMLInputElement, 10)));
    });
  });

  element<HTMLSelectElement>(panel, '#story-echo-window-unit').addEventListener('change', (event) => {
    settingsRepository.update((settings) => {
      settings.recentWindow.unit = (event.currentTarget as HTMLSelectElement).value as WindowUnit;
    });
  });

  element<HTMLInputElement>(panel, '#story-echo-max-events').addEventListener('change', (event) => {
    settingsRepository.update((settings) => {
      settings.recall.maxEvents = Math.max(0, Math.floor(numberValue(event.currentTarget as HTMLInputElement, 5)));
    });
  });

  element<HTMLInputElement>(panel, '#story-echo-max-tokens').addEventListener('change', (event) => {
    settingsRepository.update((settings) => {
      settings.recall.maxTokens = Math.max(0, Math.floor(numberValue(event.currentTarget as HTMLInputElement, 1200)));
    });
  });

  element<HTMLInputElement>(panel, '#story-echo-threshold').addEventListener('change', (event) => {
    settingsRepository.update((settings) => {
      const value = numberValue(event.currentTarget as HTMLInputElement, 0.25);
      settings.recall.scoreThreshold = Math.min(1, Math.max(0, value));
    });
  });

  element<HTMLSelectElement>(panel, '#story-echo-provider').addEventListener('change', (event) => {
    const settings = settingsRepository.update((current) => {
      current.llm.provider = (event.currentTarget as HTMLSelectElement).value as LlmProviderId;
    });
    syncVisibility(panel, settings);
  });

  element<HTMLInputElement>(panel, '#story-echo-auto-extract').addEventListener('change', (event) => {
    settingsRepository.update((settings) => {
      settings.extraction.automatic = (event.currentTarget as HTMLInputElement).checked;
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
      const normalized = normalizeChatCompletionsUrl(value, {
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

  element<HTMLInputElement>(panel, '#story-echo-model').addEventListener('change', (event) => {
    settingsRepository.update((settings) => {
      settings.llm.custom.model = (event.currentTarget as HTMLInputElement).value.trim();
    });
  });

  element<HTMLInputElement>(panel, '#story-echo-api-key').addEventListener('change', (event) => {
    const input = event.currentTarget as HTMLInputElement;
    sessionSecretVault.setSessionKey(input.value);
    input.value = '';
    syncVisibility(panel, settingsRepository.get());
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

  element<HTMLButtonElement>(panel, '#story-echo-clear-key').addEventListener('click', () => {
    sessionSecretVault.clear();
    syncVisibility(panel, settingsRepository.get());
  });

  element<HTMLButtonElement>(panel, '#story-echo-test-llm').addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    try {
      await createLlmProvider(settingsRepository.get()).testConnection();
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
      const settings = settingsRepository.get();
      const chat = getContext().chat;
      const window = selectRecentWindow(chat, settings.recentWindow.size, settings.recentWindow.unit);
      if (!window || window.retainedStartIndex <= 0) {
        notify.info('当前没有窗口外历史需要处理。');
        return;
      }
      const target = window.retainedStartIndex - 1;
      await extractionService.processThrough(target, (progress) => {
        status.textContent = `正在处理消息 ${progress.startMessageId}～${progress.endMessageId} / ${progress.targetEndMessageId}，新增 ${progress.newMemoryCount} 条事件……`;
      });
      notify.success('窗口外历史处理完成。');
      await refreshStatus(panel);
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '历史处理失败。');
      await refreshStatus(panel);
    } finally {
      button.disabled = false;
    }
  });

  element<HTMLButtonElement>(panel, '#story-echo-refresh-status').addEventListener('click', async () => {
    await refreshStatus(panel);
  });
}

async function refreshStatus(panel: HTMLElement): Promise<void> {
  const target = element<HTMLElement>(panel, '#story-echo-status');
  try {
    const state = memoryRepository.getExisting();
    if (!state) {
      target.textContent = getCurrentChatId()
        ? '当前聊天尚未初始化StoryEcho数据。'
        : '当前没有打开聊天。';
      return;
    }

    let vectorCountText = '未读取';
    try {
      const hashes = await vectorStore.list(state.vectorCollectionId, resolveVectorConfig(settingsRepository.get()));
      vectorCountText = String(hashes.length);
    } catch (error) {
      vectorCountText = 'Vector Storage不可用';
      logger.debug('读取向量状态失败。', error);
    }

    target.textContent = [
      `剧情事件：${state.memories.length}`,
      `向量：${vectorCountText}`,
      `待同步向量：${state.pendingVectorHashes.length}`,
      `已处理到消息：${state.indexedThroughMessageId}`,
      `集合：${state.vectorCollectionId}`,
    ].join('｜');
  } catch (error) {
    target.textContent = error instanceof Error ? error.message : '读取当前聊天状态失败。';
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
  await refreshStatus(panel);
}
