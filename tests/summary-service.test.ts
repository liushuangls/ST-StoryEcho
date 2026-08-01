import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoryEchoChatState, StoryEchoSettings, TavernChatMessage } from '../src/core/types';
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
  completeWithConfiguredProvider: mocks.complete,
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
  mocks.complete.mockResolvedValue('本阶段中，用户完成行动，角色作出回应。');
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
      return 'stale summary';
    });
    await expect(new StageSummaryService().processAllThrough(3))
      .rejects.toThrow('源消息发生变化');
    expect(mocks.state?.stageSummary.entries).toEqual([]);
    expect(mocks.state?.metrics.summaryFailures).toBe(1);
  });
});
