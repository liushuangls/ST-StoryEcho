import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { storyContent } from '../src/content/story-content';
import { buildStageSummaryPrompt } from '../src/summary/prompts';
import {
  STAGE_SUMMARY_PRE_STRUCTURE_SYSTEM_PROMPT, HISTORY_STRUCTURE_CANDIDATE_SYSTEM_PROMPT,
} from './history-structure-prompts';
import { PROMPT_EVAL_CHAIN_CASES } from './chain-cases';
import { clientConfiguration } from './config';
import { assertPromptEvalComplete } from './completion';
import { buildHistoryStructureProbe, historyStructureSchedule, scoreHistoryStructureProbe } from './history-structure';
import { JudgeEvaluationError, redactEvalSecrets } from './judge-diagnostics';
import { requestPromptEvalCompletion, type PromptEvalRequest } from './openai-compatible-client';
import { evalHash } from './protocol';

async function main(): Promise<void> {
  const generator = clientConfiguration('');
  // Require a separately configured reader; never fall back to the generator.
  for (const key of ['API_KEY', 'BASE_URL', 'MODEL']) {
    if (!process.env[`STORY_ECHO_EVAL_JUDGE_${key}`]?.trim()) throw new Error(`缺少独立阅读器配置：${key}`);
  }
  const reader = clientConfiguration('JUDGE_');
  const output = resolve(process.env['STORY_ECHO_EVAL_HISTORY_STRUCTURE_OUTPUT']?.trim()
    || `evals/results/history-structure-${new Date().toISOString().replace(/[:.]/gu, '-')}`);
  await mkdir(resolve('evals/results'), { recursive: true });
  await mkdir(output); // Refuse to overwrite any previous run.
  const fixtures = PROMPT_EVAL_CHAIN_CASES;
  const schedule = historyStructureSchedule(fixtures);
  const maximumRequests = fixtures.length + schedule.length * 2;
  const manifest = {
    purpose: 'L1 historical organization: downstream answerability, not readability',
    generatedAt: new Date().toISOString(), generatorModel: generator.model, readerModel: reader.model,
    generatorConnectionHash: evalHash([generator.baseUrl, generator.model]),
    readerConnectionHash: evalHash([reader.baseUrl, reader.model]),
    maximumRequests, schedule, fixtures, fixtureHash: evalHash(fixtures),
    controlSystem: STAGE_SUMMARY_PRE_STRUCTURE_SYSTEM_PROMPT,
    candidateSystem: HISTORY_STRUCTURE_CANDIDATE_SYSTEM_PROMPT,
    readerSystem: buildHistoryStructureProbe(fixtures[0]!, '').system,
    generationMaxTokens: 3_000, readerMaxTokens: 3_000, temperature: 0,
    retries: 0, maximumInFlight: 1,
    limitation: 'Existing synthetic fixtures; one L1 batch per full scene; no L2+ or actual continuation generation. Quote existence is not semantic validation.',
  };
  const saveNew = async (file: string, value: unknown): Promise<void> => {
    await writeFile(resolve(output, file), `${redactEvalSecrets(JSON.stringify(value, null, 2), [generator.baseUrl, reader.baseUrl])}\n`, { flag: 'wx' });
  };
  await saveNew('manifest.json', manifest); // Freeze everything before paid requests.
  const rows: unknown[] = [];
  let calls = 0;
  const complete = async (kind: 'generation' | 'reader', label: string, request: PromptEvalRequest) => {
    if (++calls > maximumRequests) throw new Error('超过冻结的请求上限。');
    const record = { index: calls, kind, label, startedAt: new Date().toISOString(), request, requestHash: evalHash(request) };
    console.log(`[${calls}/${maximumRequests}] start ${label}`);
    let response;
    try {
      response = await requestPromptEvalCompletion(kind === 'generation' ? generator : reader, request);
      assertPromptEvalComplete(response);
    } catch (error) {
      await saveNew(`request-${calls}.json`, { ...record, endedAt: new Date().toISOString(), ...(response ? { response } : {}),
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof JudgeEvaluationError ? { diagnostic: error.diagnostic } : {}),
      });
      throw error;
    }
    await saveNew(`request-${calls}.json`, { ...record, endedAt: new Date().toISOString(), response });
    console.log(`[${calls}/${maximumRequests}] done ${label} (${response.durationMs}ms)`);
    return response;
  };
  try {
    for (const fixture of fixtures) {
      const archive = fixture.batches.flat().map(storyContent).join('\n\n');
      const response = await complete('reader', `original-${fixture.id}`, buildHistoryStructureProbe(fixture, archive));
      const probe = scoreHistoryStructureProbe(fixture, archive, response.text);
      rows.push({ fixtureId: fixture.id, arm: 'original', probe });
      if (probe.correct !== probe.total) throw new Error('原文对照未全部答对，停止归因总结损失。');
    }
    for (const trial of schedule) {
      const fixture = fixtures.find((item) => item.id === trial.fixtureId)!;
      const messages = fixture.batches.flat();
      const label = `${fixture.id}-r${trial.round}-${trial.arm}`;
      const generation = await complete('generation', `generate-${label}`, {
        system: trial.arm === 'control' ? STAGE_SUMMARY_PRE_STRUCTURE_SYSTEM_PROMPT : HISTORY_STRUCTURE_CANDIDATE_SYSTEM_PROMPT,
        prompt: buildStageSummaryPrompt(messages, 0, fixture.identity, fixture.worldBackground),
        maxTokens: 3_000,
      });
      const response = await complete('reader', `read-${label}`, buildHistoryStructureProbe(fixture, generation.text));
      const probe = scoreHistoryStructureProbe(fixture, generation.text, response.text);
      const row = { ...trial, generatedSummary: generation.text, outputCharacters: Array.from(generation.text).length, generation, probe, reading: response };
      rows.push(row);
      await saveNew(`${label}.json`, row);
      console.log(`${label}: ${probe.correct}/${probe.total}`);
    }
    await saveNew('result.json', { completed: true, calls, maximumRequests, rows, qualityConclusion: 'pending-source-and-quote-review' });
    console.log(`Completed; manual review still required: ${output}`);
  } catch (error) {
    await saveNew('result.json', { completed: false, calls, maximumRequests, rows, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

void main().catch((error: unknown) => {
  console.error(redactEvalSecrets(error instanceof Error ? error.message : String(error), [
    process.env['STORY_ECHO_EVAL_BASE_URL'] || '', process.env['STORY_ECHO_EVAL_JUDGE_BASE_URL'] || '',
  ].filter(Boolean)));
  process.exitCode = 1;
});
