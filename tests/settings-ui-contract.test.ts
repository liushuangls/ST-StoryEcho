import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/ui/settings-panel.ts', import.meta.url), 'utf8');

const CONTROLS = [
  'story-echo-enabled',
  'story-echo-window-size',
  'story-echo-window-unit',
  'story-echo-summary-batch',
  'story-echo-summary-window',
  'story-echo-summary-tokens',
  'story-echo-skeleton-tokens',
  'story-echo-world-info-reference',
  'story-echo-reference-world-info',
  'story-echo-llm-provider',
  'story-echo-llm-base-url',
  'story-echo-llm-model',
  'story-echo-llm-api-key',
  'story-echo-llm-timeout',
  'story-echo-llm-http',
  'story-echo-llm-fallback',
  'story-echo-debug',
];

describe('context-only settings panel contract', () => {
  it('uses a context-focused display name', () => {
    expect(source).toContain("import { DISPLAY_NAME } from '../core/constants';");
    expect(source).toContain('<b>${DISPLAY_NAME}</b>');
    expect(source).not.toContain('StoryEcho · 剧情回响');
  });

  it('exposes exactly one product feature switch', () => {
    expect(source).toContain('启用 StoryEcho 上下文管理');
    expect(source).not.toContain('启用剧情记忆与召回');
    expect(source).not.toContain('story-echo-memory-enabled');
    expect(source).not.toContain('Embedding');
    expect(source).not.toContain('vectorStore');
  });

  it.each(CONTROLS)('hydrates and binds #%s', (controlId) => {
    const marker = `'#${controlId}'`;
    expect(source).toContain(marker);
    expect(source.slice(source.indexOf('function bindSettings('))).toContain(marker);
  });

  it('keeps world-book reference, history processing and metadata editing', () => {
    expect(source).toContain('总结时参考世界书');
    expect(source).toContain('处理窗口外历史');
    expect(source).toContain('${stageSummaryManagerTemplate()}');
    expect(source).toContain('${promptStatsCardTemplate()}');
  });

  it('keeps window, world-book and model settings collapsed by default', () => {
    expect(source).toContain(
      '<details id="story-echo-context-settings" class="story-echo-section story-echo-collapsible">',
    );
    expect(source).toContain(
      '<details id="story-echo-reference-settings" class="story-echo-section story-echo-collapsible">',
    );
    expect(source).toContain(
      '<details id="story-echo-llm-settings" class="story-echo-section story-echo-collapsible">',
    );
    expect(source).not.toContain(
      '<details id="story-echo-llm-settings" class="story-echo-section story-echo-collapsible" open>',
    );
    expect(source).toContain('窗口与总结设置');
    expect(source).toContain('世界书参考');
    expect(source).toContain('阶段总结与骨架模型');
  });

  it('places derived context management immediately after model settings', () => {
    const modelEnd = source.indexOf('</details>', source.indexOf('id="story-echo-llm-settings"'));
    const summaryStart = source.indexOf(
      '<details id="story-echo-summary-settings"',
      modelEnd,
    );
    const nextSection = source.slice(modelEnd + '</details>'.length).trimStart();

    expect(modelEnd).toBeGreaterThanOrEqual(0);
    expect(summaryStart).toBeGreaterThan(modelEnd);
    expect(nextSection).toMatch(/^<details id="story-echo-summary-settings"/);
  });

  it('refreshes diagnostics after relevant chat and prompt events', () => {
    for (const eventName of [
      'CHAT_CHANGED',
      'MESSAGE_RECEIVED',
      'MESSAGE_SWIPED',
      'MESSAGE_DELETED',
      'MESSAGE_SWIPE_DELETED',
      'GENERATION_STOPPED',
      'GENERATION_ENDED',
      'ITEMIZED_PROMPTS_LOADED',
      'ITEMIZED_PROMPTS_SAVED',
      'ITEMIZED_PROMPTS_DELETED',
    ]) {
      expect(source).toContain(`['${eventName}']`);
    }
    expect(source).toContain('promptTokenStatsCard.render(panel)');
  });

  it('refreshes prompt stats after the host drawer becomes visible again', () => {
    expect(source).toContain('function observePanelVisibility(');
    expect(source).toContain('observeElementVisibility(body, () => requestRefresh(panel))');
    expect(source).toContain('visibilityObserver?.disconnect()');
  });

  it('locks the panel height before derived context expands', () => {
    expect(source).toContain('function bindSummaryLayoutLock(');
    expect(source).toContain("subscriptions.listen(summary, 'click'");
    expect(source).toContain("'--story-echo-summary-layout-height'");
  });
});
