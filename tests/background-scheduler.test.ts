import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoryEchoSettings, TavernChatMessage } from '../src/core/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { chatState } from './fixtures';

const mocks = vi.hoisted(() => ({
  getOrCreate: vi.fn(),
  adoptRenamedChat: vi.fn(),
  reconcileSummary: vi.fn(),
  processNextSummary: vi.fn(),
  processNextCompaction: vi.fn(),
}));

vi.mock('../src/state/repository', () => ({
  StoryStateRepository: class {
    getOrCreate = mocks.getOrCreate;
    adoptRenamedChat = mocks.adoptRenamedChat;
  },
}));
vi.mock('../src/summary/service', () => ({
  stageSummaryService: {
    reconcileHistory: mocks.reconcileSummary,
    processNextThrough: mocks.processNextSummary,
  },
}));
vi.mock('../src/summary/compaction-service', () => ({
  summaryCompactionService: {
    processNextIfNeeded: mocks.processNextCompaction,
  },
}));

import {
  BackgroundProcessingScheduler,
  backgroundTargetMessageId,
} from '../src/background/scheduler';
import { storyEchoTaskCoordinator } from '../src/runtime/task-coordinator';

function settings(overrides: Partial<StoryEchoSettings> = {}): StoryEchoSettings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    ...overrides,
  };
}

function chat(turns: number, endsWithAssistant = true): TavernChatMessage[] {
  const messages: TavernChatMessage[] = [];
  for (let index = 0; index < turns; index += 1) {
    messages.push({ is_user: true, mes: `u-${index}` });
    messages.push({ is_user: false, mes: `a-${index}` });
  }
  if (!endsWithAssistant) {
    messages.push({ is_user: true, mes: 'pending' });
  }
  return messages;
}

function customEvent(name: string, detail: unknown): Event {
  const event = new Event(name);
  Object.defineProperty(event, 'detail', { value: detail });
  return event;
}

function installContext(
  messages: TavernChatMessage[],
  currentSettings: StoryEchoSettings,
): {
  handlers: Map<string, (...args: unknown[]) => unknown>;
  off: ReturnType<typeof vi.fn>;
} {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const off = vi.fn();
  const context = {
    chat: messages,
    chatId: 'chat-id',
    extensionSettings: { story_echo: currentSettings },
    chatMetadata: {},
    saveSettingsDebounced: vi.fn(),
    saveMetadata: vi.fn(async () => undefined),
    generateRaw: vi.fn(async () => ''),
    eventSource: {
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(event, handler);
      }),
      off,
    },
    eventTypes: {
      MESSAGE_RECEIVED: 'received',
      CHAT_CHANGED: 'changed',
      MESSAGE_EDITED: 'edited',
      CHAT_RENAMED: 'renamed',
      GENERATION_STOPPED: 'stopped',
      GENERATION_ENDED: 'ended',
      CHAT_COMPLETION_SETTINGS_READY: 'completion-settings-ready',
    },
  };
  vi.stubGlobal('SillyTavern', { getContext: () => context });
  return { handlers, off };
}

beforeEach(() => {
  vi.clearAllMocks();
  const state = chatState();
  mocks.getOrCreate.mockResolvedValue(state);
  mocks.reconcileSummary.mockResolvedValue(state);
  mocks.processNextSummary.mockResolvedValue({ state, updatedChunks: 0 });
  mocks.processNextCompaction.mockResolvedValue({ state, compactedChunks: 0, pending: false });
});

afterEach(() => {
  storyEchoTaskCoordinator.resetForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('background target', () => {
  it('selects only history outside a completed recent-turn window', () => {
    const current = settings();
    current.recentWindow = { size: 2, unit: 'turns' };
    expect(backgroundTargetMessageId(chat(5), current)).toBe(5);
    expect(backgroundTargetMessageId(chat(5, false), current)).toBe(-1);
    expect(backgroundTargetMessageId([], current)).toBe(-1);
  });

  it('supports message-count windows', () => {
    const current = settings();
    current.recentWindow = { size: 3, unit: 'messages' };
    expect(backgroundTargetMessageId(chat(4), current)).toBe(4);
  });
});

describe('BackgroundProcessingScheduler', () => {
  it('does no work when context management is disabled', async () => {
    const current = settings({ enabled: false });
    installContext(chat(5), current);
    const scheduler = new BackgroundProcessingScheduler();
    await scheduler.runNow();
    expect(mocks.getOrCreate).not.toHaveBeenCalled();
    scheduler.unregister();
  });

  it('reconciles state, advances one summary and checks hierarchy compaction', async () => {
    const current = settings({ enabled: true });
    current.recentWindow.size = 2;
    installContext(chat(5), current);
    const state = chatState();
    mocks.getOrCreate.mockResolvedValue(state);
    mocks.processNextSummary.mockResolvedValue({ state, updatedChunks: 1 });

    const scheduler = new BackgroundProcessingScheduler();
    await scheduler.runNow();

    expect(mocks.reconcileSummary).toHaveBeenCalledWith(state);
    expect(mocks.processNextSummary).toHaveBeenCalledWith(5);
    expect(mocks.processNextCompaction).toHaveBeenCalledOnce();
    scheduler.unregister();
  });

  it('registers and removes lifecycle handlers and migrates a renamed chat', async () => {
    vi.useFakeTimers();
    const current = settings({ enabled: true });
    const { handlers, off } = installContext(chat(3), current);
    const scheduler = new BackgroundProcessingScheduler();

    expect(scheduler.register()).toBe(true);
    expect(handlers.has('received')).toBe(true);
    expect(handlers.has('changed')).toBe(true);
    expect(handlers.has('renamed')).toBe(true);
    await handlers.get('renamed')?.({ oldFileName: 'old', newFileName: 'new' });
    expect(mocks.adoptRenamedChat).toHaveBeenCalledWith('old', 'new');

    scheduler.unregister();
    expect(off).toHaveBeenCalled();
  });

  it('returns false when the reply event is unavailable', () => {
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({
        chat: [],
        extensionSettings: {},
        chatMetadata: {},
        saveSettingsDebounced: vi.fn(),
        saveMetadata: vi.fn(),
        generateRaw: vi.fn(),
      }),
    });
    expect(new BackgroundProcessingScheduler().register({ silent: true })).toBe(false);
  });

  it('keeps the foreground lease through Agent intermediate commits', async () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    vi.stubGlobal('addEventListener', target.addEventListener.bind(target));
    vi.stubGlobal('removeEventListener', target.removeEventListener.bind(target));
    vi.stubGlobal('__TAURITAVERN__', {
      api: { agent: { readModelTurn: vi.fn() } },
    });
    const current = settings({ enabled: true });
    const { handlers } = installContext(chat(3), current);
    const scheduler = new BackgroundProcessingScheduler();
    expect(scheduler.register()).toBe(true);
    vi.clearAllTimers();

    await storyEchoTaskCoordinator.enqueueForeground(
      'Agent上下文准备',
      async () => true,
      { holdForegroundLease: (prepared) => prepared },
    );
    target.dispatchEvent(customEvent('tauritavern-agent-run-state-changed', {
      activeRun: { runId: 'run-1', generationType: 'normal' },
    }));

    handlers.get('received')?.();
    handlers.get('stopped')?.();
    handlers.get('changed')?.();
    expect(storyEchoTaskCoordinator.snapshot().foregroundLeaseActive).toBe(true);

    target.dispatchEvent(customEvent('tauritavern-agent-run-state-changed', {
      activeRun: null,
      lastEvent: { type: 'run_completed' },
    }));
    expect(storyEchoTaskCoordinator.snapshot().foregroundLeaseActive).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    scheduler.unregister();
  });
});
