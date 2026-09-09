import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { clientConfiguration, judgeOutputMode } from './config';
import { requestPromptEvalCompletion } from './openai-compatible-client';
import { runJudgeLayoutProbe } from './judge-layout';
import { evalHash } from './protocol';
import { redactEvalSecrets } from './judge-diagnostics';

async function main(): Promise<void> {
  const judge = clientConfiguration('JUDGE_', clientConfiguration(''));
  const outputMode = judgeOutputMode();
  const output = resolve(process.env['STORY_ECHO_EVAL_JUDGE_LAYOUT_OUTPUT']?.trim() || 'evals/results/judge-layout-latest.json');
  const identity = { judgeModel: judge.model, judgeConnectionHash: evalHash({ model: judge.model, baseUrl: judge.baseUrl, outputMode }) };
  await mkdir(dirname(output), { recursive: true });
  let printedRequests = 0;
  let printedPairs = 0;
  console.log(`Judge 输入布局实验：${judge.model} / ${outputMode}，先串行 12 次同文请求；新布局全过后再增加 6 次遗漏对照，不重试。`);
  const result = await runJudgeLayoutProbe((request) => requestPromptEvalCompletion(judge, request), outputMode, async (progress) => {
    await writeFile(output, `${JSON.stringify({ ...identity, ...progress }, null, 2)}\n`, 'utf8');
    for (const row of progress.requests.slice(printedRequests)) console.log(`[${row.sequence}/${progress.plannedRequests}] ${row.caseId} / ${row.layout}：已记录响应${row.error ? '错误' : ''}`);
    printedRequests = progress.requests.length;
    for (const pair of progress.pairs.slice(printedPairs)) console.log(`[PAIR] ${pair.id} / ${pair.layout}：${pair.outcome}，符合对照=${pair.matched}`);
    printedPairs = progress.pairs.length;
  });
  console.log(`布局实验${result.passed ? '通过小样本筛查（不等于完整校准）' : '未通过'}：${JSON.stringify(result.aggregate)}。结果：${output}`);
  if (!result.passed) process.exitCode = 1;
}

void main().catch((error: unknown) => { console.error(redactEvalSecrets(error instanceof Error ? error.message : String(error))); process.exitCode = 1; });
