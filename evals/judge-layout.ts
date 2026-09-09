import { pairwiseControls } from './pairwise-inputs';
import { evaluatePairwise, pairwiseJudgeSystem, type PairwiseInput, type PairwisePromptLayout, type PairwiseResult } from './pairwise';
import { completionDiagnostic, JudgeEvaluationError, redactEvalSecrets, type JudgeFailureDiagnostic } from './judge-diagnostics';
import { JUDGE_WIRE_VERSION, type JudgeOutputMode } from './judge-schema';
import type { PromptEvalCompletion, PromptEvalRequest } from './openai-compatible-client';
import { evalHash } from './protocol';

type ProbePhase = 'identity' | 'omission';
type ProbeLayout = Exclude<PairwisePromptLayout, 'inline-segments'>;
interface LayoutRequestResult {
  sequence: number;
  caseId: string;
  phase: ProbePhase;
  layout: PairwisePromptLayout;
  reversed: boolean;
  promptHash: string;
  schemaHash: string;
  startedAt: string;
  finishedAt: string;
  diagnostic?: JudgeFailureDiagnostic;
  error?: string;
}
export interface JudgeLayoutProbeResult {
  schemaVersion: number;
  generatedAt: string;
  judgeOutputMode: JudgeOutputMode;
  layoutProtocolHashes: Record<ProbeLayout, string>;
  initialPlannedRequests: number;
  maximumRequests: number;
  plannedRequests: number;
  maximumInFlight: number;
  omissionGateOpened: boolean;
  requests: LayoutRequestResult[];
  pairs: (PairwiseResult & { phase: ProbePhase; layout: PairwisePromptLayout })[];
  completed: boolean;
  passed: boolean;
  aggregate: Record<string, number>;
}

/** Paired old/new identity screen; only a clean new-layout screen opens 6 omission requests. */
export async function runJudgeLayoutProbe(
  complete: (request: PromptEvalRequest) => Promise<PromptEvalCompletion>,
  outputMode: JudgeOutputMode,
  onProgress: (result: JudgeLayoutProbeResult) => Promise<void> = async () => {},
): Promise<JudgeLayoutProbeResult> {
  const controls = pairwiseControls();
  const identities = controls.filter((input) => input.expected === 'tie');
  const omissions = controls.filter((input) => input.id.endsWith('-vs-omission'));
  if (identities.length !== 3 || omissions.length !== 3) throw new Error('布局实验需要三组同文与三组遗漏对照。');
  const result: JudgeLayoutProbeResult = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), judgeOutputMode: outputMode,
    layoutProtocolHashes: Object.fromEntries((['segments-json', 'full-text-with-index'] as const).map((layout) => [layout, evalHash({ system: pairwiseJudgeSystem(layout), wire: JUDGE_WIRE_VERSION })])) as Record<ProbeLayout, string>,
    initialPlannedRequests: 12, maximumRequests: 18, plannedRequests: 12, maximumInFlight: 0,
    omissionGateOpened: false, requests: [], pairs: [], completed: false, passed: false, aggregate: {},
  };
  let inFlight = 0;
  let progressError: Error | undefined;
  const publish = async (): Promise<void> => {
    try { await onProgress(result); } catch (error) {
      progressError = error instanceof Error ? error : new Error(String(error));
      throw progressError;
    }
  };
  const runPair = async (input: PairwiseInput, layout: PairwisePromptLayout, phase: ProbePhase, repetition: number): Promise<void> => {
    let orientation = 0;
    const pair = await evaluatePairwise(input, repetition, async (request) => {
      if (progressError) throw progressError;
      const row: LayoutRequestResult = {
        sequence: result.requests.length + 1, caseId: input.id, phase, layout,
        reversed: repetition % 2 === 1 ? orientation === 1 : orientation === 0,
        promptHash: evalHash(request.prompt), schemaHash: evalHash(request.responseFormat ?? null),
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
    }, outputMode, layout);
    if (progressError) throw progressError;
    result.pairs.push({ ...pair, layout, phase });
    await publish();
  };
  await publish();
  for (const [index, input] of identities.entries()) {
    // Keep old/new runs close in time and alternate which layout is requested first.
    const layouts: PairwisePromptLayout[] = index % 2 ? ['full-text-with-index', 'segments-json'] : ['segments-json', 'full-text-with-index'];
    for (const layout of layouts) await runPair(input, layout, 'identity', index + 1);
  }
  const candidateIdentities = result.pairs.filter((pair) => pair.layout === 'full-text-with-index');
  result.omissionGateOpened = candidateIdentities.length === 3 && candidateIdentities.every((pair) => pair.matched);
  if (result.omissionGateOpened) {
    result.plannedRequests = 18;
    await publish();
    for (const [index, input] of omissions.entries()) await runPair(input, 'full-text-with-index', 'omission', index + 1);
  }
  const matchedIdentityOrders = (layout: PairwisePromptLayout): number => result.pairs.filter((pair) => pair.phase === 'identity' && pair.layout === layout)
    .flatMap((pair) => pair.orders).filter((order) => order.judgement?.winner === 'tie' && order.judgement.acceptableA && order.judgement.acceptableB).length;
  result.aggregate = {
    requests: result.requests.length,
    baselineIdentityLabelsMatched: matchedIdentityOrders('segments-json'),
    candidateIdentityLabelsMatched: matchedIdentityOrders('full-text-with-index'),
    baselineIdentityPairsMatched: result.pairs.filter((pair) => pair.phase === 'identity' && pair.layout === 'segments-json' && pair.matched).length,
    candidateIdentityPairsMatched: candidateIdentities.filter((pair) => pair.matched).length,
    omissionPairsMatched: result.pairs.filter((pair) => pair.phase === 'omission' && pair.matched).length,
    errors: result.pairs.flatMap((pair) => pair.orders).filter((order) => order.error).length,
  };
  result.completed = result.requests.length === result.plannedRequests;
  result.passed = result.completed && result.maximumInFlight === 1 && result.omissionGateOpened && result.aggregate['omissionPairsMatched'] === 3;
  await publish();
  return result;
}
