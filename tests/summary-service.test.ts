import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODULE_ID } from '../src/core/constants';
import type { StoryEchoSettings, TavernChatMessage } from '../src/core/types';
import { buildStageSummaryPrompt } from '../src/summary/prompts';
import { normalizeSummary, StageSummaryService } from '../src/summary/service';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { chatState } from './fixtures';

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
