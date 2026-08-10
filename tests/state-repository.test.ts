import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODULE_ID } from '../src/core/constants';
import type { StoryEchoChatState } from '../src/core/types';
import { StoryStateRepository } from '../src/state/repository';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { chatState } from './fixtures';

function install(
  stored: unknown,
  chatId = 'chat-id',
): {
  chatMetadata: Record<string, unknown>;
  saveMetadata: ReturnType<typeof vi.fn>;
} {
  const chatMetadata: Record<string, unknown> = {};
  if (stored !== undefined) {
    chatMetadata[MODULE_ID] = stored;
  }
  const saveMetadata = vi.fn(async () => undefined);
  vi.stubGlobal('SillyTavern', {
    getContext: () => ({
      chat: [],
      chatId,
      extensionSettings: { [MODULE_ID]: structuredClone(DEFAULT_SETTINGS) },
      chatMetadata,
      saveSettingsDebounced: vi.fn(),
      saveMetadata,
      generateRaw: vi.fn(async () => ''),
    }),
  });
  return { chatMetadata, saveMetadata };
}

function entry(start: number, end: number) {
  return {
    text: `summary-${start}`,
    sourceStartMessageId: start,
    sourceEndMessageId: end,
    sourceHash: `hash-${start}`,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StoryStateRepository', () => {
  it('creates an isolated context state for a new chat', async () => {
    const { chatMetadata, saveMetadata } = install(undefined);
    const state = await new StoryStateRepository().getOrCreate();
    expect(state).toMatchObject({
      schemaVersion: 2,
      ownerChatId: 'chat-id',
      stageSummary: { entries: [], coveredThroughMessageId: -1 },
      storySkeleton: { text: '', coveredThroughMessageId: -1 },
    });
    expect(chatMetadata[MODULE_ID]).toBe(state);
    expect(saveMetadata).toHaveBeenCalledOnce();
  });

  it('migrates a version-one state and drops all unrecognized fields', async () => {
    const legacy = {
      ...chatState(),
      schemaVersion: 1,
      memories: [{ id: 'obsolete' }],
      vectorCollectionId: 'obsolete-vector',
      pendingVectorHashes: [42],
      stageSummary: {
        entries: [entry(0, 1)],
        coveredThroughMessageId: 1,
        coveredThroughHash: 'hash-0',
      },
    };
    const { chatMetadata } = install(legacy);
    const state = await new StoryStateRepository().getOrCreate();
    expect(state?.schemaVersion).toBe(2);
    expect(state?.stageSummary.entries).toHaveLength(1);
    expect(state).not.toHaveProperty('memories');
    expect(state).not.toHaveProperty('vectorCollectionId');
    expect(state).not.toHaveProperty('pendingVectorHashes');
    expect(chatMetadata[MODULE_ID]).toEqual(state);
  });

  it('normalizes current state defensively without retaining unknown data', () => {
    const stored = {
      schemaVersion: 2,
      chatUuid: 'stored-uuid',
      ownerChatId: 'chat-id',
      stageSummary: {
        entries: [
          {
            text: ' first summary ',
            sourceStartMessageId: 0,
            sourceEndMessageId: 1,
            sourceHash: 123,
            manuallyEdited: true,
            characterCount: 999,
            generation: {
              provider: 'main',
              requestedMaxTokens: 3_000,
              finishReason: 'length',
              completionTokens: 125,
              responseCharacters: 13,
              unknown: 'discarded',
            },
          },
          {
            text: 'ignored for a tombstone',
            sourceStartMessageId: 2,
            sourceEndMessageId: 3,
            sourceHash: 'deleted-hash',
            updatedAt: '2026-02-01T00:00:00.000Z',
            deleted: true,
          },
          entry(5, 6),
        ],
        rebuildCheckpoint: {
          targetEndMessageId: 5,
          targetSourceHash: 'target-source',
          generationSignature: 'generation-signature',
          entries: [entry(0, 1), entry(2, 3)],
          totalDurationMs: 1_500.9,
          totalMessagesCovered: 4,
          updatedAt: '2026-02-05T01:00:00.000Z',
        },
      },
      storySkeleton: {
        text: ' skeleton ',
        coveredThroughMessageId: '3.9',
        sourceHash: '',
        updatedAt: '2026-02-02T00:00:00.000Z',
        manuallyEdited: true,
      },
      metrics: {
        summaryUpdates: 2,
        summaryFailures: -1,
        lastSummaryAt: '2026-02-03T00:00:00.000Z',
      },
      debugTraces: [
        null,
        { id: 'bad', createdAt: 'now', stage: 'other', message: 'drop me' },
        {
          id: 'trace',
          createdAt: '2026-02-04T00:00:00.000Z',
          stage: 'summary',
          message: 'kept',
          details: {
            text: 'value',
            number: 1,
            boolean: true,
            nullable: null,
            nested: { discarded: true },
          },
        },
      ],
      recentInternalLlmAttempts: [
        { id: 'bad' },
        {
          id: 'attempt',
          task: 'stage-summary',
          status: 'completed',
          startedAt: '2026-02-04T01:00:00.000Z',
          finishedAt: '2026-02-04T01:00:01.000Z',
          durationMs: 1_000.8,
          sourceStartMessageId: 0,
          sourceEndMessageId: 1,
          requestedMaxTokens: 3_000,
          agentActiveAtStart: true,
          agentActiveAtEnd: false,
          attemptErrors: [
            ' first timeout ',
            42,
            ' retry failed ',
          ],
          completion: {
            provider: 'main',
            requestedMaxTokens: 3_000,
            finishReason: 'length',
            completionTokens: 125,
            responseCharacters: 13,
          },
        },
      ],
      lastInspection: {
        createdAt: '2026-02-05T00:00:00.000Z',
        generationType: 42,
        retainedStartIndex: '2.9',
        retainedEndIndex: Number.NaN,
        removedMessageCount: -5,
        estimatedRemovedTokens: '10',
        estimatedInjectedTokens: -2,
        warnings: ['warning', 7],
      },
      unknown: 'discarded',
    };
    install(stored);

    const state = new StoryStateRepository().getExisting();

    expect(state).toMatchObject({
      schemaVersion: 2,
      chatUuid: 'stored-uuid',
      stageSummary: {
        coveredThroughMessageId: 3,
        coveredThroughHash: 'deleted-hash',
        entries: [
          {
            text: 'first summary',
            characterCount: 13,
            sourceHash: '',
            manuallyEdited: true,
            generation: {
              provider: 'main',
              requestedMaxTokens: 3_000,
              finishReason: 'length',
              completionTokens: 125,
              responseCharacters: 13,
            },
          },
          {
            text: '',
            deleted: true,
          },
        ],
        rebuildCheckpoint: {
          targetEndMessageId: 5,
          targetSourceHash: 'target-source',
          generationSignature: 'generation-signature',
          entries: [
            { text: 'summary-0', sourceStartMessageId: 0, sourceEndMessageId: 1 },
            { text: 'summary-2', sourceStartMessageId: 2, sourceEndMessageId: 3 },
          ],
          totalDurationMs: 1_500,
          totalMessagesCovered: 4,
        },
      },
      storySkeleton: {
        text: 'skeleton',
        coveredThroughMessageId: 3,
        stale: true,
        manuallyEdited: true,
      },
      metrics: {
        summaryUpdates: 2,
        summaryFailures: 0,
        lastSummaryAt: '2026-02-03T00:00:00.000Z',
      },
      debugTraces: [{
        id: 'trace',
        details: {
          text: 'value',
          number: 1,
          boolean: true,
          nullable: null,
        },
      }],
      recentInternalLlmAttempts: [{
        id: 'attempt',
        task: 'stage-summary',
        status: 'completed',
        durationMs: 1_000,
        agentActiveAtStart: true,
        agentActiveAtEnd: false,
        attemptErrors: ['first timeout', 'retry failed'],
        completion: {
          finishReason: 'length',
          completionTokens: 125,
        },
      }],
      lastInspection: {
        generationType: 'normal',
        retainedStartIndex: 2,
        retainedEndIndex: -1,
        removedMessageCount: 0,
        estimatedRemovedTokens: 10,
        estimatedInjectedTokens: 0,
        warnings: ['warning'],
      },
    });
    expect(state).not.toHaveProperty('unknown');
  });

  it('preserves the old rolling summary shape while dropping malformed derived data', async () => {
    const stored = {
      schemaVersion: 1,
      chatUuid: 'legacy-uuid',
      ownerChatId: 'chat-id',
      stageSummary: {
        text: ' legacy rolling summary ',
        coveredThroughMessageId: '4',
        coveredThroughHash: 99,
      },
      storySkeleton: {
        text: 'will be discarded',
        coveredThroughMessageId: Number.NaN,
      },
      metrics: null,
      debugTraces: 'invalid',
      lastInspection: { createdAt: 123 },
    };
    install(stored);

    const state = await new StoryStateRepository().getOrCreate();

    expect(state?.stageSummary).toMatchObject({
      coveredThroughMessageId: 4,
      coveredThroughHash: '',
      entries: [{
        text: 'legacy rolling summary',
        sourceStartMessageId: 0,
        sourceEndMessageId: 4,
        sourceHash: '',
      }],
    });
    expect(state?.storySkeleton).toEqual({
      text: '',
      coveredThroughMessageId: -1,
      sourceHash: '',
    });
    expect(state?.debugTraces).toEqual([]);
    expect(state).not.toHaveProperty('lastInspection');
  });

  it('returns null for missing, invalid, or foreign chat ownership', async () => {
    install(undefined, '');
    const repository = new StoryStateRepository();
    expect(repository.getExisting()).toBeNull();
    await expect(repository.getOrCreate()).resolves.toBeNull();

    install({ schemaVersion: 2 }, 'chat-id');
    expect(repository.getExisting()).toBeNull();
    await expect(repository.adoptRenamedChat('old', 'chat-id')).resolves.toBe(false);

    install(chatState({ ownerChatId: 'other' }), 'chat-id');
    expect(repository.getExisting()).toBeNull();
    await expect(repository.adoptRenamedChat('old', 'chat-id')).resolves.toBe(false);
    await expect(repository.adoptRenamedChat('other', 'different')).resolves.toBe(false);
  });

  it('clones derived context for a branch and marks its skeleton stale', async () => {
    const stored = chatState({
      stageSummary: {
        entries: [],
        coveredThroughMessageId: -1,
        coveredThroughHash: '',
        rebuildCheckpoint: {
          targetEndMessageId: 1,
          targetSourceHash: 'target-source',
          generationSignature: 'generation-signature',
          entries: [entry(0, 1)],
          totalDurationMs: 100,
          totalMessagesCovered: 2,
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
      ownerChatId: 'parent',
      storySkeleton: {
        text: 'parent skeleton',
        coveredThroughMessageId: 1,
        sourceHash: 'source',
      },
    });
    install(stored, 'branch');
    const state = await new StoryStateRepository().getOrCreate();
    expect(state?.ownerChatId).toBe('branch');
    expect(state?.chatUuid).not.toBe(stored.chatUuid);
    expect(state?.storySkeleton.stale).toBe(true);
    expect(state?.metrics.summaryUpdates).toBe(0);
    expect(state?.recentInternalLlmAttempts).toEqual([]);
    expect(state?.stageSummary.rebuildCheckpoint).toBeUndefined();
  });

  it('edits and deletes summaries while invalidating a covered skeleton', async () => {
    const state = chatState({
      stageSummary: {
        entries: [entry(0, 1), entry(2, 3)],
        coveredThroughMessageId: 3,
        coveredThroughHash: 'hash-2',
      },
      storySkeleton: {
        text: 'skeleton',
        coveredThroughMessageId: 3,
        sourceHash: 'source',
      },
    });
    install(state);
    const repository = new StoryStateRepository();
    const edited = await repository.updateStageSummaryEntry(0, { text: ' edited summary ' });
    expect(edited.stageSummary.entries[0]).toMatchObject({
      text: 'edited summary',
      characterCount: 14,
      manuallyEdited: true,
    });
    expect(edited.storySkeleton.stale).toBe(true);

    const tombstoned = await repository.deleteStageSummaryEntry(0);
    expect(tombstoned.stageSummary.entries[0]).toMatchObject({ text: '', deleted: true });
    const popped = await repository.deleteStageSummaryEntry(2);
    expect(popped.stageSummary.entries).toHaveLength(1);
    expect(popped.stageSummary.coveredThroughMessageId).toBe(1);
  });

  it('rejects missing or invalid summary edits and handles deleting the final entry', async () => {
    install(undefined, '');
    const repository = new StoryStateRepository();
    await expect(repository.updateStageSummaryEntry(0, { text: 'summary' }))
      .rejects.toThrow('当前没有可用聊天');
    await expect(repository.deleteStageSummaryEntry(0))
      .rejects.toThrow('当前没有可用聊天');

    const state = chatState({
      stageSummary: {
        entries: [entry(0, 1)],
        coveredThroughMessageId: 1,
        coveredThroughHash: 'hash-0',
      },
    });
    install(state);
    await expect(repository.updateStageSummaryEntry(2, { text: 'summary' }))
      .rejects.toThrow('阶段总结不存在');
    await expect(repository.updateStageSummaryEntry(0, { text: '   ' }))
      .rejects.toThrow('正文不能为空');
    await expect(repository.updateStageSummaryEntry(0, { text: 'x'.repeat(64_001) }))
      .rejects.toThrow('不能超过64000');
    await expect(repository.deleteStageSummaryEntry(2))
      .rejects.toThrow('阶段总结不存在');

    const deleted = await repository.deleteStageSummaryEntry(0);
    expect(deleted.stageSummary).toEqual({
      entries: [],
      coveredThroughMessageId: -1,
      coveredThroughHash: '',
    });
  });

  it('rejects skeleton editing before a skeleton exists', async () => {
    install(chatState());
    await expect(new StoryStateRepository().updateStorySkeleton({ text: 'new skeleton' }))
      .rejects.toThrow('还没有可编辑的全局剧情骨架');
  });

  it('updates the skeleton, adopts a rename, rejects cross-chat saves and clears state', async () => {
    const state = chatState({
      ownerChatId: 'old',
      storySkeleton: {
        text: 'old skeleton',
        coveredThroughMessageId: 1,
        sourceHash: 'source',
      },
    });
    const { chatMetadata } = install(state, 'new');
    const repository = new StoryStateRepository();
    await expect(repository.adoptRenamedChat('old', 'new')).resolves.toBe(true);
    expect((chatMetadata[MODULE_ID] as StoryEchoChatState).ownerChatId).toBe('new');

    const updated = await repository.updateStorySkeleton({ text: 'new skeleton' });
    expect(updated.storySkeleton).toMatchObject({
      text: 'new skeleton',
      manuallyEdited: true,
    });

    await expect(repository.save({ ...updated, ownerChatId: 'other' }))
      .rejects.toThrow('聊天发生切换');
    await repository.clear();
    expect(chatMetadata).not.toHaveProperty(MODULE_ID);
  });
});
