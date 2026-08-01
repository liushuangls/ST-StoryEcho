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

  it('refreshes diagnostics after relevant chat and prompt events', () => {
    for (const eventName of [
      'CHAT_CHANGED',
      'MESSAGE_RECEIVED',
      'MESSAGE_SWIPED',
      'MESSAGE_DELETED',
      'GENERATION_ENDED',
      'ITEMIZED_PROMPTS_LOADED',
    ]) {
      expect(source).toContain(`['${eventName}']`);
    }
    expect(source).toContain('promptTokenStatsCard.render(panel)');
  });
});
