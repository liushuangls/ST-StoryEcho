import { completionDiagnostic, redactEvalSecrets, JudgeEvaluationError, type JudgeFailureDiagnostic } from './judge-diagnostics';
import { JUDGE_WIRE_VERSION, type JudgeOutputMode } from './judge-schema';
import type { PromptEvalCompletion, PromptEvalRequest } from './openai-compatible-client';
import { evaluatePairwise, pairwiseJudgeSystem, pairwiseRepeatDisagreements, type PairwiseInput, type PairwisePromptLayout, type PairwiseResult } from './pairwise';
import { caseEvaluationHash, evalHash } from './protocol';

export function pairwiseInputHash(inputs: readonly PairwiseInput[]): string {
  return evalHash(inputs.map((input) => ({ id: input.id, evaluationHash: caseEvaluationHash(input.testCase), left: input.left, right: input.right, expected: input.expected })));
}
export function pairwiseProtocolHash(layout: PairwisePromptLayout): string {
  return evalHash({ system: pairwiseJudgeSystem(layout), wire: JUDGE_WIRE_VERSION });
}
export interface PairwiseBatchResult {
  layout: PairwisePromptLayout;
  judgeOutputMode: JudgeOutputMode;
  judgeProtocolHash: string;
  inputHash: string;
  repetitions: number;
  plannedRequests: number;
  maximumInFlight: number;
  stoppedAfterRound?: number;
  pairs: PairwiseResult[];
  requests: { sequence: number; id: string; repetition: number; reversed: boolean; startedAt: string; finishedAt: string; diagnostic?: JudgeFailureDiagnostic; error?: string }[];
  completed: boolean;
  passed: boolean;
  aggregate: Record<string, number>;
}

/** Serial, persisted per request. A failed control round never opens the next round. */
export async function runPairwiseBatch(
  inputs: readonly PairwiseInput[], repetitions: number, mode: 'controls' | 'compare', layout: PairwisePromptLayout, outputMode: JudgeOutputMode,
  complete: (request: PromptEvalRequest) => Promise<PromptEvalCompletion>,
  onProgress: (result: PairwiseBatchResult) => Promise<void> = async () => {},
): Promise<PairwiseBatchResult> {
  if (!inputs.length || new Set(inputs.map((input) => input.id)).size !== inputs.length) throw new Error('A/B 输入必须非空且 ID 唯一。');
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 3) throw new Error('A/B 重复次数须为 1–3。');
  if (mode === 'controls' && inputs.some((input) => !input.expected)) throw new Error('校准对照缺少预期标签。');
  const result: PairwiseBatchResult = {
    layout, judgeOutputMode: outputMode, judgeProtocolHash: pairwiseProtocolHash(layout), inputHash: pairwiseInputHash(inputs), repetitions,
    plannedRequests: inputs.length * 2 * repetitions, maximumInFlight: 0, pairs: [], requests: [], completed: false, passed: false, aggregate: {},
  };
  let saveError: Error | undefined;
  let inFlight = 0;
  const save = async (): Promise<void> => {
    try { await onProgress(result); } catch (error) {
      saveError = error instanceof Error ? error : new Error(String(error)); throw saveError;
    }
  };
  await save();
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    const ordered = repetition % 2 ? inputs : [...inputs].reverse();
    const round: PairwiseResult[] = [];
    for (const input of ordered) {
      let orientation = 0;
      const row = await evaluatePairwise(input, repetition, async (request) => {
        if (saveError) throw saveError;
        const trace: PairwiseBatchResult['requests'][number] = {
          sequence: result.requests.length + 1, id: input.id, repetition,
          reversed: repetition % 2 ? orientation++ === 1 : orientation++ === 0,
          startedAt: new Date().toISOString(), finishedAt: '',
        };
        inFlight++; result.maximumInFlight = Math.max(result.maximumInFlight, inFlight);
        try {
          const completion = await complete(request); trace.diagnostic = completionDiagnostic(completion); return completion;
        } catch (error) {
          trace.error = redactEvalSecrets(error instanceof Error ? error.message : String(error)).slice(0, 2_000);
          if (error instanceof JudgeEvaluationError) trace.diagnostic = error.diagnostic;
          throw error;
        } finally {
          inFlight--; trace.finishedAt = new Date().toISOString(); result.requests.push(trace); await save();
        }
      }, outputMode, layout);
      if (saveError) throw saveError;
      result.pairs.push(row); round.push(row); await save();
    }
    if (mode === 'controls' && round.some((row) => !row.matched)) { result.stoppedAfterRound = repetition; break; }
  }
  const repeatedDisagreements = pairwiseRepeatDisagreements(result.pairs);
  result.aggregate = {
    pairs: result.pairs.length, consistent: result.pairs.filter((pair) => pair.consistent).length,
    matched: result.pairs.filter((pair) => pair.matched).length,
    leftWins: result.pairs.filter((pair) => pair.outcome === 'left').length,
    rightWins: result.pairs.filter((pair) => pair.outcome === 'right').length,
    ties: result.pairs.filter((pair) => pair.outcome === 'tie').length,
    inconclusive: result.pairs.filter((pair) => pair.outcome === 'inconclusive').length,
    requestErrors: result.pairs.flatMap((pair) => pair.orders).filter((order) => order.error).length,
    repeatedDisagreements,
  };
  result.completed = result.requests.length === result.plannedRequests;
  result.passed = result.completed && result.maximumInFlight === 1 && repeatedDisagreements === 0
    && (mode !== 'controls' || repetitions >= 2) && result.pairs.every((pair) => mode === 'controls' ? pair.matched : pair.consistent);
  await save();
  return result;
}

/** Reject stale or incomplete calibration before spending on a candidate comparison. */
export function assertPairwiseCalibration(value: unknown, inputs: readonly PairwiseInput[], connectionHash: string, layout: PairwisePromptLayout, outputMode: JudgeOutputMode): void {
  const result = value as Partial<PairwiseBatchResult> & { judgeConnectionHash?: string; mode?: string; controlSet?: string } | null;
  if (!result || result.mode !== 'controls' || result.controlSet !== 'extended' || !result.passed || !result.completed
    || result.judgeConnectionHash !== connectionHash || result.layout !== layout || result.judgeOutputMode !== outputMode
    || result.judgeProtocolHash !== pairwiseProtocolHash(layout) || result.inputHash !== pairwiseInputHash(inputs)
    || !Number.isSafeInteger(result.repetitions) || result.repetitions! < 2 || result.repetitions! > 3
    || result.maximumInFlight !== 1 || !Array.isArray(result.pairs) || !Array.isArray(result.requests)
    || result.pairs.length !== inputs.length * result.repetitions! || result.requests.length !== inputs.length * result.repetitions! * 2) {
    throw new Error('缺少当前连接/布局/对照集下通过的至少两轮完整 A/B 校准，不能开始候选比较。');
  }
  for (const input of inputs) for (let repetition = 1; repetition <= result.repetitions!; repetition++) {
    const pairs = result.pairs.filter((pair) => pair.id === input.id && pair.repetition === repetition);
    const pair = pairs[0];
    if (pairs.length !== 1 || !pair?.matched || !pair.consistent || pair.outcome !== input.expected || pair.orders.length !== 2
      || new Set(pair.orders.map((order) => order.reversed)).size !== 2
      || pair.orders.some((order) => {
        const judgement = order.judgement;
        const expectedWinner = input.expected === 'tie' ? 'tie' : (input.expected === 'left') !== order.reversed ? 'A' : 'B';
        return order.error || !judgement || judgement.winner !== expectedWinner
          || judgement.acceptableA !== (input.expected === 'tie' || expectedWinner === 'A')
          || judgement.acceptableB !== (input.expected === 'tie' || expectedWinner === 'B');
      })) throw new Error('A/B 校准记录存在缺失、重复或错误标签，不能作为放行依据。');
  }
}
