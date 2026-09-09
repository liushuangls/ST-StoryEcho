import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { CALIBRATION_CONTROLS, calibrationCase, calibrationMismatches } from './calibration';
import { clientConfiguration, judgeOutputMode, positiveIntegerEnvironment } from './config';
import { buildPromptEvalJudgePrompt, parsePromptEvalJudgement, PROMPT_EVAL_JUDGE_SYSTEM_PROMPT, scorePromptEvalJudgement } from './evaluator';
import { measurePromptEvalText } from './measurements';
import { requestPromptEvalCompletion } from './openai-compatible-client';
import { evalHash, PROMPT_EVAL_PROTOCOL_HASH } from './protocol';
import type { PromptEvalJudgement, PromptEvalScores } from './types';
import { singleJudgeResponseFormat } from './judge-schema';
import { completeJudgeRequest, completionDiagnostic, JudgeEvaluationError, redactEvalSecrets, type JudgeFailureDiagnostic } from './judge-diagnostics';

interface ControlResult {
  id: string;
  repetition: number;
  caseId: string;
  expectedPass: boolean;
  candidate: string;
  judgement?: PromptEvalJudgement;
  scores?: PromptEvalScores;
  error?: string;
  diagnostic?: JudgeFailureDiagnostic;
  mismatches: string[];
  durationMs?: number;
  totalTokens?: number;
}

async function main(): Promise<void> {
  const generator = clientConfiguration('');
  const judge = clientConfiguration('JUDGE_', generator);
  const outputMode = judgeOutputMode();
  const repetitions = positiveIntegerEnvironment('STORY_ECHO_EVAL_CALIBRATION_REPEATS', 2);
  if (repetitions > 5) throw new Error('校准最多重复 5 次，避免意外产生大量请求。');
  const output = resolve(process.env['STORY_ECHO_EVAL_CALIBRATION_OUTPUT']?.trim() || 'evals/results/calibration-latest.json');
  const result = {
    schemaVersion: 2,
    evaluationProtocolHash: PROMPT_EVAL_PROTOCOL_HASH,
    controlsHash: evalHash(CALIBRATION_CONTROLS),
    generatedAt: new Date().toISOString(),
    judgeModel: judge.model,
    judgeOutputMode: outputMode,
    judgeConnectionHash: evalHash({ model: judge.model, baseUrl: judge.baseUrl, outputMode }),
    labelSource: 'developer-authored-synthetic-not-human-gold',
    plannedRequests: repetitions * CALIBRATION_CONTROLS.length,
    repetitions,
    completed: false,
    classificationPassed: false,
    passed: false,
    cases: [] as ControlResult[],
    scoreGaps: [] as { caseId: string; repetition: number; referenceMinusBestNegative: number }[],
    aggregate: {} as Record<string, number>,
  };
  await mkdir(dirname(output), { recursive: true });
  const save = async (): Promise<void> => writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(`Judge 校准：${judge.model}，${result.plannedRequests} 次请求。候选均为开发者编写的对照，不调用生成模型，不把预期标签发给 Judge。`);
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    // Reverse the order in the second run; each request remains stateless and blind.
    const controls = repetition % 2 === 0 ? [...CALIBRATION_CONTROLS].reverse() : CALIBRATION_CONTROLS;
    for (const control of controls) {
      const built = calibrationCase(control);
      const row: ControlResult = {
        id: control.id, caseId: control.caseId, repetition,
        expectedPass: control.expectedPass, candidate: control.candidate, mismatches: [],
      };
      try {
        const { completion, judgement } = await completeJudgeRequest((request) => requestPromptEvalCompletion(judge, request), {
          system: PROMPT_EVAL_JUDGE_SYSTEM_PROMPT,
          prompt: buildPromptEvalJudgePrompt(built, control.candidate),
          maxTokens: 8_000,
          ...(outputMode === 'json_schema' ? { responseFormat: singleJudgeResponseFormat(built.rubric, control.candidate) } : {}),
        }, (text) => parsePromptEvalJudgement(text, built.rubric, control.candidate));
        row.durationMs = completion.durationMs;
        if (completion.totalTokens !== undefined) row.totalTokens = completion.totalTokens;
        row.judgement = judgement;
        row.scores = scorePromptEvalJudgement(row.judgement, built.rubric, measurePromptEvalText(built, control.candidate));
        row.mismatches = calibrationMismatches(control, row.judgement, row.scores);
        if (row.mismatches.length) row.diagnostic = completionDiagnostic(completion);
        console.log(`[${row.mismatches.length ? 'MISMATCH' : 'OK'}] ${control.id} #${repetition}: ${row.scores.overall}，判定 ${row.scores.passed ? '通过' : '不通过'}`);
      } catch (error) {
        row.error = redactEvalSecrets(error instanceof Error ? error.message : String(error)).slice(0, 2_000);
        if (error instanceof JudgeEvaluationError) row.diagnostic = error.diagnostic;
        console.error(`[ERROR] ${control.id} #${repetition}: ${row.error}`);
      }
      result.cases.push(row);
      await save();
    }
  }
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    for (const reference of CALIBRATION_CONTROLS.filter((item) => item.expectedPass)) {
      const group = result.cases.filter((item) => item.repetition === repetition && item.caseId === reference.caseId);
      const good = group.find((item) => item.expectedPass)?.scores;
      const bad = group.filter((item) => !item.expectedPass).flatMap((item) => item.scores ? [item.scores.overall] : []);
      if (good && bad.length === 3) result.scoreGaps.push({
        caseId: reference.caseId, repetition,
        referenceMinusBestNegative: Math.round((good.overall - Math.max(...bad)) * 10) / 10,
      });
    }
  }
  const scored = result.cases.filter((item) => item.scores);
  result.aggregate = {
    requests: result.cases.length,
    judgeErrors: result.cases.filter((item) => item.error).length,
    matchingControls: scored.filter((item) => item.mismatches.length === 0).length,
    falsePasses: scored.filter((item) => !item.expectedPass && item.scores!.passed).length,
    falseFailures: scored.filter((item) => item.expectedPass && !item.scores!.passed).length,
    minimumScoreGap: result.scoreGaps.length ? Math.min(...result.scoreGaps.map((item) => item.referenceMinusBestNegative)) : 0,
    maximumRepeatedScoreSpread: Math.max(0, ...CALIBRATION_CONTROLS.map((control) => {
      const values = scored.filter((item) => item.id === control.id).map((item) => item.scores!.overall);
      return values.length ? Math.round((Math.max(...values) - Math.min(...values)) * 10) / 10 : 0;
    })),
  };
  result.completed = true;
  result.classificationPassed = result.aggregate['matchingControls'] === result.plannedRequests
    && result.scoreGaps.length === repetitions * 3
    && result.aggregate['minimumScoreGap']! >= 10;
  result.passed = result.classificationPassed && repetitions >= 2
    && result.aggregate['maximumRepeatedScoreSpread']! <= 10;
  await save();
  console.log(`校准${result.passed ? '通过' : '未通过'}：${JSON.stringify(result.aggregate)}。结果：${output}`);
  if (!result.passed) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
