import { describe, expect, it } from 'vitest';
import { CONSOLIDATION_SYSTEM_PROMPT } from '../src/consolidation/prompts';
import { EXTRACTION_SYSTEM_PROMPT } from '../src/extraction/prompts';
import { renderMemoryBlock, renderStageSummaryBlock } from '../src/prompt/render';
import { QUERY_REWRITE_SYSTEM_PROMPT } from '../src/retrieval/query-rewriter';
import { STAGE_SUMMARY_SYSTEM_PROMPT } from '../src/summary/prompts';
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
    const summaryBlock = renderStageSummaryBlock([
      '【已确认剧情】',
      '旅队已抵达北城。',
      '【当前状态】',
      '旅队位于北城。',
      '【未解决线索】',
      '无',
      '【角色主张与推测】',
      '无',
      '【已失效或否定事实】',
      '无',
    ].join('\n'));

    const fixedPromptText = [
      EXTRACTION_SYSTEM_PROMPT,
      CONSOLIDATION_SYSTEM_PROMPT,
      QUERY_REWRITE_SYSTEM_PROMPT,
      STAGE_SUMMARY_SYSTEM_PROMPT,
      recallBlock,
      summaryBlock,
    ].join('\n');

    expect(fixedPromptText).not.toMatch(CASE_SPECIFIC_LANGUAGE);
  });
});
