import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activateStoryEchoPublicApi,
  beginStoryEchoExternalGeneration,
  clearStoryEchoLastInjection,
  deactivateStoryEchoPublicApi,
  recordStoryEchoLastInjection,
  registerStoryEchoPublicApi,
  STORY_ECHO_PUBLIC_API_NAME,
  STORY_ECHO_PUBLIC_API_VERSION,
  storyEchoReadApi,
  type StoryEchoPublicChangeView,
} from '../src/api/read-api';
import { emitStoryEchoPublicApiChanged } from '../src/api/change-events';
import { MODULE_ID } from '../src/core/constants';
import type { SillyTavernContext } from '../src/platform/sillytavern';
import { StoryStateRepository } from '../src/state/repository';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { SettingsRepository } from '../src/settings/repository';
import { chatState } from './fixtures';

interface InstalledContext {
  context: SillyTavernContext;
  setChatId(chatId: string): void;
  saveMetadata: ReturnType<typeof vi.fn>;
  registerExtensionApi: ReturnType<typeof vi.fn>;
  eventHandlers: Map<string, (...args: unknown[]) => void | Promise<void>>;
}

function summary(
  text: string,
  level: number,
  start: number,
  end: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    text,
    level,
    sourceStartMessageId: start,
    sourceEndMessageId: end,
    sourceHash: `hash-${start}-${end}`,
    updatedAt: `2026-09-12T00:00:0${start}.000Z`,
    ...overrides,
  };
}

function installContext(): InstalledContext {
  let currentChatId = 'chat-id';
  const eventHandlers = new Map<string, (...args: unknown[]) => void | Promise<void>>();
  const extensionApis = new Map<string, object>();
  const saveMetadata = vi.fn(async () => undefined);
  const registerExtensionApi = vi.fn((name: string, api: object) => {
    extensionApis.set(name, api);
  });
  const state = chatState({
    stageSummary: {
      entries: [
        summary('first summary', 1, 0, 1, {
          generation: {
            provider: 'main',
            requestedMaxTokens: 3_000,
            finishReason: 'length',
            responseCharacters: 13,
          },
        }),
        summary('', 1, 2, 3, { deleted: true }),
        summary('higher summary', 2, 4, 5),
      ],
      coveredThroughMessageId: 5,
      coveredThroughHash: 'hash-4-5',
    },
  });
  const context: SillyTavernContext = {
    chat: [],
    get chatId() {
      return currentChatId;
    },
    extensionSettings: {
      [MODULE_ID]: { ...structuredClone(DEFAULT_SETTINGS), enabled: true },
    },
    chatMetadata: { [MODULE_ID]: state },
    eventSource: {
      on: vi.fn((eventName, handler) => {
        eventHandlers.set(eventName, handler);
      }),
      off: vi.fn((eventName, handler) => {
        if (eventHandlers.get(eventName) === handler) {
          eventHandlers.delete(eventName);
        }
      }),
    },
    eventTypes: {
      CHAT_CHANGED: 'chat-changed',
      CHAT_LOADED: 'chat-loaded',
    },
    saveSettingsDebounced: vi.fn(),
    saveMetadata,
    generateRaw: vi.fn(async () => ''),
    registerExtensionApi,
    getExtensionApi: (name) => extensionApis.get(name),
  };
  vi.stubGlobal('SillyTavern', { getContext: () => context });
  return {
    context,
    setChatId: (chatId) => {
      currentChatId = chatId;
    },
    saveMetadata,
    registerExtensionApi,
    eventHandlers,
  };
}

beforeEach(() => {
  deactivateStoryEchoPublicApi();
  clearStoryEchoLastInjection();
  globalThis.StoryEcho = undefined;
});

afterEach(() => {
  deactivateStoryEchoPublicApi();
  clearStoryEchoLastInjection();
  globalThis.StoryEcho = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('StoryEcho read-only public API', () => {
  it('registers one stable API in Luker and exposes the same API globally', () => {
    const installed = installContext();

    activateStoryEchoPublicApi();
    expect(registerStoryEchoPublicApi()).toBe(true);

    expect(installed.registerExtensionApi).toHaveBeenCalledOnce();
    expect(installed.registerExtensionApi).toHaveBeenCalledWith(
      STORY_ECHO_PUBLIC_API_NAME,
      storyEchoReadApi,
    );
    expect(globalThis.StoryEcho).toEqual({
      version: storyEchoReadApi.extensionVersion,
      api: storyEchoReadApi,
    });
    expect(globalThis.StoryEcho?.api.apiVersion).toBe(STORY_ECHO_PUBLIC_API_VERSION);
    expect(Object.isFrozen(storyEchoReadApi)).toBe(true);
    expect(Object.isFrozen(globalThis.StoryEcho)).toBe(true);
  });

  it('keeps the global API available when optional host registration fails', () => {
    const installed = installContext();
    installed.context.getExtensionApi = () => undefined;
    installed.context.registerExtensionApi = vi.fn(() => {
      throw new Error('host registry failed');
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    activateStoryEchoPublicApi();

    expect(globalThis.StoryEcho?.api).toBe(storyEchoReadApi);
    expect(registerStoryEchoPublicApi()).toBe(false);
    expect(warning).toHaveBeenCalledWith(
      '[StoryEcho] Could not register the read-only API with this host.',
    );
    warning.mockRestore();
  });

  it('returns frozen active-frontier views without writing chat metadata', () => {
    const installed = installContext();
    activateStoryEchoPublicApi();

    const frontier = storyEchoReadApi.getFrontier();
    const coverage = storyEchoReadApi.getCoverage();

    expect(frontier).toHaveLength(2);
    expect(frontier.map((entry) => entry.text)).toEqual([
      'first summary',
      'higher summary',
    ]);
    expect(frontier[0]).toMatchObject({
      level: 1,
      sourceStartMessageId: 0,
      sourceEndMessageId: 1,
      characterCount: 13,
      outputTruncated: true,
      manuallyEdited: false,
    });
    expect(Object.isFrozen(frontier)).toBe(true);
    expect(Object.isFrozen(frontier[0])).toBe(true);
    expect(Object.isFrozen(frontier[0]?.truncatedSourceRanges)).toBe(true);
    expect(coverage).toEqual({
      active: true,
      enabled: true,
      chatId: 'chat-id',
      chatUuid: 'chat-uuid',
      coveredThroughMessageId: 5,
      coveredThroughHash: 'hash-4-5',
      updatedAt: '2026-09-12T00:00:04.000Z',
      frontierEntryCount: 2,
      storedEntryCount: 3,
      deletedEntryCount: 1,
      levelCounts: [
        { level: 1, count: 1 },
        { level: 2, count: 1 },
      ],
      rebuildInProgress: false,
      rebuildDraftEntryCount: 0,
    });
    expect(Object.isFrozen(coverage)).toBe(true);
    expect(Object.isFrozen(coverage?.levelCounts)).toBe(true);
    expect(installed.saveMetadata).not.toHaveBeenCalled();
  });

  it('does not create state when the current chat has no StoryEcho metadata', () => {
    const installed = installContext();
    delete installed.context.chatMetadata[MODULE_ID];
    activateStoryEchoPublicApi();

    expect(storyEchoReadApi.getFrontier()).toEqual([]);
    expect(storyEchoReadApi.getCoverage()).toMatchObject({
      chatId: 'chat-id',
      chatUuid: null,
      coveredThroughMessageId: -1,
      frontierEntryCount: 0,
      storedEntryCount: 0,
    });
    expect(installed.context.chatMetadata).not.toHaveProperty(MODULE_ID);
    expect(installed.saveMetadata).not.toHaveBeenCalled();
  });

  it('publishes only the current chat\'s exact most-recent injection snapshot', () => {
    const installed = installContext();
    activateStoryEchoPublicApi();
    const entries = chatState({
      stageSummary: {
        entries: [summary('injected summary', 1, 0, 1)],
        coveredThroughMessageId: 1,
        coveredThroughHash: 'hash-0-1',
      },
    }).stageSummary.entries;

    recordStoryEchoLastInjection({
      generationToken: beginStoryEchoExternalGeneration(),
      chatId: 'chat-id',
      chatUuid: 'chat-uuid',
      generationType: 'normal',
      retainedStartMessageId: 2,
      removedMessageCount: 2,
      text: '<story_echo_history>exact block</story_echo_history>',
      summaries: entries,
    });

    const injection = storyEchoReadApi.getLastInjection();
    expect(injection).toMatchObject({
      chatId: 'chat-id',
      generationType: 'normal',
      retainedStartMessageId: 2,
      removedMessageCount: 2,
      text: '<story_echo_history>exact block</story_echo_history>',
      summaries: [{ text: 'injected summary' }],
    });
    expect(Object.isFrozen(injection)).toBe(true);
    expect(Object.isFrozen(injection?.summaries)).toBe(true);
    expect(Object.isFrozen(injection?.summaries[0])).toBe(true);

    installed.setChatId('other-chat');
    expect(storyEchoReadApi.getLastInjection()).toBeNull();
  });

  it('emits deduplicated frozen snapshots and supports idempotent unsubscribe', async () => {
    installContext();
    activateStoryEchoPublicApi();
    const listener = vi.fn();
    const unsubscribe = storyEchoReadApi.onStateChanged(listener);

    emitStoryEchoPublicApiChanged('state');
    expect(listener).not.toHaveBeenCalled();

    const state = new StoryStateRepository().getExisting()!;
    state.stageSummary.entries[0] = {
      ...state.stageSummary.entries[0]!,
      text: 'edited through repository',
      updatedAt: '2026-09-12T01:00:00.000Z',
      manuallyEdited: true,
    };
    await new StoryStateRepository().save(state);

    expect(listener).toHaveBeenCalledOnce();
    const change = listener.mock.calls[0]![0];
    expect(change).toMatchObject({ reason: 'state', active: true });
    expect(change.frontier[0]).toMatchObject({
      text: 'edited through repository',
      manuallyEdited: true,
    });
    expect(Object.isFrozen(change)).toBe(true);
    expect(Object.isFrozen(change.frontier)).toBe(true);

    unsubscribe();
    unsubscribe();
    clearStoryEchoLastInjection();
    expect(listener).toHaveBeenCalledOnce();
  });

  it('notifies on exposed setting changes and isolates consumer failures', () => {
    installContext();
    activateStoryEchoPublicApi();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const listener = vi.fn<(change: StoryEchoPublicChangeView) => void>(() => {
      throw new Error('consumer failed');
    });
    const unsubscribe = storyEchoReadApi.onStateChanged(listener);

    expect(() => new SettingsRepository().update((settings) => {
      settings.enabled = false;
    })).not.toThrow();

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]![0]).toMatchObject({
      reason: 'settings',
      coverage: { enabled: false },
    });
    expect(warning).toHaveBeenCalledWith('[StoryEcho] Public API change listener failed.');
    unsubscribe();
    warning.mockRestore();
  });

  it('clears the runtime injection and notifies subscribers when the chat changes', async () => {
    const installed = installContext();
    activateStoryEchoPublicApi();
    recordStoryEchoLastInjection({
      generationToken: beginStoryEchoExternalGeneration(),
      chatId: 'chat-id',
      chatUuid: 'chat-uuid',
      generationType: 'swipe',
      retainedStartMessageId: 2,
      removedMessageCount: 2,
      text: 'block',
      summaries: [summary('summary', 1, 0, 1)],
    });
    const listener = vi.fn();
    const unsubscribe = storyEchoReadApi.onStateChanged(listener);

    installed.setChatId('other-chat');
    installed.eventHandlers.get('chat-changed')?.();
    await Promise.resolve();

    expect(storyEchoReadApi.getLastInjection()).toBeNull();
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]![0]).toMatchObject({
      reason: 'chat',
      coverage: {
        chatId: 'other-chat',
        chatUuid: null,
        coveredThroughMessageId: -1,
      },
      frontier: [],
      lastInjection: null,
    });
    unsubscribe();
  });

  it('rejects a stale injection from an older overlapping generation', () => {
    installContext();
    activateStoryEchoPublicApi();
    const olderToken = beginStoryEchoExternalGeneration();
    const latestToken = beginStoryEchoExternalGeneration();
    const base = {
      chatId: 'chat-id',
      chatUuid: 'chat-uuid',
      generationType: 'normal',
      retainedStartMessageId: 2,
      removedMessageCount: 2,
      text: 'block',
      summaries: [summary('summary', 1, 0, 1)],
    };

    expect(recordStoryEchoLastInjection({
      ...base,
      generationToken: olderToken,
    })).toBe(false);
    expect(storyEchoReadApi.getLastInjection()).toBeNull();

    expect(recordStoryEchoLastInjection({
      ...base,
      generationToken: latestToken,
    })).toBe(true);
    expect(storyEchoReadApi.getLastInjection()?.text).toBe('block');
  });
});
