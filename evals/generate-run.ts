import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { EXTENSION_VERSION } from '../src/core/constants';
import { clientConfiguration } from './config';
import { generatePromptCandidates } from './generate';
import { redactEvalSecrets } from './judge-diagnostics';
import { requestPromptEvalCompletion } from './openai-compatible-client';
import { promptEvalVariant } from './variants';

async function main(): Promise<void> {
  const variant = promptEvalVariant(process.env['STORY_ECHO_EVAL_VARIANT']);
  const generator = clientConfiguration('');
  const ids = (process.env['STORY_ECHO_EVAL_CASES'] || '').split(',').map((id) => id.trim()).filter(Boolean);
  const output = resolve(process.env['STORY_ECHO_EVAL_OUTPUT']?.trim() || 'evals/results/generated-latest.json');
  const metadata = { schemaVersion: 1, storyEchoVersion: EXTENSION_VERSION, generatedAt: new Date().toISOString(), generatorModel: generator.model };
  await mkdir(dirname(output), { recursive: true });
  let printed = 0;
  console.log(`仅生成候选：${generator.model} / ${variant}，不调用 Judge、不输出质量分。`);
  const result = await generatePromptCandidates(ids, variant, (request) => requestPromptEvalCompletion(generator, request), async (progress) => {
    await writeFile(output, `${JSON.stringify({ ...metadata, ...progress }, null, 2)}\n`, 'utf8');
    for (const row of progress.cases.slice(printed)) console.log(`[${row.id}] ${row.error || `生成 ${row.outputCharacters} 字，尚未评审`}`);
    printed = progress.cases.length;
  });
  console.log(`生成${result.generationSucceeded ? '完成' : '未完成'}（不代表质量通过）：${output}`);
  if (!result.generationSucceeded) process.exitCode = 1;
}
void main().catch((error: unknown) => { console.error(redactEvalSecrets(error instanceof Error ? error.message : String(error))); process.exitCode = 1; });
