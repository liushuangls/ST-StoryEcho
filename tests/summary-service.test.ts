import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODULE_ID } from '../src/core/constants';
import type { StoryEchoSettings, TavernChatMessage } from '../src/core/types';
import { buildStageSummaryPrompt } from '../src/summary/prompts';
import { StageSummaryService } from '../src/summary/service';
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

describe('rolling stage summary', () => {
  it('builds an update prompt from the previous summary and exact message ids', () => {
    const prompt = buildStageSummaryPrompt(
      '此前在旧港发现线索。',
      [
        { is_user: true, name: '刘爽', mes: '转移到新港。' },
        { is_user: false, name: 'Assistant', mes: '众人抵达新港。' },
      ],
      12,
    );

    expect(prompt).toContain('此前在旧港发现线索。');
    expect(prompt).toContain('消息 12 到 13');
    expect(prompt).toContain('"messageId":12');
    expect(prompt).toContain('"messageId":13');
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

  it('rewrites one bounded summary and advances the cursor for a complete batch', async () => {
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
      text: '众人在旧港取得钥匙，随后抵达新港。',
      coveredThroughMessageId: 4,
    });
    expect(result.state?.stageSummary.coveredThroughHash).not.toBe('');
    expect(result.state?.metrics.summaryUpdates).toBe(1);
    expect(result.state?.metrics.summaryMessagesCovered).toBe(5);
    expect(context.saveMetadata).toHaveBeenCalled();
    expect(generateRaw.mock.calls[0]?.[0]).toMatchObject({ responseLength: 1_600 });
  });

  it('lets manual processing summarize a final partial batch', async () => {
    const generateRaw = vi.fn(async () => '旧港阶段结束。');
    installContext([
      { is_user: false, mes: 'greeting' },
      { is_user: true, mes: 'u1' },
      { is_user: false, mes: 'a1' },
    ], generateRaw, 10);

    const result = await new StageSummaryService().processAllThrough(2);

    expect(result.updatedChunks).toBe(1);
    expect(result.state?.stageSummary.coveredThroughMessageId).toBe(2);
    expect(generateRaw).toHaveBeenCalledOnce();
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
      text: '',
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
      text: '',
      coveredThroughMessageId: -1,
    });
    expect(activeContext.chatMetadata[MODULE_ID].metrics.summaryFailures).toBe(1);
  });
});
