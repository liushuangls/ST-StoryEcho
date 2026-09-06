import type { BuiltPromptEvalCase } from './types';

export const PROMPT_EVAL_COMPRESSION_METRIC = 'story-body-codepoints-v1';

export function assertCompatibleCompressionMetric(value: unknown): void {
  if (value !== PROMPT_EVAL_COMPRESSION_METRIC) {
    throw new Error('评测基线使用旧版或不同的压缩率口径，不能直接比较；请使用新路径重新建立正文口径基线。');
  }
}

export function measurePromptEvalText(testCase: BuiltPromptEvalCase, output: string) {
  const sourceCharacters = testCase.sourceCharacters;
  const outputCharacters = Array.from(output).length;
  return {
    sourceCharacters,
    sourceEvidenceCharacters: Array.from(testCase.sourceEvidence).length,
    requestCharacters: Array.from(`${testCase.system}\n${testCase.prompt}`).length,
    outputCharacters,
    compressionRatio: Math.round(outputCharacters / Math.max(1, sourceCharacters) * 1000) / 1000,
  };
}
