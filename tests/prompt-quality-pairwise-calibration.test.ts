import { afterEach, describe, expect, it, vi } from 'vitest';
import { pairwisePromptLayout } from '../evals/config';
import { assertPairwiseCalibration, pairwiseInputHash, runPairwiseBatch } from '../evals/pairwise-batch';
import { pairwiseCalibrationControls } from '../evals/pairwise-calibration';
import { buildPairwisePrompt, type PairwiseInput } from '../evals/pairwise';
import { candidateEvidenceSegments } from '../evals/evidence';
import type { PromptEvalRequest } from '../evals/openai-compatible-client';

const controls = pairwiseCalibrationControls();
const layout = 'full-text-with-index' as const;
const completion = (text: string) => ({ text, finishReason: 'stop', durationMs: 1 });
function knownJudge(inputs: readonly PairwiseInput[]) {
  return async (request: PromptEvalRequest) => {
    for (const input of inputs) for (const reversed of [false, true]) {
      if (request.prompt !== buildPairwisePrompt(input, reversed, layout)) continue;
      const winner = input.expected === 'tie' ? 'tie' : (input.expected === 'left') !== reversed ? 'A' : 'B';
      return completion(JSON.stringify({ winner, acceptableA: winner !== 'B', acceptableB: winner !== 'A', reason: '合成测试标签',
        differences: winner === 'tie' ? [] : [{ criterion: 'requiredFacts:0', preferred: winner, evidenceAIds: [1], evidenceBIds: [1], reason: '测试差异' }] }));
    }
    throw new Error('unexpected prompt');
  };
}
afterEach(() => vi.unstubAllEnvs());

describe('extended A/B calibration readiness', () => {
  it('freezes 18 unique controls with 7 ties, 11 good/bad pairs and three new scenarios', () => {
    expect(controls).toHaveLength(18);
    expect(new Set(controls.map((input) => input.id)).size).toBe(18);
    expect(controls.filter((input) => input.expected === 'tie')).toHaveLength(7);
    expect(controls.filter((input) => input.expected === 'left')).toHaveLength(11);
    expect(controls.filter((input) => input.id.startsWith('boundary-'))).toHaveLength(3);
    for (const input of controls) {
      const prompt = buildPairwisePrompt(input, false, layout);
      expect(prompt).not.toContain(input.id);
      expect(prompt).not.toContain('"expected"');
      expect(input.testCase.rubric.requiredFacts.length).toBeGreaterThan(0);
    }
    const longFalse = controls.find((input) => input.id === 'boundary-campus-long-false')!;
    expect(longFalse.right.length).toBeGreaterThan(longFalse.left.length * 2);
    expect(longFalse.right).toContain('限制已取消');
    const relationship = controls.find((input) => input.id === 'relationship-reference-equivalent')!;
    expect(relationship.right).toContain('暂停搭档关系');
    expect(relationship.right).not.toContain('中止搭档关系');
  });

  it('keeps calibration hashes stable across generation prompt changes but not label/data changes', () => {
    const modified = controls.map((input) => ({ ...input, testCase: { ...input.testCase, system: 'new generation prompt', prompt: 'new prompt', maxTokens: 10000 } }));
    expect(pairwiseInputHash(modified)).toBe(pairwiseInputHash(controls));
    expect(pairwiseInputHash([{ ...controls[0]!, right: 'changed' }, ...controls.slice(1)])).not.toBe(pairwiseInputHash(controls));
    expect(pairwiseInputHash([{ ...controls[0]!, expected: 'tie' }, ...controls.slice(1)])).not.toBe(pairwiseInputHash(controls));
  });

  it('requires explicit selection and rejects invalid layout names', () => {
    vi.stubEnv('STORY_ECHO_EVAL_PAIRWISE_LAYOUT', '');
    expect(pairwisePromptLayout()).toBe('segments-json');
    vi.stubEnv('STORY_ECHO_EVAL_PAIRWISE_LAYOUT', layout);
    expect(pairwisePromptLayout()).toBe(layout);
    vi.stubEnv('STORY_ECHO_EVAL_PAIRWISE_LAYOUT', 'inline-segments');
    expect(pairwisePromptLayout()).toBe('inline-segments');
    vi.stubEnv('STORY_ECHO_EVAL_PAIRWISE_LAYOUT', 'typo');
    expect(() => pairwisePromptLayout()).toThrow('布局');
  });

  it('places every citation ID directly beside its unmodified excerpt, swapping both together', () => {
    for (const input of controls) for (const reversed of [false, true]) {
      const prompt = buildPairwisePrompt(input, reversed, 'inline-segments');
      const parts = prompt.split('## candidate_B_segments');
      for (const segment of candidateEvidenceSegments(reversed ? input.right : input.left)) expect(parts[0]).toContain(`[${segment.id}] ${segment.text}`);
      for (const segment of candidateEvidenceSegments(reversed ? input.left : input.right)) expect(parts[1]).toContain(`[${segment.id}] ${segment.text}`);
      expect(prompt).not.toContain('"candidate_A_segments":');
      expect(prompt).not.toContain(input.id);
      expect(prompt).toContain(JSON.stringify(input.testCase.sourceEvidence));
    }
  });

  it('runs 72 serial requests, reversing cases and positions in round two', async () => {
    let active = 0;
    let maximum = 0;
    const counts: number[] = [];
    const judge = knownJudge(controls);
    const result = await runPairwiseBatch(controls, 2, 'controls', layout, 'json_schema', async (request) => {
      active++; maximum = Math.max(maximum, active); const answer = await judge(request); active--; return answer;
    }, async (progress) => { counts.push(progress.requests.length); });
    expect(result).toMatchObject({ passed: true, completed: true, plannedRequests: 72, maximumInFlight: 1,
      aggregate: { matched: 36, requestErrors: 0, repeatedDisagreements: 0 } });
    expect(maximum).toBe(1);
    expect(result.requests).toHaveLength(72);
    expect(new Set(counts).size).toBe(73);
    expect(result.pairs.slice(18).map((pair) => pair.id)).toEqual(controls.map((input) => input.id).reverse());
    expect(result.requests[0]!.reversed).toBe(false);
    expect(result.requests[36]!.reversed).toBe(true);
    const certificate = { ...result, mode: 'controls', controlSet: 'extended', judgeConnectionHash: 'connection' };
    expect(() => assertPairwiseCalibration(certificate, controls, 'connection', layout, 'json_schema')).not.toThrow();
    for (const change of [{ passed: false }, { repetitions: 1 }, { judgeConnectionHash: 'different' }, { inputHash: 'old' },
      { layout: 'segments-json' }, { judgeProtocolHash: 'old' }, { judgeOutputMode: 'text' }, { pairs: result.pairs.slice(1) },
      { pairs: [result.pairs[0], result.pairs[0], ...result.pairs.slice(2)] }]) {
      expect(() => assertPairwiseCalibration({ ...certificate, ...change }, controls, 'connection', layout, 'json_schema')).toThrow();
    }
    const tampered = structuredClone(certificate);
    tampered.pairs[0]!.orders[0]!.judgement!.acceptableA = false;
    expect(() => assertPairwiseCalibration(tampered, controls, 'connection', layout, 'json_schema')).toThrow('错误标签');
  });

  it('stops after the first failed control round, preserving all failures', async () => {
    const result = await runPairwiseBatch(controls, 2, 'controls', layout, 'json_schema', async () => completion('not JSON'));
    expect(result).toMatchObject({ passed: false, completed: false, stoppedAfterRound: 1, plannedRequests: 72, aggregate: { requestErrors: 36 } });
    expect(result.requests).toHaveLength(36);
    expect(result.pairs.every((pair) => pair.orders.every((order) => order.diagnostic?.responsePreview === 'not JSON'))).toBe(true);
  });

  it('does not certify a single successful calibration round', async () => {
    const result = await runPairwiseBatch(controls, 1, 'controls', layout, 'text', knownJudge(controls));
    expect(result).toMatchObject({ completed: true, passed: false, aggregate: { matched: 18 } });
  });

  it('stops paid calls on persistence failure and validates inputs before calling', async () => {
    const judge = vi.fn(knownJudge(controls));
    await expect(runPairwiseBatch(controls, 2, 'controls', layout, 'text', judge, async (result) => {
      if (result.requests.length) throw new Error('disk full');
    })).rejects.toThrow('disk full');
    expect(judge).toHaveBeenCalledTimes(1);
    judge.mockClear();
    await expect(runPairwiseBatch([], 2, 'controls', layout, 'text', judge)).rejects.toThrow();
    await expect(runPairwiseBatch(controls, 4, 'controls', layout, 'text', judge)).rejects.toThrow();
    expect(judge).not.toHaveBeenCalled();
  });

  it('keeps inconsistent candidate comparisons from passing without suppressing round two', async () => {
    const { expected: _expected, ...unlabeled } = controls[0]!;
    const inputs = [unlabeled];
    const result = await runPairwiseBatch(inputs, 2, 'compare', layout, 'text', async () => completion(JSON.stringify({
      winner: 'A', acceptableA: true, acceptableB: false, reason: '总选 A',
      differences: [{ criterion: 'requiredFacts:0', preferred: 'A', evidenceAIds: [1], evidenceBIds: [1], reason: '测试' }],
    })));
    expect(result).toMatchObject({ completed: true, passed: false });
    expect(result.requests).toHaveLength(4);
  });
});
