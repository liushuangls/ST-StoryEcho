import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { clientConfiguration } from './config';
import { completionDiagnostic, completeJudgeRequest, JudgeEvaluationError, redactEvalSecrets } from './judge-diagnostics';
import { inputReceiptRequest, inspectInputReceipt } from './judge-input-receipt';
import { requestPromptEvalCompletion } from './openai-compatible-client';
import { pairwiseControls } from './pairwise-inputs';
import { evalHash } from './protocol';

async function main(): Promise<void> {
  const judge = clientConfiguration('JUDGE_', clientConfiguration(''));
  const inputs = pairwiseControls().filter((input) => ['custody-reference-identity', 'colony-reference-identity'].includes(input.id));
  const output = resolve(process.env['STORY_ECHO_EVAL_JUDGE_RECEIPT_OUTPUT']?.trim() || 'evals/results/judge-receipt-latest.json');
  const result = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), judgeModel: judge.model,
    judgeConnectionHash: evalHash({ model: judge.model, baseUrl: judge.baseUrl, outputMode: 'json_schema' }),
    plannedRequests: 2, mode: 'literal-input-receipt-not-quality-scoring',
    cases: [] as Record<string, unknown>[], completed: false, passed: false,
  };
  await mkdir(dirname(output), { recursive: true });
  const save = async (): Promise<void> => writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(`输入回显诊断：${judge.model}，固定 2 次串行请求，不评分、不重试。`);
  for (const input of inputs) {
    const request = inputReceiptRequest(input);
    const row: Record<string, unknown> = { id: input.id, promptHash: evalHash(request.prompt), passed: false };
    try {
      const { completion, judgement: inspection } = await completeJudgeRequest((value) => requestPromptEvalCompletion(judge, value), request, (text) => inspectInputReceipt(text, input));
      row['inspection'] = inspection;
      row['passed'] = inspection.passed;
      row['diagnostic'] = completionDiagnostic(completion);
      console.log(`[${input.id}] 原样回显=${inspection.passed}，${JSON.stringify(inspection.candidates)}`);
    } catch (error) {
      row['error'] = redactEvalSecrets(error instanceof Error ? error.message : String(error)).slice(0, 2_000);
      if (error instanceof JudgeEvaluationError) row['diagnostic'] = error.diagnostic;
      console.error(`[${input.id}] ${row['error']}`);
    }
    result.cases.push(row);
    await save();
  }
  result.completed = result.cases.length === result.plannedRequests;
  result.passed = result.completed && result.cases.every((row) => row['passed']);
  await save();
  console.log(`回显诊断${result.passed ? '通过' : '未通过'}。结果：${output}`);
  if (!result.passed) process.exitCode = 1;
}

void main().catch((error: unknown) => { console.error(redactEvalSecrets(error instanceof Error ? error.message : String(error))); process.exitCode = 1; });
