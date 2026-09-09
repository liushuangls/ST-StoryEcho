import { buildPromptEvalCase } from './cases';
import { selectGenerationCases } from './case-catalog';
import { isPromptEvalTruncated } from './completion';
import { completionDiagnostic, JudgeEvaluationError, redactEvalSecrets, type JudgeFailureDiagnostic } from './judge-diagnostics';
import { measurePromptEvalText } from './measurements';
import { evaluatePromptEvalHardChecks } from './hard-checks';
import type { PromptEvalCompletion, PromptEvalRequest } from './openai-compatible-client';
import { caseEvaluationHash, evalHash } from './protocol';
import { applyPromptEvalVariant, type PromptEvalVariant } from './variants';
import type { PromptEvalHardCheckResult } from './types';

interface GeneratedCase {
  id: string;
  promptHash: string;
  evaluationHash: string;
  outputCharacters: number;
  outputTruncated: boolean;
  generatedSummary?: string;
  generation?: Omit<PromptEvalCompletion, 'text'>;
  hardChecks?: PromptEvalHardCheckResult[];
  diagnostic?: JudgeFailureDiagnostic;
  error?: string;
}
export interface GenerationOnlyResult {
  qualityEvaluated: false;
  promptVariant: PromptEvalVariant;
  plannedRequests: number;
  completed: boolean;
  generationSucceeded: boolean;
  cases: GeneratedCase[];
}

/** A paid generation-only path. No Judge, quality scores, baselines or retries. */
export async function generatePromptCandidates(
  ids: readonly string[], variant: PromptEvalVariant,
  complete: (request: PromptEvalRequest) => Promise<PromptEvalCompletion>,
  onProgress: (result: GenerationOnlyResult) => Promise<void> = async () => {},
): Promise<GenerationOnlyResult> {
  const selected = selectGenerationCases(ids);
  const result: GenerationOnlyResult = { qualityEvaluated: false, promptVariant: variant, plannedRequests: selected.length,
    completed: false, generationSucceeded: false, cases: [] };
  await onProgress(result);
  for (const definition of selected) {
    const testCase = applyPromptEvalVariant(buildPromptEvalCase(definition), variant);
    const request = { system: testCase.system, prompt: testCase.prompt, maxTokens: testCase.maxTokens };
    const row: GeneratedCase = { id: testCase.id, promptHash: evalHash(request), evaluationHash: caseEvaluationHash(testCase), outputCharacters: 0, outputTruncated: false };
    try {
      const completion = await complete(request);
      const { text, ...generation } = completion;
      row.generatedSummary = text; row.generation = generation;
      row.outputCharacters = measurePromptEvalText(testCase, text).outputCharacters;
      row.outputTruncated = isPromptEvalTruncated(completion.finishReason);
      if (testCase.hardChecks) row.hardChecks = evaluatePromptEvalHardChecks(text, testCase.hardChecks);
      if (!text.trim() || row.outputTruncated) row.error = row.outputTruncated ? '生成被截断，不进入候选比较。' : '生成正文为空。';
    } catch (error) {
      row.error = redactEvalSecrets(error instanceof Error ? error.message : String(error)).slice(0, 2_000);
      if (error instanceof JudgeEvaluationError) row.diagnostic = error.diagnostic;
    }
    if (row.error && row.generatedSummary && row.generation) row.diagnostic = completionDiagnostic({ text: row.generatedSummary, ...row.generation });
    result.cases.push(row);
    await onProgress(result);
    if (row.error) break;
  }
  result.completed = result.cases.length === result.plannedRequests;
  result.generationSucceeded = result.completed && result.cases.every((row) => !row.error);
  await onProgress(result);
  return result;
}
