import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SillyTavernContext } from '../src/platform/sillytavern';
import { MemoryRepository } from '../src/memory/repository';
import { memory } from './fixtures';

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
    expect(state?.metrics.actions.SUPERSEDE).toBe(0);
    expect(state?.debugTraces).toEqual([]);
    expect(state?.memories[0]?.sourceHistory).toEqual([state?.memories[0]?.source]);
    expect(state?.memories[0]?.supersedesMemoryIds).toEqual([]);
    expect(state?.memories[0]?.lastOperation).toBe('CREATE');
    expect(state?.memories[0]?.logicalKey).toBe('holder:银色钥匙');
    expect(state?.memories[0]?.sourceMessageIds).toEqual([1, 2]);
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
