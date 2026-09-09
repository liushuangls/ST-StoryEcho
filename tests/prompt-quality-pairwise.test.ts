import { describe, expect, it } from 'vitest';
import { pairwiseControls, pairwiseSavedRuns } from '../evals/pairwise-inputs';
import { buildPairwisePrompt, evaluatePairwise, normalizePairwiseWinner, pairwiseRepeatDisagreements, parsePairwiseJudgement, type PairwiseInput } from '../evals/pairwise';
import { caseEvaluationHash } from '../evals/protocol';

const input = pairwiseControls()[0]!;
function judgement(winner: 'A' | 'B' | 'tie' | 'inconclusive', acceptableA = true, acceptableB = false): string {
  return JSON.stringify({ winner, acceptableA, acceptableB, reason: '按来源比较', differences: winner === 'A' || winner === 'B' ? [
    { criterion: 'requiredFacts:0', preferred: winner, evidenceAIds: [1], evidenceBIds: [1], reason: '保留关键保管状态' },
  ] : [] });
}
const completion = (text: string) => ({ text, finishReason: 'stop', durationMs: 1 });

describe('blinded pairwise evaluation', () => {
  it('builds 9 good/bad and 3 identical controls without leaking labels', () => {
    const controls = pairwiseControls();
    expect(controls).toHaveLength(12);
    expect(controls.filter((item) => item.expected === 'tie')).toHaveLength(3);
    for (const item of controls) {
      const prompt = buildPairwisePrompt(item, false);
      expect(prompt).not.toContain(item.id);
      expect(prompt).not.toContain('expected');
      expect(prompt).not.toContain('model');
      const forward = JSON.parse(prompt);
      const reverse = JSON.parse(buildPairwisePrompt(item, true));
      expect(reverse.candidate_A_segments).toEqual(forward.candidate_B_segments);
      expect(reverse.source_evidence).toEqual(forward.source_evidence);
    }
    expect(buildPairwisePrompt({ ...input, generatorModels: ['PRIVATE_MODEL_ID'] }, false)).not.toContain('PRIVATE_MODEL_ID');
  });

  it('normalizes identity across swaps', () => {
    expect(normalizePairwiseWinner('A', false)).toBe('left');
    expect(normalizePairwiseWinner('B', true)).toBe('left');
    expect(normalizePairwiseWinner('A', true)).toBe('right');
    expect(normalizePairwiseWinner('tie', true)).toBe('tie');
  });

  it('accepts a consistent preference in both orders', async () => {
    let calls = 0;
    const result = await evaluatePairwise(input, 1, async () => completion(calls++ ? judgement('B', false, true) : judgement('A')));
    expect(result).toMatchObject({ outcome: 'left', consistent: true, leftAcceptable: true, rightAcceptable: false, matched: true });
  });

  it('does not treat always choosing A as agreement', async () => {
    const result = await evaluatePairwise(input, 1, async () => completion(judgement('A')));
    expect(result).toMatchObject({ outcome: 'inconclusive', consistent: false, matched: false });
    expect(result.orders.every((order) => order.diagnostic?.responsePreview === judgement('A'))).toBe(true);
    expect(result.orders.every((order) => order.diagnostic?.finishReason === 'stop')).toBe(true);
  });

  it('does not pass calibration when acceptability labels change on swap', async () => {
    let calls = 0;
    const result = await evaluatePairwise(input, 1, async () => completion(calls++ ? judgement('B', true, true) : judgement('A')));
    expect(result.consistent).toBe(false);
  });

  it('detects repeated acceptability changes even when the winning side stays the same', async () => {
    let calls = 0;
    const first = await evaluatePairwise(input, 1, async () => completion(calls++ ? judgement('B', false, true) : judgement('A')));
    expect(pairwiseRepeatDisagreements([first, { ...first, repetition: 2 }])).toBe(0);
    expect(pairwiseRepeatDisagreements([first, { ...first, repetition: 2, rightAcceptable: true }])).toBe(1);
  });

  it('handles ties, inconclusive, and reversed preferred candidate labels', async () => {
    const same = pairwiseControls().find((item) => item.expected === 'tie')!;
    expect(await evaluatePairwise(same, 2, async () => completion(judgement('tie', true, true))))
      .toMatchObject({ outcome: 'tie', matched: true });
    expect(await evaluatePairwise(input, 1, async () => completion(judgement('inconclusive'))))
      .toMatchObject({ outcome: 'inconclusive', matched: false });
    const reversed: PairwiseInput = { ...input, left: input.right, right: input.left, expected: 'right' };
    let calls = 0;
    expect(await evaluatePairwise(reversed, 1, async () => completion(calls++ ? judgement('A') : judgement('B', false, true))))
      .toMatchObject({ outcome: 'right', matched: true });
  });

  it('requires valid grounded differences supporting a selected winner', () => {
    expect(parsePairwiseJudgement(judgement('A'), input, false).differences[0]!.evidenceA).toBeTruthy();
    for (const update of [
      { differences: [] },
      { differences: [{ criterion: 'requiredFacts:999', preferred: 'A', evidenceAIds: [1], evidenceBIds: [1], reason: '理由' }] },
      { differences: [{ criterion: 'requiredFacts:0', preferred: 'A', evidenceAIds: [999], evidenceBIds: [], reason: '理由' }] },
      { acceptableA: 'yes' },
    ]) {
      expect(() => parsePairwiseJudgement(JSON.stringify({ ...JSON.parse(judgement('A')), ...update }), input, false)).toThrow();
    }
  });

  it('keeps request errors and truncated responses inconclusive without retrying', async () => {
    let calls = 0;
    const result = await evaluatePairwise(input, 1, async () => { calls++; return { ...completion(judgement('A')), finishReason: 'MAX-TOKENS' }; });
    expect(calls).toBe(2);
    expect(result.orders.every((order) => order.error)).toBe(true);
    expect(result.outcome).toBe('inconclusive');
  });

  it('validates source/rubric hashes and case sets before paid comparisons', () => {
    const row = { id: input.testCase.id, evaluationHash: caseEvaluationHash(input.testCase), generatedSummary: input.left, generation: { finishReason: 'stop' } };
    const run = { cases: [row] };
    expect(pairwiseSavedRuns(run, run)).toHaveLength(1);
    expect(pairwiseSavedRuns({ ...run, generatorModel: 'left-model' }, { ...run, generatorModel: 'right-model' })[0]!.generatorModels)
      .toEqual(['left-model', 'right-model']);
    expect(pairwiseSavedRuns({ ...run, generatorModel: 'left-model' }, run)[0]!.generatorModels).toEqual([]);
    expect(() => pairwiseSavedRuns(run, { cases: [{ ...row, evaluationHash: 'old' }] })).toThrow('规则已变化');
    expect(() => pairwiseSavedRuns(run, { cases: [] })).toThrow('同一组');
    expect(() => pairwiseSavedRuns(run, { cases: [{ ...row, generation: { finishReason: 'length' } }] })).toThrow('截断');
    expect(() => pairwiseSavedRuns({ cases: [row, row] }, { cases: [row, row] })).toThrow('重复');
  });
});
