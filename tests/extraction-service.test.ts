import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExtractionService } from '../src/extraction/service';
import { chatState, memory } from './fixtures';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { resolveVectorConfig, vectorConfigFingerprint } from '../src/vector/config';
import { MODULE_ID } from '../src/core/constants';
import { MemoryRepository } from '../src/memory/repository';
import type { StoryEchoSettings } from '../src/core/types';

describe('ExtractionService vector synchronization', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not enumerate the complete vector collection when nothing is pending', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
    const saveMetadata = vi.fn(async () => undefined);
    const context = {
      chat: [],
      chatId: 'chat-id',
      extensionSettings: {
        story_echo: settings,
        vectors: { source: 'transformers' },
      },
      chatMetadata: {},
      saveSettingsDebounced: vi.fn(),
      saveMetadata,
      generateRaw: vi.fn(async () => ''),
      getCurrentChatId: () => 'chat-id',
      getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    };
    vi.stubGlobal('SillyTavern', { getContext: () => context });
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    const state = chatState([memory()]);
    state.ownerChatId = 'chat-id';
    state.pendingVectorHashes = [];
    state.pendingVectorDeleteHashes = [];
    state.vectorFingerprint = await vectorConfigFingerprint(resolveVectorConfig(settings));

    await expect(new ExtractionService().syncPendingVectors(state)).resolves.toBe(state);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saveMetadata).not.toHaveBeenCalled();
  });

  it('allows a complete structured response for fact-dense five-turn chunks', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
    const state = chatState([]);
    state.indexedThroughMessageId = -1;
    state.indexedThroughHash = '';
    const generateRaw = vi.fn(async (_options: unknown) => '{"memories":[]}');
    const fiveTurns = Array.from({ length: 5 }, (_, index) => [
      { is_user: true, mes: `第${index + 1}轮用户剧情` },
      { is_user: false, mes: `第${index + 1}轮AI剧情` },
    ]).flat();
    const context = {
      chat: fiveTurns,
      chatId: 'chat-id',
      extensionSettings: {
        story_echo: settings,
        vectors: { source: 'transformers' },
      },
      chatMetadata: { [MODULE_ID]: state },
      saveSettingsDebounced: vi.fn(),
      saveMetadata: vi.fn(async () => undefined),
      generateRaw,
      getCurrentChatId: () => 'chat-id',
      getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
      getCharacterCardFields: () => ({
        description: '顾青是熟悉机关的侦探。',
        system: '不得进入抽取参考的角色系统提示。',
      }),
      getSortedWorldInfoEntries: vi.fn(async () => [{
        world: '测试世界书',
        uid: 1,
        key: ['第1轮用户剧情'],
        content: '该剧情术语来自测试世界书。',
      }]),
      getTokenCountAsync: vi.fn(async (text: string) => Math.ceil(text.length / 2)),
    };
    vi.stubGlobal('SillyTavern', { getContext: () => context });
    state.vectorFingerprint = await vectorConfigFingerprint(resolveVectorConfig(settings));

    await expect(new ExtractionService().processThrough(9)).resolves.toMatchObject({
      indexedThroughMessageId: 9,
    });
    expect(generateRaw).toHaveBeenCalledOnce();
    expect(generateRaw.mock.calls[0]?.[0]).toMatchObject({ responseLength: 8_192 });
    const prompt = String((generateRaw.mock.calls[0]?.[0] as { prompt?: string })?.prompt ?? '');
    expect(prompt).toContain('顾青是熟悉机关的侦探');
    expect(prompt).toContain('该剧情术语来自测试世界书');
    expect(prompt).not.toContain('不得进入抽取参考的角色系统提示');
  });

  it('waits without calling the LLM until the configured turn batch is complete', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
    settings.debug = true;
    settings.extraction.targetTurnsPerChunk = 5;
    const state = chatState([]);
    state.indexedThroughMessageId = -1;
    state.indexedThroughHash = '';
    const generateRaw = vi.fn(async (_options: unknown) => '{"memories":[]}');
    const context = {
      chat: Array.from({ length: 4 }, (_, index) => [
        { is_user: true, mes: `第${index + 1}轮用户剧情` },
        { is_user: false, mes: `第${index + 1}轮AI剧情` },
      ]).flat(),
      chatId: 'chat-id',
      extensionSettings: {
        story_echo: settings,
        vectors: { source: 'transformers' },
      },
      chatMetadata: { [MODULE_ID]: state },
      saveSettingsDebounced: vi.fn(),
      saveMetadata: vi.fn(async () => undefined),
      generateRaw,
      getCurrentChatId: () => 'chat-id',
      getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    };
    vi.stubGlobal('SillyTavern', { getContext: () => context });
    state.vectorFingerprint = await vectorConfigFingerprint(resolveVectorConfig(settings));

    const result = await new ExtractionService().processThrough(7);

    expect(result?.indexedThroughMessageId).toBe(-1);
    expect(result?.debugTraces.at(-1)?.message).toContain('等待凑满');
    expect(generateRaw).not.toHaveBeenCalled();
  });

  it('uses a newly configured three-turn extraction batch on the very next run', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
    settings.extraction.targetTurnsPerChunk = 3;
    const state = chatState([]);
    state.indexedThroughMessageId = -1;
    state.indexedThroughHash = '';
    const generateRaw = vi.fn(async (_options: unknown) => '{"memories":[]}');
    const context = {
      chat: Array.from({ length: 4 }, (_, index) => [
        { is_user: true, mes: `第${index + 1}轮用户剧情` },
        { is_user: false, mes: `第${index + 1}轮AI剧情` },
      ]).flat(),
      chatId: 'chat-id',
      extensionSettings: {
        story_echo: settings,
        vectors: { source: 'transformers' },
      },
      chatMetadata: { [MODULE_ID]: state },
      saveSettingsDebounced: vi.fn(),
      saveMetadata: vi.fn(async () => undefined),
      generateRaw,
      getCurrentChatId: () => 'chat-id',
      getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    };
    vi.stubGlobal('SillyTavern', { getContext: () => context });
    state.vectorFingerprint = await vectorConfigFingerprint(resolveVectorConfig(settings));

    const result = await new ExtractionService().processNextThrough(7);

    expect(result?.indexedThroughMessageId).toBe(5);
    expect(generateRaw).toHaveBeenCalledOnce();
    const prompt = String((generateRaw.mock.calls[0]?.[0] as { prompt?: string })?.prompt ?? '');
    expect(prompt).toContain('消息 0 到 5');
    expect(prompt).not.toContain('第4轮用户剧情');
  });

  it('persists stable user profile facts as editable structured metadata', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
    settings.extraction.targetTurnsPerChunk = 3;
    const state = chatState([]);
    state.indexedThroughMessageId = -1;
    state.indexedThroughHash = '';
    const profileMemory = (
      messageId: number,
      attribute: string,
      after: string,
    ) => ({
      sourceMessageIds: [messageId],
      type: 'state_change',
      scene: { location: '', time: '', participants: ['用户'] },
      event: `用户的${attribute}为${after}`,
      cause: '',
      consequence: '',
      entities: ['用户', after],
      aliases: [],
      stateChanges: [{ entity: '用户', attribute, before: '', after }],
      unresolvedThreads: [],
      knownBy: ['用户'],
      truthStatus: 'confirmed',
      importance: 0.9,
      retrievalText: `用户明确说明${attribute}为${after}`,
      injectionText: `用户曾明确说明其${attribute}为${after}。`,
    });
    const generateRaw = vi.fn(async (_options: unknown) => JSON.stringify({
      memories: [
        profileMemory(0, '姓名', '刘爽'),
        profileMemory(2, '出生年份', '1997年'),
        profileMemory(4, '性别', '男'),
      ],
    }));
    const context = {
      chat: [
        { is_user: true, mes: '我叫刘爽。' },
        { is_user: false, mes: '你好，刘爽。' },
        { is_user: true, mes: '我1997年出生。' },
        { is_user: false, mes: '知道了。' },
        { is_user: true, mes: '我是男的。' },
        { is_user: false, mes: '明白。' },
      ],
      chatId: 'chat-id',
      extensionSettings: {
        story_echo: settings,
        vectors: { source: 'transformers' },
      },
      chatMetadata: { [MODULE_ID]: state },
      saveSettingsDebounced: vi.fn(),
      saveMetadata: vi.fn(async () => undefined),
      generateRaw,
      getCurrentChatId: () => 'chat-id',
      getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    };
    vi.stubGlobal('SillyTavern', { getContext: () => context });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => (
      new Response(String(input) === '/api/vector/list' ? '[]' : '{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ));
    vi.stubGlobal('fetch', fetchMock);
    state.vectorFingerprint = await vectorConfigFingerprint(resolveVectorConfig(settings));

    const result = await new ExtractionService().processThrough(5);

    expect(result?.memories).toHaveLength(3);
    expect(result?.memories.map((item) => item.logicalKey).sort()).toEqual([
      'custom:出生年份:用户',
      'custom:姓名:用户',
      'custom:性别:用户',
    ]);
    expect(result?.memories.every((item) => item.evidenceRole === 'user')).toBe(true);
    expect(result?.pendingVectorHashes).toEqual([]);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      '/api/vector/list',
      '/api/vector/insert',
    ]);
  });

  it('rebuilds already processed automatic metadata while preserving manual edits', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
    settings.debug = true;
    settings.extraction.targetTurnsPerChunk = 3;
    const automatic = memory();
    const manual = {
      ...memory(),
      id: 'manual-memory',
      status: 'invalid' as const,
      vectorHash: 456,
      retrievalHash: 'manual-hash',
      manuallyEdited: true,
      event: '用户手动保留的元数据',
    };
    const state = chatState([automatic, manual]);
    state.indexedThroughMessageId = 5;
    state.indexedThroughHash = 'old-chunk';
    state.indexedPrefixHash = 'old-prefix';
    const generateRaw = vi.fn(async (_options: unknown) => '{"memories":[]}');
    const context = {
      chat: Array.from({ length: 3 }, (_, index) => [
        { is_user: true, mes: `第${index + 1}轮用户剧情` },
        { is_user: false, mes: `第${index + 1}轮AI剧情` },
      ]).flat(),
      chatId: 'chat-id',
      extensionSettings: {
        story_echo: settings,
        vectors: { source: 'transformers' },
      },
      chatMetadata: { [MODULE_ID]: state },
      saveSettingsDebounced: vi.fn(),
      saveMetadata: vi.fn(async () => undefined),
      generateRaw,
      getCurrentChatId: () => 'chat-id',
      getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    };
    vi.stubGlobal('SillyTavern', { getContext: () => context });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response('OK', { status: 200 })
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new ExtractionService().rebuildThrough(5);

    expect(result?.indexedThroughMessageId).toBe(5);
    expect(result?.memories.map((item) => item.id)).toEqual(['manual-memory']);
    expect(result?.debugTraces.some((trace) => trace.message.includes('重建自动剧情元数据')))
      .toBe(true);
    expect(generateRaw).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/vector/purge');
  });

  it('may close an oversized chunk early but never splits its user and assistant pair', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
    settings.extraction.targetTurnsPerChunk = 5;
    const state = chatState([]);
    state.indexedThroughMessageId = -1;
    state.indexedThroughHash = '';
    const generateRaw = vi.fn(async (_options: unknown) => '{"memories":[]}');
    const context = {
      chat: [
        { is_user: true, mes: '甲'.repeat(20_000) },
        { is_user: false, mes: '乙'.repeat(20_000) },
        { is_user: true, mes: '下一轮用户剧情' },
        { is_user: false, mes: '下一轮AI剧情' },
      ],
      chatId: 'chat-id',
      extensionSettings: {
        story_echo: settings,
        vectors: { source: 'transformers' },
      },
      chatMetadata: { [MODULE_ID]: state },
      saveSettingsDebounced: vi.fn(),
      saveMetadata: vi.fn(async () => undefined),
      generateRaw,
      getCurrentChatId: () => 'chat-id',
      getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    };
    vi.stubGlobal('SillyTavern', { getContext: () => context });
    state.vectorFingerprint = await vectorConfigFingerprint(resolveVectorConfig(settings));

    const result = await new ExtractionService().processNextThrough(3);

    expect(result?.indexedThroughMessageId).toBe(1);
    expect(generateRaw).toHaveBeenCalledOnce();
    const prompt = String(generateRaw.mock.calls[0]?.[0] &&
      (generateRaw.mock.calls[0]![0] as { prompt?: string }).prompt);
    expect(prompt).toContain('消息 0 到 1');
    expect(prompt).not.toContain('下一轮用户剧情');
  });

  it('invalidates indexed memories when an indexed floor is edited or deleted', async () => {
    const settings = { ...structuredClone(DEFAULT_SETTINGS), debug: true };
    const state = chatState([memory()]);
    state.ownerChatId = 'chat-id';
    state.indexedThroughMessageId = 2;
    state.indexedPrefixHash = 'prefix-before-delete';
    state.stageSummary = {
      entries: [{
        text: '删除前的阶段总结',
        sourceStartMessageId: 0,
        sourceEndMessageId: 2,
        sourceHash: 'summary-before-delete',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }],
      coveredThroughMessageId: 2,
      coveredThroughHash: 'summary-before-delete',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const context = {
      chat: [
        { is_user: true, mes: '第一层' },
        { is_user: false, mes: '被修改或删除后替换的第二层' },
        { is_user: true, mes: '第三层' },
      ],
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
    const fetchMock = vi.fn(async () => new Response('OK', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new ExtractionService().reconcileHistory(state);

    expect(result?.indexedThroughMessageId).toBe(-1);
    expect(result?.indexedPrefixHash).toBe('');
    expect(result?.memories).toEqual([]);
    expect(result?.stageSummary.entries).toEqual([]);
    expect(result?.stageSummary.coveredThroughMessageId).toBe(-1);
    expect(result?.pendingVectorHashes).toEqual([]);
    expect(result?.debugTraces.at(-1)?.message).toContain('删楼层');
    expect(fetchMock).toHaveBeenCalledWith('/api/vector/purge', expect.any(Object));
  });

  it('rebuilds copied metadata when a new branch ends before the inherited cursor', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const inherited = chatState([memory()]);
    inherited.ownerChatId = 'original-chat';
    inherited.indexedThroughMessageId = 4;
    inherited.indexedPrefixHash = 'original-prefix';
    inherited.stageSummary = {
      entries: [{
        text: '父分支阶段总结',
        sourceStartMessageId: 0,
        sourceEndMessageId: 4,
        sourceHash: 'parent-summary',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }],
      coveredThroughMessageId: 4,
      coveredThroughHash: 'parent-summary',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const context = {
      chat: [
        { is_user: true, mes: '分支保留的第一层' },
        { is_user: false, mes: '分支保留的第二层' },
      ],
      chatId: 'branch-chat',
      extensionSettings: {
        story_echo: settings,
        vectors: { source: 'transformers' },
      },
      chatMetadata: { [MODULE_ID]: inherited },
      saveSettingsDebounced: vi.fn(),
      saveMetadata: vi.fn(async () => undefined),
      generateRaw: vi.fn(async () => ''),
      getCurrentChatId: () => 'branch-chat',
      getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    };
    vi.stubGlobal('SillyTavern', { getContext: () => context });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('OK', { status: 200 })));

    const branchState = await new MemoryRepository().getOrCreate();
    expect(branchState?.ownerChatId).toBe('branch-chat');
    expect(branchState?.memories).toHaveLength(1);

    const reconciled = await new ExtractionService().reconcileHistory(branchState!);

    expect(reconciled?.ownerChatId).toBe('branch-chat');
    expect(reconciled?.indexedThroughMessageId).toBe(-1);
    expect(reconciled?.memories).toEqual([]);
    expect(reconciled?.stageSummary.entries).toEqual([]);
    expect(reconciled?.vectorCollectionId).not.toBe(inherited.vectorCollectionId);
  });
});
