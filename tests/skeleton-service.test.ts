import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODULE_ID } from '../src/core/constants';
import type { StageSummaryEntry, StoryEchoSettings, TavernChatMessage } from '../src/core/types';
import { MemoryRepository } from '../src/memory/repository';
import type { SillyTavernWorldInfoEntry } from '../src/platform/sillytavern';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { StorySkeletonService } from '../src/summary/skeleton-service';
import {
  STORY_SKELETON_SYSTEM_PROMPT,
  STORY_SKELETON_VERIFICATION_SYSTEM_PROMPT,
} from '../src/summary/skeleton-prompts';
import {
  MAX_SKELETON_SOURCE_BATCH_CHARACTERS,
  skeletonSourceBatchCharacters,
  skeletonSourceBatches,
  storySkeletonIsUsable,
  storySkeletonSourceHash,
} from '../src/summary/skeleton-state';
import { chatState } from './fixtures';

function skeletonText(core = '用户角色与姜梦共同推进蜀山主线。'): string {
  return [
    core,
    '用户角色在蜀山学习无我剑诀，并在姜梦护法下完成一次关键突破。',
    '剑冢异动引出了来源未明的旧阵主线，相关幕后势力仍待调查。',
  ].join('\n');
}

function stageEntry(index: number): StageSummaryEntry {
  const start = index * 2;
  return {
    text: `第${index + 1}阶段完成，发生重要事件${index + 1}；后续仍需推进目标${index + 1}。`,
    sourceStartMessageId: start,
    sourceEndMessageId: start + 1,
    sourceHash: `stage-source-${index}`,
    updatedAt: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
  };
}

function installContext(
  entries: StageSummaryEntry[],
  generateRaw: ReturnType<typeof vi.fn>,
  options: {
    windowSize?: number;
    skeletonMaxTokens?: number;
    verificationRaw?: string;
    verificationError?: Error;
  } = {},
) {
  const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
  settings.enabled = true;
  settings.summary.windowSize = options.windowSize ?? 4;
  settings.summary.skeletonMaxTokens = options.skeletonMaxTokens ?? 5_000;
  const state = chatState([]);
  state.ownerChatId = 'chat-id';
  state.stageSummary = {
    entries,
    coveredThroughMessageId: entries.at(-1)?.sourceEndMessageId ?? -1,
    coveredThroughHash: entries.at(-1)?.sourceHash ?? '',
    ...(entries.length > 0 ? { updatedAt: entries.at(-1)!.updatedAt } : {}),
  };
  const chat: TavernChatMessage[] = Array.from(
    { length: (entries.at(-1)?.sourceEndMessageId ?? -1) + 1 },
    (_, index) => ({ is_user: index % 2 === 0, mes: `消息${index}` }),
  );
  const routedGenerateRaw = vi.fn(async (request: { prompt?: string; systemPrompt?: string }) => {
    if (String(request.systemPrompt ?? '').includes(STORY_SKELETON_VERIFICATION_SYSTEM_PROMPT)) {
      if (options.verificationError) {
        throw options.verificationError;
      }
      if (options.verificationRaw !== undefined) {
        return options.verificationRaw;
      }
      const candidate = String(request.prompt ?? '').match(
        /<candidate_story_skeleton>\n([\s\S]*?)\n<\/candidate_story_skeleton>/u,
      )?.[1];
      return candidate ?? skeletonText();
    }
    return generateRaw(request);
  });
  const context = {
    chat,
    chatId: 'chat-id',
    extensionSettings: { [MODULE_ID]: settings },
    chatMetadata: { [MODULE_ID]: state },
    saveSettingsDebounced: vi.fn(),
    saveMetadata: vi.fn(async () => undefined),
    generateRaw: routedGenerateRaw,
    getCurrentChatId: () => 'chat-id',
    getTokenCountAsync: vi.fn(async (text: string) => Array.from(text).length),
    getSortedWorldInfoEntries: vi.fn(async (): Promise<SillyTavernWorldInfoEntry[]> => []),
  };
  vi.stubGlobal('SillyTavern', { getContext: () => context });
  return { context, settings, state, routedGenerateRaw };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('global story skeleton lifecycle', () => {
  it('defines a genre-adaptive historical outline instead of a status or NPC profile', () => {
    expect(STORY_SKELETON_SYSTEM_PROMPT).toContain('长期的重要历史事件记录与剧情大纲');
    expect(STORY_SKELETON_SYSTEM_PROMPT).toContain('人物档案、NPC介绍');
    expect(STORY_SKELETON_SYSTEM_PROMPT).toContain('当前境界、属性数值、生命状态');
    expect(STORY_SKELETON_SYSTEM_PROMPT).toContain('修仙或玄幻剧情可突出重要历练');
    expect(STORY_SKELETON_SYSTEM_PROMPT).toContain('自主选择合适的标题');
  });

  it('first builds at S+1 but includes every current summary regardless of S', async () => {
    const generateRaw = vi.fn(async (options: { prompt: string }) => {
      expect(options.prompt).toContain('<baseline_status>initial-build</baseline_status>');
      for (let index = 1; index <= 5; index += 1) {
        expect(options.prompt).toContain(`第${index}阶段完成`);
      }
      expect(options.prompt.indexOf('第1阶段完成')).toBeLessThan(
        options.prompt.indexOf('第5阶段完成'),
      );
      return skeletonText();
    });
    const entries = Array.from({ length: 5 }, (_, index) => stageEntry(index));
    installContext(entries, generateRaw, { windowSize: 4 });

    const result = await new StorySkeletonService().processNextIfNeeded();

    expect(result.updatedChunks).toBe(1);
    expect(result.pendingEntries).toBe(0);
    expect(result.state?.storySkeleton.coveredThroughMessageId).toBe(entries.at(-1)!.sourceEndMessageId);
    expect(result.state?.storySkeleton.stale).toBeUndefined();
    expect(storySkeletonIsUsable(result.state!)).toBe(true);
    expect(generateRaw).toHaveBeenCalledOnce();
  });

  it('uses only the newly archived summary for green matches and adds blue-light background', async () => {
    const generateRaw = vi.fn(async (_options: { prompt: string; systemPrompt: string }) => (
      skeletonText('命中世界书后的骨架。')
    ));
    const entries = Array.from({ length: 6 }, (_, index) => stageEntry(index));
    entries[1]!.text = '用户角色开始修炼无我剑诀。';
    const installed = installContext(entries, generateRaw);
    installed.state.storySkeleton = {
      text: skeletonText('用户角色长期持有太虚剑。'),
      coveredThroughMessageId: entries[0]!.sourceEndMessageId,
      sourceHash: await storySkeletonSourceHash(entries, entries[0]!.sourceEndMessageId),
    };
    installed.context.getSortedWorldInfoEntries.mockResolvedValueOnce([{
      world: '剑道设定', uid: 21, key: ['太虚剑'], content: '太虚剑是蜀山古传法宝。',
    }, {
      world: '剑道设定', uid: 22, key: ['无我剑诀'], content: '无我剑诀以忘我、忘剑为核心。',
    }, {
      world: '玄天界常驻背景', uid: 23, constant: true,
      content: '玄天界的修行秩序由宗门、世家与散修共同构成。',
    }]);

    const result = await new StorySkeletonService().processNextIfNeeded();

    expect(result.updatedChunks).toBe(1);
    const request = generateRaw.mock.calls[0]?.[0];
    const prompt = String(request?.prompt ?? '');
    expect(prompt).toContain('<constant_world_info>');
    expect(prompt).toContain('<matched_world_info>');
    expect(prompt).not.toContain('太虚剑是蜀山古传法宝');
    expect(prompt).toContain('无我剑诀以忘我、忘剑为核心');
    expect(prompt).toContain('玄天界的修行秩序由宗门、世家与散修共同构成');
    expect(prompt).toContain('<baseline_status>incremental-update</baseline_status>');
    expect(prompt).toContain('用户角色长期持有太虚剑');
    expect(prompt).toContain('用户角色开始修炼无我剑诀');
    expect(prompt).not.toContain('第3阶段');
    expect(String(request?.systemPrompt ?? '')).toContain('旧骨架与阶段总结提供已经发生的剧情');
  });

  it('fact-checks every generated skeleton draft before committing it', async () => {
    const entries = Array.from({ length: 5 }, (_, index) => stageEntry(index));
    entries[0]!.text = '海伊是金丹中期修士；她携带一具元婴中期玄冰傀儡。';
    const candidate = skeletonText('海伊是元婴中期修士，并已经开始炼化异界碎片。');
    const corrected = skeletonText('海伊是金丹中期修士，携带一具元婴中期玄冰傀儡；炼化异界碎片仍只是讨论。');
    const installed = installContext(
      entries,
      vi.fn(async () => candidate),
      { windowSize: 4, verificationRaw: corrected },
    );

    const result = await new StorySkeletonService().processNextIfNeeded();

    expect(result.state?.storySkeleton.text).toBe(corrected);
    expect(installed.routedGenerateRaw).toHaveBeenCalledTimes(2);
    const verificationRequest = installed.routedGenerateRaw.mock.calls[1]?.[0];
    expect(String(verificationRequest?.systemPrompt ?? '')).toContain('事实一致性编辑器');
    expect(String(verificationRequest?.prompt ?? '')).toContain(candidate);
    expect(String(verificationRequest?.prompt ?? '')).toContain(entries[0]!.text);
  });

  it('fully rebuilds cleanly from all summaries and discards the saved old skeleton', async () => {
    const generateRaw = vi.fn(async (options: { prompt: string }) => {
      expect(options.prompt).toContain('<baseline_status>full-rebuild</baseline_status>');
      expect(options.prompt).toContain('<existing_story_skeleton>\n无\n</existing_story_skeleton>');
      expect(options.prompt).not.toContain('旧骨架保留的重要历史');
      for (let index = 1; index <= 5; index += 1) {
        expect(options.prompt).toContain(`第${index}阶段完成`);
      }
      expect(options.prompt).toContain('蓝灯常驻背景用于理解玄天界法则');
      return skeletonText('全部历史已按长期剧情大纲重新整理。');
    });
    const entries = Array.from({ length: 5 }, (_, index) => stageEntry(index));
    const { context, state } = installContext(entries, generateRaw, { windowSize: 4 });
    context.getSortedWorldInfoEntries.mockResolvedValueOnce([{
      world: '玄天界常驻设定', uid: 99, constant: true,
      content: '蓝灯常驻背景用于理解玄天界法则。',
    }]);
    state.storySkeleton = {
      text: skeletonText('旧骨架保留的重要历史。'),
      coveredThroughMessageId: entries[0]!.sourceEndMessageId,
      sourceHash: await storySkeletonSourceHash(entries, entries[0]!.sourceEndMessageId),
      manuallyEdited: true,
    };

    const result = await new StorySkeletonService().rebuildAll();

    expect(result.updatedChunks).toBe(1);
    expect(result.pendingEntries).toBe(0);
    expect(result.state?.storySkeleton.coveredThroughMessageId).toBe(entries.at(-1)!.sourceEndMessageId);
    expect(result.state?.storySkeleton.sourceHash).toBe(
      await storySkeletonSourceHash(entries, entries.at(-1)!.sourceEndMessageId),
    );
    expect(result.state?.storySkeleton.manuallyEdited).toBeUndefined();
  });

  it('processes all history chronologically in batches of at most 80000 characters', async () => {
    const entries = Array.from({ length: 3 }, (_, index) => stageEntry(index));
    entries.forEach((entry, index) => {
      entry.text = `第${index + 1}阶段：${String(index + 1).repeat(38_000)}`;
    });
    const generateRaw = vi.fn(async (options: { prompt: string }) => (
      options.prompt.includes('full-rebuild-continue')
        ? skeletonText('第二批完成后的骨架。')
        : skeletonText('第一批形成的临时草稿。')
    ));
    const { state } = installContext(entries, generateRaw, { windowSize: 1 });
    state.storySkeleton = {
      text: skeletonText('重新生成前的旧骨架。'),
      coveredThroughMessageId: entries[0]!.sourceEndMessageId,
      sourceHash: await storySkeletonSourceHash(entries, entries[0]!.sourceEndMessageId),
    };

    const result = await new StorySkeletonService().rebuildAll();

    expect(MAX_SKELETON_SOURCE_BATCH_CHARACTERS).toBe(80_000);
    expect(result.updatedChunks).toBe(2);
    expect(generateRaw).toHaveBeenCalledTimes(2);
    const firstPrompt = String(generateRaw.mock.calls[0]?.[0]?.prompt ?? '');
    const secondPrompt = String(generateRaw.mock.calls[1]?.[0]?.prompt ?? '');
    expect(firstPrompt).toContain('<baseline_status>full-rebuild</baseline_status>');
    expect(firstPrompt).toContain('第1阶段');
    expect(firstPrompt).toContain('第2阶段');
    expect(firstPrompt).not.toContain('第3阶段');
    expect(secondPrompt).toContain('<baseline_status>full-rebuild-continue</baseline_status>');
    expect(secondPrompt).toContain('第一批形成的临时草稿');
    expect(secondPrompt).toContain('第3阶段');
    expect(result.state?.storySkeleton.coveredThroughMessageId).toBe(entries.at(-1)!.sourceEndMessageId);
  });

  it('splits sources by the 80000-character batch cap and rejects one oversized summary', () => {
    const entries = [stageEntry(20), stageEntry(21), stageEntry(22)];
    entries[0]!.text = '甲'.repeat(39_000);
    entries[1]!.text = '乙'.repeat(39_000);
    entries[2]!.text = '丙'.repeat(39_000);

    const batches = skeletonSourceBatches(entries);
    expect(batches).toEqual([[entries[0], entries[1]], [entries[2]]]);
    for (const batch of batches) {
      expect(skeletonSourceBatchCharacters(batch)).toBeLessThanOrEqual(
        MAX_SKELETON_SOURCE_BATCH_CHARACTERS,
      );
    }
    entries[0]!.text = '超'.repeat(MAX_SKELETON_SOURCE_BATCH_CHARACTERS);
    expect(() => skeletonSourceBatches([entries[0]!])).toThrow(/单条阶段总结/);
  });

  it('keeps the saved skeleton intact when a later rebuild batch fails', async () => {
    const entries = Array.from({ length: 3 }, (_, index) => stageEntry(index));
    entries.forEach((entry, index) => {
      entry.text = `第${index + 1}阶段：${String(index + 1).repeat(38_000)}`;
    });
    const generateRaw = vi.fn()
      .mockResolvedValueOnce(skeletonText('第一批临时草稿。'))
      .mockRejectedValueOnce(new Error('provider unavailable'));
    const { state } = installContext(entries, generateRaw, { windowSize: 1 });
    const originalText = skeletonText('这份旧骨架应在失败后继续保留。');
    state.storySkeleton = {
      text: originalText,
      coveredThroughMessageId: entries[0]!.sourceEndMessageId,
      sourceHash: await storySkeletonSourceHash(entries, entries[0]!.sourceEndMessageId),
      manuallyEdited: true,
    };

    await expect(new StorySkeletonService().rebuildAll()).rejects.toThrow('provider unavailable');

    expect(state.storySkeleton.text).toBe(originalText);
    expect(state.storySkeleton.coveredThroughMessageId).toBe(entries[0]!.sourceEndMessageId);
    expect(state.storySkeleton.manuallyEdited).toBe(true);
  });

  it('keeps the saved skeleton intact when fact verification fails', async () => {
    const entries = Array.from({ length: 5 }, (_, index) => stageEntry(index));
    const originalText = skeletonText('核验失败后应继续保留的旧骨架。');
    const { state } = installContext(
      entries,
      vi.fn(async () => skeletonText('尚未通过核验的草稿。')),
      { windowSize: 4, verificationError: new Error('verification unavailable') },
    );
    state.storySkeleton = {
      text: originalText,
      coveredThroughMessageId: entries[0]!.sourceEndMessageId,
      sourceHash: await storySkeletonSourceHash(entries, entries[0]!.sourceEndMessageId),
      manuallyEdited: true,
    };

    await expect(new StorySkeletonService().rebuildAll())
      .rejects.toThrow('verification unavailable');

    expect(state.storySkeleton.text).toBe(originalText);
    expect(state.storySkeleton.manuallyEdited).toBe(true);
  });

  it('does not build while all stage summaries still fit inside S', async () => {
    const generateRaw = vi.fn(async () => skeletonText());
    installContext(Array.from({ length: 4 }, (_, index) => stageEntry(index)), generateRaw);

    const result = await new StorySkeletonService().processNextIfNeeded();

    expect(result.updatedChunks).toBe(0);
    expect(generateRaw).not.toHaveBeenCalled();
  });

  it('immediately absorbs exactly one newly archived summary per automatic update', async () => {
    const generateRaw = vi.fn(async (_options: { prompt: string }) => (
      skeletonText('增量更新后的骨架。')
    ));
    const entries = Array.from({ length: 7 }, (_, index) => stageEntry(index));
    const { state } = installContext(entries, generateRaw);
    state.storySkeleton = {
      text: skeletonText('最初骨架。'),
      coveredThroughMessageId: entries[0]!.sourceEndMessageId,
      sourceHash: await storySkeletonSourceHash(entries, entries[0]!.sourceEndMessageId),
    };

    const result = await new StorySkeletonService().processNextIfNeeded();

    expect(result.updatedChunks).toBe(1);
    expect(result.pendingEntries).toBe(1);
    expect(result.state?.storySkeleton.coveredThroughMessageId).toBe(entries[1]!.sourceEndMessageId);
    const prompt = String(generateRaw.mock.calls[0]?.[0]?.prompt ?? '');
    expect(prompt).toContain('第2阶段');
    expect(prompt).not.toContain('第3阶段');
  });

  it('manual history processing folds every pending archive one by one', async () => {
    const generateRaw = vi.fn(async () => skeletonText('手动更新后的骨架。'));
    const entries = Array.from({ length: 7 }, (_, index) => stageEntry(index));
    const { state } = installContext(entries, generateRaw);
    state.storySkeleton = {
      text: skeletonText('更新前骨架。'),
      coveredThroughMessageId: entries[0]!.sourceEndMessageId,
      sourceHash: await storySkeletonSourceHash(entries, entries[0]!.sourceEndMessageId),
    };

    const result = await new StorySkeletonService().processAllPending();

    expect(result.updatedChunks).toBe(2);
    expect(result.pendingEntries).toBe(0);
    expect(result.state?.storySkeleton.coveredThroughMessageId).toBe(entries[2]!.sourceEndMessageId);
    expect(generateRaw).toHaveBeenCalledTimes(2);
  });

  it('uses the configurable 10000-token cap and keeps manual edits for incremental updates', async () => {
    const generateRaw = vi.fn(async (options: { prompt: string }) => {
      expect(options.prompt).toContain('用户人工确认：姜梦是长期同行者。');
      return skeletonText('用户人工确认：姜梦是长期同行者；新增阶段已合并。');
    });
    const entries = Array.from({ length: 6 }, (_, index) => stageEntry(index));
    const { state } = installContext(entries, generateRaw, { skeletonMaxTokens: 10_000 });
    state.storySkeleton = {
      text: skeletonText('旧自动骨架。'),
      coveredThroughMessageId: entries[0]!.sourceEndMessageId,
      sourceHash: await storySkeletonSourceHash(entries, entries[0]!.sourceEndMessageId),
    };
    const repository = new MemoryRepository();
    const edited = await repository.updateStorySkeleton({
      text: skeletonText('用户人工确认：姜梦是长期同行者。'),
    });

    expect(edited.storySkeleton.manuallyEdited).toBe(true);
    const result = await new StorySkeletonService().processNextIfNeeded();

    expect(result.updatedChunks).toBe(1);
    expect(result.state?.storySkeleton.manuallyEdited).toBe(true);
    expect(generateRaw).toHaveBeenCalledWith(expect.objectContaining({ responseLength: 10_000 }));
    await expect(repository.updateStorySkeleton({ text: '' })).rejects.toThrow(/不能为空/);
  });

  it('marks an existing skeleton stale when a lowered configured cap no longer fits it', async () => {
    const entries = Array.from({ length: 5 }, (_, index) => stageEntry(index));
    const { state } = installContext(entries, vi.fn(async () => skeletonText()), {
      skeletonMaxTokens: 512,
    });
    state.storySkeleton = {
      text: skeletonText('甲'.repeat(700)),
      coveredThroughMessageId: entries[0]!.sourceEndMessageId,
      sourceHash: await storySkeletonSourceHash(entries, entries[0]!.sourceEndMessageId),
    };

    const reconciled = await new StorySkeletonService().reconcile();

    expect(reconciled?.storySkeleton.stale).toBe(true);
    expect(storySkeletonIsUsable(reconciled!)).toBe(false);
  });

  it('does not hash an unchanged skeleton source again when newer summaries are appended', async () => {
    const digest = vi.fn(async () => new Uint8Array(32).buffer);
    vi.stubGlobal('crypto', { subtle: { digest } });
    const entries = Array.from({ length: 5 }, (_, index) => stageEntry(index));
    const { state } = installContext(entries, vi.fn(async () => skeletonText()));
    state.storySkeleton = {
      text: skeletonText(),
      coveredThroughMessageId: entries[0]!.sourceEndMessageId,
      sourceHash: '00'.repeat(32),
    };
    const service = new StorySkeletonService();

    await service.reconcile(state);
    const callsAfterInitialVerification = digest.mock.calls.length;
    const next = stageEntry(5);
    state.stageSummary.entries.push(next);
    state.stageSummary.coveredThroughMessageId = next.sourceEndMessageId;
    state.stageSummary.coveredThroughHash = next.sourceHash;
    await service.reconcile(state);

    expect(digest).toHaveBeenCalledTimes(callsAfterInitialVerification);

    entries[0]!.text = '用户编辑了已经汇入骨架的阶段总结。';
    await service.reconcile(state);

    expect(digest.mock.calls.length).toBeGreaterThan(callsAfterInitialVerification);
  });
});
