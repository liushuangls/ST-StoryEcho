import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { clientConfiguration } from './config';
import { PROMPT_EVAL_CHAIN_CASES } from './chain-cases';
import { runPromptEvalChain, type ChainResult } from './chains';
import { requestPromptEvalCompletion } from './openai-compatible-client';

async function main(): Promise<void> {
  const generator = clientConfiguration('');
  const reader = clientConfiguration('JUDGE_', generator);
  const output = resolve(process.env['STORY_ECHO_EVAL_CHAIN_OUTPUT']?.trim() || 'evals/results/chains-latest.json');
  const result = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), generatorModel: generator.model, readerModel: reader.model,
    selfReading: generator.model === reader.model,
    purpose: 'synthetic-chain-answerability-not-semantic-judge-score',
    cases: [] as ChainResult[], completed: false, passed: false,
  };
  await mkdir(dirname(output), { recursive: true });
  const save = async (): Promise<void> => writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(`链式回归：${generator.model}，阅读器 ${reader.model}。2 个合成场景，测试合并数 2/2，最多 22 次请求，无自动重试。`);
  for (const fixture of PROMPT_EVAL_CHAIN_CASES) {
    await runPromptEvalChain(fixture, (request, label) => requestPromptEvalCompletion(
      label.startsWith('probe-') ? reader : generator, request,
    ), async (partial, label) => {
      const index = result.cases.findIndex((item) => item.id === partial.id);
      if (index < 0) result.cases.push(partial); else result.cases[index] = partial;
      console.log(`[${fixture.id}] ${label}${label.startsWith('probe-') ? `: ${partial.probes.at(-1)?.score}` : ''}${partial.error ? `: ${partial.error}` : ''}`);
      await save();
    });
  }
  result.completed = true;
  result.passed = result.cases.every((item) => item.passed);
  await save();
  console.log(`链式探针${result.passed ? '全部通过' : '存在失败或缺失'}。结果：${output}`);
  if (!result.passed) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
