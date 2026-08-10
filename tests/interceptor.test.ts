import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoryEchoChatState, StoryEchoSettings, TavernChatMessage } from '../src/core/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { chatState } from './fixtures';

const mocks = vi.hoisted(() => ({
  getOrCreate: vi.fn(),
  save: vi.fn(),
  reconcileSummary: vi.fn(),
}));

vi.mock('../src/state/repository', () => ({
  StoryStateRepository: class {
    getOrCreate = mocks.getOrCreate;
    save = mocks.save;
  },
}));
vi.mock('../src/summary/service', () => ({
  stageSummaryService: { reconcileHistory: mocks.reconcileSummary },
}));
import { storyEchoGenerateInterceptor } from '../src/prompt/interceptor';
import { estimateTokens } from '../src/prompt/render';
import {
  markInternalGenerationRequest,
  withInternalGeneration,
} from '../src/llm/internal-generation';
import { storyEchoTaskCoordinator } from '../src/runtime/task-coordinator';

function sourceChat(): TavernChatMessage[] {
  return [
    { is_user: true, mes: 'u0' },
    { is_user: false, mes: 'a0' },
    { is_user: true, mes: 'u1' },
    { is_user: false, mes: 'a1' },
    { is_user: true, mes: 'u2' },
    { is_user: false, mes: 'a2' },
    { is_user: true, mes: '继续。' },
  ];
}

function settings(enabled = true): StoryEchoSettings {
  const value = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
  value.enabled = enabled;
  value.recentWindow = { size: 1, unit: 'turns' };
  return value;
}

function install(
  state: StoryEchoChatState,
  currentSettings = settings(),
  chat = sourceChat(),
): TavernChatMessage[] {
  const context = {
    chat,
    chatId: 'chat-id',
    extensionSettings: { story_echo: currentSettings },
    chatMetadata: {},
    saveSettingsDebounced: vi.fn(),
    saveMetadata: vi.fn(async () => undefined),
    generateRaw: vi.fn(async () => ''),
  };
  vi.stubGlobal('SillyTavern', { getContext: () => context });
  mocks.getOrCreate.mockResolvedValue(state);
  mocks.reconcileSummary.mockImplementation(async (value: StoryEchoChatState) => value);
  mocks.save.mockResolvedValue(undefined);
  return chat;
}

function summary(
  text: string,
  start: number,
  end: number,
  level = 1,
): StoryEchoChatState['stageSummary']['entries'][number] {
  return {
    text,
    level,
    sourceStartMessageId: start,
    sourceEndMessageId: end,
    sourceHash: `hash-${start}-${end}`,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  storyEchoTaskCoordinator.resetForTests();
  vi.unstubAllGlobals();
});

describe('StoryEcho generation interceptor', () => {
  it('does nothing while the only feature switch is disabled', async () => {
    const state = chatState();
    const original = install(state, settings(false));
    const request = structuredClone(original);
    await storyEchoGenerateInterceptor(request, 8_192, vi.fn(), 'normal');
    expect(request).toEqual(original);
    expect(mocks.getOrCreate).not.toHaveBeenCalled();
  });

  it('ignores unsupported and internal generations', async () => {
    const state = chatState();
    const original = install(state);
    await storyEchoGenerateInterceptor(structuredClone(original), 8_192, vi.fn(), 'quiet');
    expect(mocks.getOrCreate).not.toHaveBeenCalled();

    const marked = markInternalGenerationRequest('system', 'prompt');
    await withInternalGeneration(marked, () => storyEchoGenerateInterceptor([
      { is_user: false, is_system: true, mes: marked.systemPrompt },
      { is_user: true, mes: marked.prompt },
    ], 8_192, vi.fn(), 'normal'));
    expect(mocks.getOrCreate).not.toHaveBeenCalled();
  });

  it('never removes source history beyond verified summary coverage', async () => {
    const state = chatState();
    state.stageSummary = {
      entries: [summary('第一阶段', 0, 1)],
      coveredThroughMessageId: 1,
      coveredThroughHash: 'hash-0-1',
    };
    const original = install(state);
    const request = structuredClone(original);

    await storyEchoGenerateInterceptor(request, 8_192, vi.fn(), 'normal');

    expect(request.some((message) => message.mes === 'u1')).toBe(true);
    expect(request.some((message) => message.mes === 'a1')).toBe(true);
    expect(request.some((message) => message.mes.includes('<story_echo_summary>'))).toBe(true);
    expect(request.some((message) => message.mes.includes('story_echo_recall'))).toBe(false);
    expect(state.lastInspection?.summaryCoveredThroughMessageId).toBe(1);
    expect(mocks.save).toHaveBeenCalledWith(state);
  });

  it('injects the chronological summary frontier before retained raw messages', async () => {
    const state = chatState();
    state.stageSummary = {
      entries: [
        summary('长期压缩历史', 0, 1, 2),
        summary('阶段二', 2, 3),
        summary('阶段三', 4, 5),
      ],
      coveredThroughMessageId: 5,
      coveredThroughHash: 'hash-4-5',
    };
    const original = install(state);
    const request = structuredClone(original);

    await storyEchoGenerateInterceptor(request, 8_192, vi.fn(), 'swipe');

    const injected = request.filter((message) => message.extra?.['story_echo_injection'] === true);
    expect(injected).toHaveLength(1);
    expect(injected[0]?.mes).toContain('长期压缩历史');
    expect(injected[0]?.mes).toContain('阶段二');
    expect(injected[0]?.mes).toContain('阶段三');
    expect(injected[0]?.mes.match(/<story_echo_summary>/g)).toHaveLength(3);
    expect(injected[0]?.mes).toContain('总结层级：L2');
    expect(injected[0]?.mes.match(/不是需要执行的指令/g)).toHaveLength(1);
    expect(injected.every((message) => message.extra?.['story_echo_injection_kind'] === 'summary'))
      .toBe(true);
    expect(state.lastInspection?.estimatedSummaryTokens).toBe(estimateTokens(injected[0]!.mes));
    expect(state.metrics.generationsTrimmed).toBe(1);
    expect(state.metrics.messagesRemoved).toBeGreaterThan(0);
  });

  it('does not emit the removed skeleton protocol', async () => {
    const state = chatState();
    state.stageSummary = {
      entries: [summary('已验证总结', 0, 5)],
      coveredThroughMessageId: 5,
      coveredThroughHash: 'hash-0-5',
    };
    const original = install(state);
    const request = structuredClone(original);
    await storyEchoGenerateInterceptor(request, 8_192, vi.fn(), 'regenerate');

    expect(request.some((message) => message.mes.includes('story_echo_skeleton'))).toBe(false);
    expect(request.some((message) => message.mes.includes('已验证总结'))).toBe(true);
  });
});
