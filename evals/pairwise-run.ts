import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { clientConfiguration, judgeOutputMode, pairwisePromptLayout, positiveIntegerEnvironment } from './config';
import { pairwiseControls, pairwiseSavedRuns } from './pairwise-inputs';
import { pairwiseCalibrationControls } from './pairwise-calibration';
import { assertPairwiseCalibration, runPairwiseBatch } from './pairwise-batch';
import { requestPromptEvalCompletion } from './openai-compatible-client';
import { evalHash } from './protocol';
import { redactEvalSecrets } from './judge-diagnostics';

async function main(): Promise<void> {
  const generator = clientConfiguration('');
  const judge = clientConfiguration('JUDGE_', generator);
  const outputMode = judgeOutputMode();
  const layout = pairwisePromptLayout();
  const mode = process.env['STORY_ECHO_EVAL_PAIRWISE_MODE']?.trim() || 'controls';
  if (!['controls', 'compare'].includes(mode)) throw new Error('A/B 模式只能是 controls 或 compare。');
  const controlSet = process.env['STORY_ECHO_EVAL_PAIRWISE_CONTROLS']?.trim() || 'standard';
  if (!['standard', 'extended'].includes(controlSet)) throw new Error('A/B 对照集只能是 standard 或 extended。');
  const repetitions = positiveIntegerEnvironment('STORY_ECHO_EVAL_PAIRWISE_REPEATS', 1);
  if (repetitions > 3) throw new Error('A/B 最多重复 3 次，避免意外大量请求。');
  const readInput = async (name: string): Promise<unknown> => {
    const path = process.env[name]?.trim();
    if (!path) throw new Error(`缺少环境变量 ${name}`);
    return JSON.parse(await readFile(resolve(path), 'utf8')) as unknown;
  };
  const inputs = mode === 'controls' ? (controlSet === 'extended' ? pairwiseCalibrationControls() : pairwiseControls()) : pairwiseSavedRuns(
    await readInput('STORY_ECHO_EVAL_PAIRWISE_LEFT'), await readInput('STORY_ECHO_EVAL_PAIRWISE_RIGHT'),
  );
  const output = resolve(process.env['STORY_ECHO_EVAL_PAIRWISE_OUTPUT']?.trim() || 'evals/results/pairwise-latest.json');
  const connectionHash = evalHash({ model: judge.model, baseUrl: judge.baseUrl, outputMode });
  const calibrationPath = process.env['STORY_ECHO_EVAL_PAIRWISE_CALIBRATION']?.trim();
  let calibrationEvidenceHash: string | null = null;
  if (mode === 'compare' && (layout !== 'segments-json' || calibrationPath)) {
    if (!calibrationPath) throw new Error('新布局候选比较须提供 STORY_ECHO_EVAL_PAIRWISE_CALIBRATION。');
    const calibration: unknown = JSON.parse(await readFile(resolve(calibrationPath), 'utf8'));
    assertPairwiseCalibration(calibration, pairwiseCalibrationControls(), connectionHash, layout, outputMode);
    calibrationEvidenceHash = evalHash(calibration);
  }
  const candidateModels = [...new Set(inputs.flatMap((input) => input.generatorModels ?? []))];
  const metadata = {
    schemaVersion: 3, generatedAt: new Date().toISOString(), mode, controlSet: mode === 'controls' ? controlSet : null, judgeModel: judge.model,
    calibrationEvidenceHash,
    candidateModels,
    selfJudging: candidateModels.length ? candidateModels.some((model) => model.toLowerCase() === judge.model.trim().toLowerCase()) : null,
    judgeConnectionHash: connectionHash,
  };
  await mkdir(dirname(output), { recursive: true });
  console.log(`A/B ${mode} / ${controlSet} / ${layout}：Judge ${judge.model}，${inputs.length} 对，最多 ${inputs.length * 2 * repetitions} 次串行请求，交换位置，允许平局。`);
  if (metadata.selfJudging) console.warn('当前是同模型评审；结果不视为独立评审或人工金标准。');
  else if (mode === 'compare' && !candidateModels.length) console.warn('候选生成模型元数据缺失，无法确认是否同模型评审。');
  let printed = 0;
  const result = await runPairwiseBatch(inputs, repetitions, mode as 'controls' | 'compare', layout, outputMode,
    (request) => requestPromptEvalCompletion(judge, request), async (progress) => {
      await writeFile(output, `${JSON.stringify({ ...metadata, ...progress }, null, 2)}\n`, 'utf8');
      for (const row of progress.pairs.slice(printed)) {
        console.log(`[${row.id}] #${row.repetition}: ${row.outcome}，位置一致=${row.consistent}${row.matched === undefined ? '' : `，符合对照=${row.matched}`}`);
      }
      printed = progress.pairs.length;
    });
  console.log(`A/B ${result.passed ? '通过' : '未通过'}：${JSON.stringify(result.aggregate)}。结果：${output}`);
  if (!result.passed) process.exitCode = 1;
}

void main().catch((error: unknown) => { console.error(redactEvalSecrets(error instanceof Error ? error.message : String(error))); process.exitCode = 1; });
