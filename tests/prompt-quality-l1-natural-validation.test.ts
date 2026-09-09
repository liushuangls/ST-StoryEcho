import { describe, expect, it } from 'vitest';
import { buildPromptEvalCase, PROMPT_EVAL_CASES } from '../evals/cases';
import { findSavedRunCase, selectGenerationCases } from '../evals/case-catalog';
import { L1_NATURAL_VALIDATION_CASES } from '../evals/l1-natural-validation-cases';
import { applyPromptEvalVariant, L1_LEAN_EVIDENCE_CONTRACT_V2_CANDIDATE } from '../evals/variants';

describe('natural long-form L1 validation fixtures', () => {
  it('freezes three distinct 15-turn cases without a scored length target', () => {
    expect(L1_NATURAL_VALIDATION_CASES).toHaveLength(3);
    expect(new Set(L1_NATURAL_VALIDATION_CASES.map((row) => row.id)).size).toBe(3);
    for (const definition of L1_NATURAL_VALIDATION_CASES) {
      expect(definition.kind).toBe('l1');
      if (definition.kind !== 'l1') throw new Error('Expected L1 fixture');
      expect(definition.messages).toHaveLength(30);
      expect(definition.messages.every((row, index) => row.is_user === (index % 2 === 1))).toBe(true);
      expect(definition.idealCompressionRatio).toBeUndefined();
      expect(definition.hardChecks?.length).toBeGreaterThanOrEqual(4);
      expect(definition.rubric.requiredFacts.length).toBeGreaterThanOrEqual(8);
      expect(definition.rubric.requiredCausalChains.length).toBeGreaterThanOrEqual(3);
      expect(definition.rubric.uncertaintyRules.length).toBeGreaterThanOrEqual(4);
      expect(definition.rubric.focusRules).toHaveLength(2);
      expect(definition.rubric.forbiddenClaims.length).toBeGreaterThanOrEqual(4);
      const built = buildPromptEvalCase(definition);
      expect(built.sourceCharacters).toBeGreaterThan(2_000);
      expect(built.maxTokens).toBe(3_000);
      expect(built.idealCompressionRatio).toBeUndefined();
      expect(built.prompt).not.toContain(definition.purpose);
      for (const rule of Object.values(definition.rubric).flat()) {
        expect(built.prompt).not.toContain(rule.description);
      }
    }
  });

  it('keeps the validation opt-in and applies only the frozen L1 candidate', () => {
    expect(selectGenerationCases([])).toBe(PROMPT_EVAL_CASES);
    const ids = L1_NATURAL_VALIDATION_CASES.map((row) => row.id);
    expect(selectGenerationCases(ids)).toEqual(L1_NATURAL_VALIDATION_CASES);
    expect(findSavedRunCase(ids[0]!)).toBe(L1_NATURAL_VALIDATION_CASES[0]);
    for (const definition of L1_NATURAL_VALIDATION_CASES) {
      const base = buildPromptEvalCase(definition);
      const candidate = applyPromptEvalVariant(base, 'l1-lean-evidence-contract-v2');
      expect(candidate).toEqual({ ...base, system: L1_LEAN_EVIDENCE_CONTRACT_V2_CANDIDATE });
      expect(candidate.prompt).toBe(base.prompt);
      expect(candidate.rubric).toBe(base.rubric);
    }
  });
});
