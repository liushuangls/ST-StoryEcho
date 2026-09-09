import { describe, expect, it, vi } from 'vitest';
import { PROMPT_EVAL_CASES, buildPromptEvalCase } from '../evals/cases';
import { generatePromptCandidates } from '../evals/generate';
import { pairwiseSavedRuns } from '../evals/pairwise-inputs';
import { applyPromptEvalVariant } from '../evals/variants';
import { PROMPT_VALIDATION_CASES } from '../evals/validation-cases';
import { findSavedRunCase, selectGenerationCases } from '../evals/case-catalog';

const ids = PROMPT_EVAL_CASES.filter((row) => row.kind === 'l2').map((row) => row.id);
const response = { text: '模拟总结正文。', finishReason: 'stop', durationMs: 1 };

describe('generation-only prompt iteration', () => {
  it('makes exactly one generation call per selected case, without Judge schema or score', async () => {
    let call = 0;
    const counts: number[] = [];
    const complete = vi.fn(async (request) => {
      const id = ids[call++];
      const definition = PROMPT_EVAL_CASES.find((row) => row.id === id)!;
      const built = applyPromptEvalVariant(buildPromptEvalCase(definition), 'l2-state-dedup');
      expect(request).toEqual({ system: built.system, prompt: built.prompt, maxTokens: built.maxTokens });
      return response;
    });
    const result = await generatePromptCandidates(ids, 'l2-state-dedup', complete, async (progress) => { counts.push(progress.cases.length); });
    expect(complete).toHaveBeenCalledTimes(ids.length);
    expect(result).toMatchObject({ completed: true, generationSucceeded: true, qualityEvaluated: false });
    expect(result).not.toHaveProperty('passed');
    expect(result.cases.every((row) => !('scores' in row) && !('judge' in row))).toBe(true);
    expect(new Set(counts).size).toBe(ids.length + 1);
    expect(pairwiseSavedRuns(result, result)).toHaveLength(ids.length);
  });

  it('rejects duplicate/unknown IDs before any paid call', async () => {
    const complete = vi.fn(async () => response);
    await expect(generatePromptCandidates(['unknown'], 'production', complete)).rejects.toThrow('未知');
    await expect(generatePromptCandidates([ids[0]!, ids[0]!], 'production', complete)).rejects.toThrow('重复');
    expect(complete).not.toHaveBeenCalled();
  });

  it('keeps the original twelve-case default and requires explicit validation IDs', async () => {
    expect(PROMPT_EVAL_CASES).toHaveLength(12);
    expect(selectGenerationCases([])).toBe(PROMPT_EVAL_CASES);
    expect(findSavedRunCase('unknown')).toBeUndefined();
    const complete = vi.fn(async () => response);
    const result = await generatePromptCandidates([], 'production', complete);
    expect(complete).toHaveBeenCalledTimes(12);
    expect(result.cases.map((row) => row.id)).toEqual(PROMPT_EVAL_CASES.map((row) => row.id));
    expect(result.cases.some((row) => row.id.startsWith('validation-'))).toBe(false);
  });

  it('generates and compares opt-in validation cases with source/rubric hashes intact', async () => {
    const validationIds = PROMPT_VALIDATION_CASES.map((row) => row.id);
    const complete = vi.fn(async () => response);
    const left = await generatePromptCandidates(validationIds, 'production', complete);
    const right = await generatePromptCandidates(validationIds, 'l2-binding-examples', complete);
    expect(complete).toHaveBeenCalledTimes(6);
    expect(left.plannedRequests).toBe(3);
    expect(pairwiseSavedRuns(left, right)).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(left.cases[i]!.evaluationHash).toBe(right.cases[i]!.evaluationHash);
      expect(left.cases[i]!.promptHash).not.toBe(right.cases[i]!.promptHash);
    }
    const invalid = { ...right, cases: right.cases.map((row) => ({ ...row, evaluationHash: 'changed' })) };
    expect(() => pairwiseSavedRuns(left, invalid)).toThrow('规则已变化');
    expect(() => selectGenerationCases([validationIds[0]!, validationIds[0]!])).toThrow('重复');
  });

  it('keeps both audience arms on identical inputs and passes them to saved-run comparison', async () => {
    const selected = ['l2-campus-ensemble-and-slow-burn', PROMPT_VALIDATION_CASES[0]!.id];
    for (const variant of ['l2-binding-contract', 'l2-binding-audience'] as const) {
      let call = 0;
      const complete = vi.fn(async (request) => {
        const base = applyPromptEvalVariant(buildPromptEvalCase(findSavedRunCase(selected[call++]!)!), variant);
        expect(request).toEqual({ system: base.system, prompt: base.prompt, maxTokens: 8000 });
        return response;
      });
      const result = await generatePromptCandidates(selected, variant, complete);
      expect(result).toMatchObject({ promptVariant: variant, generationSucceeded: true, qualityEvaluated: false });
      expect(complete).toHaveBeenCalledTimes(2);
      expect(pairwiseSavedRuns(result, result)).toHaveLength(2);
    }
  });

  it('preserves a truncated draft but stops without retrying or judging', async () => {
    const complete = vi.fn(async () => ({ ...response, finishReason: 'MAX-TOKENS' }));
    const result = await generatePromptCandidates(ids, 'production', complete);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ completed: false, generationSucceeded: false });
    expect(result.cases[0]).toMatchObject({ outputTruncated: true, generatedSummary: response.text, diagnostic: { responsePreview: response.text } });
    expect(() => pairwiseSavedRuns(result, result)).toThrow('截断');
  });

  it('sends the contract-only variant unchanged and compares it against production', async () => {
    const selected = [ids[0]!, PROMPT_VALIDATION_CASES[2]!.id];
    const left = await generatePromptCandidates(selected, 'production', async () => response);
    let call = 0;
    const complete = vi.fn(async (request) => {
      const built = applyPromptEvalVariant(buildPromptEvalCase(findSavedRunCase(selected[call++]!)!), 'l2-contract-only');
      expect(request).toEqual({ system: built.system, prompt: built.prompt, maxTokens: 8000 });
      return response;
    });
    const right = await generatePromptCandidates(selected, 'l2-contract-only', complete);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(right).toMatchObject({ promptVariant: 'l2-contract-only', qualityEvaluated: false, generationSucceeded: true });
    expect(pairwiseSavedRuns(left, right)).toHaveLength(2);
    for (let i = 0; i < 2; i++) {
      expect(right.cases[i]!.evaluationHash).toBe(left.cases[i]!.evaluationHash);
      expect(right.cases[i]!.promptHash).not.toBe(left.cases[i]!.promptHash);
    }
  });

  it('records empty/network errors and does not continue paid requests', async () => {
    for (const complete of [vi.fn(async () => ({ ...response, text: '' })), vi.fn(async () => { throw new Error('offline'); })]) {
      const result = await generatePromptCandidates(ids, 'production', complete);
      expect(result.generationSucceeded).toBe(false);
      expect(result.cases[0]!.error).toBeTruthy();
      expect(complete).toHaveBeenCalledTimes(1);
    }
  });

  it('stops immediately when a generated candidate cannot be saved', async () => {
    const complete = vi.fn(async () => response);
    await expect(generatePromptCandidates(ids, 'production', complete, async (progress) => {
      if (progress.cases.length) throw new Error('disk full');
    })).rejects.toThrow('disk full');
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
