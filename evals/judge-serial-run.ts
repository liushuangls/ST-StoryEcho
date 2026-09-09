import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { clientConfiguration, judgeOutputMode } from './config';
import { requestPromptEvalCompletion } from './openai-compatible-client';
import { runSerialIdentityProbe } from './judge-serial';
import { evalHash } from './protocol';
import { redactEvalSecrets } from './judge-diagnostics';

async function main(): Promise<void> {
  const judge = clientConfiguration('JUDGE_', clientConfiguration(''));
  const outputMode = judgeOutputMode();
  const output = resolve(process.env['STORY_ECHO_EVAL_JUDGE_SERIAL_OUTPUT']?.trim() || 'evals/results/judge-serial-latest.json');
  const identity = { judgeModel: judge.model, judgeConnectionHash: evalHash({ model: judge.model, baseUrl: judge.baseUrl, outputMode }) };
  await mkdir(dirname(output), { recursive: true });
  let printedRequests = 0;
  let printedPairs = 0;
  console.log(`串行同文诊断：${judge.model} / ${outputMode}，固定 12 次请求；请勿同时启动其他评测进程。`);
  const result = await runSerialIdentityProbe((request) => requestPromptEvalCompletion(judge, request), outputMode, async (progress) => {
    // Await disk persistence as well as the request before starting the next request.
    await writeFile(output, `${JSON.stringify({ ...identity, ...progress }, null, 2)}\n`, 'utf8');
    for (const row of progress.requests.slice(printedRequests)) {
      const transport = row.diagnostic?.transport;
      console.log(`[${row.sequence}/12] ${row.caseId} #${row.repetition}: HTTP ${transport?.httpStatus ?? '未知'}，返回模型 ${transport?.returnedModel ?? '未提供'}，请求 ID ${transport?.serverRequestId ? '已记录' : '未提供'}`);
    }
    printedRequests = progress.requests.length;
    for (const pair of progress.pairs.slice(printedPairs)) console.log(`[PAIR] ${pair.id} #${pair.repetition}: ${pair.outcome}，符合同文对照=${pair.matched}`);
    printedPairs = progress.pairs.length;
  });
  console.log(`串行诊断${result.passed ? '通过（不等于完整质量校准）' : '未通过'}：${JSON.stringify(result.aggregate)}。结果：${output}`);
  if (!result.passed) process.exitCode = 1;
}

void main().catch((error: unknown) => { console.error(redactEvalSecrets(error instanceof Error ? error.message : String(error))); process.exitCode = 1; });
