import type {
  PromptEvalHardCheck,
  PromptEvalHardCheckResult,
} from './types';

function normalized(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/gu, '');
}

export function evaluatePromptEvalHardChecks(
  output: string,
  checks: readonly PromptEvalHardCheck[] = [],
): PromptEvalHardCheckResult[] {
  const haystack = normalized(output);
  return checks.map((check) => {
    const matched = check.needles.filter((needle) => haystack.includes(normalized(needle)));
    const missing = check.needles.filter((needle) => !matched.includes(needle));
    const passed = check.mode === 'all'
      ? missing.length === 0
      : check.mode === 'any'
        ? matched.length > 0
        : matched.length === 0;
    return { ...check, passed, matched, missing };
  });
}

export function promptEvalHardChecksPassed(
  results: readonly PromptEvalHardCheckResult[],
): boolean {
  return results.every((result) => result.passed);
}
