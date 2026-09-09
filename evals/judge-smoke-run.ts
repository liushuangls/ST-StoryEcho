import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { CALIBRATION_CONTROLS, calibrationCase, calibrationMismatches } from './calibration';
import { clientConfiguration, judgeOutputMode } from './config';
import { buildPromptEvalJudgePrompt, parsePromptEvalJudgement, PROMPT_EVAL_JUDGE_SYSTEM_PROMPT, scorePromptEvalJudgement } from './evaluator';
import { completeJudgeRequest, JudgeEvaluationError, redactEvalSecrets } from './judge-diagnostics';
import { singleJudgeResponseFormat } from './judge-schema';
import { measurePromptEvalText } from './measurements';
import { requestPromptEvalCompletion } from './openai-compatible-client';
import { pairwiseControls } from './pairwise-inputs';
import { evaluatePairwise } from './pairwise';
import { evalHash, PROMPT_EVAL_PROTOCOL_HASH } from './protocol';

async function main(): Promise<void> {
  const judge = clientConfiguration('JUDGE_', clientConfiguration(''));
  const outputMode = judgeOutputMode();
  const output = resolve(process.env['STORY_ECHO_EVAL_JUDGE_SMOKE_OUTPUT']?.trim() || 'evals/results/judge-smoke-latest.json');
  const result: Record<string, unknown> = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), judgeModel: judge.model, judgeOutputMode: outputMode,
    evaluationProtocolHash: PROMPT_EVAL_PROTOCOL_HASH,
    judgeConnectionHash: evalHash({ model: judge.model, baseUrl: judge.baseUrl, outputMode }),
    plannedRequests: 3, passed: false,
  };
  await mkdir(dirname(output), { recursive: true });
  const save = async (): Promise<void> => writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  // Previously problematic cases; passing this smoke test is not full calibration.
  const control = CALIBRATION_CONTROLS.find((item) => item.id === 'relationship-reference')!;
  const built = calibrationCase(control);
  const complete = (request: Parameters<typeof requestPromptEvalCompletion>[1]) => requestPromptEvalCompletion(judge, request);
  console.log(`Judge 协议冒烟：${judge.model} / ${outputMode}，最多 3 次请求。`);
  try {
    const { completion, judgement } = await completeJudgeRequest(complete, {
      system: PROMPT_EVAL_JUDGE_SYSTEM_PROMPT, prompt: buildPromptEvalJudgePrompt(built, control.candidate), maxTokens: 8_000,
      ...(outputMode === 'json_schema' ? { responseFormat: singleJudgeResponseFormat(built.rubric, control.candidate) } : {}),
    }, (text) => parsePromptEvalJudgement(text, built.rubric, control.candidate));
    const scores = scorePromptEvalJudgement(judgement, built.rubric, measurePromptEvalText(built, control.candidate));
    const mismatches = calibrationMismatches(control, judgement, scores);
    result['single'] = { id: control.id, judgement, scores, mismatches, finishReason: completion.finishReason, durationMs: completion.durationMs, totalTokens: completion.totalTokens };
    await save();
    console.log(`逐项评分：${scores.overall}，对照差异 ${mismatches.length}。`);
    if (mismatches.length) throw new Error('逐项冒烟未符合已知对照，停止后续请求。');
    const pair = pairwiseControls().find((item) => item.id === 'colony-reference-vs-omission')!;
    const row = await evaluatePairwise(pair, 1, complete, outputMode);
    result['pairwise'] = row;
    result['passed'] = row.matched === true;
    console.log(`A/B 冒烟：${row.outcome}，位置一致=${row.consistent}，符合对照=${row.matched}。`);
  } catch (error) {
    result['error'] = redactEvalSecrets(error instanceof Error ? error.message : String(error)).slice(0, 2_000);
    if (error instanceof JudgeEvaluationError) result['diagnostic'] = error.diagnostic;
    console.error(result['error']);
  }
  await save();
  console.log(`冒烟${result['passed'] ? '通过' : '未通过'}，结果：${output}`);
  if (!result['passed']) process.exitCode = 1;
}

void main().catch((error: unknown) => { console.error(redactEvalSecrets(error instanceof Error ? error.message : String(error))); process.exitCode = 1; });
