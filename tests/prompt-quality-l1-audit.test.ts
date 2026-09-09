import { describe, expect, it } from 'vitest';
import { buildPromptEvalCase, PROMPT_EVAL_CASES } from '../evals/cases';
import { findSavedRunCase, selectGenerationCases } from '../evals/case-catalog';
import {
  L1_AUDIT_CASES,
  L1_AUDIT_DEVELOPMENT_CASES,
  L1_AUDIT_HOLDOUT_CASES,
} from '../evals/l1-audit-cases';
import {
  evaluatePromptEvalHardChecks,
  promptEvalHardChecksPassed,
} from '../evals/hard-checks';

describe('fresh L1 prompt audit fixtures', () => {
  it('freezes eight development cases and four separately named holdouts', () => {
    expect(L1_AUDIT_DEVELOPMENT_CASES).toHaveLength(8);
    expect(L1_AUDIT_HOLDOUT_CASES).toHaveLength(4);
    expect(L1_AUDIT_CASES).toHaveLength(12);
    expect(new Set(L1_AUDIT_CASES.map((row) => row.id)).size).toBe(12);
    expect(L1_AUDIT_DEVELOPMENT_CASES.every((row) => row.id.startsWith('l1-audit-dev-'))).toBe(true);
    expect(L1_AUDIT_HOLDOUT_CASES.every((row) => row.id.startsWith('l1-audit-holdout-'))).toBe(true);
  });

  it('uses production L1 prompts while keeping rubrics and hard checks out of model input', () => {
    for (const definition of L1_AUDIT_CASES) {
      expect(definition.kind).toBe('l1');
      if (definition.kind !== 'l1') throw new Error('Expected L1 fixture');
      expect(definition.messages.length).toBeGreaterThanOrEqual(8);
      expect(definition.hardChecks?.length).toBeGreaterThanOrEqual(3);
      expect(definition.rubric.requiredFacts.length).toBeGreaterThanOrEqual(5);
      expect(definition.rubric.requiredCausalChains.length).toBeGreaterThanOrEqual(2);
      expect(definition.rubric.uncertaintyRules.length).toBeGreaterThanOrEqual(3);
      expect(definition.rubric.focusRules.length).toBeGreaterThanOrEqual(2);
      expect(definition.rubric.forbiddenClaims.length).toBeGreaterThanOrEqual(3);

      const built = buildPromptEvalCase(definition);
      expect(built.maxTokens).toBe(3_000);
      expect(built.sourceCharacters).toBeGreaterThan(500);
      expect(built.hardChecks).toEqual(definition.hardChecks);
      for (const check of definition.hardChecks ?? []) {
        expect(check.needles.length).toBeGreaterThan(0);
        expect(built.prompt).not.toContain(check.description);
      }
      for (const rule of Object.values(definition.rubric).flat()) {
        expect(built.prompt).not.toContain(rule.description);
      }
    }
  });

  it('keeps audit cases opt-in and resolves an explicit development/holdout subset', () => {
    expect(selectGenerationCases([])).toBe(PROMPT_EVAL_CASES);
    expect(selectGenerationCases([])).toHaveLength(12);
    const requested = [L1_AUDIT_DEVELOPMENT_CASES[0]!.id, L1_AUDIT_HOLDOUT_CASES[0]!.id];
    expect(selectGenerationCases(requested).map((row) => row.id)).toEqual(requested);
    expect(findSavedRunCase(requested[0]!)).toBe(L1_AUDIT_DEVELOPMENT_CASES[0]);
  });
});

describe('local-only L1 hard checks', () => {
  const checks = [
    { id: 'all', description: 'all', mode: 'all' as const, needles: ['D-14', 'S-33'] },
    { id: 'any', description: 'any', mode: 'any' as const, needles: ['尚未', '未确认'] },
    { id: 'none', description: 'none', mode: 'none' as const, needles: ['已经定罪'] },
  ];

  it('normalizes case, width and whitespace without treating probes as model instructions', () => {
    const result = evaluatePromptEvalHardChecks('d－14 与 S-33；结论 尚 未确认。', checks);
    expect(result.map((row) => row.passed)).toEqual([true, true, true]);
    expect(promptEvalHardChecksPassed(result)).toBe(true);
  });

  it('reports the exact missing and forbidden needles deterministically', () => {
    const result = evaluatePromptEvalHardChecks('D-14 已经定罪。', checks);
    expect(result.map((row) => row.passed)).toEqual([false, false, false]);
    expect(result[0]!.missing).toEqual(['S-33']);
    expect(result[2]!.matched).toEqual(['已经定罪']);
    expect(promptEvalHardChecksPassed(result)).toBe(false);
  });

  it('accepts an explicit ungranted proxy authorization without changing old results', () => {
    const medical = L1_AUDIT_DEVELOPMENT_CASES.find((row) => row.id === 'l1-audit-dev-medical-consent-and-proxy');
    expect(medical?.kind).toBe('l1');
    if (medical?.kind !== 'l1') throw new Error('医疗审计夹具必须为L1。');
    const proxyBoundary = medical.hardChecks?.find((row) => row.id === 'proxy-boundary');
    expect(proxyBoundary).toBeDefined();
    const result = evaluatePromptEvalHardChecks('顾禾未授权周宁代签任何治疗同意书。', [proxyBoundary!]);
    expect(result[0]?.passed).toBe(true);
  });
});
