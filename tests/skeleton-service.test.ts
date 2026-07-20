import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODULE_ID } from '../src/core/constants';
import type { StageSummaryEntry, StoryEchoSettings, TavernChatMessage } from '../src/core/types';
import { MemoryRepository } from '../src/memory/repository';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { StorySkeletonService } from '../src/summary/skeleton-service';
import { STORY_SKELETON_SYSTEM_PROMPT } from '../src/summary/skeleton-prompts';
import {
  storySkeletonIsUsable,
  storySkeletonSourceHash,
} from '../src/summary/skeleton-state';
import { chatState } from './fixtures';

function skeletonText(core = '用户角色与姜梦共同推进蜀山主线。'): string {
  return [
    core,
    '用户角色在蜀山修炼无我剑诀，并承诺继续完成姜梦安排的功课。',
    '当前用户角色仍在蜀山；剑冢异动的原因尚未确认。',
  ].join('\n');
}

function stageEntry(index: number): StageSummaryEntry {
  const start = index * 2;
  return {
    text: `第${index + 1}阶段完成，当前状态更新为状态${index + 1}；下一阶段仍需推进目标${index + 1}。`,
    sourceStartMessageId: start,
    sourceEndMessageId: start + 1,
    sourceHash: `stage-source-${index}`,
    updatedAt: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
  };
}

function installContext(
  entries: StageSummaryEntry[],
  generateRaw: ReturnType<typeof vi.fn>,
  options: { windowSize?: number; skeletonMaxTokens?: number } = {},
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
    { length: entries.at(-1)?.sourceEndMessageId ?? 0 },
    (_, index) => ({ is_user: index % 2 === 0, mes: `消息${index}` }),
  );
  const context = {
    chat,
    chatId: 'chat-id',
    extensionSettings: { [MODULE_ID]: settings },
    chatMetadata: { [MODULE_ID]: state },
    saveSettingsDebounced: vi.fn(),
    saveMetadata: vi.fn(async () => undefined),
    generateRaw,
    getCurrentChatId: () => 'chat-id',
  };
  vi.stubGlobal('SillyTavern', { getContext: () => context });
  return { context, settings, state };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('global story skeleton lifecycle', () => {
  it('keeps a genre-adaptive long-term plot spine with cultivation progression', () => {
    expect(STORY_SKELETON_SYSTEM_PROMPT).toContain('不要套用预设题材、卷宗式分类或固定栏目');
    expect(STORY_SKELETON_SYSTEM_PROMPT).toContain('修仙或玄幻剧情优先修炼体系、境界与突破');
    expect(STORY_SKELETON_SYSTEM_PROMPT).toContain('可以按时间、因果、人物成长、关系或势力线自然分段');
    expect(STORY_SKELETON_SYSTEM_PROMPT).toContain('重大因果和成长轨迹');
  });

  it('first builds when the S+1 stage summary becomes archived', async () => {
    const generateRaw = vi.fn(async () => skeletonText());
    const entries = Array.from({ length: 5 }, (_, index) => stageEntry(index));
    installContext(entries, generateRaw, { windowSize: 4 });

    const result = await new StorySkeletonService().processNextIfNeeded();

    expect(result.updatedChunks).toBe(1);
    expect(result.pendingEntries).toBe(0);
    expect(result.state?.storySkeleton.coveredThroughMessageId).toBe(1);
    expect(result.state?.storySkeleton.stale).toBeUndefined();
    expect(storySkeletonIsUsable(result.state!)).toBe(true);
    expect(generateRaw).toHaveBeenCalledOnce();
  });

  it('does not build while all stage summaries still fit inside S', async () => {
    const generateRaw = vi.fn(async () => skeletonText());
    installContext(Array.from({ length: 4 }, (_, index) => stageEntry(index)), generateRaw);

    const result = await new StorySkeletonService().processNextIfNeeded();

    expect(result.updatedChunks).toBe(0);
    expect(generateRaw).not.toHaveBeenCalled();
  });

  it('waits for three pending archived entries during routine updates', async () => {
    const generateRaw = vi.fn(async () => skeletonText('增量更新后的骨架。'));
    const entries = Array.from({ length: 7 }, (_, index) => stageEntry(index));
    const { state } = installContext(entries, generateRaw);
    state.storySkeleton = {
      text: skeletonText('最初骨架。'),
      coveredThroughMessageId: entries[0]!.sourceEndMessageId,
      sourceHash: await storySkeletonSourceHash(entries, entries[0]!.sourceEndMessageId),
    };
    const service = new StorySkeletonService();

    expect((await service.processNextIfNeeded()).updatedChunks).toBe(0);
    expect(generateRaw).not.toHaveBeenCalled();

    const next = stageEntry(7);
    state.stageSummary.entries.push(next);
    state.stageSummary.coveredThroughMessageId = next.sourceEndMessageId;
    state.stageSummary.coveredThroughHash = next.sourceHash;
    const result = await service.processNextIfNeeded();

    expect(result.updatedChunks).toBe(1);
    expect(result.state?.storySkeleton.coveredThroughMessageId).toBe(entries[3]!.sourceEndMessageId);
    expect(generateRaw).toHaveBeenCalledOnce();
  });

  it('forces a one-entry update from the manual history action', async () => {
    const generateRaw = vi.fn(async () => skeletonText('手动更新后的骨架。'));
    const entries = Array.from({ length: 6 }, (_, index) => stageEntry(index));
    const { state } = installContext(entries, generateRaw);
    state.storySkeleton = {
      text: skeletonText('更新前骨架。'),
      coveredThroughMessageId: entries[0]!.sourceEndMessageId,
      sourceHash: await storySkeletonSourceHash(entries, entries[0]!.sourceEndMessageId),
    };

    const result = await new StorySkeletonService().processAllPending();

    expect(result.updatedChunks).toBe(1);
    expect(result.pendingEntries).toBe(0);
    expect(result.state?.storySkeleton.coveredThroughMessageId).toBe(entries[1]!.sourceEndMessageId);
  });

  it('uses the configurable 10000-token cap for generation and keeps manual edits as the baseline', async () => {
    const generateRaw = vi.fn(async (options: { prompt: string }) => {
      expect(options.prompt).toContain('用户人工确认：姜梦是长期同行者。');
      return skeletonText('用户人工确认：姜梦是长期同行者；新增阶段已合并。');
    });
    const entries = Array.from({ length: 8 }, (_, index) => stageEntry(index));
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
    const natural = await repository.updateStorySkeleton({
      text: '刘爽继续在蜀山修炼；姜梦是长期同行与指导者。',
    });
    expect(natural.storySkeleton.text).toBe('刘爽继续在蜀山修炼；姜梦是长期同行与指导者。');
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
});
