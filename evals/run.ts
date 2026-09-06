import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { EXTENSION_VERSION } from '../src/core/constants';
import {
  buildPromptEvalCase,
  PROMPT_EVAL_CASES,
} from './cases';
import {
  buildPromptEvalJudgePrompt,
  parsePromptEvalJudgement,
  PROMPT_EVAL_JUDGE_SYSTEM_PROMPT,
  scorePromptEvalJudgement,
} from './evaluator';
import {
  requestPromptEvalCompletion,
  type PromptEvalCompletion,
} from './openai-compatible-client';
import type {
  PromptEvalJudgement,
  PromptEvalKind,
  PromptEvalScores,
} from './types';
import {
  assertCompatibleCompressionMetric,
  measurePromptEvalText,
  PROMPT_EVAL_COMPRESSION_METRIC,
} from './measurements';
import { clientConfiguration } from './config';
import { assertCompatibleEvaluationProtocol, caseEvaluationHash, evalHash, PROMPT_EVAL_PROTOCOL_HASH } from './protocol';
import { assertPromptEvalComplete, isPromptEvalTruncated } from './completion';

const RESULT_SCHEMA_VERSION = 4;

interface StoredCompletion {
  finishReason: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  durationMs: number;
  responseCharacters: number;
}

interface PromptEvalCaseResult {
  id: string;
  name: string;
  kind: PromptEvalKind;
  promptHash: string;
  evaluationHash: string;
  passed: boolean;
  outputTruncated: boolean;
  sourceCharacters: number;
  sourceEvidenceCharacters: number;
  requestCharacters: number;
  outputCharacters: number;
  compressionRatio: number;
  idealCompressionRatio?: { min: number; max: number };
  generatedSummary?: string;
  generation?: StoredCompletion;
  judge?: StoredCompletion;
  judgement?: PromptEvalJudgement;
  scores?: PromptEvalScores;
  baselineRegression?: string;
  error?: string;
}

interface PromptEvalRunResult {
  schemaVersion: number;
  compressionMetric: typeof PROMPT_EVAL_COMPRESSION_METRIC;
  evaluationProtocolHash: string;
  storyEchoVersion: string;
  generatedAt: string;
  generatorModel: string;
  judgeModel: string;
  judgeConnectionHash: string;
  selfJudging: boolean;
  caseFilter: string[];
  cases: PromptEvalCaseResult[];
  aggregate?: PromptEvalAggregate;
  passed: boolean;
}

interface PromptEvalAggregate {
  totalCases: number;
  scoredCases: number;
  passedCases: number;
  errorCases: number;
  factRetention: number;
  causalContinuity: number;
  uncertaintyPrecision: number;
  focusAndUsability: number;
  forbiddenClaimSafety: number;
  compressionEfficiency: number | null;
  errorPenalty: number;
  overall: number;
}

interface BaselineCase {
  id: string;
  evaluationHash: string;
  passed: boolean;
  scores?: PromptEvalScores;
}

interface BaselineRun {
  generatorModel?: string;
  judgeModel?: string;
  judgeConnectionHash: string;
  cases: BaselineCase[];
}

function baselineScores(value: unknown): PromptEvalScores | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const score = (name: string): number | undefined => {
    const candidate = record[name];
    return typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0 && candidate <= 100
      ? candidate
      : undefined;
  };
  const factRetention = score('factRetention');
  const causalContinuity = score('causalContinuity');
  const uncertaintyPrecision = score('uncertaintyPrecision');
  const focusAndUsability = score('focusAndUsability');
  const forbiddenClaimSafety = score('forbiddenClaimSafety');
  const compressionEfficiency = record['compressionEfficiency'] === null ? null : score('compressionEfficiency');
  const errorPenalty = score('errorPenalty');
  const overall = score('overall');
  if (
    factRetention === undefined ||
    causalContinuity === undefined ||
    uncertaintyPrecision === undefined ||
    focusAndUsability === undefined ||
    forbiddenClaimSafety === undefined ||
    compressionEfficiency === undefined ||
    errorPenalty === undefined ||
    overall === undefined
  ) {
    return undefined;
  }
  return {
    factRetention,
    causalContinuity,
    uncertaintyPrecision,
    focusAndUsability,
    forbiddenClaimSafety,
    compressionEfficiency,
    errorPenalty,
    overall,
    passed: record['passed'] === true,
  };
}

function nonNegativeNumberEnvironment(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`环境变量 ${name} 必须是非负数。`);
  }
  return value;
}

function selectedCaseIds(): string[] {
  return (process.env['STORY_ECHO_EVAL_CASES'] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function storedCompletion(completion: PromptEvalCompletion): StoredCompletion {
  return {
    finishReason: completion.finishReason,
    ...(completion.promptTokens !== undefined ? { promptTokens: completion.promptTokens } : {}),
    ...(completion.completionTokens !== undefined
      ? { completionTokens: completion.completionTokens }
      : {}),
    ...(completion.totalTokens !== undefined ? { totalTokens: completion.totalTokens } : {}),
    durationMs: completion.durationMs,
    responseCharacters: Array.from(completion.text).length,
  };
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 2_000);
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
}

function promptHash(system: string, prompt: string): string {
  return createHash('sha256')
    .update(system)
    .update('\n\u0000\n')
    .update(prompt)
    .digest('hex');
}

async function loadBaseline(path: string): Promise<BaselineRun> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { cases?: unknown }).cases)
  ) {
    throw new Error('评测基线文件格式无效。');
  }
  const record = parsed as Record<string, unknown>;
  assertCompatibleCompressionMetric(record['compressionMetric']);
  assertCompatibleEvaluationProtocol(record['evaluationProtocolHash']);
  return {
    judgeConnectionHash: String(record['judgeConnectionHash'] ?? ''),
    ...(typeof record['generatorModel'] === 'string'
      ? { generatorModel: record['generatorModel'] }
      : {}),
    ...(typeof record['judgeModel'] === 'string'
      ? { judgeModel: record['judgeModel'] }
      : {}),
    cases: (record['cases'] as unknown[]).flatMap((candidate): BaselineCase[] => {
      if (
        typeof candidate !== 'object' ||
        candidate === null ||
        typeof (candidate as Record<string, unknown>)['id'] !== 'string'
      ) {
        return [];
      }
      const item = candidate as Record<string, unknown>;
      const scores = baselineScores(item['scores']);
      return [{
        id: item['id'] as string,
        evaluationHash: String(item['evaluationHash'] ?? ''),
        passed: item['passed'] === true,
        ...(scores ? { scores } : {}),
      }];
    }),
  };
}

function applyBaseline(
  result: PromptEvalRunResult,
  baseline: BaselineRun,
  maximumRegression: number,
): void {
  const baselineById = new Map(baseline.cases.map((item) => [item.id, item]));
  for (const current of result.cases) {
    const prior = baselineById.get(current.id);
    if (!prior || !current.scores || !prior.scores) {
      continue;
    }
    const scoreDrop = prior.scores.overall - current.scores.overall;
    if ((prior.passed && !current.passed) || scoreDrop > maximumRegression) {
      current.baselineRegression = prior.passed && !current.passed
        ? '基线通过但本次失败。'
        : `综合分较基线下降 ${Math.round(scoreDrop * 10) / 10} 分。`;
      current.passed = false;
    }
  }
  result.passed = result.cases.every((item) => item.passed);
}

function safeModelName(model: string): string {
  return model.replace(/[^a-z0-9._-]+/giu, '-').replace(/^-+|-+$/gu, '') || 'model';
}

function printCaseResult(result: PromptEvalCaseResult): void {
  if (result.error) {
    console.error(`[ERROR] ${result.id}: ${result.error}`);
    return;
  }
  const scores = result.scores!;
  const status = result.passed ? 'PASS' : 'FAIL';
  const truncation = result.outputTruncated ? '，输出截断' : '';
  const regression = result.baselineRegression ? `，${result.baselineRegression}` : '';
  console.log(
    `[${status}] ${result.id}: 综合 ${scores.overall}，事实 ${scores.factRetention}，因果 ${scores.causalContinuity}，不确定性 ${scores.uncertaintyPrecision}，聚焦 ${scores.focusAndUsability}，安全 ${scores.forbiddenClaimSafety}，密度参考 ${scores.compressionEfficiency ?? '未标定'}，错误扣分 ${scores.errorPenalty}，压缩比 ${result.compressionRatio}${truncation}${regression}`,
  );
  if (!result.passed && result.judgement) {
    for (const item of result.judgement.hallucinations) {
      console.error(`  幻觉（${item.severity}）：${item.reason}；片段：${item.evidence}`);
    }
    for (const item of result.judgement.chronologyErrors) {
      console.error(`  时序错误（${item.severity}）：${item.reason}；片段：${item.evidence}`);
    }
  }
}

function roundedAverage(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

function aggregateResults(cases: readonly PromptEvalCaseResult[]): PromptEvalAggregate {
  const scored = cases.filter((item): item is PromptEvalCaseResult & { scores: PromptEvalScores } => (
    item.scores !== undefined
  ));
  return {
    totalCases: cases.length,
    scoredCases: scored.length,
    passedCases: cases.filter((item) => item.passed).length,
    errorCases: cases.filter((item) => item.error !== undefined).length,
    factRetention: roundedAverage(scored.map((item) => item.scores.factRetention)),
    causalContinuity: roundedAverage(scored.map((item) => item.scores.causalContinuity)),
    uncertaintyPrecision: roundedAverage(scored.map((item) => item.scores.uncertaintyPrecision)),
    focusAndUsability: roundedAverage(scored.map((item) => item.scores.focusAndUsability)),
    forbiddenClaimSafety: roundedAverage(scored.map((item) => item.scores.forbiddenClaimSafety)),
    compressionEfficiency: scored.some((item) => item.scores.compressionEfficiency !== null)
      ? roundedAverage(scored.flatMap((item) => item.scores.compressionEfficiency === null ? [] : [item.scores.compressionEfficiency]))
      : null,
    errorPenalty: roundedAverage(scored.map((item) => item.scores.errorPenalty)),
    overall: roundedAverage(scored.map((item) => item.scores.overall)),
  };
}

async function main(): Promise<void> {
  const generator = clientConfiguration('');
  const judge = clientConfiguration('JUDGE_', generator);
  const selfJudging = generator.model.trim().toLowerCase() === judge.model.trim().toLowerCase();
  const requestedIds = selectedCaseIds();
  const availableIds = new Set(PROMPT_EVAL_CASES.map((testCase) => testCase.id));
  const unknownIds = requestedIds.filter((id) => !availableIds.has(id));
  if (unknownIds.length > 0) {
    throw new Error(`未知评测用例：${unknownIds.join(', ')}`);
  }
  const selected = PROMPT_EVAL_CASES.filter(
    (testCase) => requestedIds.length === 0 || requestedIds.includes(testCase.id),
  );
  if (selected.length === 0) {
    throw new Error('没有选中任何提示词评测用例。');
  }

  const result: PromptEvalRunResult = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    compressionMetric: PROMPT_EVAL_COMPRESSION_METRIC,
    evaluationProtocolHash: PROMPT_EVAL_PROTOCOL_HASH,
    storyEchoVersion: EXTENSION_VERSION,
    generatedAt: new Date().toISOString(),
    generatorModel: generator.model,
    judgeModel: judge.model,
    judgeConnectionHash: evalHash({ model: judge.model, baseUrl: judge.baseUrl }),
    selfJudging,
    caseFilter: requestedIds,
    cases: [],
    passed: false,
  };

  console.log(`StoryEcho 提示词质量评测：生成模型 ${generator.model}，Judge ${judge.model}，共 ${selected.length} 个用例。`);
  if (selfJudging) {
    console.warn('提示：生成模型与 Judge 相同；本次适合本地回归，但跨模型排名建议固定独立 Judge，以降低自评偏高。');
  }
  // Validate the baseline before spending any model requests on an incompatible run.
  const baselineEnvironment = process.env['STORY_ECHO_EVAL_BASELINE']?.trim() ?? '';
  const writeBaseline = process.env['STORY_ECHO_EVAL_WRITE_BASELINE'] === '1';
  let baseline: BaselineRun | undefined;
  if (baselineEnvironment) {
    try {
      baseline = await loadBaseline(resolve(baselineEnvironment));
    } catch (error) {
      if (!writeBaseline || errorCode(error) !== 'ENOENT') throw error;
      console.log(`基线文件尚不存在，将在本次全部通过后创建 ${resolve(baselineEnvironment)}`);
    }
  }
  if (baseline) {
    if (baseline.judgeModel !== judge.model || baseline.judgeConnectionHash !== result.judgeConnectionHash) {
      throw new Error('基线 Judge 模型或连接不同，不能直接比较质量分。');
    }
    const baselineById = new Map(baseline.cases.map((item) => [item.id, item]));
    for (const definition of selected) {
      const prior = baselineById.get(definition.id);
      if (prior?.evaluationHash !== caseEvaluationHash(buildPromptEvalCase(definition))) {
        throw new Error(`基线缺少用例或来源/评分规则已变化：${definition.id}；请重新建立基线。`);
      }
      if (!prior.scores) throw new Error(`基线用例缺少有效分数：${definition.id}；不能跳过回归比较。`);
    }
  }
  for (const definition of selected) {
    const testCase = buildPromptEvalCase(definition);
    const requestPromptHash = promptHash(testCase.system, testCase.prompt);
    console.log(`[RUN] ${testCase.id}: ${testCase.name}`);
    let generation: PromptEvalCompletion | undefined;
    try {
      generation = await requestPromptEvalCompletion(generator, {
        system: testCase.system,
        prompt: testCase.prompt,
        maxTokens: testCase.maxTokens,
      });
      const measurements = measurePromptEvalText(testCase, generation.text);
      const { compressionRatio } = measurements;
      const outputTruncated = isPromptEvalTruncated(generation.finishReason);
      const judgeCompletion = await requestPromptEvalCompletion(judge, {
        system: PROMPT_EVAL_JUDGE_SYSTEM_PROMPT,
        prompt: buildPromptEvalJudgePrompt(testCase, generation.text),
        maxTokens: 5_000,
      });
      assertPromptEvalComplete(judgeCompletion);
      const judgement = parsePromptEvalJudgement(
        judgeCompletion.text,
        testCase.rubric,
        generation.text,
      );
      const initialScores = scorePromptEvalJudgement(judgement, testCase.rubric, {
        compressionRatio,
        ...(testCase.idealCompressionRatio ? { idealCompressionRatio: testCase.idealCompressionRatio } : {}),
      });
      const scores: PromptEvalScores = {
        ...initialScores,
        passed: initialScores.passed && !outputTruncated,
      };
      const caseResult: PromptEvalCaseResult = {
        id: testCase.id,
        name: testCase.name,
        kind: testCase.kind,
        promptHash: requestPromptHash,
        evaluationHash: caseEvaluationHash(testCase),
        passed: scores.passed,
        outputTruncated,
        ...measurements,
        ...(testCase.idealCompressionRatio ? { idealCompressionRatio: testCase.idealCompressionRatio } : {}),
        generatedSummary: generation.text,
        generation: storedCompletion(generation),
        judge: storedCompletion(judgeCompletion),
        judgement,
        scores,
      };
      result.cases.push(caseResult);
    } catch (error) {
      const outputTruncated = Boolean(generation && isPromptEvalTruncated(generation.finishReason));
      const caseResult: PromptEvalCaseResult = {
        id: testCase.id,
        name: testCase.name,
        kind: testCase.kind,
        promptHash: requestPromptHash,
        evaluationHash: caseEvaluationHash(testCase),
        passed: false,
        outputTruncated,
        ...measurePromptEvalText(testCase, generation?.text ?? ''),
        ...(testCase.idealCompressionRatio ? { idealCompressionRatio: testCase.idealCompressionRatio } : {}),
        ...(generation ? {
          generatedSummary: generation.text,
          generation: storedCompletion(generation),
        } : {}),
        error: boundedError(error),
      };
      result.cases.push(caseResult);
    }
  }
  result.passed = result.cases.every((item) => item.passed);

  if (baseline) {
    if (
      baseline.generatorModel &&
      baseline.generatorModel !== result.generatorModel
    ) {
      console.warn(`警告：基线生成模型是 ${baseline.generatorModel}，本次是 ${result.generatorModel}。`);
    }
    applyBaseline(
      result,
      baseline,
      nonNegativeNumberEnvironment('STORY_ECHO_EVAL_MAX_REGRESSION', 5),
    );
  }

  for (const caseResult of result.cases) {
    printCaseResult(caseResult);
  }
  result.aggregate = aggregateResults(result.cases);
  console.log(
    `汇总：${result.aggregate.passedCases}/${result.aggregate.totalCases} 通过，综合均分 ${result.aggregate.overall}，事实 ${result.aggregate.factRetention}，因果 ${result.aggregate.causalContinuity}，不确定性 ${result.aggregate.uncertaintyPrecision}，聚焦 ${result.aggregate.focusAndUsability}，安全 ${result.aggregate.forbiddenClaimSafety}，密度参考 ${result.aggregate.compressionEfficiency ?? '未标定'}，平均错误扣分 ${result.aggregate.errorPenalty}。`,
  );

  const outputPath = resolve(
    process.env['STORY_ECHO_EVAL_OUTPUT']?.trim() || 'evals/results/latest.json',
  );
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(`完整结果已写入 ${outputPath}`);

  if (writeBaseline) {
    if (!result.passed) {
      throw new Error('本次评测没有全部通过，拒绝写入基线。');
    }
    const baselinePath = resolve(
      baselineEnvironment || `evals/results/baseline-${safeModelName(result.generatorModel)}.json`,
    );
    await mkdir(dirname(baselinePath), { recursive: true });
    await writeFile(baselinePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(`评测基线已写入 ${baselinePath}`);
  }

  if (!result.passed) {
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  console.error(`提示词质量评测失败：${boundedError(error)}`);
  process.exitCode = 1;
});
