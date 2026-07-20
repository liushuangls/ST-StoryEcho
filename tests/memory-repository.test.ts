import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SillyTavernContext } from '../src/platform/sillytavern';
import { MemoryRepository, type StoryMemoryEdit } from '../src/memory/repository';
import { chatState, memory } from './fixtures';

function editable(overrides: Partial<StoryMemoryEdit> = {}): StoryMemoryEdit {
  return {
    type: 'state_change',
    status: 'active',
    truthStatus: 'confirmed',
    importance: 0.9,
    event: '银色钥匙现在由顾青持有',
    cause: '林雨完成交接',
    consequence: '',
    scene: { location: '钟楼', time: '午夜', participants: ['林雨', '顾青'] },
    entities: ['银色钥匙', '顾青'],
    aliases: ['钟楼钥匙'],
    stateChanges: [{ entity: '银色钥匙', attribute: '持有者', before: '林雨', after: '顾青' }],
    unresolvedThreads: [],
    knownBy: ['林雨', '顾青'],
    retrievalText: '银色钥匙（钟楼钥匙）当前由顾青持有。',
    injectionText: '较早时，林雨把银色钥匙交给了顾青。',
    pinned: true,
    excluded: false,
    ...overrides,
  };
}

describe('MemoryRepository migration', () => {
  afterEach(() => {
    globalThis.SillyTavern = undefined;
  });

  it('upgrades legacy chat state with diagnostics and consolidation fields', async () => {
    const legacyMemory = { ...memory() } as Record<string, unknown>;
    legacyMemory['status'] = 'resolved';
    legacyMemory['unresolvedThreads'] = ['已经完成、不应继续显示的待办'];
    delete legacyMemory['sourceHistory'];
    delete legacyMemory['supersedesMemoryIds'];
    delete legacyMemory['lastOperation'];
    delete legacyMemory['logicalKey'];
    delete legacyMemory['sourceMessageIds'];
    delete legacyMemory['evidenceRole'];
    const saveMetadata = vi.fn(async () => undefined);
    const context: SillyTavernContext = {
      chat: [],
      chatId: 'chat-id',
      extensionSettings: {},
      chatMetadata: {
        story_echo: {
          schemaVersion: 1,
          chatUuid: 'chat-uuid',
          ownerChatId: 'chat-id',
          vectorCollectionId: 'story_echo_chat-uuid_v1',
          indexedThroughMessageId: 2,
          indexedThroughHash: 'source-1',
          memories: [legacyMemory],
          pendingRanges: [],
          pendingVectorHashes: [],
          vectorFingerprint: 'fingerprint',
          lastInspection: {
            createdAt: '2026-01-01T00:00:00.000Z',
            generationType: 'normal',
            retainedStartIndex: 1,
            retainedEndIndex: 2,
            removedMessageCount: 1,
            query: '钥匙',
            candidateMemoryIds: [],
            selectedMemoryIds: [],
            estimatedRecallTokens: 0,
            warnings: [],
          },
        },
      },
      saveSettingsDebounced: vi.fn(),
      saveMetadata,
      generateRaw: vi.fn(async () => ''),
    };
    globalThis.SillyTavern = { getContext: () => context };

    const state = await new MemoryRepository().getOrCreate();

    expect(state?.pendingVectorDeleteHashes).toEqual([]);
    expect(state?.stageSummary).toEqual({
      entries: [],
      coveredThroughMessageId: -1,
      coveredThroughHash: '',
    });
    expect(state?.storySkeleton).toEqual({
      text: '',
      coveredThroughMessageId: -1,
      sourceHash: '',
    });
    expect(state?.metrics.actions.SUPERSEDE).toBe(0);
    expect(state?.debugTraces).toEqual([]);
    expect(state?.memories[0]?.sourceHistory).toEqual([state?.memories[0]?.source]);
    expect(state?.memories[0]?.supersedesMemoryIds).toEqual([]);
    expect(state?.memories[0]?.lastOperation).toBe('CREATE');
    expect(state?.memories[0]?.logicalKey).toBe('holder:银色钥匙');
    expect(state?.memories[0]?.sourceMessageIds).toEqual([1, 2]);
    expect(state?.memories[0]?.evidenceRole).toBe('unknown');
    expect(state?.memories[0]?.unresolvedThreads).toEqual([]);
    expect(state?.lastInspection?.durationMs).toBe(0);
    expect(state?.lastInspection?.vectorResultCount).toBe(0);
    expect(saveMetadata).toHaveBeenCalledOnce();
  });

  it('preserves a 0.8 rolling summary as one legacy stage entry', async () => {
    const saveMetadata = vi.fn(async () => undefined);
    const context: SillyTavernContext = {
      chat: [],
      chatId: 'chat-id',
      extensionSettings: {},
      chatMetadata: {
        story_echo: {
          schemaVersion: 1,
          chatUuid: 'chat-uuid',
          ownerChatId: 'chat-id',
          vectorCollectionId: 'story_echo_chat-uuid_v1',
          indexedThroughMessageId: 4,
          indexedThroughHash: 'source-1',
          indexedPrefixHash: '',
          stageSummary: {
            text: '旧版滚动总结',
            coveredThroughMessageId: 4,
            coveredThroughHash: 'legacy-summary-hash',
            updatedAt: '2026-01-02T00:00:00.000Z',
          },
          memories: [],
          pendingRanges: [],
          pendingVectorHashes: [],
          pendingVectorDeleteHashes: [],
          vectorFingerprint: '',
        },
      },
      saveSettingsDebounced: vi.fn(),
      saveMetadata,
      generateRaw: vi.fn(async () => ''),
    };
    globalThis.SillyTavern = { getContext: () => context };

    const state = await new MemoryRepository().getOrCreate();

    expect(state?.stageSummary).toEqual({
      entries: [{
        text: '旧版滚动总结',
        sourceStartMessageId: 0,
        sourceEndMessageId: 4,
        sourceHash: 'legacy-summary-hash',
        updatedAt: '2026-01-02T00:00:00.000Z',
      }],
      coveredThroughMessageId: 4,
      coveredThroughHash: 'legacy-summary-hash',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    expect(saveMetadata).toHaveBeenCalledOnce();
  });
});

describe('MemoryRepository manual metadata editing', () => {
  afterEach(() => {
    globalThis.SillyTavern = undefined;
  });

  function contextWithMemory() {
    const saveMetadata = vi.fn(async () => undefined);
    const state = chatState([memory()]);
    const context: SillyTavernContext = {
      chat: [
        { is_user: true, mes: '林雨拿到钥匙' },
        { is_user: false, mes: '林雨收好钥匙' },
        { is_user: true, mes: '继续' },
      ],
      chatId: 'chat-id',
      extensionSettings: {},
      chatMetadata: { story_echo: state },
      saveSettingsDebounced: vi.fn(),
      saveMetadata,
      generateRaw: vi.fn(async () => ''),
    };
    globalThis.SillyTavern = { getContext: () => context };
    return { context, saveMetadata };
  }

  it('persists an edited memory, protects it from automatic consolidation, and replaces its vector', async () => {
    const { saveMetadata } = contextWithMemory();

    const state = await new MemoryRepository().updateMemory('mem-1', editable());
    const updated = state.memories[0];

    expect(updated).toMatchObject({
      id: 'mem-1',
      event: '银色钥匙现在由顾青持有',
      logicalKey: 'holder:银色钥匙',
      scene: { location: '钟楼', time: '午夜', participants: ['林雨', '顾青'] },
      pinned: true,
      manuallyEdited: true,
      lastOperation: 'UPDATE',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(updated?.vectorHash).not.toBe(123);
    expect(updated?.retrievalHash).not.toBe('retrieval-1');
    expect(state.pendingVectorDeleteHashes).toContain(123);
    expect(state.pendingVectorHashes).toContain(updated?.vectorHash);
    expect(saveMetadata).toHaveBeenCalledOnce();
  });

  it('does not requeue a vector when only non-retrieval metadata changes', async () => {
    contextWithMemory();
    const original = memory();

    const state = await new MemoryRepository().updateMemory('mem-1', editable({
      retrievalText: original.retrievalText,
      injectionText: '人工修正后的注入文本。',
    }));

    expect(state.memories[0]?.vectorHash).toBe(123);
    expect(state.pendingVectorHashes).toEqual([]);
    expect(state.pendingVectorDeleteHashes).toEqual([]);
  });

  it('queues vector deletion when an edited memory is marked invalid', async () => {
    contextWithMemory();
    const original = memory();

    const state = await new MemoryRepository().updateMemory('mem-1', editable({
      status: 'invalid',
      retrievalText: original.retrievalText,
    }));

    expect(state.memories[0]?.status).toBe('invalid');
    expect(state.pendingVectorHashes).toEqual([]);
    expect(state.pendingVectorDeleteHashes).toEqual([123]);
  });

  it('deletes a memory and queues its stored vector for removal', async () => {
    contextWithMemory();

    const state = await new MemoryRepository().removeMemory('mem-1');

    expect(state.memories).toEqual([]);
    expect(state.pendingVectorHashes).toEqual([]);
    expect(state.pendingVectorDeleteHashes).toEqual([123]);
  });

  it('rejects malformed manual state changes instead of corrupting chat metadata', async () => {
    const { context } = contextWithMemory();

    await expect(new MemoryRepository().updateMemory('mem-1', editable({
      stateChanges: [{ entity: '', attribute: '持有者', after: '顾青' }],
    }))).rejects.toThrow('状态主体不能为空');

    expect((context.chatMetadata['story_echo'] as ReturnType<typeof chatState>).memories[0]?.event)
      .toBe('林雨获得银色钥匙');
  });
});

describe('MemoryRepository stage summary editing', () => {
  afterEach(() => {
    globalThis.SillyTavern = undefined;
  });

  function sectionedSummary(confirmed: string): string {
    return [
      '【已确认剧情】',
      confirmed,
      '【当前状态】',
      '无',
      '【未解决线索】',
      '无',
      '【角色主张与推测】',
      '无',
      '【已失效或否定事实】',
      '无',
    ].join('\n');
  }

  function contextWithSummaries() {
    const saveMetadata = vi.fn(async () => undefined);
    const state = chatState([]);
    state.ownerChatId = 'chat-id';
    state.stageSummary = {
      entries: [
        {
          text: sectionedSummary('第一阶段。'),
          sourceStartMessageId: 0,
          sourceEndMessageId: 1,
          sourceHash: 'summary-a',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          text: sectionedSummary('第二阶段。'),
          sourceStartMessageId: 2,
          sourceEndMessageId: 3,
          sourceHash: 'summary-b',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      ],
      coveredThroughMessageId: 3,
      coveredThroughHash: 'summary-b',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };
    const context: SillyTavernContext = {
      chat: [
        { is_user: true, mes: '第一轮' },
        { is_user: false, mes: '第一轮回复' },
        { is_user: true, mes: '第二轮' },
        { is_user: false, mes: '第二轮回复' },
      ],
      chatId: 'chat-id',
      extensionSettings: {},
      chatMetadata: { story_echo: state },
      saveSettingsDebounced: vi.fn(),
      saveMetadata,
      generateRaw: vi.fn(async () => ''),
    };
    globalThis.SillyTavern = { getContext: () => context };
    return { context, saveMetadata };
  }

  it('persists a manual summary edit without changing its source coverage', async () => {
    const { saveMetadata } = contextWithSummaries();
    const edited = sectionedSummary('第一阶段由用户人工修正。');

    const state = await new MemoryRepository().updateStageSummaryEntry(0, { text: edited });

    expect(state.stageSummary.entries[0]).toMatchObject({
      text: edited,
      sourceStartMessageId: 0,
      sourceEndMessageId: 1,
      sourceHash: 'summary-a',
      manuallyEdited: true,
    });
    expect(state.stageSummary.coveredThroughMessageId).toBe(3);
    expect(state.stageSummary.coveredThroughHash).toBe('summary-b');
    expect(saveMetadata).toHaveBeenCalledOnce();
  });

  it('marks a covering skeleton stale when an archived stage summary is edited', async () => {
    const { context } = contextWithSummaries();
    const stored = context.chatMetadata['story_echo'] as ReturnType<typeof chatState>;
    stored.storySkeleton = {
      text: '【核心设定与身份】\n旧骨架\n【主线因果与阶段脉络】\n无\n【长期关系、承诺与目标】\n无\n【当前全局状态】\n无\n【未决主线与关键线索】\n无\n【重要修正与失效事实】\n无',
      coveredThroughMessageId: 1,
      sourceHash: 'skeleton-source',
    };

    const state = await new MemoryRepository().updateStageSummaryEntry(0, {
      text: sectionedSummary('第一阶段由用户人工修正。'),
    });

    expect(state.storySkeleton.stale).toBe(true);
  });

  it('allows editing a skeleton without changing coverage and rejects deletion by blanking it', async () => {
    const { context } = contextWithSummaries();
    const stored = context.chatMetadata['story_echo'] as ReturnType<typeof chatState>;
    stored.storySkeleton = {
      text: '【核心设定与身份】\n旧骨架\n【主线因果与阶段脉络】\n无\n【长期关系、承诺与目标】\n无\n【当前全局状态】\n无\n【未决主线与关键线索】\n无\n【重要修正与失效事实】\n无',
      coveredThroughMessageId: 1,
      sourceHash: 'skeleton-source',
    };
    const edited = '【核心设定与身份】\n人工骨架\n【主线因果与阶段脉络】\n无\n【长期关系、承诺与目标】\n无\n【当前全局状态】\n无\n【未决主线与关键线索】\n无\n【重要修正与失效事实】\n无';
    const repository = new MemoryRepository();

    const state = await repository.updateStorySkeleton({ text: edited });

    expect(state.storySkeleton).toMatchObject({
      text: edited,
      coveredThroughMessageId: 1,
      sourceHash: 'skeleton-source',
      manuallyEdited: true,
    });
    await expect(repository.updateStorySkeleton({ text: '' })).rejects.toThrow(/不能为空/);
    expect((context.chatMetadata['story_echo'] as ReturnType<typeof chatState>).storySkeleton.text)
      .toBe(edited);
  });

  it('rejects a manual summary that breaks the five-section contract', async () => {
    const { context } = contextWithSummaries();

    await expect(new MemoryRepository().updateStageSummaryEntry(0, {
      text: '只有一段普通文本',
    })).rejects.toThrow('阶段总结缺少或打乱分级标题');

    const stored = context.chatMetadata['story_echo'] as ReturnType<typeof chatState>;
    expect(stored.stageSummary.entries).toHaveLength(2);
    expect(stored.stageSummary.coveredThroughMessageId).toBe(3);
  });

  it('tombstones an older summary without restoring old raw history or changing chat messages', async () => {
    const { context, saveMetadata } = contextWithSummaries();
    const originalChat = structuredClone(context.chat);

    const state = await new MemoryRepository().deleteStageSummaryEntry(0);

    expect(state.stageSummary.entries).toHaveLength(2);
    expect(state.stageSummary.entries[0]).toMatchObject({
      text: '',
      sourceStartMessageId: 0,
      sourceEndMessageId: 1,
      sourceHash: 'summary-a',
      deleted: true,
    });
    expect(state.stageSummary.entries[1]).toMatchObject({
      text: sectionedSummary('第二阶段。'),
      sourceStartMessageId: 2,
      sourceEndMessageId: 3,
      sourceHash: 'summary-b',
    });
    expect(state.stageSummary.coveredThroughMessageId).toBe(3);
    expect(state.stageSummary.coveredThroughHash).toBe('summary-b');
    expect(context.chat).toEqual(originalChat);
    expect(saveMetadata).toHaveBeenCalledOnce();
  });

  it('removes the latest summary and retreats coverage so its raw source participates again', async () => {
    const { context } = contextWithSummaries();
    const originalChat = structuredClone(context.chat);

    const state = await new MemoryRepository().deleteStageSummaryEntry(2);

    expect(state.stageSummary.entries).toHaveLength(1);
    expect(state.stageSummary.coveredThroughMessageId).toBe(1);
    expect(state.stageSummary.coveredThroughHash).toBe('summary-a');
    expect(context.chat).toEqual(originalChat);
  });
});
