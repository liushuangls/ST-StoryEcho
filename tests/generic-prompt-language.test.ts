import { describe, expect, it } from 'vitest';
import { renderStageSummaryBlock, renderStorySkeletonBlock } from '../src/prompt/render';
import {
  buildStageSummaryPrompt,
  STAGE_SUMMARY_SYSTEM_PROMPT,
} from '../src/summary/prompts';
import {
  buildStorySkeletonPrompt,
  STORY_SKELETON_SYSTEM_PROMPT,
} from '../src/summary/skeleton-prompts';

describe('context prompts', () => {
  it('contains only the retained context-management protocol tags', () => {
    const text = [
      STAGE_SUMMARY_SYSTEM_PROMPT,
      STORY_SKELETON_SYSTEM_PROMPT,
      renderStageSummaryBlock('阶段纪要'),
      renderStorySkeletonBlock('长期主线', 10),
    ].join('\n');
    expect(text).toContain('story_echo_summary');
    expect(text).toContain('story_echo_skeleton');
    expect(text).not.toContain('story_echo_recall');
    expect(text).not.toContain('authoritative_facts');
  });

  it('lets summaries and skeletons choose a content-shaped structure', () => {
    const stagePrompt = buildStageSummaryPrompt([
      { mes: '旅队穿过山谷后抵达北城。', is_user: false, name: '旁白' },
    ], 0);
    const skeletonPrompt = buildStorySkeletonPrompt({
      existingSkeleton: '',
      sourceEntries: [],
      mode: 'initial-build',
    });
    for (const prompt of [
      `${STAGE_SUMMARY_SYSTEM_PROMPT}\n${stagePrompt}`,
      `${STORY_SKELETON_SYSTEM_PROMPT}\n${skeletonPrompt}`,
    ]) {
      expect(prompt).toContain('标题');
      expect(prompt).toContain('动态小节');
      expect(prompt).toContain('自然段落');
      expect(prompt).toContain('自主选择');
    }
  });
});
