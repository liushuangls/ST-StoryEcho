import { describe, expect, it } from 'vitest';
import { buildPromptEvalCase, PROMPT_EVAL_CASES } from '../evals/cases';
import { PROMPT_VALIDATION_CASES } from '../evals/validation-cases';
import { selectGenerationCases } from '../evals/case-catalog';

describe('opt-in narrative validation fixtures', () => {
  it('keeps eight chronological L1 sources per new L2 case and the production budget', () => {
    const allIds = [...PROMPT_EVAL_CASES, ...PROMPT_VALIDATION_CASES].map((row) => row.id);
    expect(new Set(allIds).size).toBe(15);
    for (const definition of PROMPT_VALIDATION_CASES) {
      expect(definition.sources).toHaveLength(8);
      definition.sources.forEach((source, index) => {
        expect(source).toMatchObject({ level: 1, sourceStartMessageId: index * 10, sourceEndMessageId: index * 10 + 9 });
        expect(source.text.length).toBeGreaterThan(60);
      });
      const built = buildPromptEvalCase(definition);
      expect(built.maxTokens).toBe(8000);
      expect(built.sourceCharacters).toBeGreaterThan(600);
      expect(built.prompt).not.toContain(definition.rubric.forbiddenClaims[0]!.description);
      expect(built.rubric.requiredFacts).toHaveLength(7);
      expect(built.rubric.requiredCausalChains.length).toBeGreaterThan(0);
      expect(built.rubric.forbiddenClaims.every((row) => row.critical)).toBe(true);
    }
  });

  it('permits an explicit mixed subset without implicitly adding validation requests', () => {
    const ids = [PROMPT_VALIDATION_CASES[0]!.id, PROMPT_EVAL_CASES[0]!.id];
    expect(selectGenerationCases(ids).map((row) => row.id)).toEqual([...ids].reverse());
    expect(selectGenerationCases([PROMPT_EVAL_CASES[0]!.id])).toHaveLength(1);
  });
});
