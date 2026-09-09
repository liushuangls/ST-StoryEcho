import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { clientConfiguration } from './config';
import { DEFAULT_CHAIN_CASE } from './default-chain-case';
import { runDefaultPromptEvalChain, type DefaultChainResult } from './default-chain';
import { requestPromptEvalCompletion } from './openai-compatible-client';

async function main(): Promise<void> {
  const generator = clientConfiguration('');
  const reader = clientConfiguration('JUDGE_', generator);
  const output = resolve(process.env['STORY_ECHO_EVAL_DEFAULT_CHAIN_OUTPUT']?.trim() || 'evals/results/default-chain-latest.json');
  const result = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), generatorModel: generator.model, readerModel: reader.model,
    selfReading: generator.model === reader.model, purpose: 'default-10-5-synthetic-chain-answerability',
    chain: null as DefaultChainResult | null,
  };
  await mkdir(dirname(output), { recursive: true });
  console.log(`默认 10/5 长链：${generator.model}，阅读器 ${reader.model}。61 L1 + 6 L2 + 1 L3 + 4 组探针，最多 72 次请求，无自动重试。`);
  const chain = await runDefaultPromptEvalChain(DEFAULT_CHAIN_CASE, (request, label) => requestPromptEvalCompletion(
    label.startsWith('probe-') ? reader : generator, request,
  ), async (partial, label) => {
    result.chain = partial;
    console.log(`${label}${label.startsWith('probe-') ? `: ${partial.probes.at(-1)?.score}` : ''}${partial.error ? `: ${partial.error}` : ''}`);
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  });
  console.log(`默认长链${chain.passed ? '通过' : '未通过'}。结果：${output}`);
  if (!chain.passed) process.exitCode = 1;
}

void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
