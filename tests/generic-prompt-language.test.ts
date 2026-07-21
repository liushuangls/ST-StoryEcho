import { describe, expect, it } from 'vitest';
import { CONSOLIDATION_SYSTEM_PROMPT } from '../src/consolidation/prompts';
import { EXTRACTION_SYSTEM_PROMPT } from '../src/extraction/prompts';
import { renderMemoryBlock, renderStageSummaryBlock } from '../src/prompt/render';
import { QUERY_REWRITE_SYSTEM_PROMPT } from '../src/retrieval/query-rewriter';
import {
  buildStageSummaryPrompt,
  STAGE_SUMMARY_SYSTEM_PROMPT,
} from '../src/summary/prompts';
import {
  buildStorySkeletonPrompt,
  STORY_SKELETON_SYSTEM_PROMPT,
} from '../src/summary/skeleton-prompts';
import { memory } from './fixtures';

const CASE_SPECIFIC_LANGUAGE = /(?:旧案|新案|案件|案情|结案)/u;

describe('genre-neutral LLM prompts', () => {
  it('keeps every fixed LLM instruction and request injection genre-neutral', () => {
    const recallBlock = renderMemoryBlock([memory({
      event: '旅队完成山谷穿越并抵达北城',
      scene: { time: '清晨', location: '北城', participants: ['旅队'] },
      entities: ['旅队', '北城'],
      aliases: [],
      stateChanges: [],
    })]);
    const summaryBlock = renderStageSummaryBlock(
      '旅队已抵达北城并准备休整，下一步计划尚未确定。',
    );

    const fixedPromptText = [
      EXTRACTION_SYSTEM_PROMPT,
      CONSOLIDATION_SYSTEM_PROMPT,
      QUERY_REWRITE_SYSTEM_PROMPT,
      STAGE_SUMMARY_SYSTEM_PROMPT,
      STORY_SKELETON_SYSTEM_PROMPT,
      recallBlock,
      summaryBlock,
    ].join('\n');

    expect(fixedPromptText).not.toMatch(CASE_SPECIFIC_LANGUAGE);
  });

  it('lets stage summaries and global skeletons choose content-shaped headings and sections', () => {
    const stagePrompt = [
      STAGE_SUMMARY_SYSTEM_PROMPT,
      buildStageSummaryPrompt([
        {
          mes: '旅队穿过山谷后抵达北城。',
          is_user: false,
          is_system: false,
          name: '旁白',
        },
      ], 0),
    ].join('\n');
    const skeletonPrompt = [
      STORY_SKELETON_SYSTEM_PROMPT,
      buildStorySkeletonPrompt('', [], 5_000, false),
    ].join('\n');

    for (const prompt of [stagePrompt, skeletonPrompt]) {
      expect(prompt).toContain('标题');
      expect(prompt).toContain('动态小节');
      expect(prompt).toContain('分类标签');
      expect(prompt).toContain('自然段落');
      expect(prompt).not.toContain('不要强行添加固定标题');
    }
  });
});
