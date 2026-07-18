import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODULE_ID } from '../src/core/constants';
import type { StoryEchoSettings, TavernChatMessage } from '../src/core/types';
import { storyEchoGenerateInterceptor } from '../src/prompt/interceptor';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { resolveVectorConfig, vectorConfigFingerprint } from '../src/vector/config';
import { chatState, memory } from './fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
});

const sourceChat: TavernChatMessage[] = [
  { is_user: false, mes: 'greeting' },
  { is_user: true, mes: '银色钥匙交给林雨保管。' },
  { is_user: false, mes: '林雨收好了银色钥匙。' },
  { is_user: true, mes: '我们去院中喝水。' },
  { is_user: false, mes: '院中很安静。' },
  { is_user: true, mes: '银色钥匙现在由谁保管？' },
];

async function installContext(options: {
  settings?: Partial<StoryEchoSettings>;
  withMemory?: boolean;
  summaryCoveredThrough?: number;
}) {
  const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
  settings.enabled = true;
  settings.debug = true;
  settings.recentWindow = { size: 1, unit: 'turns' };
  settings.extraction.automatic = false;
  settings.summary.automatic = false;
  settings.recall.queryMode = 'local';
  settings.recall.maxEvents = options.withMemory ? 1 : 0;
  Object.assign(settings, options.settings ?? {});

  const state = chatState(options.withMemory ? [memory()] : []);
  state.ownerChatId = 'chat-id';
  state.indexedThroughMessageId = 2;
  state.stageSummary = {
    text: options.summaryCoveredThrough === undefined || options.summaryCoveredThrough < 0
      ? ''
      : '较早时，林雨开始保管银色钥匙。',
    coveredThroughMessageId: options.summaryCoveredThrough ?? 2,
    coveredThroughHash: options.summaryCoveredThrough === undefined || options.summaryCoveredThrough < 0
      ? ''
      : 'summary-source',
  };
  const context = {
    chat: structuredClone(sourceChat),
    chatId: 'chat-id',
    extensionSettings: {
      story_echo: settings,
      vectors: { source: 'transformers' },
    },
    chatMetadata: { [MODULE_ID]: state },
    saveSettingsDebounced: vi.fn(),
    saveMetadata: vi.fn(async () => undefined),
    generateRaw: vi.fn(async () => ''),
    getCurrentChatId: () => 'chat-id',
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
  };
  vi.stubGlobal('SillyTavern', { getContext: () => context });
  state.vectorFingerprint = await vectorConfigFingerprint(resolveVectorConfig(settings));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    metadata: options.withMemory
      ? [{ hash: 123, text: '银色钥匙由林雨保管', index: 2 }]
      : [],
  }), { status: 200 })));
  return { context, settings, state };
}

describe('StoryEcho request ordering', () => {
  it('injects summary before recent raw and recall immediately before the unchanged current User', async () => {
    const { context } = await installContext({ withMemory: true, summaryCoveredThrough: 2 });
    const promptChat = structuredClone(sourceChat);
    const currentInput = promptChat.at(-1)!;
    const originalText = currentInput.mes;

    await storyEchoGenerateInterceptor(promptChat, 32_000, () => undefined, 'normal');

    expect(promptChat.map((message) => message.extra?.['story_echo_injection_kind'] ?? message.mes))
      .toEqual([
        'summary',
        '我们去院中喝水。',
        '院中很安静。',
        'recall',
        '银色钥匙现在由谁保管？',
      ]);
    const summary = promptChat[0]!;
    const recall = promptChat[3]!;
    expect(summary).toMatchObject({
      is_system: true,
      extra: { type: 'narrator', story_echo_injection_kind: 'summary' },
    });
    expect(recall).toMatchObject({
      is_system: true,
      extra: { type: 'narrator', story_echo_injection_kind: 'recall' },
    });
    expect(recall.mes).toContain('<story_echo_recall>');
    expect(promptChat.at(-1)).toBe(currentInput);
    expect(currentInput.mes).toBe(originalText);

    // Only the request copy is changed. Persistent chat and JSONL-bound data
    // never receive StoryEcho's injected messages.
    expect(context.chat).toEqual(sourceChat);
  });

  it('keeps every unsummarized message when the summary cursor is behind', async () => {
    const { context } = await installContext({ withMemory: false, summaryCoveredThrough: -1 });
    const promptChat = structuredClone(sourceChat);

    await storyEchoGenerateInterceptor(promptChat, 32_000, () => undefined, 'normal');

    expect(promptChat).toEqual(sourceChat);
    const stored = context.chatMetadata[MODULE_ID];
    expect(stored.lastInspection?.removedMessageCount).toBe(0);
    expect(stored.metrics.generationsDeferred).toBe(1);
  });

  it('trims only the covered prefix and keeps unsummarized raw beyond the minimum window', async () => {
    const { context } = await installContext({ withMemory: false, summaryCoveredThrough: 0 });
    const promptChat = structuredClone(sourceChat);

    await storyEchoGenerateInterceptor(promptChat, 32_000, () => undefined, 'normal');

    expect(promptChat.map((message) => message.extra?.['story_echo_injection_kind'] ?? message.mes))
      .toEqual([
        'summary',
        '银色钥匙交给林雨保管。',
        '林雨收好了银色钥匙。',
        '我们去院中喝水。',
        '院中很安静。',
        '银色钥匙现在由谁保管？',
      ]);
    const stored = context.chatMetadata[MODULE_ID];
    expect(stored.lastInspection?.removedMessageCount).toBe(1);
    expect(stored.metrics.generationsTrimmed).toBe(1);
  });
});
