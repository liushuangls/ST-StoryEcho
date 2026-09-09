import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { EXTENSION_VERSION } from '../src/core/constants';
import { clientConfiguration } from './config';
import { redactEvalSecrets } from './judge-diagnostics';
import { requestPromptEvalCompletion } from './openai-compatible-client';
import { localizeSources, SOURCE_LOCALIZATION_PROTOCOL_HASH } from './source-localization';
import { LOCALIZATION_ARCHIVES, localizationCasesFromArchives, type LocalizationArchive } from './source-localization-cases';

async function main(): Promise<void> {
  const inputDir = resolve(process.env['STORY_ECHO_EVAL_LOCALIZATION_INPUT_DIR']?.trim() || 'evals/results/source-revision-gpt-20260907');
  const values = {} as Record<LocalizationArchive, unknown>;
  for (const name of Object.keys(LOCALIZATION_ARCHIVES) as LocalizationArchive[]) {
    const path = join(inputDir, `contract-only-${name}.json`);
    if ((await stat(path)).size > 16 * 1024 * 1024) throw new Error('定位输入文件超过 16 MiB 上限。');
    values[name] = JSON.parse(await readFile(path, 'utf8'));
  }
  const inputs = localizationCasesFromArchives(values);
  // Explicit configured connection only: no generator-key/model/host fallback.
  for (const suffix of ['MODEL', 'BASE_URL', 'API_KEY']) {
    if (!process.env[`STORY_ECHO_EVAL_JUDGE_${suffix}`]?.trim()) throw new Error(`缺少 STORY_ECHO_EVAL_JUDGE_${suffix}。`);
  }
  const client = clientConfiguration('JUDGE_');
  if (client.model !== 'gpt-5.6-sol') throw new Error('本轮冻结模型为 gpt-5.6-sol，拒绝静默换模型。');
  client.timeoutMs = 300_000;
  const output = resolve(process.env['STORY_ECHO_EVAL_LOCALIZATION_OUTPUT_DIR']?.trim() || 'evals/results/source-localization');
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  const metadata = { schemaVersion: 1, storyEchoVersion: EXTENSION_VERSION, generatedAt: new Date().toISOString(),
    diagnosticModel: client.model, summaryRevision: false, timeoutMs: client.timeoutMs, outputMode: 'json-in-text' };
  console.log(`本地错误定位：${client.model}，${inputs.length} 稿各两次，最多 ${inputs.length * 2} 次请求，不改写。协议 ${SOURCE_LOCALIZATION_PROTOCOL_HASH}`);
  let printed = 0;
  const result = await localizeSources(inputs, (request) => requestPromptEvalCompletion(client, request), async (progress) => {
    await writeFile(join(output, 'localization.json'), `${JSON.stringify({ ...metadata, ...progress }, null, 2)}\n`, 'utf8');
    for (const row of progress.rows.slice(printed)) console.log(`[${row.id}/r${row.repeat}] ${row.error || `${row.issues?.length ?? 0} 条报告，语义待核查`}`);
    printed = progress.rows.length;
  });
  if (!result.protocolValid) process.exitCode = 1;
  console.log(`结果目录：${output}；协议有效不代表检出或误报验收通过。`);
}

void main().catch((error: unknown) => { console.error(redactEvalSecrets(error instanceof Error ? error.message : String(error))); process.exitCode = 1; });
