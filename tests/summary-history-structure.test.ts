import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { buildPromptEvalCase, PROMPT_EVAL_CASES } from '../evals/cases';
import { SUMMARY_ARCHIVAL_GUIDANCE } from '../src/summary/archival-guidance';
import { STAGE_SUMMARY_SYSTEM_PROMPT } from '../src/summary/prompts';
import {
  STAGE_SUMMARY_BASE_WRITING_RULE,
  STAGE_SUMMARY_HISTORY_WRITING_RULE,
  STAGE_SUMMARY_PRE_STRUCTURE_SYSTEM_PROMPT,
  HISTORY_STRUCTURE_CANDIDATE_SYSTEM_PROMPT,
} from '../evals/history-structure-prompts';
import {
  LEVEL_2_SUMMARY_COMPACTION_SYSTEM_PROMPT,
  HIGHER_LEVEL_SUMMARY_COMPACTION_SYSTEM_PROMPT,
} from '../src/summary/compaction-prompts';
import { summaryRequestForModel } from '../src/summary/model-prompts';

describe('archived L1 historical event-chain experiment', () => {
  it('replaces exactly one writing rule without changing the remaining evidence contract', () => {
    expect(STAGE_SUMMARY_PRE_STRUCTURE_SYSTEM_PROMPT.split(STAGE_SUMMARY_BASE_WRITING_RULE)).toHaveLength(2);
    expect(HISTORY_STRUCTURE_CANDIDATE_SYSTEM_PROMPT.split(STAGE_SUMMARY_HISTORY_WRITING_RULE)).toHaveLength(2);
    expect(HISTORY_STRUCTURE_CANDIDATE_SYSTEM_PROMPT.replace(STAGE_SUMMARY_HISTORY_WRITING_RULE, STAGE_SUMMARY_BASE_WRITING_RULE))
      .toBe(STAGE_SUMMARY_PRE_STRUCTURE_SYSTEM_PROMPT);
    expect(HISTORY_STRUCTURE_CANDIDATE_SYSTEM_PROMPT.split(SUMMARY_ARCHIVAL_GUIDANCE)).toHaveLength(2);
  });

  it('uses optional event-stage headings instead of fixed categories or per-scene labels', () => {
    expect(STAGE_SUMMARY_HISTORY_WRITING_RULE).toContain('短总结使用紧凑段落');
    expect(STAGE_SUMMARY_HISTORY_WRITING_RULE).toContain('较长且包含多个实际剧情阶段时');
    expect(STAGE_SUMMARY_HISTORY_WRITING_RULE).toContain('少量简短、事实性小标题');
    expect(STAGE_SUMMARY_HISTORY_WRITING_RULE).toContain('不设固定分类');
    expect(STAGE_SUMMARY_HISTORY_WRITING_RULE).toContain('不逐消息或逐场景设标题');
    expect(STAGE_SUMMARY_HISTORY_WRITING_RULE).toContain('不新增动机、关系定性或完成结论');
  });

  it('keeps event conditions together and scopes states to the summarized historical period', () => {
    expect(STAGE_SUMMARY_HISTORY_WRITING_RULE).toContain('起因、行动或回应、结果、条件和未兑现承诺留在同一事件链中');
    expect(STAGE_SUMMARY_HISTORY_WRITING_RULE).toContain('不为分类拆散或重复事实');
    expect(STAGE_SUMMARY_HISTORY_WRITING_RULE).toContain('以本批历史结束时为界');
    expect(STAGE_SUMMARY_HISTORY_WRITING_RULE).toContain('不将当时状态表述为聊天至今仍然有效');
    expect(STAGE_SUMMARY_HISTORY_WRITING_RULE).toContain('不补写日期');
  });

  it('does not change higher-level prompts, model requests or output caps', () => {
    for (const prompt of [LEVEL_2_SUMMARY_COMPACTION_SYSTEM_PROMPT, HIGHER_LEVEL_SUMMARY_COMPACTION_SYSTEM_PROMPT]) {
      expect(prompt).not.toContain(STAGE_SUMMARY_HISTORY_WRITING_RULE);
    }
    const request = { system: STAGE_SUMMARY_SYSTEM_PROMPT, prompt: 'source evidence', summaryLevel: 1, maxTokens: 3_000 };
    expect(summaryRequestForModel(request, 'other-model')).toBe(request);
    const gemini = summaryRequestForModel(request, 'gemini-3.8-flash');
    expect(gemini.system).toContain(STAGE_SUMMARY_BASE_WRITING_RULE);
    expect(gemini.system).not.toContain(STAGE_SUMMARY_HISTORY_WRITING_RULE);
    expect(gemini.maxTokens).toBe(request.maxTokens);
    expect(gemini.prompt.startsWith(request.prompt)).toBe(true);
  });

  it('keeps the archived heading experiment out of production and default L1 evaluations', () => {
    expect(STAGE_SUMMARY_SYSTEM_PROMPT).not.toContain(STAGE_SUMMARY_HISTORY_WRITING_RULE);
    for (const definition of PROMPT_EVAL_CASES.filter((item) => item.kind === 'l1')) {
      expect(buildPromptEvalCase(definition).system).toBe(STAGE_SUMMARY_SYSTEM_PROMPT);
    }
  });

  it('retains both exact historical prompt hashes outside production', () => {
    expect(createHash('sha256').update(STAGE_SUMMARY_PRE_STRUCTURE_SYSTEM_PROMPT).digest('hex'))
      .toBe('bcec115f1da338458d043f351eb7b91a4d914b829bf1a70946f7e918f9f9df4c');
    expect(createHash('sha256').update(HISTORY_STRUCTURE_CANDIDATE_SYSTEM_PROMPT).digest('hex'))
      .toBe('dac1f993b66208e7dfbc8bbc759e60d7884e2d51b3941af33ecdc38f70d73f5a');
  });
});
