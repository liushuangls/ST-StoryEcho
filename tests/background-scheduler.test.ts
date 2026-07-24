import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODULE_ID } from '../src/core/constants';
import type { StoryEchoSettings, TavernChatMessage } from '../src/core/types';
import {
  BackgroundProcessingScheduler,
  backgroundTargetMessageId,
} from '../src/background/scheduler';
import { extractionService } from '../src/extraction/service';
import {
  resetStructuredOutputDiagnostics,
  structuredOutputDiagnosticsSnapshot,
} from '../src/llm/structured-diagnostics';
import { storyEchoTaskCoordinator } from '../src/runtime/task-coordinator';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { stageSummaryService } from '../src/summary/service';
import { vectorCollectionRegistry } from '../src/vector/collection-registry';
import { chatState } from './fixtures';

afterEach(() => {
  storyEchoTaskCoordinator.resetForTests();
  resetStructuredOutputDiagnostics();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function turn(user: string, assistant: string): TavernChatMessage[] {
  return [
    { is_user: true, mes: user },
    { is_user: false, mes: assistant },
  ];
}

describe('backgroundTargetMessageId', () => {
  it('cancels a hanging stage-summary request when the chat branch changes', async () => {
    const chat = [...turn('u1', 'a1'), ...turn('u2', 'a2')];
    const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
    settings.enabled = true;
    settings.memory.enabled = false;
    settings.recentWindow = { size: 1, unit: 'turns' };
    settings.summary.targetTurnsPerUpdate = 1;
    const state = chatState([]);
    state.ownerChatId = 'chat-id';
    state.stageSummary.coveredThroughMessageId = -1;
    const handlers = new Map<string, (...args: unknown[]) => void | Promise<void>>();
    const generateRaw = vi.fn(() => new Promise<string>(() => undefined));
    const context = {
      chat,
      chatId: 'chat-id',
      extensionSettings: { [MODULE_ID]: settings },
      chatMetadata: { [MODULE_ID]: state },
      event_types: {
        MESSAGE_RECEIVED: 'message-received',
        CHAT_CHANGED: 'chat-changed',
      },
      eventSource: {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void | Promise<void>) => {
          handlers.set(event, handler);
        }),
        off: vi.fn(),
      },
      saveSettingsDebounced: vi.fn(),
      saveMetadata: vi.fn(async () => undefined),
      generateRaw,
      getCurrentChatId: () => 'chat-id',
    };
    vi.stubGlobal('SillyTavern', { getContext: () => context });
    const scheduler = new BackgroundProcessingScheduler();
    vi.spyOn(scheduler, 'schedule').mockImplementation(() => undefined);
    scheduler.register();

    const running = scheduler.runNow();
    await vi.waitFor(() => expect(generateRaw).toHaveBeenCalledOnce());
    (context.extensionSettings[MODULE_ID] as StoryEchoSettings).enabled = false;
    handlers.get('chat-changed')?.();

    await running;
    await vi.waitFor(() => {
      expect(storyEchoTaskCoordinator.snapshot().runningKind).toBeNull();
    });
    scheduler.unregister();
    expect(state.stageSummary.entries).toHaveLength(0);
    expect(state.metrics.summaryFailures).toBe(0);
  });

  it('only prepares complete history outside the minimum turn window', () => {
    const chat = [
      ...turn('u1', 'a1'),
      ...turn('u2', 'a2'),
      ...turn('u3', 'a3'),
      ...turn('u4', 'a4'),
      { is_user: true, mes: 'u5' },
      { is_user: false, mes: 'a5' },
    ];

    expect(backgroundTargetMessageId(chat, {
      recentWindow: { size: 2, unit: 'turns' },
    })).toBe(5);
  });

  it('does nothing until history exists outside the minimum window', () => {
    const chat = [...turn('u1', 'a1'), { is_user: true, mes: 'u2' }];

    expect(backgroundTargetMessageId(chat, {
      recentWindow: { size: 5, unit: 'turns' },
    })).toBe(-1);
  });

  it('counts the completed reply when the minimum window uses message units', () => {
    const chat = [...turn('u1', 'a1'), ...turn('u2', 'a2')];

    expect(backgroundTargetMessageId(chat, {
      recentWindow: { size: 2, unit: 'messages' },
    })).toBe(1);
  });

  it('processes at most one accumulated extraction and summary batch per background run', async () => {
    const chat = [
      ...turn('u1', 'a1'),
      ...turn('u2', 'a2'),
      ...turn('u3', 'a3'),
    ];
    const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
    settings.enabled = true;
    settings.memory.enabled = true;
    settings.recentWindow = { size: 1, unit: 'turns' };
    settings.extraction.targetTurnsPerChunk = 2;
    settings.summary.enabled = true;
    settings.summary.automatic = true;
    settings.summary.targetTurnsPerUpdate = 2;
    const state = chatState([]);
    state.ownerChatId = 'chat-id';
    state.indexedThroughMessageId = -1;
    state.stageSummary.coveredThroughMessageId = -1;
    const context = {
      chat,
      chatId: 'chat-id',
      extensionSettings: { [MODULE_ID]: settings },
      chatMetadata: { [MODULE_ID]: state },
      saveSettingsDebounced: vi.fn(),
      saveMetadata: vi.fn(async () => undefined),
      generateRaw: vi.fn(async () => ''),
      getCurrentChatId: () => 'chat-id',
    };
    vi.stubGlobal('SillyTavern', { getContext: () => context });
    vi.spyOn(extractionService, 'reconcileHistory').mockResolvedValue(state);
    const extract = vi.spyOn(extractionService, 'processNextThroughVerifiedHistory')
      .mockImplementation(async (target) => {
        state.indexedThroughMessageId = target;
        return state;
      });
    const summarize = vi.spyOn(stageSummaryService, 'processNextThrough')
      .mockImplementation(async (target) => {
        state.stageSummary.coveredThroughMessageId = target;
        return { state, updatedChunks: 1 };
      });

    await new BackgroundProcessingScheduler().runNow();

    expect(extract).toHaveBeenCalledOnce();
    expect(extract).toHaveBeenCalledWith(3);
    expect(summarize).toHaveBeenCalledOnce();
    expect(summarize).toHaveBeenCalledWith(3);
  });

  it('continues stage summaries without invoking the memory subsystem when memory is disabled', async () => {
    const chat = [...turn('u1', 'a1'), ...turn('u2', 'a2')];
    const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
    settings.enabled = true;
    settings.memory.enabled = false;
    settings.recentWindow = { size: 1, unit: 'turns' };
    const state = chatState([]);
    state.ownerChatId = 'chat-id';
    state.indexedThroughMessageId = 1;
    state.pendingVectorHashes = [123];
    state.pendingVectorDeleteHashes = [456];
    state.stageSummary.coveredThroughMessageId = -1;
    const context = {
      chat,
      chatId: 'chat-id',
      extensionSettings: { [MODULE_ID]: settings },
      chatMetadata: { [MODULE_ID]: state },
      saveSettingsDebounced: vi.fn(),
      saveMetadata: vi.fn(async () => undefined),
      generateRaw: vi.fn(async () => ''),
      getCurrentChatId: () => 'chat-id',
    };
    vi.stubGlobal('SillyTavern', { getContext: () => context });
    const reconcileExtraction = vi.spyOn(extractionService, 'reconcileHistory');
    const extract = vi.spyOn(extractionService, 'processNextThroughVerifiedHistory');
    const sync = vi.spyOn(extractionService, 'syncPendingVectors');
    const reconcileSummary = vi.spyOn(stageSummaryService, 'reconcileHistory')
      .mockResolvedValue(state);
    const summarize = vi.spyOn(stageSummaryService, 'processNextThrough')
      .mockImplementation(async (target) => {
        state.stageSummary.coveredThroughMessageId = target;
        return { state, updatedChunks: 1 };
      });

    await new BackgroundProcessingScheduler().runNow();

    expect(reconcileSummary).toHaveBeenCalledOnce();
    expect(summarize).toHaveBeenCalledWith(1);
    expect(reconcileExtraction).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    expect(state.pendingVectorHashes).toEqual([123]);
    expect(state.pendingVectorDeleteHashes).toEqual([456]);
  });

  it('reuses an append-only verified prefix across background replies', async () => {
    const chat = [
      ...turn('u1', 'a1'),
      ...turn('u2', 'a2'),
      ...turn('u3', 'a3'),
    ];
    const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
    settings.enabled = true;
    settings.memory.enabled = true;
    settings.recentWindow = { size: 1, unit: 'turns' };
    settings.summary.enabled = false;
    const state = chatState([]);
    state.ownerChatId = 'chat-id';
    state.indexedThroughMessageId = -1;
    const context = {
      chat,
      chatId: 'chat-id',
      extensionSettings: { [MODULE_ID]: settings },
      chatMetadata: { [MODULE_ID]: state },
      saveSettingsDebounced: vi.fn(),
      saveMetadata: vi.fn(async () => undefined),
      generateRaw: vi.fn(async () => ''),
      getCurrentChatId: () => 'chat-id',
    };
    vi.stubGlobal('SillyTavern', { getContext: () => context });
    const reconcile = vi.spyOn(extractionService, 'reconcileHistory').mockResolvedValue(state);
    const extract = vi.spyOn(extractionService, 'processNextThroughVerifiedHistory')
      .mockImplementation(async (target) => {
        state.indexedThroughMessageId = target;
        return state;
      });
    const scheduler = new BackgroundProcessingScheduler();

    await scheduler.runNow();
    chat.push(...turn('u4', 'a4'));
    await scheduler.runNow();

    expect(reconcile).toHaveBeenCalledOnce();
    expect(extract).toHaveBeenCalledTimes(2);
    expect(extract.mock.calls.map(([target]) => target)).toEqual([3, 5]);
  });

  it('backs off the same failed automatic extraction block without retrying before cooldown', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const chat = [
      ...turn('u1', 'a1'),
      ...turn('u2', 'a2'),
      ...turn('u3', 'a3'),
    ];
    const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
    settings.enabled = true;
    settings.memory.enabled = true;
    settings.recentWindow = { size: 1, unit: 'turns' };
    settings.summary.enabled = false;
    const state = chatState([]);
    state.ownerChatId = 'chat-id';
    state.indexedThroughMessageId = -1;
    const context = {
      chat,
      chatId: 'chat-id',
      extensionSettings: { [MODULE_ID]: settings },
      chatMetadata: { [MODULE_ID]: state },
      saveSettingsDebounced: vi.fn(),
      saveMetadata: vi.fn(async () => undefined),
      generateRaw: vi.fn(async () => ''),
      getCurrentChatId: () => 'chat-id',
    };
    vi.stubGlobal('SillyTavern', { getContext: () => context });
    vi.spyOn(extractionService, 'reconcileHistory').mockResolvedValue(state);
    const extract = vi.spyOn(extractionService, 'processNextThroughVerifiedHistory')
      .mockRejectedValueOnce(new Error('temporary provider failure'))
      .mockImplementation(async (target) => {
        state.indexedThroughMessageId = target;
        return state;
      });
    const scheduler = new BackgroundProcessingScheduler();

    await scheduler.runNow();
    expect(scheduler.snapshot(now)).toMatchObject({
      extractionCooldownActive: true,
      extractionCooldownFailures: 1,
      extractionCooldownRemainingMs: 30_000,
    });

    await scheduler.runNow();
    expect(extract).toHaveBeenCalledTimes(1);
    expect(structuredOutputDiagnosticsSnapshot().extractionCooldownSkips).toBe(1);

    now += 30_001;
    await scheduler.runNow();
    expect(extract).toHaveBeenCalledTimes(2);
    expect(scheduler.snapshot(now).extractionCooldownActive).toBe(false);
  });

  it('retries pending vector writes in the reply-complete background task', async () => {
    const chat = [...turn('u1', 'a1'), ...turn('u2', 'a2')];
    const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
    settings.enabled = true;
    settings.memory.enabled = true;
    settings.recentWindow = { size: 1, unit: 'turns' };
    settings.summary.enabled = false;
    const state = chatState([]);
    state.ownerChatId = 'chat-id';
    state.indexedThroughMessageId = 1;
    state.pendingVectorHashes = [123];
    const context = {
      chat,
      chatId: 'chat-id',
      extensionSettings: { [MODULE_ID]: settings },
      chatMetadata: { [MODULE_ID]: state },
      saveSettingsDebounced: vi.fn(),
      saveMetadata: vi.fn(async () => undefined),
      generateRaw: vi.fn(async () => ''),
      getCurrentChatId: () => 'chat-id',
    };
    vi.stubGlobal('SillyTavern', { getContext: () => context });
    vi.spyOn(extractionService, 'reconcileHistory').mockResolvedValue(state);
    const sync = vi.spyOn(extractionService, 'syncPendingVectors')
      .mockImplementation(async () => {
        state.pendingVectorHashes = [];
        return state;
      });

    await new BackgroundProcessingScheduler().runNow();

    expect(sync).toHaveBeenCalledOnce();
    expect(state.pendingVectorHashes).toEqual([]);
  });

  it('syncs pending vectors before a failing summary task can end the background run', async () => {
    const chat = [...turn('u1', 'a1'), ...turn('u2', 'a2')];
    const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
    settings.enabled = true;
    settings.memory.enabled = true;
    settings.recentWindow = { size: 1, unit: 'turns' };
    settings.summary.enabled = true;
    settings.summary.automatic = true;
    const state = chatState([]);
    state.ownerChatId = 'chat-id';
    state.indexedThroughMessageId = 1;
    state.pendingVectorHashes = [123];
    const context = {
      chat,
      chatId: 'chat-id',
      extensionSettings: { [MODULE_ID]: settings },
      chatMetadata: { [MODULE_ID]: state },
      saveSettingsDebounced: vi.fn(),
      saveMetadata: vi.fn(async () => undefined),
      generateRaw: vi.fn(async () => ''),
      getCurrentChatId: () => 'chat-id',
    };
    vi.stubGlobal('SillyTavern', { getContext: () => context });
    vi.spyOn(extractionService, 'reconcileHistory').mockResolvedValue(state);
    const sync = vi.spyOn(extractionService, 'syncPendingVectors')
      .mockImplementation(async () => {
        state.pendingVectorHashes = [];
        return state;
      });
    vi.spyOn(stageSummaryService, 'processNextThrough')
      .mockRejectedValue(new Error('summary unavailable'));

    await new BackgroundProcessingScheduler().runNow();

    expect(sync).toHaveBeenCalledOnce();
    expect(state.pendingVectorHashes).toEqual([]);
  });

  it('invalidates the append-only shortcut after a delete or branch event', async () => {
    const chat = [...turn('u1', 'a1'), ...turn('u2', 'a2')];
    const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
    settings.enabled = true;
    settings.memory.enabled = true;
    settings.recentWindow = { size: 1, unit: 'turns' };
    settings.summary.enabled = false;
    const state = chatState([]);
    state.ownerChatId = 'chat-id';
    state.indexedThroughMessageId = -1;
    const handlers = new Map<string, (...args: unknown[]) => void | Promise<void>>();
    const context = {
      chat,
      chatId: 'chat-id',
      extensionSettings: { [MODULE_ID]: settings },
      chatMetadata: { [MODULE_ID]: state },
      event_types: {
        MESSAGE_RECEIVED: 'message-received',
        MESSAGE_DELETED: 'message-deleted',
        CHAT_CHANGED: 'chat-changed',
      },
      eventSource: {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void | Promise<void>) => {
          handlers.set(event, handler);
        }),
        off: vi.fn(),
      },
      saveSettingsDebounced: vi.fn(),
      saveMetadata: vi.fn(async () => undefined),
      generateRaw: vi.fn(async () => ''),
      getCurrentChatId: () => 'chat-id',
    };
    vi.stubGlobal('SillyTavern', { getContext: () => context });
    const reconcile = vi.spyOn(extractionService, 'reconcileHistory').mockResolvedValue(state);
    vi.spyOn(extractionService, 'processNextThroughVerifiedHistory')
      .mockImplementation(async (target) => {
        state.indexedThroughMessageId = target;
        return state;
      });
    const scheduler = new BackgroundProcessingScheduler();
    const schedule = vi.spyOn(scheduler, 'schedule').mockImplementation(() => undefined);
    scheduler.register();
    schedule.mockClear();

    await scheduler.runNow();
    handlers.get('message-deleted')?.();
    expect(schedule).toHaveBeenCalledOnce();
    await scheduler.runNow();
    scheduler.unregister();

    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('purges a registered StoryEcho vector collection when its chat is deleted', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
    const handlers = new Map<string, (...args: unknown[]) => void | Promise<void>>();
    const context = {
      chat: [],
      chatId: 'current-chat',
      extensionSettings: { [MODULE_ID]: settings },
      chatMetadata: {},
      event_types: {
        MESSAGE_RECEIVED: 'message-received',
        CHAT_DELETED: 'chat-deleted',
      },
      eventSource: {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void | Promise<void>) => {
          handlers.set(event, handler);
        }),
        off: vi.fn(),
      },
      saveSettingsDebounced: vi.fn(),
      saveMetadata: vi.fn(async () => undefined),
      generateRaw: vi.fn(async () => ''),
      getCurrentChatId: () => 'current-chat',
      getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    };
    vi.stubGlobal('SillyTavern', { getContext: () => context });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vectorCollectionRegistry.remember('deleted-chat', 'story_echo_deleted-chat_v1');
    const scheduler = new BackgroundProcessingScheduler();
    vi.spyOn(scheduler, 'schedule').mockImplementation(() => undefined);
    scheduler.register();

    await handlers.get('chat-deleted')?.('deleted-chat');
    scheduler.unregister();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      collectionId: 'story_echo_deleted-chat_v1',
    });
    expect(vectorCollectionRegistry.pendingCount()).toBe(0);
  });

  it('keeps a stopped reply on the current branch and only dirties history after a branch change', async () => {
    const chat = [
      ...turn('u1', 'a1'),
      ...turn('u2', 'a2'),
    ];
    const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
    settings.enabled = true;
    settings.memory.enabled = true;
    settings.recentWindow = { size: 1, unit: 'turns' };
    settings.summary.enabled = false;
    const state = chatState([]);
    state.ownerChatId = 'chat-id';
    state.indexedThroughMessageId = -1;
    const handlers = new Map<string, (...args: unknown[]) => void | Promise<void>>();
    const context = {
      chat,
      chatId: 'chat-id',
      extensionSettings: { [MODULE_ID]: settings },
      chatMetadata: { [MODULE_ID]: state },
      event_types: {
        MESSAGE_RECEIVED: 'message-received',
        CHAT_CHANGED: 'chat-changed',
        GENERATION_STOPPED: 'generation-stopped',
      },
      eventSource: {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void | Promise<void>) => {
          handlers.set(event, handler);
        }),
        off: vi.fn(),
      },
      saveSettingsDebounced: vi.fn(),
      saveMetadata: vi.fn(async () => undefined),
      generateRaw: vi.fn(async () => ''),
      getCurrentChatId: () => 'chat-id',
    };
    vi.stubGlobal('SillyTavern', { getContext: () => context });
    const releaseLease = vi.spyOn(storyEchoTaskCoordinator, 'releaseForegroundLease');
    const cancelBackground = vi.spyOn(storyEchoTaskCoordinator, 'cancelRunningBackground');
    const reconcile = vi.spyOn(extractionService, 'reconcileHistory').mockResolvedValue(state);
    vi.spyOn(extractionService, 'processNextThroughVerifiedHistory')
      .mockImplementation(async (target) => {
        state.indexedThroughMessageId = target;
        return state;
      });
    const scheduler = new BackgroundProcessingScheduler();
    const schedule = vi.spyOn(scheduler, 'schedule').mockImplementation(() => undefined);
    scheduler.register();
    expect(schedule).toHaveBeenCalledOnce();
    schedule.mockClear();

    await scheduler.runNow();
    expect(reconcile).toHaveBeenCalledOnce();

    chat.push({ is_user: true, mes: 'u3' });
    handlers.get('generation-stopped')?.();
    chat.push({ is_user: false, mes: '被用户停止但保留在当前分支的半截回复' });
    handlers.get('message-received')?.();
    await scheduler.runNow();

    expect(schedule).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(releaseLease).toHaveBeenCalledWith('generation-stopped');
    expect(releaseLease).toHaveBeenCalledWith('assistant-message-received');

    handlers.get('chat-changed')?.();
    await scheduler.runNow();
    scheduler.unregister();

    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(releaseLease).toHaveBeenCalledWith('chat-changed');
    expect(cancelBackground).toHaveBeenCalledWith('聊天分支已经切换');
  });

  it('releases the reply lease immediately when an assistant swipe changes branch', async () => {
    const chat = [...turn('u1', 'a1')];
    const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
    settings.enabled = true;
    settings.memory.enabled = false;
    const state = chatState([]);
    state.ownerChatId = 'chat-id';
    const handlers = new Map<string, (...args: unknown[]) => void | Promise<void>>();
    const context = {
      chat,
      chatId: 'chat-id',
      extensionSettings: { [MODULE_ID]: settings },
      chatMetadata: { [MODULE_ID]: state },
      event_types: {
        MESSAGE_RECEIVED: 'message-received',
        MESSAGE_SWIPED: 'message-swiped',
      },
      eventSource: {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void | Promise<void>) => {
          handlers.set(event, handler);
        }),
        off: vi.fn(),
      },
      saveSettingsDebounced: vi.fn(),
      saveMetadata: vi.fn(async () => undefined),
      generateRaw: vi.fn(async () => ''),
      getCurrentChatId: () => 'chat-id',
    };
    vi.stubGlobal('SillyTavern', { getContext: () => context });
    const scheduler = new BackgroundProcessingScheduler();
    const schedule = vi.spyOn(scheduler, 'schedule').mockImplementation(() => undefined);
    const cancelBackground = vi.spyOn(storyEchoTaskCoordinator, 'cancelRunningBackground');
    scheduler.register();
    schedule.mockClear();

    await storyEchoTaskCoordinator.enqueueForeground('old reply', async () => true);
    expect(storyEchoTaskCoordinator.snapshot().foregroundLeaseActive).toBe(true);
    const manualStarted = vi.fn();
    const manual = storyEchoTaskCoordinator.enqueueManual('queued manual', async () => {
      manualStarted();
    });
    await Promise.resolve();
    expect(manualStarted).not.toHaveBeenCalled();

    handlers.get('message-swiped')?.();
    await manual;
    scheduler.unregister();

    expect(storyEchoTaskCoordinator.snapshot().foregroundLeaseActive).toBe(false);
    expect(cancelBackground).toHaveBeenCalledWith('聊天回复分支已经切换');
    expect(schedule).toHaveBeenCalledOnce();
  });

  it('forces reconciliation when history mutates during background extraction', async () => {
    const chat = [...turn('u1', 'a1'), ...turn('u2', 'a2')];
    const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
    settings.enabled = true;
    settings.memory.enabled = true;
    settings.recentWindow = { size: 1, unit: 'turns' };
    settings.summary.enabled = false;
    const state = chatState([]);
    state.ownerChatId = 'chat-id';
    state.indexedThroughMessageId = -1;
    const handlers = new Map<string, (...args: unknown[]) => void | Promise<void>>();
    const context = {
      chat,
      chatId: 'chat-id',
      extensionSettings: { [MODULE_ID]: settings },
      chatMetadata: { [MODULE_ID]: state },
      event_types: {
        MESSAGE_RECEIVED: 'message-received',
        MESSAGE_EDITED: 'message-edited',
      },
      eventSource: {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void | Promise<void>) => {
          handlers.set(event, handler);
        }),
        off: vi.fn(),
      },
      saveSettingsDebounced: vi.fn(),
      saveMetadata: vi.fn(async () => undefined),
      generateRaw: vi.fn(async () => ''),
      getCurrentChatId: () => 'chat-id',
    };
    vi.stubGlobal('SillyTavern', { getContext: () => context });
    const reconcile = vi.spyOn(extractionService, 'reconcileHistory').mockResolvedValue(state);
    vi.spyOn(extractionService, 'processNextThroughVerifiedHistory')
      .mockImplementation(async (target) => {
        handlers.get('message-edited')?.();
        state.indexedThroughMessageId = target;
        state.indexedPrefixHash = 'hash-written-after-edit';
        return state;
      });
    const scheduler = new BackgroundProcessingScheduler();
    scheduler.register();

    await scheduler.runNow();
    scheduler.unregister();

    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(reconcile.mock.calls[1]?.[0]?.indexedPrefixHash).toBe('dirty:1');
  });
});
