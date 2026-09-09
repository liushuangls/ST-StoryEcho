import { pairwiseControls } from './pairwise-inputs';
import { buildPairwisePrompt, evaluatePairwise, pairwiseRepeatDisagreements, PAIRWISE_JUDGE_SYSTEM, type PairwiseResult } from './pairwise';
import { completionDiagnostic, JudgeEvaluationError, redactEvalSecrets, type JudgeFailureDiagnostic } from './judge-diagnostics';
import { JUDGE_WIRE_VERSION, type JudgeOutputMode } from './judge-schema';
import type { PromptEvalCompletion, PromptEvalRequest } from './openai-compatible-client';
import { candidateEvidenceSegments } from './evidence';
import { evalHash } from './protocol';

interface SerialRequestResult {
  sequence: number;
  caseId: string;
  repetition: number;
  reversed: boolean;
  startedAt: string;
  finishedAt: string;
  diagnostic?: JudgeFailureDiagnostic;
  error?: string;
}

export interface SerialIdentityProbeResult {
  schemaVersion: number;
  generatedAt: string;
  judgeOutputMode: JudgeOutputMode;
  judgeProtocolHash: string;
  plannedRequests: number;
  repetitions: number;
  maximumInFlight: number;
  inputs: {
    id: string;
    candidateCharacters: number;
    candidateSegments: number;
    candidateHash: string;
    candidateEqual: boolean;
    promptHash: string;
  }[];
  requests: SerialRequestResult[];
  pairs: PairwiseResult[];
  completed: boolean;
  passed: boolean;
  aggregate: Record<string, number>;
}

/** Fixed 3 identities x 2 orientations x 2 rounds. No parallelism or retries. */
export async function runSerialIdentityProbe(
  complete: (request: PromptEvalRequest) => Promise<PromptEvalCompletion>,
  outputMode: JudgeOutputMode,
  onProgress: (result: SerialIdentityProbeResult) => Promise<void> = async () => {},
): Promise<SerialIdentityProbeResult> {
  const inputs = pairwiseControls().filter((input) => input.expected === 'tie');
  if (inputs.length !== 3 || inputs.some((input) => input.left !== input.right)) throw new Error('串行诊断必须使用三组完全相同的候选。');
  const result: SerialIdentityProbeResult = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), judgeOutputMode: outputMode,
    judgeProtocolHash: evalHash({ system: PAIRWISE_JUDGE_SYSTEM, wire: JUDGE_WIRE_VERSION }),
    plannedRequests: 12, repetitions: 2, maximumInFlight: 0,
    inputs: inputs.map((input) => ({
      id: input.id, candidateCharacters: Array.from(input.left).length,
      candidateSegments: candidateEvidenceSegments(input.left).length,
      candidateHash: evalHash(input.left), candidateEqual: input.left === input.right,
      promptHash: evalHash(buildPairwisePrompt(input, false)),
    })),
    requests: [], pairs: [], completed: false, passed: false, aggregate: {},
  };
  let inFlight = 0;
  let progressError: Error | undefined;
  const publish = async (): Promise<void> => {
    try { await onProgress(result); } catch (error) {
      progressError = error instanceof Error ? error : new Error(String(error));
      throw progressError;
    }
  };
  await publish();
  for (let repetition = 1; repetition <= result.repetitions; repetition++) {
    for (const input of inputs) {
      let orientation = 0;
      const pair = await evaluatePairwise(input, repetition, async (request) => {
        if (progressError) throw progressError;
        const row: SerialRequestResult = {
          sequence: result.requests.length + 1, caseId: input.id, repetition,
          reversed: repetition % 2 === 1 ? orientation === 1 : orientation === 0,
          startedAt: new Date().toISOString(), finishedAt: '',
        };
        orientation++;
        inFlight++;
        result.maximumInFlight = Math.max(result.maximumInFlight, inFlight);
        try {
          const completion = await complete(request);
          row.diagnostic = completionDiagnostic(completion);
          return completion;
        } catch (error) {
          row.error = redactEvalSecrets(error instanceof Error ? error.message : String(error)).slice(0, 2_000);
          if (error instanceof JudgeEvaluationError) row.diagnostic = error.diagnostic;
          throw error;
        } finally {
          inFlight--;
          row.finishedAt = new Date().toISOString();
          result.requests.push(row);
          await publish();
        }
      }, outputMode);
      if (progressError) throw progressError;
      result.pairs.push(pair);
      await publish();
    }
  }
  const orders = result.pairs.flatMap((pair) => pair.orders);
  const ids = result.requests.flatMap((row) => row.diagnostic?.transport?.serverRequestId ? [row.diagnostic.transport.serverRequestId] : []);
  result.aggregate = {
    requests: result.requests.length,
    validJudgements: orders.filter((order) => order.judgement).length,
    correctIdentityJudgements: orders.filter((order) => order.judgement?.winner === 'tie' && order.judgement.acceptableA && order.judgement.acceptableB).length,
    errors: orders.filter((order) => order.error).length,
    matchedPairs: result.pairs.filter((pair) => pair.matched).length,
    repeatedDisagreements: pairwiseRepeatDisagreements(result.pairs),
    serverRequestIdsPresent: ids.length,
    duplicateServerRequestIds: ids.length - new Set(ids).size,
  };
  result.completed = result.requests.length === result.plannedRequests;
  result.passed = result.completed && result.maximumInFlight === 1 && result.pairs.every((pair) => pair.matched)
    && result.aggregate['repeatedDisagreements'] === 0;
  await publish();
  return result;
}
