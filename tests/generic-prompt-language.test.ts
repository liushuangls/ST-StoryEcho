import { describe, expect, it } from 'vitest';
import { renderStageSummaryBlock } from '../src/prompt/render';
import {
  buildStageSummaryPrompt,
  STAGE_SUMMARY_SYSTEM_PROMPT,
} from '../src/summary/prompts';
import {
  buildSummaryCompactionPrompt,
  SUMMARY_COMPACTION_SYSTEM_PROMPT,
} from '../src/summary/compaction-prompts';

describe('context prompts', () => {
  it('contains only the retained context-management protocol tags', () => {
    const text = [
      STAGE_SUMMARY_SYSTEM_PROMPT,
      SUMMARY_COMPACTION_SYSTEM_PROMPT,
      renderStageSummaryBlock('阶段纪要'),
    ].join('\n');
    expect(text).toContain('story_echo_summary');
    expect(text).not.toContain('story_echo_skeleton');
    expect(text).not.toContain('story_echo_recall');
    expect(text).not.toContain('authoritative_facts');
  });

  it('lets Level 1 and higher-level summaries choose a content-shaped structure', () => {
    const stagePrompt = buildStageSummaryPrompt([
      { mes: '旅队穿过山谷后抵达北城。', is_user: false, name: '旁白' },
    ], 0);
    const compactionPrompt = buildSummaryCompactionPrompt({
      targetLevel: 2,
      sources: [{
        text: '旅队穿过山谷后抵达北城。',
        level: 1,
        sourceStartMessageId: 0,
        sourceEndMessageId: 9,
        sourceHash: 'hash',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }],
    });
    for (const prompt of [
      `${STAGE_SUMMARY_SYSTEM_PROMPT}\n${stagePrompt}`,
      `${SUMMARY_COMPACTION_SYSTEM_PROMPT}\n${compactionPrompt}`,
    ]) {
      expect(prompt).toContain('标题');
      expect(prompt).toContain('自然段落');
    }
  });
});
