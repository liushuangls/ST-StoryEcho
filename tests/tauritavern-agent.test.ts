import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SillyTavernContext } from '../src/platform/sillytavern';
import {
  agentUsageInputTokens,
  TauriTavernAgentBridge,
} from '../src/platform/tauritavern-agent';

function customEvent(name: string, detail: unknown): Event {
  const event = new Event(name);
  Object.defineProperty(event, 'detail', { value: detail });
  return event;
}

function installContext(): {
  context: SillyTavernContext;
  handlers: Map<string, (...args: unknown[]) => void | Promise<void>>;
  off: ReturnType<typeof vi.fn>;
} {
  const handlers = new Map<string, (...args: unknown[]) => void | Promise<void>>();
  const off = vi.fn();
  const context: SillyTavernContext = {
    chat: [
      { is_user: true, mes: 'hello' },
      { is_user: false, mes: 'hi' },
    ],
    chatId: 'chat-id',
    extensionSettings: {},
    chatMetadata: {},
    saveSettingsDebounced: vi.fn(),
    saveMetadata: vi.fn(async () => undefined),
    generateRaw: vi.fn(async () => ''),
    eventSource: {
      on: vi.fn((event, handler) => handlers.set(event, handler)),
      off,
    },
    eventTypes: {
      CHAT_COMPLETION_SETTINGS_READY: 'completion-settings-ready',
    },
  };
  vi.stubGlobal('SillyTavern', { getContext: () => context });
  return { context, handlers, off };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('TauriTavern Agent compatibility bridge', () => {
  it('captures only the final prompt surface and detects Agent Profile re-trimming', () => {
    const target = new EventTarget();
    const readModelTurn = vi.fn();
    vi.stubGlobal('__TAURITAVERN__', { api: { agent: { readModelTurn } } });
    const { context, handlers, off } = installContext();
    const bridge = new TauriTavernAgentBridge(target);
    const stateChanges: unknown[] = [];

    expect(bridge.register(context)).toBe(true);
    bridge.subscribeRunState((change) => stateChanges.push(change));
    bridge.beginStoryEchoPreparation('chat-id');
    bridge.markStoryEchoSummaryInjected('chat-id', 2);
    handlers.get('completion-settings-ready')?.({
      messages: [
        { role: 'system', content: '<story_echo_skeleton>partial</story_echo_skeleton>' },
        { role: 'user', content: 'continue' },
      ],
      tools: [{ type: 'function', function: { name: 'search' } }],
      chat_completion_source: 'custom',
      model: 'agent-model',
      api_key: 'must-not-be-captured',
    });
    target.dispatchEvent(customEvent('tauritavern-agent-run-state-changed', {
      activeRun: { runId: 'run-1', generationType: 'normal' },
      lastEvent: null,
    }));

    expect(bridge.isRunActive()).toBe(true);
    context.chat.push({
      is_user: false,
      mes: 'agent reply',
      extra: { tauritavern: { agent: { runId: 'run-1', profileId: 'profile-1' } } },
    });
    const snapshot = bridge.promptForLatestMessage(context);
    expect(snapshot).toMatchObject({
      runId: 'run-1',
      expectedMessageId: 2,
      api: 'custom',
      model: 'agent-model',
      profile: 'profile-1',
      storyEchoTrimmedByAgentAssembly: true,
    });
    expect(snapshot?.toolDefinitions).toHaveLength(1);
    expect(snapshot).not.toHaveProperty('api_key');

    target.dispatchEvent(customEvent('tauritavern-agent-run-state-changed', {
      activeRun: null,
      lastEvent: { type: 'run_completed' },
    }));
    expect(bridge.isRunActive()).toBe(false);
    expect(stateChanges).toContainEqual({
      activeRunId: null,
      previousRunId: 'run-1',
      terminalEventType: 'run_completed',
    });

    bridge.unregister();
    expect(off).toHaveBeenCalledWith(
      'completion-settings-ready',
      expect.any(Function),
    );
  });

  it('reads the first model invocation usage and ignores later rounds', async () => {
    const target = new EventTarget();
    const readModelTurn = vi.fn(async () => ({
      provider: {
        source: 'openrouter',
        model: 'provider-model',
        usage: { prompt_tokens: 1_234 },
      },
    }));
    vi.stubGlobal('__TAURITAVERN__', { api: { agent: { readModelTurn } } });
    const { context, handlers } = installContext();
    const bridge = new TauriTavernAgentBridge(target);
    bridge.register(context);
    bridge.beginStoryEchoPreparation('chat-id');
    bridge.markStoryEchoSummaryInjected('chat-id');
    handlers.get('completion-settings-ready')?.({
      messages: [{
        role: 'system',
        content: '<story_echo_summary>older plot</story_echo_summary>',
      }],
    });
    target.dispatchEvent(customEvent('tauritavern-agent-run-state-changed', {
      activeRun: { runId: 'run-2', generationType: 'normal' },
    }));
    context.chat.push({
      is_user: false,
      mes: 'agent reply',
      extra: { tauritavern: { agent: { runId: 'run-2' } } },
    });
    target.dispatchEvent(customEvent('tauritavern-agent-run-event', {
      event: {
        type: 'model_completed',
        runId: 'run-2',
        payload: { round: 2, invocationId: 'later' },
      },
    }));
    target.dispatchEvent(customEvent('tauritavern-agent-run-event', {
      event: {
        type: 'model_completed',
        runId: 'run-2',
        payload: { round: 1, invocationId: 'first' },
      },
    }));

    await vi.waitFor(() => {
      expect(bridge.promptForLatestMessage(context)?.actualInputTokens).toBe(1_234);
    });
    expect(readModelTurn).toHaveBeenCalledOnce();
    expect(readModelTurn).toHaveBeenCalledWith({
      runId: 'run-2',
      round: 1,
      invocationId: 'first',
      maxChars: 1,
    });
    expect(bridge.promptForLatestMessage(context)).toMatchObject({
      api: 'openrouter',
      model: 'provider-model',
      storyEchoTrimmedByAgentAssembly: false,
    });
    bridge.unregister();
  });

  it('registers only when both the Tauri Agent ABI and host prompt event exist', () => {
    const target = new EventTarget();
    const { context } = installContext();
    const bridge = new TauriTavernAgentBridge(target);

    expect(bridge.register(context)).toBe(false);
    vi.stubGlobal('__TAURITAVERN__', { api: { agent: {} } });
    const { eventSource: _eventSource, ...contextWithoutEventSource } = context;
    expect(bridge.register(contextWithoutEventSource)).toBe(false);
    const { eventTypes: _eventTypes, ...contextWithoutEventTypes } = context;
    expect(bridge.register(contextWithoutEventTypes)).toBe(false);
    expect(bridge.register(context)).toBe(true);
    expect(bridge.register(context)).toBe(true);
    bridge.unregister();
  });

  it('expires unmatched prompt snapshots and ignores malformed host payloads', () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    vi.stubGlobal('__TAURITAVERN__', { api: { agent: {} } });
    const { context, handlers } = installContext();
    const bridge = new TauriTavernAgentBridge(target);
    bridge.register(context);

    bridge.beginStoryEchoPreparation(null);
    bridge.markStoryEchoSummaryInjected(null);
    bridge.beginStoryEchoPreparation('other-chat');
    bridge.markStoryEchoSummaryInjected('chat-id');
    handlers.get('completion-settings-ready')?.({ messages: 'invalid' });
    handlers.get('completion-settings-ready')?.({
      messages: [{ role: 'user', content: () => 'cannot clone' }],
    });
    target.dispatchEvent(customEvent('tauritavern-agent-run-state-changed', {
      activeRun: { runId: 'malformed-run' },
    }));
    expect(bridge.promptForLatestMessage(context)).toBeNull();

    target.dispatchEvent(customEvent('tauritavern-agent-run-state-changed', {
      activeRun: null,
    }));
    handlers.get('completion-settings-ready')?.({
      messages: [{ role: 'user', content: 'expires' }],
      tools: [{ callback: () => undefined }],
    });
    vi.advanceTimersByTime(2 * 60 * 1_000);
    target.dispatchEvent(customEvent('tauritavern-agent-run-state-changed', {
      activeRun: { runId: 'expired-run' },
    }));
    expect(bridge.promptForLatestMessage(context)).toBeNull();
    bridge.unregister();
  });

  it('supports swipe handles, profile events, candidate matching and bounded snapshots', () => {
    const target = new EventTarget();
    vi.stubGlobal('__TAURITAVERN__', { api: { agent: {} } });
    const { context, handlers } = installContext();
    const bridge = new TauriTavernAgentBridge(target);
    bridge.register(context);

    handlers.get('completion-settings-ready')?.({
      messages: [{
        role: 'system',
        content: [{ type: 'text', text: '<story_echo_skeleton>plot</story_echo_skeleton>' }],
      }],
    });
    target.dispatchEvent(customEvent('tauritavern-agent-run-state-changed', {
      activeRun: { run_id: 'run-1', generation_type: 'swipe' },
    }));
    target.dispatchEvent(customEvent('tauritavern-agent-run-event', {
      event: {
        type: 'profile_resolved',
        run_id: 'run-1',
        payload: { profile_id: 'writer' },
      },
    }));
    expect(bridge.promptForLatestMessage(context)).toMatchObject({
      generationType: 'swipe',
      expectedMessageId: 1,
      profile: 'writer',
    });
    context.chat[1]!.extra = { tauritavern: { agent: { run_id: 'run-1' } } };
    expect(bridge.latestMessageBelongsToAgent(context)).toBe(true);
    target.dispatchEvent(customEvent('tauritavern-agent-run-state-changed', {
      activeRun: null,
      lastEvent: { type: 'run_completed' },
    }));

    for (let index = 2; index <= 6; index += 1) {
      const runId = `run-${index}`;
      delete context.chat.at(-1)!.extra;
      handlers.get('completion-settings-ready')?.({
        messages: [{ role: 'user', content: `prompt-${index}` }],
      });
      target.dispatchEvent(customEvent('tauritavern-agent-run-state-changed', {
        activeRun: { runId, generationType: 'normal' },
      }));
      expect(bridge.promptForLatestMessage(context)).toBeNull();
      context.chat.push({ is_user: false, mes: `reply-${index}` });
      expect(bridge.promptForLatestMessage(context)?.runId).toBe(runId);
      context.chat.at(-1)!.extra = { tauritavern: { agent: { runId } } };
      target.dispatchEvent(customEvent('tauritavern-agent-run-state-changed', {
        activeRun: null,
        lastEvent: { type: 'run_completed' },
      }));
    }

    context.chat.at(-1)!.extra = { tauritavern: { agent: { runId: 'run-1' } } };
    expect(bridge.promptForLatestMessage(context)).toBeNull();
    bridge.unregister();
  });

  it('does not reuse a metadata-less Agent snapshot after a normal prompt replaces it', () => {
    const target = new EventTarget();
    vi.stubGlobal('__TAURITAVERN__', { api: { agent: {} } });
    const { context, handlers } = installContext();
    const bridge = new TauriTavernAgentBridge(target);
    bridge.register(context);

    handlers.get('completion-settings-ready')?.({
      messages: [{ role: 'user', content: 'agent prompt' }],
    });
    target.dispatchEvent(customEvent('tauritavern-agent-run-state-changed', {
      activeRun: { runId: 'agent-run', generationType: 'normal' },
    }));
    context.chat.push({ is_user: false, mes: 'agent reply without merged metadata yet' });
    expect(bridge.promptForLatestMessage(context)?.runId).toBe('agent-run');
    target.dispatchEvent(customEvent('tauritavern-agent-run-state-changed', {
      activeRun: null,
      lastEvent: { type: 'run_completed' },
    }));

    handlers.get('completion-settings-ready')?.({
      messages: [{ role: 'user', content: 'normal swipe prompt' }],
    });
    expect(bridge.promptForLatestMessage(context)).toBeNull();
    bridge.unregister();
  });
});

describe('Agent provider usage normalization', () => {
  it.each([
    [{ prompt_tokens: 10 }, 10],
    [{ usage: { totalInputTokens: 20 } }, 20],
    [{ usageMetadata: { promptTokenCount: 30 } }, 30],
    [{
      input_tokens: 40,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 6,
    }, 51],
    [{ input_tokens: 7 }, 7],
    [{
      usage: {
        inputTokens: 40,
        cacheCreationInputTokens: 5,
        cacheReadInputTokens: 6,
      },
    }, 51],
    [{ completion_tokens: 10 }, null],
    [null, null],
    [{ prompt_tokens: -1 }, null],
    [{ total_input_tokens: null, prompt_tokens: 12 }, 12],
    [{ totalInputTokens: '', promptTokens: 13 }, 13],
    [{ prompt_tokens: false }, null],
  ])('normalizes %o', (usage, expected) => {
    expect(agentUsageInputTokens(usage)).toBe(expected);
  });
});
