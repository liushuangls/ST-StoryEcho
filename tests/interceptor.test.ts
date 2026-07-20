import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODULE_ID } from '../src/core/constants';
import type { StoryEchoSettings, TavernChatMessage } from '../src/core/types';
import { storyEchoGenerateInterceptor } from '../src/prompt/interceptor';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { storyEchoTaskCoordinator } from '../src/runtime/task-coordinator';
import { resolveVectorConfig, vectorConfigFingerprint } from '../src/vector/config';
import { chatState, memory } from './fixtures';

function sectionedSummary(value: string): string {
  return `【已确认剧情】\n${value}\n【当前状态】\n无\n【未解决线索】\n无\n【角色主张与推测】\n无\n【已失效或否定事实】\n无`;
}

afterEach(() => {
  storyEchoTaskCoordinator.resetForTests();
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
    entries: options.summaryCoveredThrough === undefined || options.summaryCoveredThrough < 0
      ? []
      : [{
          text: sectionedSummary('较早时，林雨开始保管银色钥匙。'),
          sourceStartMessageId: 0,
          sourceEndMessageId: options.summaryCoveredThrough,
          sourceHash: 'summary-source',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }],
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

  it('places evolved current-state corrections after summaries and before recent raw', async () => {
    const { context } = await installContext({ withMemory: true, summaryCoveredThrough: 2 });
    const stored = context.chatMetadata[MODULE_ID];
    const current = stored.memories[0]!;
    current.sourceHistory = [
      { startMessageId: 0, endMessageId: 0, sourceHash: 'older-state' },
      current.source,
    ];
    const promptChat = structuredClone(sourceChat);

    await storyEchoGenerateInterceptor(promptChat, 32_000, () => undefined, 'normal');

    expect(promptChat.map((message) => message.extra?.['story_echo_injection_kind'] ?? message.mes))
      .toEqual([
        'summary',
        'state',
        '我们去院中喝水。',
        '院中很安静。',
        'recall',
        '银色钥匙现在由谁保管？',
      ]);
    expect(promptChat[1]?.mes).toContain('<story_echo_current_state>');
    expect(context.chat).toEqual(sourceChat);
  });

  it('skips query rewrite and recall injection when the recall limit is zero', async () => {
    const { context, settings } = await installContext({
      withMemory: true,
      summaryCoveredThrough: 2,
    });
    settings.recall.maxEvents = 0;
    settings.recall.queryMode = 'llm';
    const promptChat = structuredClone(sourceChat);

    await storyEchoGenerateInterceptor(promptChat, 32_000, () => undefined, 'normal');

    expect(context.generateRaw).not.toHaveBeenCalled();
    expect(promptChat.some(
      (message) => message.extra?.['story_echo_injection_kind'] === 'recall',
    )).toBe(false);
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

  it('keeps raw history and skips extraction until the configured batch has accumulated', async () => {
    const { context, settings, state } = await installContext({
      withMemory: false,
      summaryCoveredThrough: -1,
    });
    settings.extraction.automatic = true;
    settings.extraction.targetTurnsPerChunk = 5;
    settings.summary.enabled = false;
    state.indexedThroughMessageId = -1;
    state.indexedThroughHash = '';
    state.indexedPrefixHash = '';
    const promptChat = structuredClone(sourceChat);

    await storyEchoGenerateInterceptor(promptChat, 32_000, () => undefined, 'normal');

    expect(context.generateRaw).not.toHaveBeenCalled();
    expect(context.chatMetadata[MODULE_ID].indexedThroughMessageId).toBe(-1);
    expect(promptChat).toEqual(sourceChat);
  });

  it('never runs a full eligible extraction or summary batch in foreground prompt preparation', async () => {
    const { context, settings, state } = await installContext({
      withMemory: false,
      summaryCoveredThrough: -1,
    });
    settings.extraction.automatic = true;
    settings.extraction.targetTurnsPerChunk = 1;
    settings.summary.enabled = true;
    settings.summary.automatic = true;
    settings.summary.targetTurnsPerUpdate = 1;
    state.indexedThroughMessageId = -1;
    state.indexedThroughHash = '';
    state.indexedPrefixHash = '';
    const promptChat = structuredClone(sourceChat);

    await storyEchoGenerateInterceptor(promptChat, 32_000, () => undefined, 'normal');

    expect(context.generateRaw).not.toHaveBeenCalled();
    expect(context.chatMetadata[MODULE_ID].indexedThroughMessageId).toBe(-1);
    expect(context.chatMetadata[MODULE_ID].stageSummary.coveredThroughMessageId).toBe(-1);
    expect(promptChat).toEqual(sourceChat);
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

  it('injects only the latest S independent summaries in chronological order', async () => {
    const { context, settings } = await installContext({
      withMemory: false,
      summaryCoveredThrough: 2,
    });
    settings.summary.windowSize = 2;
    const stored = context.chatMetadata[MODULE_ID];
    stored.stageSummary = {
      entries: [
        {
          text: sectionedSummary('第一阶段'),
          sourceStartMessageId: 0,
          sourceEndMessageId: 0,
          sourceHash: 'summary-1',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          text: sectionedSummary('第二阶段'),
          sourceStartMessageId: 1,
          sourceEndMessageId: 1,
          sourceHash: 'summary-2',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
        {
          text: sectionedSummary('第三阶段'),
          sourceStartMessageId: 2,
          sourceEndMessageId: 2,
          sourceHash: 'summary-3',
          updatedAt: '2026-01-03T00:00:00.000Z',
        },
      ],
      coveredThroughMessageId: 2,
      coveredThroughHash: 'summary-3',
      updatedAt: '2026-01-03T00:00:00.000Z',
    };
    const promptChat = structuredClone(sourceChat);

    await storyEchoGenerateInterceptor(promptChat, 32_000, () => undefined, 'normal');

    const summaries = promptChat.filter(
      (message) => message.extra?.['story_echo_injection_kind'] === 'summary',
    );
    expect(summaries).toHaveLength(2);
    expect(summaries[0]?.mes).toContain('第二阶段');
    expect(summaries[1]?.mes).toContain('第三阶段');
    expect(summaries.map((message) => message.mes)).not.toContain(expect.stringContaining('第一阶段'));
  });

  it('excludes inferred memories and summary hypotheses from strict fact verification', async () => {
    const { context } = await installContext({ withMemory: true, summaryCoveredThrough: 2 });
    const stored = context.chatMetadata[MODULE_ID];
    stored.memories[0]!.truthStatus = 'inferred';
    stored.stageSummary.entries[0]!.text = [
      '【已确认剧情】',
      '众人在院中喝水。',
      '【当前状态】',
      '无',
      '【未解决线索】',
      '无',
      '【角色主张与推测】',
      '福尔摩斯猜测托马斯持有银色钥匙。',
      '【已失效或否定事实】',
      '无',
    ].join('\n');
    const promptChat = structuredClone(sourceChat);

    await storyEchoGenerateInterceptor(promptChat, 32_000, () => undefined, 'normal');

    expect(promptChat.some(
      (message) => message.extra?.['story_echo_injection_kind'] === 'recall',
    )).toBe(false);
    const injected = promptChat.map((message) => message.mes).join('\n');
    expect(injected).not.toContain('托马斯');
    expect(context.chatMetadata[MODULE_ID].lastInspection?.candidateMemoryIds).toEqual([]);
  });

  it('omits summaries from before an explicit story-phase boundary during ordinary continuation', async () => {
    const { context } = await installContext({ withMemory: false, summaryCoveredThrough: 2 });
    context.chat[3] = { is_user: true, mes: '上一段剧情已经结束，接下来进入全新的雪原篇章。' };
    context.chat[4] = { is_user: false, mes: '雪原篇章里只有一双蓝手套。' };
    context.chat[5] = { is_user: true, mes: '我们继续向雪原深处前进。' };
    const promptChat = structuredClone(context.chat);

    await storyEchoGenerateInterceptor(promptChat, 32_000, () => undefined, 'normal');

    expect(promptChat.some(
      (message) => message.extra?.['story_echo_injection_kind'] === 'summary',
    )).toBe(false);
    expect(promptChat.map((message) => message.mes).join('\n')).not.toContain('林雨开始保管银色钥匙');
    expect(promptChat.map((message) => message.mes)).toEqual([
      '上一段剧情已经结束，接下来进入全新的雪原篇章。',
      '雪原篇章里只有一双蓝手套。',
      '我们继续向雪原深处前进。',
    ]);
  });

  it('restores earlier summaries when the User explicitly asks to review an earlier phase', async () => {
    const { context } = await installContext({ withMemory: false, summaryCoveredThrough: 2 });
    context.chat[3] = { is_user: true, mes: '上一段剧情已经结束，接下来进入全新的雪原篇章。' };
    context.chat[4] = { is_user: false, mes: '雪原篇章里只有一双蓝手套。' };
    context.chat[5] = { is_user: true, mes: '回顾上一段剧情发生的事情。' };
    const promptChat = structuredClone(context.chat);

    await storyEchoGenerateInterceptor(promptChat, 32_000, () => undefined, 'normal');

    const summaries = promptChat.filter(
      (message) => message.extra?.['story_echo_injection_kind'] === 'summary',
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.mes).toContain('林雨开始保管银色钥匙');
  });

  it('does not perform pending vector writes in foreground prompt preparation', async () => {
    const { context, settings, state } = await installContext({
      withMemory: true,
      summaryCoveredThrough: 2,
    });
    settings.recall.maxEvents = 0;
    state.pendingVectorHashes = [123];
    const promptChat = structuredClone(sourceChat);
    const fetchMock = vi.mocked(globalThis.fetch);

    await storyEchoGenerateInterceptor(promptChat, 32_000, () => undefined, 'normal');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(context.chatMetadata[MODULE_ID].pendingVectorHashes).toEqual([123]);
    expect(context.chatMetadata[MODULE_ID].lastInspection?.warnings).toContain(
      '部分剧情记忆尚未完成向量化，将使用可用索引和关键词召回。',
    );
  });

  it('invalidates a changed branch locally without purging vectors in foreground', async () => {
    const { context, state } = await installContext({
      withMemory: true,
      summaryCoveredThrough: 2,
    });
    state.indexedPrefixHash = 'hash-from-a-different-branch';
    const promptChat = structuredClone(sourceChat);
    const fetchMock = vi.mocked(globalThis.fetch);

    await storyEchoGenerateInterceptor(promptChat, 32_000, () => undefined, 'normal');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(context.chatMetadata[MODULE_ID].memories).toEqual([]);
    expect(context.chatMetadata[MODULE_ID].pendingVectorDeleteHashes).toEqual([123]);
    expect(promptChat).toEqual(sourceChat);
  });

  it('isolates an unsupported legacy name from recall, disambiguation, and current-state injection', async () => {
    const { context } = await installContext({ withMemory: true, summaryCoveredThrough: 2 });
    const stored = context.chatMetadata[MODULE_ID];
    const source = { startMessageId: 3, endMessageId: 4, sourceHash: 'phantom-source' };
    stored.memories = [memory({
      source,
      sourceMessageIds: [3, 4],
      sourceHistory: [
        { startMessageId: 1, endMessageId: 2, sourceHash: 'older-phantom' },
        source,
      ],
      event: '托马斯转移到钟楼。',
      entities: ['托马斯'],
      aliases: [],
      scene: { participants: ['托马斯'] },
      stateChanges: [{ entity: '托马斯', attribute: '位置', after: '钟楼' }],
      knownBy: ['托马斯'],
      retrievalText: '托马斯当前位于钟楼。',
      injectionText: '托马斯当前位于钟楼。',
      truthStatus: 'confirmed',
    })];
    const promptChat = structuredClone(sourceChat);

    await storyEchoGenerateInterceptor(promptChat, 32_000, () => undefined, 'normal');

    const injected = promptChat.map((message) => message.mes).join('\n');
    expect(injected).not.toContain('托马斯');
    expect(promptChat.some(
      (message) => message.extra?.['story_echo_injection_kind'] === 'recall',
    )).toBe(false);
    expect(promptChat.some(
      (message) => message.extra?.['story_echo_injection_kind'] === 'state',
    )).toBe(false);
    expect(context.chatMetadata[MODULE_ID].debugTraces.some(
      (trace) => trace.message.includes('已隔离缺少源楼层证据的旧版记忆'),
    )).toBe(true);
  });
});
