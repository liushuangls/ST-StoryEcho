import { createHash } from 'node:crypto';
import { PROMPT_EVAL_JUDGE_SYSTEM_PROMPT, PROMPT_EVAL_SCORING_VERSION } from './evaluator';
import { PROMPT_EVAL_COMPRESSION_METRIC } from './measurements';
import type { BuiltPromptEvalCase } from './types';
import { JUDGE_WIRE_VERSION } from './judge-schema';

export function evalHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export const PROMPT_EVAL_PROTOCOL_HASH = evalHash({
  scoring: PROMPT_EVAL_SCORING_VERSION,
  judge: PROMPT_EVAL_JUDGE_SYSTEM_PROMPT,
  compression: PROMPT_EVAL_COMPRESSION_METRIC,
  wire: JUDGE_WIRE_VERSION,
});

// Deliberately excludes the production prompt: changing it is what an A/B run measures.
export function caseEvaluationHash(testCase: BuiltPromptEvalCase): string {
  return evalHash({
    id: testCase.id,
    name: testCase.name,
    purpose: testCase.purpose,
    sourceEvidence: testCase.sourceEvidence,
    rubric: testCase.rubric,
    sourceCharacters: testCase.sourceCharacters,
    idealCompressionRatio: testCase.idealCompressionRatio,
    hardChecks: testCase.hardChecks,
  });
}

export function assertCompatibleEvaluationProtocol(value: unknown): void {
  if (value !== PROMPT_EVAL_PROTOCOL_HASH) {
    throw new Error('评测基线的评分/Judge 协议已变化，不能直接比较；请重新建立基线。');
  }
}
