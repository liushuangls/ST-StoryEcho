import { describe, expect, it } from 'vitest';
import { PROMPT_EVAL_CASES, buildPromptEvalCase } from '../evals/cases';
import { caseEvaluationHash } from '../evals/protocol';
import { applyPromptEvalVariant, L2_BINDING_AUDIENCE_EXAMPLE, L2_BINDING_CONTRACT_GUIDANCE, L2_BINDING_EXAMPLES_CANDIDATE, L2_BINDING_SCOPE_GUIDANCE, L2_EVIDENCE_BOUNDARIES_CANDIDATE, L2_INTEGRATED_EVIDENCE_EVENTS_CANDIDATE, L2_RELATIONSHIP_PROCESS_CANDIDATE, L2_SOURCE_FAITHFUL_CANDIDATE, L2_STATE_DEDUP_CANDIDATE, L2_STATEMENT_EVENTS_CANDIDATE, promptEvalVariant } from '../evals/variants';
import { PROMPT_VALIDATION_CASES } from '../evals/validation-cases';
import { LEVEL_2_SUMMARY_COMPACTION_SYSTEM_PROMPT } from '../src/summary/compaction-prompts';

describe('local prompt candidates', () => {
  it('keeps production as the default and rejects typos before requests', () => {
    expect(promptEvalVariant(undefined)).toBe('production');
    expect(promptEvalVariant(' l2-state-dedup ')).toBe('l2-state-dedup');
    expect(promptEvalVariant(' l2-evidence-boundaries ')).toBe('l2-evidence-boundaries');
    expect(promptEvalVariant(' l2-relationship-process ')).toBe('l2-relationship-process');
    expect(promptEvalVariant(' l2-source-faithful ')).toBe('l2-source-faithful');
    expect(promptEvalVariant(' l2-binding-examples ')).toBe('l2-binding-examples');
    expect(promptEvalVariant(' l2-binding-scope ')).toBe('l2-binding-scope');
    expect(promptEvalVariant(' l2-binding-contract ')).toBe('l2-binding-contract');
    expect(promptEvalVariant(' l2-binding-audience ')).toBe('l2-binding-audience');
    expect(promptEvalVariant(' l2-contract-only ')).toBe('l2-contract-only');
    expect(promptEvalVariant(' l2-statement-events ')).toBe('l2-statement-events');
    expect(promptEvalVariant(' l2-integrated-evidence-events ')).toBe('l2-integrated-evidence-events');
    expect(() => promptEvalVariant('typo')).toThrow('未知');
  });

  it('changes only the L2 system prompt while preserving source, rubric and token caps', () => {
    for (const definition of PROMPT_EVAL_CASES) {
      const base = buildPromptEvalCase(definition);
      expect(applyPromptEvalVariant(base, 'production')).toBe(base);
      const candidate = applyPromptEvalVariant(base, 'l2-state-dedup');
      expect(candidate).toEqual({ ...base, system: base.kind === 'l2' ? base.system + L2_STATE_DEDUP_CANDIDATE : base.system });
      expect(caseEvaluationHash(candidate)).toBe(caseEvaluationHash(base));
      if (base.kind === 'l2') expect(base.system).toBe(LEVEL_2_SUMMARY_COMPACTION_SYSTEM_PROMPT);
    }
    expect(LEVEL_2_SUMMARY_COMPACTION_SYSTEM_PROMPT).not.toContain('跨段去重');
    expect(L2_STATE_DEDUP_CANDIDATE).toContain('更正、反转、条件变化');
  });

  it('isolates the evidence-boundary experiment without changing coverage, sources or other levels', () => {
    for (const definition of PROMPT_EVAL_CASES) {
      const base = buildPromptEvalCase(definition);
      const candidate = applyPromptEvalVariant(base, 'l2-evidence-boundaries');
      expect(candidate).toEqual({ ...base, system: base.kind === 'l2' ? base.system + L2_EVIDENCE_BOUNDARIES_CANDIDATE : base.system });
      expect(caseEvaluationHash(candidate)).toBe(caseEvaluationHash(base));
      expect(candidate.system).not.toContain(L2_STATE_DEDUP_CANDIDATE);
      if (base.kind !== 'l2') expect(candidate).toBe(base);
    }
    expect(LEVEL_2_SUMMARY_COMPACTION_SYSTEM_PROMPT).not.toContain('证据粒度与强度');
    expect(L2_EVIDENCE_BOUNDARIES_CANDIDATE).toContain('已明确的事实与因果仍须完整保留');
    expect(L2_EVIDENCE_BOUNDARIES_CANDIDATE).not.toMatch(/留宿|同住|幕后者|京都|闻鹤|宁昭|Token|字数/);
  });

  it('revises only the L2 process paragraph without stacking candidates or changing the workload', () => {
    for (const definition of PROMPT_EVAL_CASES) {
      const base = buildPromptEvalCase(definition);
      const candidate = applyPromptEvalVariant(base, 'l2-relationship-process');
      expect(caseEvaluationHash(candidate)).toBe(caseEvaluationHash(base));
      expect({ ...candidate, system: base.system }).toEqual(base);
      if (base.kind !== 'l2') { expect(candidate).toBe(base); continue; }
      const before = base.system.split('\n');
      const after = candidate.system.split('\n');
      expect(after).toHaveLength(before.length);
      expect(after.filter((line, i) => line !== before[i])).toEqual([L2_RELATIONSHIP_PROCESS_CANDIDATE]);
      expect(after[before.findIndex((line) => line.startsWith('2. '))]).toBe(L2_RELATIONSHIP_PROCESS_CANDIDATE);
      expect(candidate.system).not.toContain(L2_EVIDENCE_BOUNDARIES_CANDIDATE);
      expect(candidate.system).not.toContain(L2_STATE_DEDUP_CANDIDATE);
    }
    expect(L2_RELATIONSHIP_PROCESS_CANDIDATE).toContain('即使关系称呼未变');
    expect(L2_RELATIONSHIP_PROCESS_CANDIDATE).not.toMatch(/公寓|千纱|周砚|宁昭|上缴|Token|字数|JSON/);
  });

  it('rejects changed, duplicated or already-revised production paragraphs before applying the edit', () => {
    const base = buildPromptEvalCase(PROMPT_EVAL_CASES.find((row) => row.kind === 'l2')!);
    for (const system of [base.system.replace('2. 重要情节', '2. 新原则'), `${base.system}\n${base.system}`]) {
      expect(() => applyPromptEvalVariant({ ...base, system }, 'l2-relationship-process')).toThrow('须重新核对');
    }
    expect(() => applyPromptEvalVariant(applyPromptEvalVariant(base, 'l2-relationship-process'), 'l2-relationship-process')).toThrow('须重新核对');
  });

  it('isolates source-faithful writing from relationship and evidence-boundary rules', () => {
    for (const definition of PROMPT_EVAL_CASES) {
      const base = buildPromptEvalCase(definition);
      const candidate = applyPromptEvalVariant(base, 'l2-source-faithful');
      expect(caseEvaluationHash(candidate)).toBe(caseEvaluationHash(base));
      expect({ ...candidate, system: base.system }).toEqual(base);
      if (base.kind !== 'l2') { expect(candidate).toBe(base); continue; }
      const before = base.system.split('\n');
      const after = candidate.system.split('\n');
      expect(after).toHaveLength(before.length);
      expect(after.filter((line, i) => line !== before[i])).toEqual([L2_SOURCE_FAITHFUL_CANDIDATE]);
      expect(after[before.findIndex((line) => line.startsWith('6. '))]).toBe(L2_SOURCE_FAITHFUL_CANDIDATE);
      for (const prior of [L2_RELATIONSHIP_PROCESS_CANDIDATE, L2_EVIDENCE_BOUNDARIES_CANDIDATE, L2_STATE_DEDUP_CANDIDATE]) {
        expect(candidate.system).not.toContain(prior);
      }
    }
    expect(L2_SOURCE_FAITHFUL_CANDIDATE).not.toMatch(/公寓|星盘|宁昭|上缴|Token|字数|JSON/);
  });

  it('rejects stale or repeated source-faithful edits', () => {
    const base = buildPromptEvalCase(PROMPT_EVAL_CASES.find((row) => row.kind === 'l2')!);
    for (const system of [base.system.replace('6. 每个事实', '6. 新要求'), `${base.system}\n${base.system}`,
      applyPromptEvalVariant(base, 'l2-source-faithful').system]) {
      expect(() => applyPromptEvalVariant({ ...base, system }, 'l2-source-faithful')).toThrow('须重新核对');
    }
  });

  it('keeps teaching examples isolated from real evidence, budgets and other levels', () => {
    for (const definition of [...PROMPT_EVAL_CASES, ...PROMPT_VALIDATION_CASES]) {
      const base = buildPromptEvalCase(definition);
      const candidate = applyPromptEvalVariant(base, 'l2-binding-examples');
      expect(candidate).toEqual({ ...base, system: base.kind === 'l2' ? base.system + L2_BINDING_EXAMPLES_CANDIDATE : base.system });
      expect(caseEvaluationHash(candidate)).toBe(caseEvaluationHash(base));
      if (base.kind !== 'l2') expect(candidate).toBe(base);
      expect(base.prompt + base.sourceEvidence + JSON.stringify(base.rubric)).not.toMatch(/骆栖|季衡|钟师|试织机|修复方案/);
    }
    expect(L2_BINDING_EXAMPLES_CANDIDATE).toContain('不是本次剧情证据');
    expect(L2_BINDING_EXAMPLES_CANDIDATE).not.toMatch(/唐梨|罗音|陆昭|千纱|宁昭|周砚|星盘|Token|字数|JSON/);
    expect(LEVEL_2_SUMMARY_COMPACTION_SYSTEM_PROMPT).not.toContain('事实绑定示例');
  });

  it('rejects mixed or duplicate candidates before appending teaching examples', () => {
    const base = buildPromptEvalCase(PROMPT_EVAL_CASES.find((row) => row.kind === 'l2')!);
    for (const variant of ['l2-state-dedup', 'l2-evidence-boundaries', 'l2-relationship-process', 'l2-source-faithful', 'l2-binding-examples'] as const) {
      expect(() => applyPromptEvalVariant(applyPromptEvalVariant(base, variant), 'l2-binding-examples')).toThrow('不能叠加');
    }
  });

  it('adds only the scope paragraph to frozen examples without changing any evidence or budget', () => {
    for (const definition of [...PROMPT_EVAL_CASES, ...PROMPT_VALIDATION_CASES]) {
      const base = buildPromptEvalCase(definition);
      const prior = applyPromptEvalVariant(base, 'l2-binding-examples');
      const next = applyPromptEvalVariant(base, 'l2-binding-scope');
      expect(next).toEqual({ ...prior, system: prior.system + (base.kind === 'l2' ? L2_BINDING_SCOPE_GUIDANCE : '') });
      expect(caseEvaluationHash(next)).toBe(caseEvaluationHash(base));
      if (base.kind !== 'l2') expect(next).toBe(base);
    }
    expect(L2_BINDING_SCOPE_GUIDANCE).toContain('来源的完整关键语句');
    expect(L2_BINDING_SCOPE_GUIDANCE).toContain('来源未指定听者');
    expect(L2_BINDING_SCOPE_GUIDANCE).not.toMatch(/周砚|叶岚|千纱|悠|宁昭|唐梨|罗音|陆昭|暗号|独自行动|Token|字数|JSON/);
    expect(LEVEL_2_SUMMARY_COMPACTION_SYSTEM_PROMPT).not.toContain(L2_BINDING_SCOPE_GUIDANCE);
  });

  it('rejects arbitrary or repeated scope edits rather than composing hidden interventions', () => {
    const base = buildPromptEvalCase(PROMPT_EVAL_CASES.find((row) => row.kind === 'l2')!);
    for (const variant of ['l2-state-dedup', 'l2-evidence-boundaries', 'l2-relationship-process', 'l2-source-faithful', 'l2-binding-examples', 'l2-binding-scope'] as const) {
      const prior = applyPromptEvalVariant(base, variant);
      expect(() => applyPromptEvalVariant(prior, 'l2-binding-scope')).toThrow('不能叠加');
      expect(() => applyPromptEvalVariant(prior, 'l2-binding-examples')).toThrow('不能叠加');
    }
    expect(() => applyPromptEvalVariant({ ...base, system: base.system + '外部改动' }, 'l2-binding-scope')).toThrow('不能叠加');
  });

  it('isolates the contract control and changes only the audience example between fresh arms', () => {
    expect(L2_BINDING_SCOPE_GUIDANCE).toContain(L2_BINDING_CONTRACT_GUIDANCE.split('\n').at(-1)!);
    for (const definition of [...PROMPT_EVAL_CASES, ...PROMPT_VALIDATION_CASES]) {
      const base = buildPromptEvalCase(definition);
      const control = applyPromptEvalVariant(base, 'l2-binding-contract');
      const candidate = applyPromptEvalVariant(base, 'l2-binding-audience');
      expect(control).toEqual({ ...base, system: base.system + (base.kind === 'l2' ? L2_BINDING_EXAMPLES_CANDIDATE + L2_BINDING_CONTRACT_GUIDANCE : '') });
      expect(candidate).toEqual({ ...control, system: control.system + (base.kind === 'l2' ? L2_BINDING_AUDIENCE_EXAMPLE : '') });
      expect(caseEvaluationHash(candidate)).toBe(caseEvaluationHash(base));
      if (base.kind !== 'l2') { expect(control).toBe(base); expect(candidate).toBe(base); }
      expect(candidate.system).not.toContain(L2_BINDING_SCOPE_GUIDANCE);
      expect(base.prompt + base.sourceEvidence + JSON.stringify(base.rubric)).not.toMatch(/顾弦|梁芷|乌澄/);
    }
    expect(L2_BINDING_AUDIENCE_EXAMPLE).toContain('旁白事实不改成人物发言');
    expect(L2_BINDING_AUDIENCE_EXAMPLE).toContain('不为回避扩写而删掉明确告知');
    expect(L2_BINDING_AUDIENCE_EXAMPLE).not.toMatch(/周砚|叶岚|千纱|悠|宁昭|唐梨|罗音|陆昭|暗号|独自行动|Token|字数|JSON/);
  });

  it('requires clean production prompts for both audience experiment arms', () => {
    const base = buildPromptEvalCase(PROMPT_EVAL_CASES.find((row) => row.kind === 'l2')!);
    for (const prior of ['l2-state-dedup', 'l2-evidence-boundaries', 'l2-relationship-process', 'l2-source-faithful', 'l2-binding-examples', 'l2-binding-scope', 'l2-binding-contract', 'l2-binding-audience'] as const) {
      for (const next of ['l2-binding-contract', 'l2-binding-audience'] as const) {
        expect(() => applyPromptEvalVariant(applyPromptEvalVariant(base, prior), next)).toThrow('不能叠加');
      }
    }
  });

  it('adds only the frozen contract sentence to production with no examples or other changes', () => {
    for (const definition of [...PROMPT_EVAL_CASES, ...PROMPT_VALIDATION_CASES]) {
      const base = buildPromptEvalCase(definition);
      const candidate = applyPromptEvalVariant(base, 'l2-contract-only');
      expect(candidate).toEqual({ ...base, system: base.system + (base.kind === 'l2' ? L2_BINDING_CONTRACT_GUIDANCE : '') });
      expect(caseEvaluationHash(candidate)).toBe(caseEvaluationHash(base));
      if (base.kind !== 'l2') expect(candidate).toBe(base);
      expect(candidate.system).not.toContain(L2_BINDING_EXAMPLES_CANDIDATE);
      expect(candidate.system).not.toContain(L2_BINDING_AUDIENCE_EXAMPLE);
      expect(candidate.system).not.toContain(L2_BINDING_SCOPE_GUIDANCE);
    }
    expect(L2_BINDING_CONTRACT_GUIDANCE).not.toMatch(/周砚|叶岚|千纱|悠|宁昭|唐梨|罗音|陆昭|暗号|独自行动|Token|字数|JSON/);
  });

  it('rejects arbitrary, stacked and repeated contract-only edits', () => {
    const base = buildPromptEvalCase(PROMPT_EVAL_CASES.find((row) => row.kind === 'l2')!);
    for (const prior of ['l2-state-dedup', 'l2-evidence-boundaries', 'l2-relationship-process', 'l2-source-faithful', 'l2-binding-examples', 'l2-binding-scope', 'l2-binding-contract', 'l2-binding-audience', 'l2-contract-only'] as const) {
      expect(() => applyPromptEvalVariant(applyPromptEvalVariant(base, prior), 'l2-contract-only')).toThrow('不能叠加');
    }
    expect(() => applyPromptEvalVariant({ ...base, system: base.system + '外部修改' }, 'l2-contract-only')).toThrow('不能叠加');
  });

  it('adds only the important-statement rule to a clean L2 production prompt', () => {
    for (const definition of [...PROMPT_EVAL_CASES, ...PROMPT_VALIDATION_CASES]) {
      const base = buildPromptEvalCase(definition);
      const candidate = applyPromptEvalVariant(base, 'l2-statement-events');
      expect(candidate).toEqual({ ...base, system: base.kind === 'l2' ? base.system + L2_STATEMENT_EVENTS_CANDIDATE : base.system });
      expect(caseEvaluationHash(candidate)).toBe(caseEvaluationHash(base));
      if (base.kind !== 'l2') expect(candidate).toBe(base);
      for (const prior of [L2_STATE_DEDUP_CANDIDATE, L2_EVIDENCE_BOUNDARIES_CANDIDATE, L2_RELATIONSHIP_PROCESS_CANDIDATE,
        L2_SOURCE_FAITHFUL_CANDIDATE, L2_BINDING_EXAMPLES_CANDIDATE, L2_BINDING_SCOPE_GUIDANCE,
        L2_BINDING_CONTRACT_GUIDANCE, L2_BINDING_AUDIENCE_EXAMPLE]) {
        expect(candidate.system).not.toContain(prior);
      }
    }
    expect(L2_STATEMENT_EVENTS_CANDIDATE).toContain('不能替代该行为');
    expect(L2_STATEMENT_EVENTS_CANDIDATE).toContain('来源未说明的听者');
    expect(L2_STATEMENT_EVENTS_CANDIDATE).not.toMatch(/周砚|叶岚|千纱|悠|宁昭|唐梨|罗音|陆昭|公寓|暗号|Token|字数|JSON/);
    expect(LEVEL_2_SUMMARY_COMPACTION_SYSTEM_PROMPT).not.toContain(L2_STATEMENT_EVENTS_CANDIDATE);
  });

  it('rejects arbitrary, stacked and repeated important-statement edits', () => {
    const base = buildPromptEvalCase(PROMPT_EVAL_CASES.find((row) => row.kind === 'l2')!);
    for (const prior of ['l2-state-dedup', 'l2-evidence-boundaries', 'l2-relationship-process', 'l2-source-faithful',
      'l2-binding-examples', 'l2-binding-scope', 'l2-binding-contract', 'l2-binding-audience', 'l2-contract-only',
      'l2-statement-events'] as const) {
      expect(() => applyPromptEvalVariant(applyPromptEvalVariant(base, prior), 'l2-statement-events')).toThrow('不能叠加');
    }
    expect(() => applyPromptEvalVariant({ ...base, system: base.system + '外部修改' }, 'l2-statement-events')).toThrow('不能叠加');
  });

  it('replaces only the first two L2 principles with a no-longer-than-production integrated evidence rule', () => {
    for (const definition of [...PROMPT_EVAL_CASES, ...PROMPT_VALIDATION_CASES]) {
      const base = buildPromptEvalCase(definition);
      const candidate = applyPromptEvalVariant(base, 'l2-integrated-evidence-events');
      expect(caseEvaluationHash(candidate)).toBe(caseEvaluationHash(base));
      expect({ ...candidate, system: base.system }).toEqual(base);
      if (base.kind !== 'l2') { expect(candidate).toBe(base); continue; }
      const before = base.system.split('\n');
      const after = candidate.system.split('\n');
      expect(after).toHaveLength(before.length);
      expect(after.filter((line, index) => line !== before[index])).toEqual(L2_INTEGRATED_EVIDENCE_EVENTS_CANDIDATE.split('\n'));
      expect([...L2_INTEGRATED_EVIDENCE_EVENTS_CANDIDATE].length).toBeLessThanOrEqual(
        [...before.filter((line) => /^\d\. /.test(line)).slice(0, 2).join('\n')].length,
      );
      for (const prior of [L2_STATE_DEDUP_CANDIDATE, L2_EVIDENCE_BOUNDARIES_CANDIDATE,
        L2_RELATIONSHIP_PROCESS_CANDIDATE, L2_SOURCE_FAITHFUL_CANDIDATE, L2_BINDING_EXAMPLES_CANDIDATE,
        L2_BINDING_SCOPE_GUIDANCE, L2_BINDING_CONTRACT_GUIDANCE, L2_BINDING_AUDIENCE_EXAMPLE,
        L2_STATEMENT_EVENTS_CANDIDATE]) {
        expect(candidate.system).not.toContain(prior);
      }
    }
    expect(L2_INTEGRATED_EVIDENCE_EVENTS_CANDIDATE).toContain('旁白事实不得改成人物发言');
    expect(L2_INTEGRATED_EVIDENCE_EVENTS_CANDIDATE).toContain('重要表态、回应');
    expect(L2_INTEGRATED_EVIDENCE_EVENTS_CANDIDATE).not.toMatch(/周砚|叶岚|千纱|悠|宁昭|唐梨|罗音|陆昭|温策|私印|Token|字数|JSON/);
  });

  it('rejects stale, arbitrary, stacked and repeated integrated evidence edits', () => {
    const base = buildPromptEvalCase(PROMPT_EVAL_CASES.find((row) => row.kind === 'l2')!);
    for (const system of [
      base.system.replace('1. 覆盖每条来源总结', '1. 新覆盖要求'),
      `${base.system}\n${base.system}`,
      `${base.system}\n外部修改`,
      applyPromptEvalVariant(base, 'l2-integrated-evidence-events').system,
      applyPromptEvalVariant(base, 'l2-statement-events').system,
    ]) {
      expect(() => applyPromptEvalVariant({ ...base, system }, 'l2-integrated-evidence-events')).toThrow('须重新核对');
    }
  });
});
