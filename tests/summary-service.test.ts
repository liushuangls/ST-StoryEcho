import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODULE_ID } from '../src/core/constants';
import type { StoryEchoSettings, TavernChatMessage } from '../src/core/types';
import {
  buildStageSummaryGrounding,
  buildStageSummaryPrompt,
} from '../src/summary/prompts';
import { normalizeSummary, StageSummaryService } from '../src/summary/service';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { chatState, memory } from './fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
});

function installContext(
  chat: TavernChatMessage[],
  generateRaw: ReturnType<typeof vi.fn>,
  targetTurnsPerUpdate = 2,
) {
  const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
  settings.summary.targetTurnsPerUpdate = targetTurnsPerUpdate;
  const state = chatState([]);
  state.ownerChatId = 'chat-id';
  state.indexedThroughMessageId = chat.length - 1;
  const context = {
    chat,
    chatId: 'chat-id',
    extensionSettings: { story_echo: settings },
    chatMetadata: { [MODULE_ID]: state },
    saveSettingsDebounced: vi.fn(),
    saveMetadata: vi.fn(async () => undefined),
    generateRaw,
    getCurrentChatId: () => 'chat-id',
  };
  vi.stubGlobal('SillyTavern', { getContext: () => context });
  return { context, settings, state };
}

describe('independent stage summaries', () => {
  it('builds an independent batch prompt with exact message ids', () => {
    const prompt = buildStageSummaryPrompt(
      [
        { is_user: true, name: '刘爽', mes: '转移到新港。' },
        { is_user: false, name: 'Assistant', mes: '众人抵达新港。' },
      ],
      12,
      { userUiPersona: '刘爽', assistantCharacter: '福尔摩斯' },
    );

    expect(prompt).toContain('消息 12 到 13');
    expect(prompt).toContain('"messageId":12');
    expect(prompt).toContain('"messageId":13');
    expect(prompt).toContain('"userUiPersona":"刘爽"');
    expect(prompt).toContain('"speaker":"user-character"');
    expect(prompt).not.toContain('"speaker":"刘爽"');
    expect(prompt).not.toContain('previous_summary');
  });

  it('grounds a correction batch with user-confirmed current facts instead of assistant speculation', () => {
    const correction = memory({
      id: 'drink-correction',
      evidenceRole: 'user',
      sourceMessageIds: [12],
      source: { startMessageId: 12, endMessageId: 12, sourceHash: 'drink' },
      sourceHistory: [{ startMessageId: 12, endMessageId: 12, sourceHash: 'drink' }],
      stateChanges: [{
        entity: '贝克街会客室饮品',
        attribute: '供应状态',
        before: '推测有酒',
        after: '只有淡茶，没有酒',
      }],
      event: '用户明确纠正会客室里没有酒。',
      retrievalText: '贝克街会客室只有淡茶，没有酒。',
    });
    const assistantGuess = memory({
      id: 'assistant-guess',
      evidenceRole: 'assistant',
      sourceMessageIds: [11],
      stateChanges: [],
      event: '福尔摩斯猜测桌上也许有酒。',
      retrievalText: '福尔摩斯猜测桌上也许有酒。',
    });

    const grounding = buildStageSummaryGrounding([assistantGuess, correction], 10, 13);
    const prompt = buildStageSummaryPrompt(
      [
        { is_user: false, mes: '桌上也许有酒。' },
        { is_user: true, mes: '纠正：这里只供应淡茶，没有酒。' },
      ],
      11,
      { userUiPersona: '', assistantCharacter: '福尔摩斯' },
      grounding,
    );

    expect(grounding).toContain('推测有酒 → 只有淡茶，没有酒');
    expect(grounding).not.toContain('福尔摩斯猜测');
    expect(prompt).toContain('<authoritative_facts>');
    expect(prompt).toContain('用户明确事实优先于冲突的Assistant推测');
  });

  it('keeps an explicit Assistant-authored before-to-after plot transition in the grounding ledger', () => {
    const transition = memory({
      id: 'stolen-key',
      evidenceRole: 'assistant',
      sourceMessageIds: [21],
      source: { startMessageId: 21, endMessageId: 21, sourceHash: 'stolen' },
      stateChanges: [{
        entity: '银色钥匙',
        attribute: '持有者',
        before: '林雨',
        after: '灰帽男人',
      }],
      event: '灰帽男人从林雨手中夺走银色钥匙。',
      retrievalText: '灰帽男人夺走银色钥匙。',
    });

    expect(buildStageSummaryGrounding([transition], 20, 22)).toContain(
      'Assistant明确剧情推进｜状态：银色钥匙 · 持有者：林雨 → 灰帽男人',
    );
  });

  it('does not leak a later merged state backwards into an earlier summary batch', () => {
    const updated = memory({
      id: 'updated-holder',
      evidenceRole: 'mixed',
      sourceMessageIds: [12, 30],
      source: { startMessageId: 28, endMessageId: 31, sourceHash: 'latest-version' },
      sourceHistory: [
        { startMessageId: 10, endMessageId: 13, sourceHash: 'old-version' },
        { startMessageId: 28, endMessageId: 31, sourceHash: 'latest-version' },
      ],
      stateChanges: [{
        entity: '真月桂铜印R-1',
        attribute: '持有者',
        before: '雷斯垂德',
        after: '哈丽雅特·莫斯',
      }],
    });

    expect(buildStageSummaryGrounding([updated], 10, 13)).toBe('');
    expect(buildStageSummaryGrounding([updated], 28, 31)).toContain(
      '#30｜User参与确认事实｜状态：真月桂铜印R-1 · 持有者：雷斯垂德 → 哈丽雅特·莫斯',
    );
  });

  it('keeps a later explicit transition when a dense grounding ledger reaches its budget', () => {
    const earlier = memory({
      id: 'earlier-state',
      evidenceRole: 'user',
      sourceMessageIds: [10],
      source: { startMessageId: 10, endMessageId: 10, sourceHash: 'earlier' },
      stateChanges: [{ entity: '银色钥匙', attribute: '持有者', after: '林雨' }],
    });
    const correction = memory({
      id: 'later-correction',
      evidenceRole: 'user',
      sourceMessageIds: [20],
      source: { startMessageId: 20, endMessageId: 20, sourceHash: 'later' },
      stateChanges: [{ entity: '银色钥匙', attribute: '持有者', before: '林雨', after: '灰帽男人' }],
    });
    const correctionOnly = buildStageSummaryGrounding([correction], 0, 30);

    const grounding = buildStageSummaryGrounding(
      [earlier, correction],
      0,
      30,
      correctionOnly.length,
    );

    expect(grounding).toBe(correctionOnly);
    expect(grounding).toContain('林雨 → 灰帽男人');
  });

  it('omits superseded audit records from the authoritative grounding ledger', () => {
    const stale = memory({
      id: 'stale-holder',
      status: 'superseded',
      evidenceRole: 'user',
      sourceMessageIds: [10],
      source: { startMessageId: 10, endMessageId: 10, sourceHash: 'stale' },
      stateChanges: [{ entity: '银色钥匙', attribute: '持有者', after: '林雨' }],
    });
    const current = memory({
      id: 'current-holder',
      evidenceRole: 'user',
      sourceMessageIds: [12],
      source: { startMessageId: 12, endMessageId: 12, sourceHash: 'current' },
      stateChanges: [{ entity: '银色钥匙', attribute: '持有者', before: '林雨', after: '灰帽男人' }],
    });

    const grounding = buildStageSummaryGrounding([stale, current], 10, 13);

    expect(grounding).toContain('林雨 → 灰帽男人');
    expect(grounding).not.toContain('#10');
  });

  it('removes an unsupported UI persona name from a stage summary', () => {
    const source = [
      { is_user: true, mes: '我走进了贝克街。' },
      { is_user: false, mes: '福尔摩斯抬头看向来客。' },
    ];

    expect(normalizeSummary('刘爽走进贝克街并见到福尔摩斯。', source, '刘爽'))
      .toBe('用户角色走进贝克街并见到福尔摩斯。');
    expect(normalizeSummary('刘爽明确介绍了自己的姓名。', [
      { is_user: true, mes: '我叫刘爽。' },
    ], '刘爽')).toContain('刘爽');
  });

  it('waits for a complete automatic batch and keeps the coverage cursor unchanged', async () => {
    const generateRaw = vi.fn(async () => '不应调用');
    const { state } = installContext([
      { is_user: false, mes: 'greeting' },
      { is_user: true, mes: 'u1' },
      { is_user: false, mes: 'a1' },
    ], generateRaw, 2);

    const result = await new StageSummaryService().processNextThrough(2);

    expect(result.updatedChunks).toBe(0);
    expect(state.stageSummary.coveredThroughMessageId).toBe(-1);
    expect(generateRaw).not.toHaveBeenCalled();
  });

  it('appends one bounded summary entry and advances the cursor for a complete batch', async () => {
    const generateRaw = vi.fn(async (_options: unknown) => '众人在旧港取得钥匙，随后抵达新港。');
    const { context } = installContext([
      { is_user: false, mes: 'greeting' },
      { is_user: true, mes: 'u1' },
      { is_user: false, mes: 'a1' },
      { is_user: true, mes: 'u2' },
      { is_user: false, mes: 'a2' },
    ], generateRaw, 2);

    const result = await new StageSummaryService().processNextThrough(4);

    expect(result.updatedChunks).toBe(1);
    expect(result.state?.stageSummary).toMatchObject({
      coveredThroughMessageId: 4,
      entries: [{
        text: '众人在旧港取得钥匙，随后抵达新港。',
        sourceStartMessageId: 0,
        sourceEndMessageId: 4,
      }],
    });
    expect(result.state?.stageSummary.coveredThroughHash).not.toBe('');
    expect(result.state?.metrics.summaryUpdates).toBe(1);
    expect(result.state?.metrics.summaryMessagesCovered).toBe(5);
    expect(context.saveMetadata).toHaveBeenCalled();
    expect(generateRaw.mock.calls[0]?.[0]).toMatchObject({ responseLength: 1_600 });
  });

  it('keeps a final partial manual batch as raw history until it reaches N turns', async () => {
    const generateRaw = vi.fn(async () => '旧港阶段结束。');
    installContext([
      { is_user: false, mes: 'greeting' },
      { is_user: true, mes: 'u1' },
      { is_user: false, mes: 'a1' },
    ], generateRaw, 10);

    const result = await new StageSummaryService().processAllThrough(2);

    expect(result.updatedChunks).toBe(0);
    expect(result.state?.stageSummary.coveredThroughMessageId).toBe(-1);
    expect(result.state?.stageSummary.entries).toEqual([]);
    expect(generateRaw).not.toHaveBeenCalled();
  });

  it('creates immutable entries for successive batches without feeding an old summary back', async () => {
    const generateRaw = vi.fn()
      .mockResolvedValueOnce('第一阶段总结')
      .mockResolvedValueOnce('第二阶段总结');
    installContext([
      { is_user: true, mes: 'u1' },
      { is_user: false, mes: 'a1' },
      { is_user: true, mes: 'u2' },
      { is_user: false, mes: 'a2' },
      { is_user: true, mes: 'u3' },
      { is_user: false, mes: 'a3' },
      { is_user: true, mes: 'u4' },
      { is_user: false, mes: 'a4' },
    ], generateRaw, 2);

    const result = await new StageSummaryService().processAllThrough(7);

    expect(result.updatedChunks).toBe(2);
    expect(result.state?.stageSummary.entries).toMatchObject([
      {
        text: '第一阶段总结',
        sourceStartMessageId: 0,
        sourceEndMessageId: 3,
      },
      {
        text: '第二阶段总结',
        sourceStartMessageId: 4,
        sourceEndMessageId: 7,
      },
    ]);
    const secondPrompt = String(generateRaw.mock.calls[1]?.[0]?.prompt ?? '');
    expect(secondPrompt).not.toContain('第一阶段总结');
    expect(secondPrompt).toContain('消息 4 到 7');
  });

  it('discards an update when its source messages change during the request', async () => {
    let context: ReturnType<typeof installContext>['context'];
    const generateRaw = vi.fn(async () => {
      context.chat[1]!.mes = 'edited while summarizing';
      return '不应保存的总结';
    });
    const installed = installContext([
      { is_user: true, mes: 'u1' },
      { is_user: false, mes: 'a1' },
    ], generateRaw, 1);
    context = installed.context;

    await expect(new StageSummaryService().processNextThrough(1)).rejects.toThrow(/源消息发生变化/);
    const stored = installed.context.chatMetadata[MODULE_ID];
    expect(stored.stageSummary).toMatchObject({
      entries: [],
      coveredThroughMessageId: -1,
    });
    expect(stored.metrics.summaryFailures).toBe(1);
  });

  it('discards an update when SillyTavern replaces the chat array during the request', async () => {
    let activeContext: ReturnType<typeof installContext>['context'];
    const generateRaw = vi.fn(async () => {
      activeContext = {
        ...activeContext,
        chat: activeContext.chat.map((message, index) => ({
          ...message,
          mes: index === 0 ? 'edited in a replacement array' : message.mes,
        })),
      };
      return '不应保存的总结';
    });
    const installed = installContext([
      { is_user: true, mes: 'u1' },
      { is_user: false, mes: 'a1' },
    ], generateRaw, 1);
    activeContext = installed.context;
    vi.stubGlobal('SillyTavern', { getContext: () => activeContext });

    await expect(new StageSummaryService().processNextThrough(1)).rejects.toThrow(/源消息发生变化/);
    expect(activeContext.chatMetadata[MODULE_ID].stageSummary).toMatchObject({
      entries: [],
      coveredThroughMessageId: -1,
    });
    expect(activeContext.chatMetadata[MODULE_ID].metrics.summaryFailures).toBe(1);
  });
});
