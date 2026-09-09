import { buildPromptEvalCase } from './cases';
import { findSavedRunCase } from './case-catalog';
import { CALIBRATION_CONTROLS, calibrationCase } from './calibration';
import { caseEvaluationHash } from './protocol';
import { isPromptEvalTruncated } from './completion';
import type { PairwiseInput } from './pairwise';

export function pairwiseControls(): PairwiseInput[] {
  return CALIBRATION_CONTROLS.filter((item) => item.expectedPass).flatMap((good) => [
    ...CALIBRATION_CONTROLS.filter((item) => item.caseId === good.caseId && !item.expectedPass).map((bad): PairwiseInput => ({
      id: `${good.id}-vs-${bad.variant}`, testCase: calibrationCase(good), left: good.candidate, right: bad.candidate, expected: 'left',
    })),
    { id: `${good.id}-identity`, testCase: calibrationCase(good), left: good.candidate, right: good.candidate, expected: 'tie' as const },
  ]);
}

interface SavedCandidate { id: string; evaluationHash: string; generatedSummary: string }

function savedCandidates(value: unknown): SavedCandidate[] {
  if (!value || typeof value !== 'object' || !('cases' in value) || !Array.isArray(value.cases)) throw new Error('A/B 输入必须是 eval:prompts 的结果。');
  const seen = new Set<string>();
  return value.cases.map((item: unknown): SavedCandidate => {
    if (!item || typeof item !== 'object') throw new Error('A/B 输入用例格式无效。');
    const row = item as Record<string, unknown>;
    const generation = row['generation'] as { finishReason?: string } | undefined;
    if (typeof row['id'] !== 'string' || seen.has(row['id']) || typeof row['evaluationHash'] !== 'string'
      || typeof row['generatedSummary'] !== 'string' || !row['generatedSummary'].trim()
      || !generation || typeof generation.finishReason !== 'string' || isPromptEvalTruncated(generation.finishReason)) {
      throw new Error('A/B 输入存在重复 ID、缺失正文/指纹或截断输出。');
    }
    seen.add(row['id']);
    return { id: row['id'], evaluationHash: row['evaluationHash'], generatedSummary: row['generatedSummary'] };
  });
}

export function pairwiseSavedRuns(leftValue: unknown, rightValue: unknown): PairwiseInput[] {
  const left = savedCandidates(leftValue);
  const right = savedCandidates(rightValue);
  const rightById = new Map(right.map((item) => [item.id, item]));
  const knownModels = [leftValue, rightValue].flatMap((value) => {
    if (value && typeof value === 'object' && 'generatorModel' in value
      && typeof value.generatorModel === 'string' && value.generatorModel.trim()) return [value.generatorModel.trim()];
    return [];
  });
  const generatorModels = knownModels.length === 2 ? knownModels : [];
  if (!left.length || left.length !== right.length) throw new Error('A/B 两侧必须包含同一组非空用例。');
  return left.map((prior) => {
    const next = rightById.get(prior.id);
    const definition = findSavedRunCase(prior.id);
    if (!next || !definition) throw new Error(`A/B 用例不匹配：${prior.id}`);
    const built = buildPromptEvalCase(definition);
    const hash = caseEvaluationHash(built);
    if (prior.evaluationHash !== hash || next.evaluationHash !== hash) throw new Error(`A/B 来源或规则已变化：${prior.id}`);
    return { id: prior.id, testCase: built, left: prior.generatedSummary, right: next.generatedSummary, generatorModels };
  });
}
