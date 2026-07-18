import { logger } from '../core/logger';
import type {
  LlmProviderId,
  RetrievalQueryMode,
  StoryEchoSettings,
  VectorSourceMode,
  WindowUnit,
} from '../core/types';
import { DIAGNOSTICS_UPDATED_EVENT } from '../debug/events';
import { resetDiagnostics } from '../debug/metrics';
import { buildDebugReport } from '../debug/report';
import { extractionService } from '../extraction/service';
import { createLlmProvider } from '../llm/provider-factory';
import { embeddingSecretVault, sessionSecretVault } from '../llm/secret-vault';
import { normalizeChatCompletionsUrl } from '../llm/url';
import { MemoryRepository } from '../memory/repository';
import { getContext, getCurrentChatId } from '../platform/sillytavern';
import { selectRecentWindow } from '../prompt/window';
import { SettingsRepository } from '../settings/repository';
import { resolveVectorConfig } from '../vector/config';
import { openAiCompatibleEmbeddingClient } from '../vector/openai-compatible-embedding';
import { SillyTavernVectorStore } from '../vector/sillytavern-vector-store';
import { normalizeEmbeddingsUrl } from '../vector/url';
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
      <div class="inline-drawer-content story-echo-panel-body">
        <label class="checkbox_label story-echo-inline">
          <input id="story-echo-enabled" type="checkbox">
          <span>启用滑动窗口与历史剧情召回</span>
        </label>

        <div class="story-echo-grid story-echo-section">
          <div class="story-echo-section-title story-echo-field-wide">
            <i class="fa-solid fa-sliders" aria-hidden="true"></i>
            <span>上下文与召回</span>
          </div>
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
            <span>检索查询构造</span>
            <select id="story-echo-query-mode" class="text_pole">
              <option value="llm">LLM上下文改写（推荐）</option>
              <option value="local">本地快速规则</option>
            </select>
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
          <label class="checkbox_label story-echo-inline story-echo-field-wide">
            <input id="story-echo-debug" type="checkbox">
            <span>调试模式（保留最近50条运行轨迹）</span>
          </label>
          <p class="story-echo-hint story-echo-field-wide">
            LLM改写会在每次需要召回时先生成一句检索查询；失败时自动回退本地双路查询。
          </p>
        </div>

        <div id="story-echo-custom-provider" class="story-echo-grid story-echo-subsection">
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
          <div class="story-echo-field-wide story-echo-key-row">
            <span id="story-echo-key-status" class="story-echo-secret-empty">API Key未加载</span>
            <button id="story-echo-clear-key" class="menu_button" type="button">清除Key</button>
          </div>
        </div>

        <div class="story-echo-grid story-echo-section">
          <div class="story-echo-section-title story-echo-field-wide">
            <i class="fa-solid fa-database" aria-hidden="true"></i>
            <span>Embedding 与 Vector Storage</span>
          </div>
          <label class="story-echo-field story-echo-field-wide">
            <span>Embedding来源</span>
            <select id="story-echo-vector-source" class="text_pole">
              <option value="inherit">酒馆Vector Storage当前向量源（默认）</option>
              <option value="openai-compatible">自定义OpenAI兼容接口（支持火山方舟）</option>
            </select>
          </label>
          <p class="story-echo-hint story-echo-field-wide">
            自定义模式只替换向量生成器；向量仍由酒馆Vector Storage保存并在服务端检索。
          </p>
        </div>

        <div id="story-echo-custom-embedding" class="story-echo-grid story-echo-subsection">
          <label class="story-echo-field story-echo-field-wide">
            <span>Embedding Base URL</span>
            <input id="story-echo-embedding-base-url" class="text_pole" type="url" maxlength="2048" placeholder="https://ark.cn-beijing.volces.com/api/v3">
          </label>
          <label class="story-echo-field story-echo-field-wide">
            <span>Embedding模型或Endpoint ID</span>
            <input id="story-echo-embedding-model" class="text_pole" type="text" maxlength="200" placeholder="doubao-embedding-text-… 或 ep-…">
          </label>
          <label class="story-echo-field story-echo-field-wide">
            <span>Embedding API Key（仅当前页面内存）</span>
            <input id="story-echo-embedding-api-key" class="text_pole" type="password" autocomplete="off" placeholder="刷新后需要重新输入">
          </label>
          <label class="checkbox_label story-echo-inline story-echo-field-wide">
            <input id="story-echo-embedding-allow-http" type="checkbox">
            <span>允许不安全HTTP（仅建议局域网）</span>
          </label>
          <div class="story-echo-field-wide story-echo-key-row">
            <span id="story-echo-embedding-key-status" class="story-echo-secret-empty">Embedding Key未加载</span>
            <div class="story-echo-key-actions">
              <button id="story-echo-test-embedding" class="menu_button" type="button">
                <i class="fa-solid fa-vial" aria-hidden="true"></i><span>测试Embedding</span>
              </button>
              <button id="story-echo-clear-embedding-key" class="menu_button" type="button">
                <i class="fa-solid fa-key" aria-hidden="true"></i><span>清除Key</span>
              </button>
            </div>
          </div>
          <p class="story-echo-hint story-echo-field-wide">
            优先直连接口；若目标不允许浏览器跨域，会自动回退酒馆CORS代理。火山方舟可直接使用。
          </p>
        </div>

        <div class="story-echo-actions" role="group" aria-label="StoryEcho操作">
          <button id="story-echo-test-llm" class="menu_button story-echo-action-primary" type="button">
            <i class="fa-solid fa-plug" aria-hidden="true"></i><span>测试LLM连接</span>
          </button>
          <button id="story-echo-process-history" class="menu_button story-echo-action-primary" type="button">
            <i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i><span>处理窗口外历史</span>
          </button>
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

        <p class="story-echo-hint">
          LLM与Embedding自定义Key都不会保存到扩展设置；刷新页面后需要重新输入。
        </p>
        <div id="story-echo-status" class="story-echo-status">正在读取当前聊天状态……</div>
        <details class="story-echo-diagnostics" open>
          <summary>测试统计</summary>
          <pre id="story-echo-stats">尚无统计数据。</pre>
        </details>
        <details class="story-echo-diagnostics">
          <summary>最近一次上下文检查</summary>
          <pre id="story-echo-inspection">尚无生成记录。</pre>
        </details>
        <details class="story-echo-diagnostics">
          <summary>最近调试轨迹</summary>
          <pre id="story-echo-traces">调试模式关闭或尚无轨迹。</pre>
        </details>
        <p class="story-echo-hint">调试报告不包含API Key，但会包含检索查询和被召回的剧情文本。</p>
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

  const customEmbedding = element<HTMLElement>(panel, '#story-echo-custom-embedding');
  customEmbedding.hidden = settings.vector.source !== 'openai-compatible';

  const keyStatus = element<HTMLElement>(panel, '#story-echo-key-status');
  keyStatus.textContent = sessionSecretVault.hasSessionKey() ? 'API Key已加载到当前页面' : 'API Key未加载';
  keyStatus.classList.toggle('story-echo-secret-loaded', sessionSecretVault.hasSessionKey());
  keyStatus.classList.toggle('story-echo-secret-empty', !sessionSecretVault.hasSessionKey());

  const embeddingKeyStatus = element<HTMLElement>(panel, '#story-echo-embedding-key-status');
  embeddingKeyStatus.textContent = embeddingSecretVault.hasSessionKey()
    ? 'Embedding Key已加载到当前页面'
    : 'Embedding Key未加载';
  embeddingKeyStatus.classList.toggle('story-echo-secret-loaded', embeddingSecretVault.hasSessionKey());
  embeddingKeyStatus.classList.toggle('story-echo-secret-empty', !embeddingSecretVault.hasSessionKey());
}

function syncForm(panel: HTMLElement, settings: StoryEchoSettings): void {
  element<HTMLInputElement>(panel, '#story-echo-enabled').checked = settings.enabled;
  element<HTMLInputElement>(panel, '#story-echo-window-size').value = String(settings.recentWindow.size);
  element<HTMLSelectElement>(panel, '#story-echo-window-unit').value = settings.recentWindow.unit;
  element<HTMLInputElement>(panel, '#story-echo-max-events').value = String(settings.recall.maxEvents);
  element<HTMLInputElement>(panel, '#story-echo-max-tokens').value = String(settings.recall.maxTokens);
  element<HTMLInputElement>(panel, '#story-echo-threshold').value = String(settings.recall.scoreThreshold);
  element<HTMLSelectElement>(panel, '#story-echo-query-mode').value = settings.recall.queryMode;
  element<HTMLSelectElement>(panel, '#story-echo-provider').value = settings.llm.provider;
  element<HTMLInputElement>(panel, '#story-echo-auto-extract').checked = settings.extraction.automatic;
  element<HTMLInputElement>(panel, '#story-echo-debug').checked = settings.debug;
  element<HTMLInputElement>(panel, '#story-echo-base-url').value = settings.llm.custom.baseUrl;
  element<HTMLInputElement>(panel, '#story-echo-model').value = settings.llm.custom.model;
  element<HTMLInputElement>(panel, '#story-echo-allow-http').checked = settings.llm.custom.allowInsecureHttp;
  element<HTMLInputElement>(panel, '#story-echo-fallback-main').checked = settings.llm.custom.fallbackToMain;
  element<HTMLInputElement>(panel, '#story-echo-api-key').value = '';
  element<HTMLSelectElement>(panel, '#story-echo-vector-source').value = settings.vector.source;
  element<HTMLInputElement>(panel, '#story-echo-embedding-base-url').value = settings.vector.custom.baseUrl;
  element<HTMLInputElement>(panel, '#story-echo-embedding-model').value = settings.vector.custom.model;
  element<HTMLInputElement>(panel, '#story-echo-embedding-allow-http').checked =
    settings.vector.custom.allowInsecureHttp;
  element<HTMLInputElement>(panel, '#story-echo-embedding-api-key').value = '';
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

  element<HTMLInputElement>(panel, '#story-echo-auto-extract').addEventListener('change', (event) => {
    settingsRepository.update((settings) => {
      settings.extraction.automatic = (event.currentTarget as HTMLInputElement).checked;
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

  element<HTMLSelectElement>(panel, '#story-echo-vector-source').addEventListener('change', (event) => {
    const settings = settingsRepository.update((current) => {
      current.vector.source = (event.currentTarget as HTMLSelectElement).value as VectorSourceMode;
    });
    syncVisibility(panel, settings);
    void refreshStatus(panel);
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

  element<HTMLInputElement>(panel, '#story-echo-embedding-model').addEventListener('change', (event) => {
    settingsRepository.update((settings) => {
      settings.vector.custom.model = (event.currentTarget as HTMLInputElement).value.trim();
    });
  });

  element<HTMLInputElement>(panel, '#story-echo-embedding-api-key').addEventListener('change', (event) => {
    const input = event.currentTarget as HTMLInputElement;
    embeddingSecretVault.setSessionKey(input.value);
    input.value = '';
    syncVisibility(panel, settingsRepository.get());
  });

  element<HTMLInputElement>(panel, '#story-echo-embedding-allow-http').addEventListener('change', (event) => {
    settingsRepository.update((settings) => {
      settings.vector.custom.allowInsecureHttp = (event.currentTarget as HTMLInputElement).checked;
    });
  });

  element<HTMLButtonElement>(panel, '#story-echo-clear-embedding-key').addEventListener('click', () => {
    embeddingSecretVault.clear();
    syncVisibility(panel, settingsRepository.get());
  });

  element<HTMLButtonElement>(panel, '#story-echo-test-embedding').addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    try {
      const config = resolveVectorConfig(settingsRepository.get());
      if (!config.precomputed) {
        throw new Error('请先选择自定义OpenAI兼容Embedding。');
      }
      const vectors = await openAiCompatibleEmbeddingClient.embed({
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
        status.textContent = `正在处理消息 ${progress.startMessageId}～${progress.endMessageId} / ${progress.targetEndMessageId}，新增 ${progress.newMemoryCount} 条、更新 ${progress.changedMemoryCount} 条事件……`;
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

  element<HTMLButtonElement>(panel, '#story-echo-copy-debug').addEventListener('click', async () => {
    const state = memoryRepository.getExisting();
    if (!state) {
      notify.info('当前聊天还没有StoryEcho调试数据。');
      return;
    }
    let vectorCount: number | string = 'unavailable';
    try {
      vectorCount = (await vectorStore.list(
        state.vectorCollectionId,
        resolveVectorConfig(settingsRepository.get()),
      )).length;
    } catch {
      // The report still has useful local diagnostics when Vector Storage is unavailable.
    }
    try {
      await copyText(buildDebugReport(state, settingsRepository.get(), vectorCount));
      notify.success('调试报告已复制。');
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '复制调试报告失败。');
    }
  });

  element<HTMLButtonElement>(panel, '#story-echo-reset-stats').addEventListener('click', async () => {
    const state = memoryRepository.getExisting();
    if (!state) {
      notify.info('当前聊天还没有统计数据。');
      return;
    }
    if (!globalThis.confirm('重置当前聊天的StoryEcho统计、调试轨迹和最近检查记录？')) {
      return;
    }
    resetDiagnostics(state);
    await memoryRepository.save(state);
    await refreshStatus(panel);
    notify.success('当前聊天统计已重置。');
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
  return [
    `记忆：active ${statusCount('active')} / resolved ${statusCount('resolved')} / superseded ${statusCount('superseded')} / invalid ${statusCount('invalid')}`,
    `抽取：${metrics.extractionChunks}块，${metrics.candidatesExtracted}候选，失败${metrics.extractionFailures}次，平均${averageExtraction}ms/块`,
    `整理：调用${metrics.consolidationCalls}次，失败回退${metrics.consolidationFailures}次，平均${averageConsolidation}ms`,
    `查询改写：请求${metrics.queryRewriteRequests}次，缓存命中${metrics.queryRewriteCacheHits}次，失败回退${metrics.queryRewriteFailures}次，平均${averageQueryRewrite}ms`,
    `动作：CREATE ${metrics.actions.CREATE} / MERGE ${metrics.actions.MERGE} / UPDATE ${metrics.actions.UPDATE} / RESOLVE ${metrics.actions.RESOLVE} / SUPERSEDE ${metrics.actions.SUPERSEDE} / IGNORE ${metrics.actions.IGNORE}`,
    `向量：查询${metrics.vectorQueries}次，查询失败${metrics.vectorQueryFailures}次，同步失败${metrics.vectorSyncFailures}次，写入${metrics.vectorItemsInserted}，删除${metrics.vectorItemsDeleted}，重建${metrics.vectorRebuilds}次`,
    `上下文：尝试${metrics.generationAttempts}次，裁剪${metrics.generationsTrimmed}次，延迟裁剪${metrics.generationsDeferred}次，移除${metrics.messagesRemoved}条原文，注入${metrics.memoriesInjected}条记忆`,
    `估算Token：移除${metrics.estimatedRemovedTokens}，注入${metrics.estimatedInjectedTokens}，累计净节省${estimatedNetSaved}`,
    `最近：抽取 ${metrics.lastExtractionAt ?? '无'} / 生成 ${metrics.lastGenerationAt ?? '无'}`,
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
    .map((memory) => `- [${memory.lastOperation}/${memory.status}] ${memory.injectionText}`);
  return [
    `时间：${inspection.createdAt}`,
    `耗时：${inspection.durationMs}ms`,
    `保留范围：${inspection.retainedStartIndex}～${inspection.retainedEndIndex}`,
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

async function refreshStatus(panel: HTMLElement): Promise<void> {
  const target = element<HTMLElement>(panel, '#story-echo-status');
  const stats = element<HTMLElement>(panel, '#story-echo-stats');
  const inspection = element<HTMLElement>(panel, '#story-echo-inspection');
  const traces = element<HTMLElement>(panel, '#story-echo-traces');
  try {
    const state = memoryRepository.getExisting();
    if (!state) {
      target.textContent = getCurrentChatId()
        ? '当前聊天尚未初始化StoryEcho数据。'
        : '当前没有打开聊天。';
      stats.textContent = '尚无统计数据。';
      inspection.textContent = '尚无生成记录。';
      traces.textContent = '调试模式关闭或尚无轨迹。';
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
      `待删除向量：${state.pendingVectorDeleteHashes.length}`,
      `已处理到消息：${state.indexedThroughMessageId}`,
      `集合：${state.vectorCollectionId}`,
    ].join('｜');
    stats.textContent = statsText(state);
    inspection.textContent = inspectionText(state);
    traces.textContent = tracesText(state);
  } catch (error) {
    const message = error instanceof Error ? error.message : '读取当前聊天状态失败。';
    target.textContent = message;
    stats.textContent = `读取失败：${message}`;
    inspection.textContent = '读取失败。';
    traces.textContent = '读取失败。';
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
  globalThis.addEventListener(DIAGNOSTICS_UPDATED_EVENT, () => {
    void refreshStatus(panel);
  });
  await refreshStatus(panel);
}
