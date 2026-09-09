import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { EXTENSION_VERSION } from '../src/core/constants';
import { clientConfiguration } from './config';
import { redactEvalSecrets } from './judge-diagnostics';
import { requestPromptEvalCompletion } from './openai-compatible-client';
import { prepareSourceRevision, reviseSourceDrafts } from './source-revision';

async function main(): Promise<void> {
  const raw: unknown = JSON.parse(process.env['STORY_ECHO_EVAL_REVISION_INPUTS'] || 'null');
  if (!Array.isArray(raw) || !raw.length || raw.length > 4 || raw.some((path) => typeof path !== 'string' || !path.trim())) {
    throw new Error('STORY_ECHO_EVAL_REVISION_INPUTS 必须是 1–4 个保存结果路径的 JSON 数组。');
  }
  const paths = (raw as string[]).map((path) => resolve(path));
  if (new Set(paths).size !== paths.length || new Set(paths.map((path) => basename(path))).size !== paths.length) {
    throw new Error('核验输入路径或文件名重复。');
  }
  const batches = [];
  for (const path of paths) {
    if ((await stat(path)).size > 16 * 1024 * 1024) throw new Error('核验输入文件超过 16 MiB 上限。');
    batches.push(prepareSourceRevision(JSON.parse(await readFile(path, 'utf8'))));
  }
  const count = batches.reduce((sum, batch) => sum + batch.inputs.length, 0);
  if (count > 28) throw new Error('单轮核验最多 28 次请求。');
  if (new Set(batches.map((batch) => batch.parentRunHash)).size !== batches.length) throw new Error('同一输入结果被重复提供。');
  const client = clientConfiguration('');
  const output = resolve(process.env['STORY_ECHO_EVAL_REVISION_OUTPUT_DIR']?.trim() || 'evals/results/source-revision');
  await mkdir(dirname(output), { recursive: true });
  // Reserve a fresh directory atomically. An existing directory is never reused,
  // even if it contains only an interrupted run; this prevents silent overwrite.
  await mkdir(output);
  console.log(`本地来源核验：${client.model}，${count} 稿，每稿一次，不调用 Judge。`);
  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index]!;
    const name = basename(paths[index]!);
    const metadata = { schemaVersion: 1, storyEchoVersion: EXTENSION_VERSION, generatedAt: new Date().toISOString(),
      generatorModel: client.model, selfRevision: batch.originalGeneratorModel.toLowerCase() === client.model.toLowerCase() };
    let printed = 0;
    const result = await reviseSourceDrafts(batch, (request) => requestPromptEvalCompletion(client, request), async (progress) => {
      await writeFile(join(output, name), `${JSON.stringify({ ...metadata, ...progress }, null, 2)}\n`, 'utf8');
      for (const row of progress.cases.slice(printed)) console.log(`[${name}/${row.id}] ${row.error || `${row.outputCharacters} 字，${row.changed ? '正文有修改' : '原样返回'}，未评审`}`);
      printed = progress.cases.length;
    });
    if (!result.generationSucceeded) { process.exitCode = 1; break; }
  }
  console.log(`结果目录：${output}；请求完成不代表核验质量通过。`);
}

void main().catch((error: unknown) => { console.error(redactEvalSecrets(error instanceof Error ? error.message : String(error))); process.exitCode = 1; });
