import { describe, expect, it } from 'vitest';
import { candidateEvidenceSegments } from '../evals/evidence';
import { runJudgeLayoutProbe } from '../evals/judge-layout';
import { indexedRubric, JUDGE_WIRE_VERSION } from '../evals/judge-schema';
import { pairwiseControls } from '../evals/pairwise-inputs';
import { buildPairwisePrompt, evaluatePairwise, pairwiseJudgeSystem, type PairwisePromptLayout } from '../evals/pairwise';
import type { PromptEvalRequest } from '../evals/openai-compatible-client';
import { evalHash } from '../evals/protocol';

const layouts: PairwisePromptLayout[] = ['segments-json', 'full-text-with-index'];
const controls = pairwiseControls();
const input = controls[0]!;
function completion(winner: 'A' | 'B' | 'tie' | 'inconclusive') {
  return { finishReason: 'stop', durationMs: 1, text: JSON.stringify({
    winner, acceptableA: winner === 'A' || winner === 'tie', acceptableB: winner === 'B' || winner === 'tie', reason: '测试判断',
    differences: winner === 'A' || winner === 'B' ? [{ criterion: 'requiredFacts:0', preferred: winner, evidenceAIds: [1], evidenceBIds: [1], reason: '关键事实差异' }] : [],
  }) };
}

describe('local Judge layout experiment', () => {
  it('keeps the baseline system fingerprint and original JSON bytes unchanged', () => {
    expect(evalHash({ system: pairwiseJudgeSystem('segments-json'), wire: JUDGE_WIRE_VERSION }))
      .toBe('842dc851faf8c72ee3834545f5acb6491ce6a85da7a3ece04b81152ab5423acf');
    for (const reversed of [false, true]) {
      const expected = JSON.stringify({ source_evidence: input.testCase.sourceEvidence, rubric: indexedRubric(input.testCase.rubric),
        candidate_A_segments: candidateEvidenceSegments(reversed ? input.right : input.left),
        candidate_B_segments: candidateEvidenceSegments(reversed ? input.left : input.right) });
      expect(buildPairwisePrompt(input, reversed)).toBe(expected);
      expect(buildPairwisePrompt(input, reversed, 'segments-json')).toBe(expected);
    }
  });

  it('puts complete blinded candidates first and preserves the exact source/rubric/index JSON', () => {
    const blinded = { ...input, id: 'LOCAL_PRIVATE_CASE_ID', generatorModels: ['PRIVATE_MODEL'], expected: 'left' as const };
    for (const reversed of [false, true]) {
      const prompt = buildPairwisePrompt(blinded, reversed, 'full-text-with-index');
      expect(prompt.startsWith(`## candidate_A_text（完整正文）\n\n\`\`\`text\n${reversed ? input.right : input.left}\n\`\`\``)).toBe(true);
      expect(prompt).toContain(`## candidate_B_text（完整正文）\n\n\`\`\`text\n${reversed ? input.left : input.right}\n\`\`\``);
      expect(prompt).toContain(buildPairwisePrompt(input, reversed));
      for (const label of ['LOCAL_PRIVATE_CASE_ID', 'PRIVATE_MODEL', 'expected']) expect(prompt).not.toContain(label);
    }
  });

  it('keeps embedded Markdown fences inside their data block', () => {
    const text = '正文\n````\n仍是候选\n```';
    const prompt = buildPairwisePrompt({ ...input, left: text }, false, 'full-text-with-index');
    expect(prompt).toContain(`\`\`\`\`\`text\n${text}\n\`\`\`\`\``);
    expect(prompt).toContain(buildPairwisePrompt({ ...input, left: text }, false));
  });

  it('changes only input navigation in system and keeps output schema/budget identical', async () => {
    const requests: PromptEvalRequest[] = [];
    for (const layout of layouts) await evaluatePairwise(input, 1, async (request) => {
      requests.push(request); return completion('inconclusive');
    }, 'json_schema', layout);
    for (let index = 0; index < 2; index++) {
      expect(requests[index]!.responseFormat).toEqual(requests[index + 2]!.responseFormat);
      expect(requests[index]!.maxTokens).toBe(5_000);
      expect(requests[index + 2]!.maxTokens).toBe(5_000);
    }
    const gradingPrefix = pairwiseJudgeSystem('segments-json').split('候选 A 的完整文本在')[0]!;
    const citationSuffix = pairwiseJudgeSystem('segments-json').split('evidenceAIds 只引用')[1]!;
    expect(pairwiseJudgeSystem('full-text-with-index').startsWith(gradingPrefix)).toBe(true);
    expect(pairwiseJudgeSystem('full-text-with-index').endsWith(citationSuffix)).toBe(true);
  });

  it('stops after 12 serial requests when new-layout identities fail, without synthesizing ties', async () => {
    let calls = 0;
    let inFlight = 0;
    let maximumInFlight = 0;
    const progressCounts: number[] = [];
    const result = await runJudgeLayoutProbe(async () => {
      calls++; inFlight++; maximumInFlight = Math.max(maximumInFlight, inFlight);
      await Promise.resolve(); inFlight--; return completion('inconclusive');
    }, 'json_schema', async (progress) => { progressCounts.push(progress.requests.length); });
    expect(calls).toBe(12);
    expect(maximumInFlight).toBe(1);
    expect(result).toMatchObject({ completed: true, passed: false, omissionGateOpened: false, plannedRequests: 12, maximumInFlight: 1 });
    expect(result.pairs).toHaveLength(6);
    expect(result.requests.every((row) => row.phase === 'identity')).toBe(true);
    expect(result.aggregate['candidateIdentityLabelsMatched']).toBe(0);
    expect(new Set(progressCounts).size).toBe(13);
    expect(result.requests.map((row) => row.layout)).toEqual([
      'segments-json', 'segments-json', 'full-text-with-index', 'full-text-with-index',
      'full-text-with-index', 'full-text-with-index', 'segments-json', 'segments-json',
      'segments-json', 'segments-json', 'full-text-with-index', 'full-text-with-index',
    ]);
  });

  it('opens only six omission requests after all new-layout identities pass', async () => {
    let calls = 0;
    const result = await runJudgeLayoutProbe(async (request) => {
      calls++;
      if (request.system === pairwiseJudgeSystem('segments-json')) return completion('inconclusive');
      for (const control of controls.filter((row) => row.id.endsWith('-vs-omission'))) {
        for (const reversed of [false, true]) {
          if (request.prompt === buildPairwisePrompt(control, reversed, 'full-text-with-index')) return completion(reversed ? 'B' : 'A');
        }
      }
      return completion('tie');
    }, 'json_schema');
    expect(calls).toBe(18);
    expect(result).toMatchObject({ completed: true, passed: true, omissionGateOpened: true, plannedRequests: 18, maximumRequests: 18, maximumInFlight: 1,
      aggregate: { baselineIdentityLabelsMatched: 0, candidateIdentityLabelsMatched: 6, omissionPairsMatched: 3 } });
    expect(result.requests.filter((row) => row.phase === 'omission')).toHaveLength(6);
    expect(result.layoutProtocolHashes['full-text-with-index']).not.toBe(result.layoutProtocolHashes['segments-json']);
  });

  it('does not pass an always-tie Judge that fails to detect omissions', async () => {
    const result = await runJudgeLayoutProbe(async () => completion('tie'), 'text');
    expect(result).toMatchObject({ completed: true, passed: false, omissionGateOpened: true, plannedRequests: 18,
      aggregate: { candidateIdentityLabelsMatched: 6, omissionPairsMatched: 0 } });
  });

  it('stops paid requests when progress cannot be saved', async () => {
    let calls = 0;
    await expect(runJudgeLayoutProbe(async () => { calls++; return completion('tie'); }, 'text', async (progress) => {
      if (progress.requests.length) throw new Error('disk unavailable');
    })).rejects.toThrow('disk unavailable');
    expect(calls).toBe(1);
  });
});
