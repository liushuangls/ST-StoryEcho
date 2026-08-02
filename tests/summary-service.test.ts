import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoryEchoChatState, StoryEchoSettings, TavernChatMessage } from '../src/core/types';
import { StoryEchoTaskCancelledError } from '../src/runtime/task-cancellation';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { chatState } from './fixtures';

const mocks = vi.hoisted(() => ({
  state: null as StoryEchoChatState | null,
  save: vi.fn(),
  complete: vi.fn(),
}));

vi.mock('../src/state/repository', () => ({
  StoryStateRepository: class {
    getOrCreate = vi.fn(async () => mocks.state);
    getExisting = vi.fn(() => mocks.state);
    save = mocks.save.mockImplementation(async (state: StoryEchoChatState) => {
      mocks.state = state;
    });
  },
}));
vi.mock('../src/llm/complete', () => ({
  completeWithConfiguredProviderDetailed: mocks.complete,
}));

import {
  MAX_SUMMARY_SOURCE_CHARACTERS,
  normalizeSummary,
  StageSummaryService,
} from '../src/summary/service';
import {
  boundedPreviousStageSummary,
  buildStageSummaryPrompt,
  MAX_PREVIOUS_STAGE_SUMMARY_CHARACTERS,
} from '../src/summary/prompts';

function settings(): StoryEchoSettings {
  const value = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
  value.enabled = true;
  value.summary.targetTurnsPerUpdate = 2;
  value.summary.reference.enabled = false;
  return value;
}

function completedChat(turns: number): TavernChatMessage[] {
  return Array.from({ length: turns }, (_, index) => [
    { is_user: true, mes: `用户行动 ${index}` },
    { is_user: false, name: '角色', mes: `角色回应 ${index}` },
  ]).flat();
}

function install(chat: TavernChatMessage[], currentSettings = settings()): void {
  const context = {
    chat,
    chatId: 'chat-id',
    name1: '界面用户',
    name2: '角色',
    extensionSettings: { story_echo: currentSettings },
    chatMetadata: {},
    saveSettingsDebounced: vi.fn(),
    saveMetadata: vi.fn(async () => undefined),
    generateRaw: vi.fn(async () => ''),
  };
  vi.stubGlobal('SillyTavern', { getContext: () => context });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state = chatState();
  mocks.complete.mockResolvedValue({
    text: '本阶段中，用户完成行动，角色作出回应。',
    metadata: {
      provider: 'main',
      requestedMaxTokens: 1_600,
      finishReason: 'stop',
      completionTokens: 42,
      reasoningTokens: 0,
      responseCharacters: 19,
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('stage-summary prompt helpers', () => {
  it('normalizes wrappers and removes a UI-only persona label', () => {
    expect(normalizeSummary(
      '```md\n<story_echo_summary>界面用户取得钥匙。</story_echo_summary>\n```',
      [{ is_user: true, mes: '我取得钥匙。' }],
      '界面用户',
    )).toBe('用户角色取得钥匙。');
    expect(() => normalizeSummary('  ')).toThrow('空内容');
    expect(() => normalizeSummary('x'.repeat(64_001))).toThrow('过长');
  });

  it('bounds the previous summary from the end and builds a raw-history prompt', () => {
    const previous = boundedPreviousStageSummary(
      'a'.repeat(MAX_PREVIOUS_STAGE_SUMMARY_CHARACTERS + 100),
    );
    expect(Array.from(previous).length).toBe(MAX_PREVIOUS_STAGE_SUMMARY_CHARACTERS);
    expect(previous).toContain('仅保留');
    const prompt = buildStageSummaryPrompt(
      [{ is_user: true, mes: '开始行动' }, { is_user: false, mes: '行动完成' }],
      10,
      { userUiPersona: '用户', assistantCharacter: '角色' },
      '<story_echo_world_background>设定</story_echo_world_background>',
      '更早总结',
      800,
    );
    expect(prompt).toContain('消息 10 到 11');
    expect(prompt).toContain('<history_messages>');
    expect(prompt).toContain('<previous_stage_summary>');
    expect(prompt).not.toContain('authoritative_facts');
  });
});

describe('StageSummaryService', () => {
  it('waits until the configured number of complete turns exists', async () => {
    const chat = completedChat(1);
    install(chat);
    const result = await new StageSummaryService().processAllThrough(chat.length - 1);
    expect(result.updatedChunks).toBe(0);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('generates consecutive entries directly from chat history', async () => {
    const chat = completedChat(4);
    install(chat);
    const result = await new StageSummaryService().processAllThrough(chat.length - 1);

    expect(result.updatedChunks).toBe(2);
    expect(result.state?.stageSummary.entries).toHaveLength(2);
    expect(result.state?.stageSummary.coveredThroughMessageId).toBe(7);
    expect(mocks.complete).toHaveBeenCalledTimes(2);
    expect(mocks.complete.mock.calls[0]?.[1]).toMatchObject({
      maxTokens: 1_600,
      timeoutMs: 600_000,
    });
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(result.state?.stageSummary.entries[0]).toMatchObject({
      characterCount: 19,
      generation: {
        finishReason: 'stop',
        completionTokens: 42,
      },
    });
    expect(result.state?.recentInternalLlmAttempts).toHaveLength(2);
  });

  it('atomically regenerates only the selected summary and invalidates a covered skeleton', async () => {
    const chat = completedChat(4);
    install(chat);
    const service = new StageSummaryService();
    await service.processAllThrough(chat.length - 1);
    const first = mocks.state!.stageSummary.entries[0]!;
    const secondBefore = structuredClone(mocks.state!.stageSummary.entries[1]!);
    const coveredMessagesBefore = mocks.state!.metrics.summaryMessagesCovered;
    mocks.state!.storySkeleton = {
      text: '旧骨架',
      coveredThroughMessageId: first.sourceEndMessageId,
      sourceHash: 'old-skeleton-source',
    };
    mocks.complete.mockResolvedValueOnce({
      text: '重新生成的完整阶段总结。',
      metadata: {
        provider: 'main',
        requestedMaxTokens: 1_600,
        finishReason: 'length',
        promptTokens: 1_000,
        completionTokens: 50,
        reasoningTokens: 20,
        totalTokens: 1_050,
        responseCharacters: 12,
      },
    });

    const result = await service.regenerateEntry(
      first.sourceStartMessageId,
      first.updatedAt,
    );

    expect(result.previousCharacterCount).toBe(19);
    expect(result.entry).toMatchObject({
      text: '重新生成的完整阶段总结。',
      characterCount: 12,
      sourceStartMessageId: first.sourceStartMessageId,
      sourceEndMessageId: first.sourceEndMessageId,
      sourceHash: first.sourceHash,
      generation: {
        finishReason: 'length',
        completionTokens: 50,
        reasoningTokens: 20,
      },
    });
    expect(result.state.stageSummary.entries[1]).toEqual(secondBefore);
    expect(result.state.storySkeleton.stale).toBe(true);
    expect(result.state.metrics.summaryMessagesCovered).toBe(coveredMessagesBefore);
    expect(result.state.recentInternalLlmAttempts.at(-1)).toMatchObject({
      task: 'stage-summary',
      status: 'completed',
      sourceStartMessageId: 0,
      sourceEndMessageId: 3,
      agentActiveAtStart: false,
      completion: {
        finishReason: 'length',
        responseCharacters: 12,
      },
    });
  });

  it('keeps the old summary when regenerating the selected entry fails', async () => {
    const chat = completedChat(2);
    install(chat);
    const service = new StageSummaryService();
    await service.processAllThrough(chat.length - 1);
    const previous = structuredClone(mocks.state!.stageSummary.entries[0]!);
    mocks.complete.mockRejectedValueOnce(new Error('upstream disconnected'));

    await expect(service.regenerateEntry(
      previous.sourceStartMessageId,
      previous.updatedAt,
    )).rejects.toThrow('upstream disconnected');

    expect(mocks.state!.stageSummary.entries[0]).toEqual(previous);
    expect(mocks.state!.metrics.summaryFailures).toBe(1);
    expect(mocks.state!.recentInternalLlmAttempts.at(-1)).toMatchObject({
      task: 'stage-summary',
      status: 'failed',
      error: 'upstream disconnected',
    });
  });

  it('persists cancellation diagnostics without counting a cancelled summary as a failure', async () => {
    const chat = completedChat(2);
    install(chat);
    mocks.complete.mockRejectedValueOnce(
      new StoryEchoTaskCancelledError('Agent前台请求开始'),
    );

    await expect(new StageSummaryService().processAllThrough(chat.length - 1))
      .rejects.toThrow('Agent前台请求开始');

    expect(mocks.state!.stageSummary.entries).toEqual([]);
    expect(mocks.state!.metrics.summaryFailures).toBe(0);
    expect(mocks.state!.recentInternalLlmAttempts.at(-1)).toMatchObject({
      task: 'stage-summary',
      status: 'cancelled',
      requestedMaxTokens: 1_600,
      agentActiveAtStart: false,
      agentActiveAtEnd: false,
      error: expect.stringContaining('Agent前台请求开始'),
    });
    expect(mocks.save).toHaveBeenCalledOnce();
  });

  it('closes a short chunk at an explicit story-phase transition', async () => {
    const chat = [
      { is_user: true, mes: '旧阶段行动' },
      { is_user: false, mes: '旧阶段结果' },
      { is_user: true, mes: '上一段剧情已经结束，现在进入一个新的篇章。' },
      { is_user: false, mes: '新阶段开始' },
    ];
    const currentSettings = settings();
    currentSettings.summary.targetTurnsPerUpdate = 5;
    install(chat, currentSettings);
    const result = await new StageSummaryService().processAllThrough(chat.length - 1);
    expect(result.updatedChunks).toBe(1);
    expect(result.state?.stageSummary.entries[0]).toMatchObject({
      sourceStartMessageId: 0,
      sourceEndMessageId: 1,
    });
  });

  it('keeps one oversized complete turn intact', async () => {
    const chat = [
      { is_user: true, mes: 'x'.repeat(MAX_SUMMARY_SOURCE_CHARACTERS + 1) },
      { is_user: false, mes: 'done' },
    ];
    const currentSettings = settings();
    currentSettings.summary.targetTurnsPerUpdate = 2;
    install(chat, currentSettings);
    const result = await new StageSummaryService().processAllThrough(1);
    expect(result.updatedChunks).toBe(1);
    expect(result.state?.stageSummary.coveredThroughMessageId).toBe(1);
  });

  it('truncates summaries from the first edited source range', async () => {
    const chat = completedChat(2);
    install(chat);
    const service = new StageSummaryService();
    await service.processAllThrough(3);
    expect(mocks.state?.stageSummary.entries).toHaveLength(1);

    chat[0]!.mes = 'edited source';
    const reconciled = await service.reconcileHistory(mocks.state ?? undefined);
    expect(reconciled?.stageSummary.entries).toEqual([]);
    expect(reconciled?.stageSummary.coveredThroughMessageId).toBe(-1);
  });

  it('does not commit a result if source messages change during the request', async () => {
    const chat = completedChat(2);
    install(chat);
    mocks.complete.mockImplementationOnce(async () => {
      chat[0]!.mes = 'changed while generating';
      return {
        text: 'stale summary',
        metadata: {
          provider: 'main',
          requestedMaxTokens: 1_600,
          finishReason: 'stop',
          responseCharacters: 13,
        },
      };
    });
    await expect(new StageSummaryService().processAllThrough(3))
      .rejects.toThrow('源消息发生变化');
    expect(mocks.state?.stageSummary.entries).toEqual([]);
    expect(mocks.state?.metrics.summaryFailures).toBe(1);
  });
});
