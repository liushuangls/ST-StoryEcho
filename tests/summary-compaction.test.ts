import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '../src/core/hash';
import type {
  StageSummaryEntry,
  StoryEchoChatState,
  StoryEchoSettings,
  TavernChatMessage,
} from '../src/core/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { summarySourcePayload } from '../src/summary/source';
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

import { SummaryCompactionService } from '../src/summary/compaction-service';
import {
  findSummaryCompactionCandidate,
  summaryCompactionDue,
} from '../src/summary/compaction-state';
import {
  buildSummaryCompactionPrompt,
  HIGHER_LEVEL_SUMMARY_COMPACTION_SYSTEM_PROMPT,
  LEVEL_2_SUMMARY_COMPACTION_SYSTEM_PROMPT,
  summaryCompactionSystemPrompt,
} from '../src/summary/compaction-prompts';

const thresholds = { level1: 10, higherLevels: 5 };

function bareEntry(index: number, level = 1): StageSummaryEntry {
  return {
    text: `总结-${level}-${index}`,
    level,
    sourceStartMessageId: index,
    sourceEndMessageId: index,
    sourceHash: `hash-${index}`,
    updatedAt: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
  };
}

function settings(): StoryEchoSettings {
  const value = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
  value.enabled = true;
  value.debug = true;
  value.summary.level1EntriesPerGroup = 2;
  value.summary.higherLevelEntriesPerGroup = 2;
  value.summary.reference.enabled = false;
  return value;
}

function chat(size: number): TavernChatMessage[] {
  return Array.from({ length: size }, (_, index) => ({
    is_user: index % 2 === 0,
    is_system: false,
    name: index % 2 === 0 ? '用户' : '角色',
    mes: `消息-${index}`,
  }));
}

async function entriesForChat(messages: TavernChatMessage[]): Promise<StageSummaryEntry[]> {
  return Promise.all(messages.map(async (message, index) => ({
    text: `L1剧情-${index}`,
    level: 1,
    sourceStartMessageId: index,
    sourceEndMessageId: index,
    sourceHash: await sha256(summarySourcePayload([message], index)),
    updatedAt: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
  })));
}

function install(
  messages: TavernChatMessage[],
  entries: StageSummaryEntry[],
  chatForRead: () => TavernChatMessage[] = () => messages,
): void {
  const currentSettings = settings();
  const state = chatState({
    stageSummary: {
      entries,
      coveredThroughMessageId: entries.at(-1)?.sourceEndMessageId ?? -1,
      coveredThroughHash: entries.at(-1)?.sourceHash ?? '',
    },
  });
  mocks.state = state;
  vi.stubGlobal('SillyTavern', {
    getContext: () => ({
      get chat() {
        return chatForRead();
      },
      chatId: 'chat-id',
      extensionSettings: { story_echo: currentSettings },
      chatMetadata: {},
      saveSettingsDebounced: vi.fn(),
      saveMetadata: vi.fn(async () => undefined),
      generateRaw: vi.fn(async () => ''),
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.complete.mockImplementation(async (_settings, request: { maxTokens?: number }) => ({
    text: `高层总结-${mocks.complete.mock.calls.length}`,
    metadata: {
      provider: 'main',
      requestedMaxTokens: request.maxTokens ?? 0,
      finishReason: 'stop',
      responseCharacters: 6,
    },
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('summary compaction planning', () => {
  it('uses separate L1 and L2+ fan-in thresholds', () => {
    const l1 = Array.from({ length: 11 }, (_, index) => bareEntry(index));
    expect(findSummaryCompactionCandidate(l1, thresholds)).toMatchObject({
      level: 1,
      startIndex: 0,
      entries: expect.arrayContaining([
        expect.objectContaining({ sourceStartMessageId: 0 }),
        expect.objectContaining({ sourceStartMessageId: 9 }),
      ]),
    });

    const l2 = Array.from({ length: 6 }, (_, index) => bareEntry(index, 2));
    l2.push(bareEntry(6, 1));
    const candidate = findSummaryCompactionCandidate(l2, thresholds);
    expect(candidate?.level).toBe(2);
    expect(candidate?.entries).toHaveLength(5);
    expect(summaryCompactionDue(l2, thresholds)).toBe(true);
  });

  it('rejects non-contiguous same-level runs instead of replacing unrelated history', () => {
    const invalid = [bareEntry(0, 2), bareEntry(1, 1), ...Array.from(
      { length: 5 },
      (_, offset) => bareEntry(offset + 2, 2),
    )];
    expect(() => findSummaryCompactionCandidate(invalid, thresholds))
      .toThrow('未形成连续区间');
  });

  it('produces the configured 10/5 carry pattern across multiple levels', () => {
    const entries: StageSummaryEntry[] = [];
    for (let index = 0; index < 61; index += 1) {
      entries.push(bareEntry(index));
      let candidate = findSummaryCompactionCandidate(entries, thresholds);
      while (candidate) {
        entries.splice(candidate.startIndex, candidate.entries.length, {
          text: `L${candidate.level + 1}压缩`,
          level: candidate.level + 1,
          sourceStartMessageId: candidate.entries[0]!.sourceStartMessageId,
          sourceEndMessageId: candidate.entries.at(-1)!.sourceEndMessageId,
          sourceHash: `parent-${candidate.level}-${index}`,
          updatedAt: '2026-01-01T00:00:00.000Z',
        });
        candidate = findSummaryCompactionCandidate(entries, thresholds);
      }
    }

    expect(entries.map((entry) => [
      entry.level,
      entry.sourceStartMessageId,
      entry.sourceEndMessageId,
    ])).toEqual([
      [3, 0, 49],
      [2, 50, 59],
      [1, 60, 60],
    ]);
    expect(summaryCompactionDue(entries, thresholds)).toBe(false);
  });
});

describe('SummaryCompactionService', () => {
  it('returns cleanly when there is no chat state or no overflowing level', async () => {
    install([], []);
    mocks.state = null;
    await expect(new SummaryCompactionService().processNextIfNeeded()).resolves.toEqual({
      state: null,
      compactedChunks: 0,
      pending: false,
    });

    const messages = chat(2);
    const entries = await entriesForChat(messages);
    install(messages, entries);
    await expect(new SummaryCompactionService().processAllPending()).resolves.toMatchObject({
      compactedChunks: 0,
      pending: false,
    });
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('recursively carries Level 1 summaries into higher levels', async () => {
    const messages = chat(7);
    install(messages, await entriesForChat(messages));
    const onProgress = vi.fn();

    const result = await new SummaryCompactionService().processAllPending(onProgress);

    expect(result.compactedChunks).toBe(4);
    expect(result.pending).toBe(false);
    expect(result.state?.stageSummary.entries.map((entry) => entry.level)).toEqual([3, 2, 1]);
    expect(result.state?.stageSummary.entries.map((entry) => [
      entry.sourceStartMessageId,
      entry.sourceEndMessageId,
    ])).toEqual([[0, 3], [4, 5], [6, 6]]);
    expect(result.state?.stageSummary.entries[0]?.compaction).toMatchObject({
      sourceLevel: 2,
      sourceEntryCount: 2,
    });
    expect(result.state?.metrics.summaryCompactions).toBe(4);
    expect(result.state?.recentInternalLlmAttempts).toHaveLength(4);
    expect(mocks.complete).toHaveBeenCalledTimes(4);
    expect(onProgress).toHaveBeenCalledTimes(4);
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ pending: false }));
    for (const [index, [, request]] of mocks.complete.mock.calls.entries()) {
      expect(request).toMatchObject({ maxTokens: 8_000, timeoutMs: 300_000 });
      expect(request.system).toBe(index < 3
        ? LEVEL_2_SUMMARY_COMPACTION_SYSTEM_PROMPT
        : HIGHER_LEVEL_SUMMARY_COMPACTION_SYSTEM_PROMPT);
    }
  });

  it('preserves an interrupted full-rebuild checkpoint while compacting active summaries', async () => {
    const messages = chat(3);
    const entries = await entriesForChat(messages);
    install(messages, entries);
    mocks.state!.stageSummary.rebuildCheckpoint = {
      targetEndMessageId: 2,
      targetSourceHash: 'target-source',
      generationSignature: 'generation-signature',
      entries: [structuredClone(entries[0]!)],
      totalDurationMs: 100,
      totalMessagesCovered: 1,
      updatedAt: '2026-01-02T00:00:00.000Z',
    };

    const result = await new SummaryCompactionService().processNextIfNeeded();

    expect(result.compactedChunks).toBe(1);
    expect(result.state?.stageSummary.rebuildCheckpoint).toMatchObject({
      targetSourceHash: 'target-source',
      entries: [{ sourceStartMessageId: 0, sourceEndMessageId: 0 }],
    });
  });

  it('keeps source entries unchanged when the high-level request fails', async () => {
    const messages = chat(3);
    const entries = await entriesForChat(messages);
    install(messages, entries);
    mocks.complete.mockRejectedValueOnce(new Error('upstream failed'));

    await expect(new SummaryCompactionService().processAllPending())
      .rejects.toThrow('upstream failed');

    expect(mocks.state?.stageSummary.entries).toEqual(entries);
    expect(mocks.state?.metrics.summaryCompactionFailures).toBe(1);
    expect(mocks.state?.recentInternalLlmAttempts.at(-1)).toMatchObject({
      task: 'summary-compaction',
      status: 'failed',
    });
  });

  it('rejects stale child source hashes before calling the model', async () => {
    const messages = chat(3);
    const entries = await entriesForChat(messages);
    entries[0] = { ...entries[0]!, sourceHash: 'stale-source-hash' };
    install(messages, entries);

    await expect(new SummaryCompactionService().processNextIfNeeded())
      .rejects.toThrow('来源消息 0～0 已变化');

    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.state?.stageSummary.entries).toEqual(entries);
    expect(mocks.state?.metrics.summaryCompactionFailures).toBe(1);
  });

  it('rejects a source edit that lands between child-hash validation steps', async () => {
    const messages = chat(3);
    const edited = structuredClone(messages);
    edited[0]!.mes = '消息-0-已编辑';
    const entries = await entriesForChat(messages);
    let chatReads = 0;
    install(messages, entries, () => {
      chatReads += 1;
      return chatReads >= 4 ? edited : messages;
    });

    await expect(new SummaryCompactionService().processNextIfNeeded())
      .rejects.toThrow('校验高层总结来源期间原文发生变化');

    expect(chatReads).toBeGreaterThanOrEqual(4);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.state?.stageSummary.entries).toEqual(entries);
  });

  it('initially accepts a legacy child without a source hash and anchors the parent to raw chat', async () => {
    const messages = chat(3);
    const entries = await entriesForChat(messages);
    entries[0] = { ...entries[0]!, sourceHash: '' };
    install(messages, entries);

    const result = await new SummaryCompactionService().processNextIfNeeded();

    expect(result.compactedChunks).toBe(1);
    expect(result.state?.stageSummary.entries[0]?.sourceHash).toBeTruthy();
    expect(result.state?.stageSummary.entries[0]?.compaction?.sources[0]?.sourceHash).toBe('');
  });

  it('rejects a compaction range that is no longer present in the chat', async () => {
    const originalMessages = chat(3);
    const entries = await entriesForChat(originalMessages);
    install(originalMessages.slice(0, 1), entries);

    await expect(new SummaryCompactionService().processNextIfNeeded())
      .rejects.toThrow('来源范围已超出当前聊天');
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('compacts an all-deleted run without spending an LLM request', async () => {
    const messages = chat(3);
    const entries = await entriesForChat(messages);
    entries[0] = { ...entries[0]!, text: '', deleted: true };
    entries[1] = { ...entries[1]!, text: '', deleted: true };
    install(messages, entries);

    const result = await new SummaryCompactionService().processNextIfNeeded();

    expect(mocks.complete).not.toHaveBeenCalled();
    expect(result.state?.stageSummary.entries[0]).toMatchObject({
      level: 2,
      sourceStartMessageId: 0,
      sourceEndMessageId: 1,
      text: '',
      deleted: true,
    });
  });

  it('regenerates a high-level entry from its saved direct children', async () => {
    const messages = chat(3);
    install(messages, await entriesForChat(messages));
    const service = new SummaryCompactionService();
    const compacted = await service.processNextIfNeeded();
    const parent = compacted.state!.stageSummary.entries[0]!;
    mocks.complete.mockResolvedValueOnce({
      text: '重新生成的高层总结',
      metadata: {
        provider: 'main',
        requestedMaxTokens: 8_000,
        finishReason: 'stop',
        responseCharacters: 9,
      },
    });

    const result = await service.regenerateEntry(parent.sourceStartMessageId, parent.updatedAt);

    expect(result.entry).toMatchObject({
      text: '重新生成的高层总结',
      level: 2,
      sourceStartMessageId: 0,
      sourceEndMessageId: 1,
      compaction: { sourceLevel: 1, sourceEntryCount: 2 },
    });
    expect(result.state.stageSummary.entries[1]?.level).toBe(1);
  });

  it('refuses high-level regeneration when the selected revision or provenance changed', async () => {
    const messages = chat(3);
    install(messages, await entriesForChat(messages));
    const service = new SummaryCompactionService();
    const compacted = await service.processNextIfNeeded();
    const parent = compacted.state!.stageSummary.entries[0]!;

    await expect(service.regenerateEntry(parent.sourceStartMessageId, 'older-revision'))
      .rejects.toThrow('已在其他操作中发生变化');

    parent.compaction!.inputHash = 'corrupted-provenance';
    await expect(service.regenerateEntry(parent.sourceStartMessageId, parent.updatedAt))
      .rejects.toThrow('来源记录校验失败');
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });

  it('rejects regeneration for a Level 1 entry without high-level provenance', async () => {
    const messages = chat(2);
    const entries = await entriesForChat(messages);
    install(messages, entries);

    await expect(new SummaryCompactionService().regenerateEntry(entries[0]!.sourceStartMessageId))
      .rejects.toThrow('不存在或缺少来源记录');
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('rejects high-level regeneration when the chat has no StoryEcho state', async () => {
    install([], []);
    mocks.state = null;

    await expect(new SummaryCompactionService().regenerateEntry(0))
      .rejects.toThrow('当前没有可用聊天');
  });

  it('records a failed high-level regeneration and preserves the parent', async () => {
    const messages = chat(3);
    install(messages, await entriesForChat(messages));
    const service = new SummaryCompactionService();
    const compacted = await service.processNextIfNeeded();
    const parent = structuredClone(compacted.state!.stageSummary.entries[0]!);
    mocks.complete.mockRejectedValueOnce(new Error('regeneration failed'));

    await expect(service.regenerateEntry(parent.sourceStartMessageId))
      .rejects.toThrow('regeneration failed');

    expect(mocks.state?.stageSummary.entries[0]).toEqual(parent);
    expect(mocks.state?.metrics.summaryCompactionFailures).toBe(1);
    expect(mocks.state?.recentInternalLlmAttempts.at(-1)).toMatchObject({
      task: 'summary-compaction',
      status: 'failed',
    });
  });
});

describe('summary compaction prompt', () => {
  it('uses a loss-bounded consolidation prompt for Level 2', () => {
    const prompt = buildSummaryCompactionPrompt({
      targetLevel: 2,
      sources: [bareEntry(0)],
    });
    const all = `${summaryCompactionSystemPrompt(2)}\n${prompt}`;
    expect(summaryCompactionSystemPrompt(2)).toBe(LEVEL_2_SUMMARY_COMPACTION_SYSTEM_PROMPT);
    expect(all).toContain('L2 是详细的中期归档层');
    expect(all).toContain('起因—关键转折或选择—结果');
    expect(all).toContain('逐条核对所有 source_summaries');
    expect(all).toContain('成品理应明显长于任意一条来源总结');
    expect(all).not.toContain('高层级意味着更强压缩');
    expect(all).toContain('source_summaries');
    expect(all).not.toContain('最大输出');
    expect(all).not.toContain('Token');
    expect(all).not.toContain('JSON 输出');
  });

  it('uses stronger long-term compression only for Level 3 and above', () => {
    expect(summaryCompactionSystemPrompt(3)).toBe(HIGHER_LEVEL_SUMMARY_COMPACTION_SYSTEM_PROMPT);
    expect(summaryCompactionSystemPrompt(8)).toBe(HIGHER_LEVEL_SUMMARY_COMPACTION_SYSTEM_PROMPT);
    expect(summaryCompactionSystemPrompt(3)).toContain('高层级意味着更强压缩');
    expect(summaryCompactionSystemPrompt(3)).toContain('最短因果链');
  });

  it('marks deleted sources as empty and includes optional world background', () => {
    const prompt = buildSummaryCompactionPrompt({
      targetLevel: 3,
      worldBackground: '<story_echo_world_background>设定</story_echo_world_background>',
      sources: [{ ...bareEntry(0, 2), text: '', deleted: true }],
    });

    expect(prompt).toContain('<story_echo_world_background>设定</story_echo_world_background>');
    expect(prompt).toContain('"deleted":true');
    expect(prompt).toContain('"content":""');
  });

  it('renders a defensive empty range when no source is supplied', () => {
    const prompt = buildSummaryCompactionPrompt({ targetLevel: 2, sources: [] });

    expect(prompt).toContain('来源覆盖：消息 -1 到 -1');
    expect(prompt).toContain('<source_summaries>\n[]\n</source_summaries>');
  });
});
