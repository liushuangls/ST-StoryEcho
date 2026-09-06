import { describe, expect, it } from 'vitest';
import { PROMPT_EVAL_CHAIN_CASES } from '../evals/chain-cases';
import { buildChainProbeRequest, runPromptEvalChain, scoreChainProbe, type ChainRequest } from '../evals/chains';
import type { PromptEvalCompletion } from '../evals/openai-compatible-client';

const fixture = PROMPT_EVAL_CHAIN_CASES[0]!;
const response = (text: string): PromptEvalCompletion => ({ text, finishReason: 'stop', durationMs: 1 });
const probeResponse = (choice?: 'unknown'): string => JSON.stringify({
  answers: fixture.probes.map((probe) => ({ id: probe.id, choice: choice ?? probe.correctChoice, evidenceIds: choice ? [] : [1] })),
});

describe('real-output chain quality harness', () => {
  it('has two multi-scene conversations and keeps expected answers out of reader requests', () => {
    expect(PROMPT_EVAL_CHAIN_CASES).toHaveLength(2);
    for (const item of PROMPT_EVAL_CHAIN_CASES) {
      expect(item.batches).toHaveLength(4);
      expect(item.batches.flat()).toHaveLength(32);
      expect(item.batches.flat().map((message) => message.mes).join('').length).toBeGreaterThan(4_000);
      expect(new Set(item.probes.map((probe) => probe.id)).size).toBe(item.probes.length);
      const request = buildChainProbeRequest(item, '只给当前总结');
      expect(request.prompt).not.toContain('correctChoice');
      expect(request.prompt).not.toContain(item.batches[0]![0]!.mes);
      expect(request.prompt).toContain('只给当前总结');
    }
  });

  it('uses generated children and the previous generated L1, not idealized fixtures', async () => {
    const requests: { label: string; request: ChainRequest }[] = [];
    const result = await runPromptEvalChain(fixture, async (request, label) => {
      requests.push({ label, request });
      return response(label.startsWith('probe-') ? probeResponse() : `generated-${label}`);
    });
    expect(result.passed).toBe(true);
    expect(result.nodes.map((node) => node.level)).toEqual([1, 1, 1, 1, 2, 2, 3]);
    expect(requests).toHaveLength(11);
    expect(requests.find((item) => item.label === 'L1-2')!.request.prompt).toContain('generated-L1-1');
    const l2 = requests.find((item) => item.label === 'L2-1')!.request;
    const l3 = requests.find((item) => item.label === 'L3-1')!.request;
    expect(l2.prompt).toContain('generated-L1-1');
    expect(l2.prompt).toContain('generated-L1-2');
    expect(l2.prompt).not.toContain(fixture.batches[0]![0]!.mes);
    expect(l3.prompt).toContain('generated-L2-1');
    expect(l3.prompt).toContain('generated-L2-2');
    expect(l3.prompt).not.toContain('generated-L1-');
    expect(l3.system).toContain('高层级意味着更强压缩');
    expect(result.nodes.at(-1)).toMatchObject({ sourceStartMessageId: 0, sourceEndMessageId: 31 });
    expect(result.probes.map((probe) => probe.stage)).toEqual(['original', 'L1', 'L2', 'L3']);
  });

  it('stops if the raw-source reader fails, avoiding false compression-loss attribution', async () => {
    let calls = 0;
    const result = await runPromptEvalChain(fixture, async () => { calls++; return response(probeResponse('unknown')); });
    expect(calls).toBe(1);
    expect(result.error).toContain('原文对照探针');
    expect(result.nodes).toEqual([]);
    expect(result.passed).toBe(false);
  });

  it('records first observed loss without silently restoring source facts in higher levels', async () => {
    const result = await runPromptEvalChain(fixture, async (_request, label) => response(
      label.startsWith('probe-') ? probeResponse(label === 'probe-L2' ? 'unknown' : undefined) : label,
    ));
    expect(result.completed).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.firstObservedLoss.every((item) => item.stage === 'L2')).toBe(true);
  });

  it('stops on a truncated model output, without retrying or feeding it into L2', async () => {
    const labels: string[] = [];
    const result = await runPromptEvalChain(fixture, async (_request, label) => {
      labels.push(label);
      return label.startsWith('probe-') ? response(probeResponse()) : { ...response('半条总结'), finishReason: 'max_tokens' };
    });
    expect(labels).toEqual(['probe-original', 'L1-1']);
    expect(result.error).toContain('输出上限');
  });

  it('rejects invented evidence, duplicate IDs, missing answers and malformed choices', () => {
    const valid = JSON.parse(probeResponse()) as { answers: { id: string; choice: number; evidenceIds: number[] }[] };
    expect(scoreChainProbe(fixture, '证据。', JSON.stringify(valid), 'L3').score).toBe(100);
    for (const mutate of [
      (copy: typeof valid) => { copy.answers[0]!.evidenceIds = [999]; },
      (copy: typeof valid) => { copy.answers[0]!.evidenceIds = []; },
      (copy: typeof valid) => { copy.answers[0]!.choice = 99; },
      (copy: typeof valid) => { copy.answers[1]!.id = copy.answers[0]!.id; },
      (copy: typeof valid) => { copy.answers.pop(); },
    ]) {
      const copy = structuredClone(valid);
      mutate(copy);
      expect(() => scoreChainProbe(fixture, '证据。', JSON.stringify(copy), 'L3')).toThrow();
    }
  });
});
