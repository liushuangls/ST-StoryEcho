import { PROMPT_EVAL_CASES } from './cases';
import { PROMPT_VALIDATION_CASES } from './validation-cases';
import { L1_AUDIT_CASES } from './l1-audit-cases';
import { L1_NATURAL_VALIDATION_CASES } from './l1-natural-validation-cases';
import type { PromptEvalCase } from './types';

const catalog: readonly PromptEvalCase[] = [
  ...PROMPT_EVAL_CASES,
  ...PROMPT_VALIDATION_CASES,
  ...L1_AUDIT_CASES,
  ...L1_NATURAL_VALIDATION_CASES,
];
if (new Set(catalog.map((row) => row.id)).size !== catalog.length) throw new Error('本地评测目录有重复 ID。');

export function findSavedRunCase(id: string): PromptEvalCase | undefined {
  return catalog.find((row) => row.id === id);
}

/** Keep the default paid workload at 12; validation/audit stories require explicit IDs. */
export function selectGenerationCases(ids: readonly string[]): readonly PromptEvalCase[] {
  if (new Set(ids).size !== ids.length || ids.some((id) => !findSavedRunCase(id))) {
    throw new Error('生成用例包含未知或重复 ID。');
  }
  return ids.length ? catalog.filter((row) => ids.includes(row.id)) : PROMPT_EVAL_CASES;
}
