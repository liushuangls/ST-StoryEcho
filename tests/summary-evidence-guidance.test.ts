import { describe, expect, it } from 'vitest';
import { SUMMARY_EVIDENCE_SCOPE_GUIDANCE, L1_INFORMATION_PRIORITY_GUIDANCE } from '../src/summary/evidence-guidance';
import { STAGE_SUMMARY_BASE_SYSTEM_PROMPT, STAGE_SUMMARY_SYSTEM_PROMPT } from '../src/summary/prompts';
import { summaryCompactionSystemPrompt } from '../src/summary/compaction-prompts';

describe('bounded summary evidence and information priority', () => {
  it.each([STAGE_SUMMARY_SYSTEM_PROMPT, summaryCompactionSystemPrompt(2), summaryCompactionSystemPrompt(3)])(
    'applies evidence limits once at each level', (prompt) => {
      expect(prompt.split(SUMMARY_EVIDENCE_SCOPE_GUIDANCE)).toHaveLength(2);
      expect(prompt).toContain('不凭缺少前文补结论');
      expect(prompt).toContain('只有明确的更正或状态变化才能替换已有事实');
      expect(prompt).toContain('来源明确支持');
    },
  );

  it('prioritizes meaningful fact chains without changing the frozen baseline or imposing a layout', () => {
    expect(STAGE_SUMMARY_BASE_SYSTEM_PROMPT).toContain('主动追求高压缩率');
    expect(STAGE_SUMMARY_BASE_SYSTEM_PROMPT).not.toContain(SUMMARY_EVIDENCE_SCOPE_GUIDANCE);
    expect(STAGE_SUMMARY_SYSTEM_PROMPT).not.toContain('主动追求高压缩率');
    expect(STAGE_SUMMARY_SYSTEM_PROMPT.split(L1_INFORMATION_PRIORITY_GUIDANCE)).toHaveLength(2);
    expect(L1_INFORMATION_PRIORITY_GUIDANCE).toContain('关键行动与结果');
    expect(L1_INFORMATION_PRIORITY_GUIDANCE).toContain('日常场景');
    expect(`${L1_INFORMATION_PRIORITY_GUIDANCE}\n${SUMMARY_EVIDENCE_SCOPE_GUIDANCE}`)
      .not.toMatch(/JSON|标题|分类|\d+/u);
    expect(STAGE_SUMMARY_SYSTEM_PROMPT).toContain('不为每个场景设置标题');
  });
});
