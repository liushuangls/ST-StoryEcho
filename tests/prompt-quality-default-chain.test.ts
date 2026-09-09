import { describe, expect, it } from 'vitest';
import { DEFAULT_CHAIN_CASE } from '../evals/default-chain-case';
import { runDefaultPromptEvalChain } from '../evals/default-chain';
import type { ChainRequest } from '../evals/chains';
import type { PromptEvalCompletion } from '../evals/openai-compatible-client';

const fixture = DEFAULT_CHAIN_CASE;
const response = (text: string): PromptEvalCompletion => ({ text, finishReason: 'stop', durationMs: 1 });
function answer(request: ChainRequest, unknown = false): PromptEvalCompletion {
  const input = JSON.parse(request.prompt) as { questions: { id: string }[] };
  return response(JSON.stringify({ answers: input.questions.map(({ id }) => ({
    id, choice: unknown ? 'unknown' : fixture.probes.find((probe) => probe.id === id)!.correctChoice,
    evidenceIds: unknown ? [] : [1],
  })) }));
}

describe('default 10/5 real-output chain', () => {
  it('contains 61 batches, 366 messages and sparse early commitments without a final recap', () => {
    expect(fixture.batches).toHaveLength(61);
    expect(fixture.batches.flat()).toHaveLength(366);
    const source = fixture.batches.flat().map((message) => message.mes).join('');
    expect(source.length).toBeGreaterThan(30_000);
    expect(source.match(/潮纹镜片/gu)).toHaveLength(1);
    expect(fixture.probes).toHaveLength(16);
    expect(fixture.batches.at(-1)!.map((message) => message.mes).join('')).not.toContain('潮纹镜片');
  });

  it('uses real N+1 triggers and feeds only generated children into L2/L3', async () => {
    const requests: { label: string; request: ChainRequest }[] = [];
    const result = await runDefaultPromptEvalChain(fixture, async (request, label) => {
      requests.push({ request, label });
      return label.startsWith('probe-') ? answer(request) : response(`generated-${label}`);
    });
    expect(result.passed).toBe(true);
    expect(result.fanIn).toEqual({ level1: 10, higherLevels: 5 });
    expect(result.nodes).toHaveLength(68);
    expect(requests).toHaveLength(72);
    expect(result.merges.map(({ afterBatch, level, childCount }) => [afterBatch, level, childCount])).toEqual([
      [11, 2, 10], [21, 2, 10], [31, 2, 10], [41, 2, 10], [51, 2, 10], [61, 2, 10], [61, 3, 5],
    ]);
    expect(result.frontier.map(({ level, sourceStartMessageId, sourceEndMessageId }) => [level, sourceStartMessageId, sourceEndMessageId])).toEqual([
      [3, 0, 299], [2, 300, 359], [1, 360, 365],
    ]);
    const l2 = requests.find((item) => item.label === 'L2-1')!.request;
    expect(l2.maxTokens).toBe(8_000);
    expect(l2.prompt).toContain('generated-L1-10');
    expect(l2.prompt).not.toContain('generated-L1-11');
    expect(l2.prompt).not.toContain(fixture.batches[0]![0]!.mes);
    const l3 = requests.find((item) => item.label === 'L3-1')!.request;
    expect(l3.prompt).toContain('generated-L2-5');
    expect(l3.prompt).not.toContain('generated-L2-6');
    expect(l3.prompt).not.toContain('generated-L1-');
    expect(requests.find((item) => item.label === 'L1-12')!.request.prompt).toContain('generated-L1-11');
    expect(result.probes.map(({ stage, answers }) => [stage, answers.length])).toEqual([
      ['original', 16], ['first-L2', 3], ['before-L3', 16], ['after-L3', 16],
    ]);
    const early = requests.find((item) => item.label === 'probe-first-L2')!.request.prompt;
    expect(early).not.toContain('key-owner');
    expect(early).not.toContain('correctChoice');
    expect(early).not.toContain('availableAfterBatch');
  });

  it('stops before generation if the original-source QA fails', async () => {
    let calls = 0;
    const result = await runDefaultPromptEvalChain(fixture, async (request) => { calls++; return answer(request, true); });
    expect(calls).toBe(1);
    expect(result.nodes).toEqual([]);
    expect(result.error).toContain('原文对照探针');
  });

  it('reports first observed loss while keeping actual generated summaries', async () => {
    const result = await runDefaultPromptEvalChain(fixture, async (request, label) => label.startsWith('probe-')
      ? answer(request, label === 'probe-before-L3') : response(label));
    expect(result.completed).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.firstObservedLoss).toHaveLength(16);
    expect(result.firstObservedLoss.every((loss) => loss.stage === 'before-L3')).toBe(true);
  });

  it('keeps the last valid frontier on incomplete output, without retrying', async () => {
    const result = await runDefaultPromptEvalChain(fixture, async (request, label) => label.startsWith('probe-') ? answer(request)
      : label === 'L2-1' ? { ...response('未完成'), finishReason: 'length' } : response(label));
    expect(result.completed).toBe(false);
    expect(result.nodes).toHaveLength(11);
    expect(result.frontier).toHaveLength(11);
    expect(result.merges).toEqual([]);
    expect(result.error).toContain('输出上限');
  });

  it('rejects invalid batch counts and probe availability before any paid requests', async () => {
    const complete = async (): Promise<PromptEvalCompletion> => { throw new Error('must not call'); };
    await expect(runDefaultPromptEvalChain({ ...fixture, batches: fixture.batches.slice(0, 60) }, complete)).rejects.toThrow('61');
    await expect(runDefaultPromptEvalChain({ ...fixture, probes: [{ ...fixture.probes[0]!, availableAfterBatch: 62 }] }, complete)).rejects.toThrow('生效批次');
  });
});
