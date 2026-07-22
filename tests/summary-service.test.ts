import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODULE_ID } from '../src/core/constants';
import type { StoryEchoSettings, TavernChatMessage } from '../src/core/types';
import type { SillyTavernWorldInfoEntry } from '../src/platform/sillytavern';
import { LlmRequestTimeoutError } from '../src/llm/errors';
import {
  boundedPreviousStageSummary,
  buildStageSummaryGrounding,
  buildStageSummaryPrompt,
  MAX_PREVIOUS_STAGE_SUMMARY_CHARACTERS,
  STAGE_SUMMARY_SYSTEM_PROMPT,
} from '../src/summary/prompts';
import {
  MAX_SUMMARY_SOURCE_CHARACTERS,
  normalizeSummary,
  StageSummaryService,
} from '../src/summary/service';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { chatState, memory } from './fixtures';

function sectionedSummary(confirmed: string): string {
  return confirmed;
}

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
    getTokenCountAsync: vi.fn(async (text: string) => Array.from(text).length),
    getSortedWorldInfoEntries: vi.fn(async (): Promise<SillyTavernWorldInfoEntry[]> => []),
  };
  vi.stubGlobal('SillyTavern', { getContext: () => context });
  return { context, settings, state };
}

describe('independent stage summaries', () => {
  it('adapts both content and presentation to cultivation and other plot genres', () => {
    expect(STAGE_SUMMARY_SYSTEM_PROMPT).toContain('自主选择最合适的写法');
    expect(STAGE_SUMMARY_SYSTEM_PROMPT).toContain('修仙或玄幻剧情可重点说明境界、功法术法');
    expect(STAGE_SUMMARY_SYSTEM_PROMPT).toContain('概括性标题、动态小节、内容分类、自然段落');
    expect(STAGE_SUMMARY_SYSTEM_PROMPT).toContain('修炼、学习、赠礼、照料、同行');
  });

  it('advances independently of the extraction cursor in summary-only mode', async () => {
    const generateRaw = vi.fn(async () => sectionedSummary('第一轮已经完成。'));
    const installed = installContext([
      { is_user: true, mes: 'u1' },
      { is_user: false, mes: 'a1' },
    ], generateRaw, 1);
    installed.settings.memory.enabled = false;
    installed.state.indexedThroughMessageId = -1;

    const result = await new StageSummaryService().processNextThrough(1);

    expect(result.updatedChunks).toBe(1);
    expect(result.state?.stageSummary.coveredThroughMessageId).toBe(1);
    expect(result.state?.indexedThroughMessageId).toBe(-1);
  });

  it('waits for extraction coverage when the memory subsystem is enabled', async () => {
    const generateRaw = vi.fn(async () => sectionedSummary('不应生成。'));
    const installed = installContext([
      { is_user: true, mes: 'u1' },
      { is_user: false, mes: 'a1' },
    ], generateRaw, 1);
    installed.settings.memory.enabled = true;
    installed.state.indexedThroughMessageId = -1;

    const result = await new StageSummaryService().processNextThrough(1);

    expect(result.updatedChunks).toBe(0);
    expect(result.state?.stageSummary.coveredThroughMessageId).toBe(-1);
    expect(generateRaw).not.toHaveBeenCalled();
  });

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

  it('sends blue-light and batch-matched world info as non-evidence background', async () => {
    const generateRaw = vi.fn(async (_options: { systemPrompt: string; prompt: string }) => (
      '用户角色在姜梦指导下修炼无我剑诀。'
    ));
    const installed = installContext([
      { is_user: true, mes: '开始修炼无我剑诀。' },
      { is_user: false, name: '姜梦', mes: '姜梦指点了心法要领。' },
    ], generateRaw, 1);
    installed.context.getSortedWorldInfoEntries.mockResolvedValueOnce([
      {
        world: '玄天界常驻设定',
        uid: 6,
        constant: true,
        content: '玄天界由宗门、世家与散修共同构成修行秩序。',
      },
      {
        world: '蜀山设定',
        uid: 7,
        key: ['无我剑诀'],
        content: '无我剑诀以忘我、忘剑为核心。',
      },
    ]);

    const result = await new StageSummaryService().processNextThrough(1);

    expect(result.updatedChunks).toBe(1);
    const request = generateRaw.mock.calls[0]?.[0];
    expect(String(request?.prompt ?? '')).toContain('<story_echo_world_background>');
    expect(String(request?.prompt ?? '')).toContain('<constant_world_info>');
    expect(String(request?.prompt ?? '')).toContain('玄天界由宗门、世家与散修共同构成修行秩序');
    expect(String(request?.prompt ?? '')).toContain('<matched_world_info>');
    expect(String(request?.prompt ?? '')).toContain('无我剑诀以忘我、忘剑为核心');
    expect(String(request?.systemPrompt ?? '')).toContain('为后续续写披露足够的上下文');
    expect(String(request?.systemPrompt ?? '')).toContain('history_messages和authoritative_facts提供已经发生的剧情与有效变化');
    expect(String(request?.systemPrompt ?? '')).toContain('世界书补足这些事件所在的设定语境');
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
    expect(prompt).toContain('以带来源的用户明确事实和较新有效状态形成最终表述');
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

  it('accepts natural multi-paragraph recaps without adding or requiring headings', () => {
    const summary = [
      '刘爽在姜梦指点下掌握了无我剑诀的收束要领，并突破至金丹中期。',
      '',
      '两人的师徒关系更亲近；剑冢异动仍未解释，姜梦要求刘爽不要靠近。',
    ].join('\n');

    expect(normalizeSummary(`<story_echo_summary>\n${summary}\n</story_echo_summary>`)).toBe(summary);
    expect(normalizeSummary(summary)).not.toContain('【已确认剧情】');
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
    const summary = sectionedSummary('众人在旧港取得钥匙，随后抵达新港。');
    const generateRaw = vi.fn(async (_options: unknown) => summary);
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
        text: summary,
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

  it('does not hash an unchanged summarized prefix again after new messages are appended', async () => {
    const digest = vi.fn(async () => new Uint8Array(32).buffer);
    vi.stubGlobal('crypto', { subtle: { digest } });
    const installed = installContext([
      { is_user: true, mes: '已总结的用户消息' },
      { is_user: false, mes: '已总结的角色回复' },
    ], vi.fn(async () => '不应调用'), 1);
    installed.state.stageSummary = {
      entries: [{
        text: '已经保存的阶段总结。',
        sourceStartMessageId: 0,
        sourceEndMessageId: 1,
        sourceHash: '',
        updatedAt: '2026-07-21T00:00:00.000Z',
      }],
      coveredThroughMessageId: 1,
      coveredThroughHash: '',
    };
    const service = new StageSummaryService();

    await service.reconcileHistory(installed.state);
    const callsAfterInitialVerification = digest.mock.calls.length;
    installed.context.chat.push({ is_user: true, mes: '尚未总结的新消息' });
    await service.reconcileHistory(installed.state);

    expect(digest).toHaveBeenCalledTimes(callsAfterInitialVerification);

    installed.context.chat[0]!.mes = '用户编辑了已总结的原文';
    await service.reconcileHistory(installed.state);

    expect(digest.mock.calls.length).toBeGreaterThan(callsAfterInitialVerification);
  });

  it('stores a provider free-form recap unchanged', async () => {
    const recap = '刘爽完成第一轮修炼，境界保持稳定。\n姜梦准备继续指导剑诀。';
    const generateRaw = vi.fn(async () => recap);
    installContext([
      { is_user: true, mes: 'u1' },
      { is_user: false, mes: 'a1' },
    ], generateRaw, 1);

    const result = await new StageSummaryService().processNextThrough(1);

    expect(result.updatedChunks).toBe(1);
    expect(result.state?.stageSummary.entries[0]?.text).toBe(recap);
    expect(result.state?.metrics.summaryFailures).toBe(0);
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

  it('summarizes a complete long turn when the character cap cuts a batch before N turns', async () => {
    const summary = sectionedSummary('第一段超长剧情已经压缩。');
    const generateRaw = vi.fn(async () => summary);
    installContext([
      { is_user: true, mes: 'u1' },
      { is_user: false, mes: '甲'.repeat(60_000) },
      { is_user: true, mes: 'u2' },
      { is_user: false, mes: '乙'.repeat(60_000) },
    ], generateRaw, 10);

    const result = await new StageSummaryService().processAllThrough(3);

    expect(result.updatedChunks).toBe(1);
    expect(result.state?.stageSummary.entries).toMatchObject([{
      text: summary,
      sourceStartMessageId: 0,
      sourceEndMessageId: 1,
    }]);
    expect(result.state?.stageSummary.coveredThroughMessageId).toBe(1);
    expect(generateRaw).toHaveBeenCalledTimes(1);
    expect(MAX_SUMMARY_SOURCE_CHARACTERS).toBe(100_000);
  });

  it('keeps one oversized complete turn intact and records a bounded debug warning', async () => {
    const generateRaw = vi.fn(async () => '超长单回合已经完整总结。');
    const installed = installContext([
      { is_user: true, mes: '继续这一回合。' },
      { is_user: false, mes: '甲'.repeat(MAX_SUMMARY_SOURCE_CHARACTERS + 1) },
    ], generateRaw, 10);
    installed.settings.debug = true;

    const result = await new StageSummaryService().processAllThrough(1);

    expect(result.updatedChunks).toBe(1);
    expect(result.state?.stageSummary.entries[0]).toMatchObject({
      sourceStartMessageId: 0,
      sourceEndMessageId: 1,
      text: '超长单回合已经完整总结。',
    });
    const warning = result.state?.debugTraces.find((trace) => (
      trace.message.includes('单个完整剧情回合超过阶段总结原文字符上限')
    ));
    expect(warning?.details).toMatchObject({
      sourceCharacterLimit: 100_000,
    });
    expect(Number(warning?.details?.sourceCharacters)).toBeGreaterThan(100_000);
  });

  it('creates immutable entries and uses only the adjacent old summary for continuity', async () => {
    const generateRaw = vi.fn()
      .mockResolvedValueOnce(sectionedSummary('第一阶段总结'))
      .mockResolvedValueOnce(sectionedSummary('第二阶段总结'));
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
        text: sectionedSummary('第一阶段总结'),
        sourceStartMessageId: 0,
        sourceEndMessageId: 3,
      },
      {
        text: sectionedSummary('第二阶段总结'),
        sourceStartMessageId: 4,
        sourceEndMessageId: 7,
      },
    ]);
    const secondPrompt = String(generateRaw.mock.calls[1]?.[0]?.prompt ?? '');
    expect(secondPrompt).toContain('<previous_stage_summary>\n第一阶段总结\n</previous_stage_summary>');
    expect(secondPrompt).toContain('history_messages是本批剧情事实与较新变化的最高依据');
    expect(secondPrompt).toContain('消息 4 到 7');
    expect(secondPrompt).not.toContain('"content":"u1"');
  });

  it('bounds adjacent-summary continuity context to 5000 characters from the tail', () => {
    const previous = `开头线索-${'甲'.repeat(5_200)}-末尾伏笔`;
    const bounded = boundedPreviousStageSummary(previous);

    expect(MAX_PREVIOUS_STAGE_SUMMARY_CHARACTERS).toBe(5_000);
    expect(Array.from(bounded)).toHaveLength(5_000);
    expect(bounded).toContain('仅保留与本批衔接最相关的末尾内容');
    expect(bounded).not.toContain('开头线索');
    expect(bounded).toContain('末尾伏笔');
  });

  it('keeps an explicitly tiny adjacent-summary bound exact', () => {
    const bounded = boundedPreviousStageSummary('开头内容-中间内容-末尾伏笔', 4);

    expect(Array.from(bounded)).toHaveLength(4);
    expect(bounded).toBe('末尾伏笔');
  });

  it('atomically replaces all stage summaries and marks the old skeleton stale', async () => {
    const generateRaw = vi.fn()
      .mockResolvedValueOnce('重建后的第一阶段。')
      .mockResolvedValueOnce('重建后的第二阶段。');
    const installed = installContext([
      { is_user: true, mes: 'u1' },
      { is_user: false, mes: 'a1' },
      { is_user: true, mes: 'u2' },
      { is_user: false, mes: 'a2' },
      { is_user: true, mes: 'u3' },
      { is_user: false, mes: 'a3' },
      { is_user: true, mes: 'u4' },
      { is_user: false, mes: 'a4' },
    ], generateRaw, 2);
    installed.state.stageSummary = {
      entries: [{
        text: '旧第一阶段。',
        sourceStartMessageId: 0,
        sourceEndMessageId: 3,
        sourceHash: 'old-1',
        updatedAt: '2026-07-20T00:00:00.000Z',
      }, {
        text: '旧第二阶段。',
        sourceStartMessageId: 4,
        sourceEndMessageId: 7,
        sourceHash: 'old-2',
        updatedAt: '2026-07-20T01:00:00.000Z',
        manuallyEdited: true,
      }],
      coveredThroughMessageId: 7,
      coveredThroughHash: 'old-2',
      updatedAt: '2026-07-20T01:00:00.000Z',
    };
    installed.state.storySkeleton = {
      text: '仍由旧阶段总结支撑的骨架。',
      coveredThroughMessageId: 3,
      sourceHash: 'old-skeleton',
      updatedAt: '2026-07-20T02:00:00.000Z',
    };
    installed.context.saveMetadata.mockClear();

    const result = await new StageSummaryService().rebuildAllThrough(7);

    expect(result.updatedChunks).toBe(2);
    expect(result.state?.stageSummary.entries.map((entry) => entry.text)).toEqual([
      '重建后的第一阶段。',
      '重建后的第二阶段。',
    ]);
    expect(result.state?.stageSummary.entries.some((entry) => entry.manuallyEdited)).toBe(false);
    expect(result.state?.storySkeleton).toMatchObject({
      text: '仍由旧阶段总结支撑的骨架。',
      stale: true,
    });
    expect(installed.context.saveMetadata).toHaveBeenCalledTimes(1);
  });

  it('retries only the timed-out rebuild batch without regenerating completed batches', async () => {
    const generateRaw = vi.fn()
      .mockResolvedValueOnce('第一阶段只生成一次。')
      .mockRejectedValueOnce(new LlmRequestTimeoutError(300_000))
      .mockResolvedValueOnce('第二阶段在当前批次重试成功。');
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

    const result = await new StageSummaryService().rebuildAllThrough(7);

    expect(result.updatedChunks).toBe(2);
    expect(generateRaw).toHaveBeenCalledTimes(3);
    expect(String(generateRaw.mock.calls[0]?.[0]?.prompt ?? '')).toContain('"content":"u1"');
    for (const callIndex of [1, 2]) {
      const prompt = String(generateRaw.mock.calls[callIndex]?.[0]?.prompt ?? '');
      expect(prompt).toContain('"content":"u3"');
      expect(prompt).not.toContain('"content":"u1"');
    }
  });

  it('keeps the complete old summary set when a rebuild batch fails', async () => {
    const generateRaw = vi.fn()
      .mockResolvedValueOnce('尚未提交的第一阶段。')
      .mockRejectedValueOnce(new Error('provider unavailable'));
    const installed = installContext([
      { is_user: true, mes: 'u1' },
      { is_user: false, mes: 'a1' },
      { is_user: true, mes: 'u2' },
      { is_user: false, mes: 'a2' },
      { is_user: true, mes: 'u3' },
      { is_user: false, mes: 'a3' },
      { is_user: true, mes: 'u4' },
      { is_user: false, mes: 'a4' },
    ], generateRaw, 2);
    const oldEntries = [{
      text: '必须保留的旧总结。',
      sourceStartMessageId: 0,
      sourceEndMessageId: 7,
      sourceHash: 'old-all',
      updatedAt: '2026-07-20T00:00:00.000Z',
    }];
    installed.state.stageSummary = {
      entries: oldEntries.map((entry) => ({ ...entry })),
      coveredThroughMessageId: 7,
      coveredThroughHash: 'old-all',
      updatedAt: oldEntries[0]!.updatedAt,
    };
    installed.state.storySkeleton = {
      text: '必须保留的旧骨架。',
      coveredThroughMessageId: 7,
      sourceHash: 'old-skeleton',
    };

    await expect(new StageSummaryService().rebuildAllThrough(7)).rejects.toThrow(
      'provider unavailable',
    );

    expect(installed.state.stageSummary.entries).toEqual(oldEntries);
    expect(installed.state.storySkeleton).toEqual({
      text: '必须保留的旧骨架。',
      coveredThroughMessageId: 7,
      sourceHash: 'old-skeleton',
    });
    expect(installed.state.metrics.summaryFailures).toBe(1);
  });

  it('discards a full rebuild when an earlier completed source batch changes later', async () => {
    let context: ReturnType<typeof installContext>['context'];
    const generateRaw = vi.fn(async () => {
      if (generateRaw.mock.calls.length === 2) {
        context.chat[0]!.mes = '第一批已在后续请求期间被编辑';
      }
      return generateRaw.mock.calls.length === 1
        ? '尚未提交的第一阶段。'
        : '尚未提交的第二阶段。';
    });
    const installed = installContext([
      { is_user: true, mes: 'u1' },
      { is_user: false, mes: 'a1' },
      { is_user: true, mes: 'u2' },
      { is_user: false, mes: 'a2' },
      { is_user: true, mes: 'u3' },
      { is_user: false, mes: 'a3' },
      { is_user: true, mes: 'u4' },
      { is_user: false, mes: 'a4' },
    ], generateRaw, 2);
    context = installed.context;

    await expect(new StageSummaryService().rebuildAllThrough(7))
      .rejects.toThrow(/历史原文发生变化/);

    expect(installed.state.stageSummary.entries).toEqual([]);
    expect(installed.state.stageSummary.coveredThroughMessageId).toBe(-1);
    expect(installed.state.metrics.summaryFailures).toBe(1);
  });

  it('splits summary batches at an explicit story-phase boundary', async () => {
    const generateRaw = vi.fn()
      .mockResolvedValueOnce(sectionedSummary('山谷阶段结束。'))
      .mockResolvedValueOnce(sectionedSummary('雪原阶段开始。'));
    installContext([
      { is_user: true, mes: '上一段旅程已经结束，现在开始全新的山谷篇章。' },
      { is_user: false, mes: '旅队穿过山谷并抵达出口。' },
      { is_user: true, mes: '旅队在出口整理行装。' },
      { is_user: false, mes: '行装已经整理好。' },
      { is_user: true, mes: '山谷篇章已经结束，接下来进入全新的雪原篇章。' },
      { is_user: false, mes: '旅队踏上雪原。' },
      { is_user: true, mes: '众人沿北方前进。' },
      { is_user: false, mes: '远处出现一片松林。' },
      { is_user: true, mes: '旅队在松林边扎营。' },
      { is_user: false, mes: '营火已经点燃。' },
    ], generateRaw, 3);

    const result = await new StageSummaryService().processAllThrough(9);

    expect(result.updatedChunks).toBe(2);
    expect(result.state?.stageSummary.entries).toMatchObject([
      { sourceStartMessageId: 0, sourceEndMessageId: 3 },
      { sourceStartMessageId: 4, sourceEndMessageId: 9 },
    ]);
    expect(String(generateRaw.mock.calls[0]?.[0]?.prompt ?? '')).not.toContain('雪原篇章');
    expect(String(generateRaw.mock.calls[1]?.[0]?.prompt ?? '')).not.toContain('旅队在出口整理行装');
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
