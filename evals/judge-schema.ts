import type { PromptEvalRubric } from './types';
import { candidateEvidenceSegments } from './evidence';

export const JUDGE_WIRE_VERSION = 'indexed-rules-v1';
export type JudgeOutputMode = 'text' | 'json_schema';
type Schema = Record<string, unknown>;
export interface JudgeResponseFormat {
  type: 'json_schema';
  json_schema: { name: string; strict: true; schema: Schema };
}
export const RULE_DIMENSIONS = ['requiredFacts', 'requiredCausalChains', 'uncertaintyRules', 'focusRules', 'forbiddenClaims'] as const;

export function indexedRubric(rubric: PromptEvalRubric): Record<string, unknown> {
  return Object.fromEntries(RULE_DIMENSIONS.map((dimension) => [dimension,
    rubric[dimension].map((rule, criterionIndex) => ({ ...rule, criterionIndex, criterionId: `${dimension}:${criterionIndex}` })),
  ]));
}

function object(properties: Record<string, Schema>): Schema {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}
const string: Schema = { type: 'string' };
function enumeration(values: readonly string[]): Schema { return { type: 'string', enum: values }; }
function evidence(candidate: string): Schema {
  const count = candidateEvidenceSegments(candidate).length;
  return { type: 'array', items: { type: 'integer', minimum: 1, maximum: Math.max(1, count) }, maxItems: count ? 24 : 0 };
}
function format(name: string, schema: Schema): JudgeResponseFormat {
  return { type: 'json_schema', json_schema: { name, strict: true, schema } };
}

export function singleJudgeResponseFormat(rubric: PromptEvalRubric, candidate: string): JudgeResponseFormat {
  const evidenceIds = evidence(candidate);
  const dimensions = Object.fromEntries(RULE_DIMENSIONS.map((dimension) => {
    const verdict = enumeration(dimension === 'forbiddenClaims'
      ? ['clear', 'ambiguous', 'violated'] : ['complete', 'mostly', 'partial', 'missing', 'contradicted']);
    return [dimension, object(Object.fromEntries(rubric[dimension].map((_, index) => [String(index),
      object({ verdict, evidenceIds, reason: string }),
    ])))];
  }));
  const issues: Schema = { type: 'array', maxItems: 50, items: object({ severity: enumeration(['minor', 'major', 'critical']), evidenceIds, reason: string }) };
  return format('story_echo_quality_judgement', object({ ...dimensions, hallucinations: issues, chronologyErrors: issues, notes: string }));
}

export function pairwiseJudgeResponseFormat(rubric: PromptEvalRubric, candidateA: string, candidateB: string): JudgeResponseFormat {
  const criteria = RULE_DIMENSIONS.flatMap((dimension) => rubric[dimension].map((_, index) => `${dimension}:${index}`));
  if (!criteria.length) throw new Error('A/B 评审至少需要一条规则。');
  return format('story_echo_pairwise_judgement', object({
    winner: enumeration(['A', 'B', 'tie', 'inconclusive']),
    acceptableA: { type: 'boolean' }, acceptableB: { type: 'boolean' }, reason: string,
    differences: { type: 'array', maxItems: 12, items: object({
      criterion: enumeration(criteria), preferred: enumeration(['A', 'B', 'tie']),
      evidenceAIds: evidence(candidateA), evidenceBIds: evidence(candidateB), reason: string,
    }) },
  }));
}
