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
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { stageSummaryService } from '../src/summary/service';
import { chatState } from './fixtures';

afterEach(() => {
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
    settings.recentWindow = { size: 1, unit: 'turns' };
    settings.extraction.automatic = true;
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

  it('reuses an append-only verified prefix across background replies', async () => {
    const chat = [
      ...turn('u1', 'a1'),
      ...turn('u2', 'a2'),
      ...turn('u3', 'a3'),
    ];
    const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
    settings.enabled = true;
    settings.recentWindow = { size: 1, unit: 'turns' };
    settings.extraction.automatic = true;
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

  it('backs off the same failed automatic extraction block without blocking later foreground safety work', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const chat = [
      ...turn('u1', 'a1'),
      ...turn('u2', 'a2'),
      ...turn('u3', 'a3'),
    ];
    const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
    settings.enabled = true;
    settings.recentWindow = { size: 1, unit: 'turns' };
    settings.extraction.automatic = true;
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

  it('invalidates the append-only shortcut after a delete or branch event', async () => {
    const chat = [...turn('u1', 'a1'), ...turn('u2', 'a2')];
    const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
    settings.enabled = true;
    settings.recentWindow = { size: 1, unit: 'turns' };
    settings.extraction.automatic = true;
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
    scheduler.register();

    await scheduler.runNow();
    handlers.get('message-deleted')?.();
    await scheduler.runNow();
    scheduler.unregister();

    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('forces reconciliation when history mutates during background extraction', async () => {
    const chat = [...turn('u1', 'a1'), ...turn('u2', 'a2')];
    const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
    settings.enabled = true;
    settings.recentWindow = { size: 1, unit: 'turns' };
    settings.extraction.automatic = true;
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
