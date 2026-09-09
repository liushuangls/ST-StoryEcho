import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  DETERMINISTIC_GUARD_DEVELOPMENT_CASES,
  DETERMINISTIC_GUARD_HOLDOUT_CASES,
  type DeterministicGuardSplit,
} from './deterministic-guard-cases';
import {
  deterministicGuardDevelopmentGate,
  deterministicGuardHoldoutGate,
  evaluateDeterministicGuards,
} from './deterministic-guard-eval';
import { inspectDeterministicSummaryGuards } from './deterministic-guards';

function splitFromEnvironment(): DeterministicGuardSplit {
  const value = process.env['STORY_ECHO_GUARD_SPLIT']?.trim() || 'development';
  if (value !== 'development' && value !== 'holdout') {
    throw new Error(`未知确定性校验集：${value}`);
  }
  return value;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function benchmark(): { iterations: number; sourceCharacters: number; summaryCharacters: number; p50Ms: number; p95Ms: number } {
  const source = DETERMINISTIC_GUARD_DEVELOPMENT_CASES.map((item) => item.source).join('\n').repeat(4);
  const summary = DETERMINISTIC_GUARD_DEVELOPMENT_CASES.map((item) => item.summary).join('\n').repeat(4);
  const iterations = 2_000;
  const timings: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now();
    inspectDeterministicSummaryGuards(source, summary);
    timings.push(performance.now() - start);
  }
  return {
    iterations,
    sourceCharacters: Array.from(source).length,
    summaryCharacters: Array.from(summary).length,
    p50Ms: Math.round(percentile(timings, 0.5) * 1_000) / 1_000,
    p95Ms: Math.round(percentile(timings, 0.95) * 1_000) / 1_000,
  };
}

async function main(): Promise<void> {
  const split = splitFromEnvironment();
  const cases = split === 'development'
    ? DETERMINISTIC_GUARD_DEVELOPMENT_CASES
    : DETERMINISTIC_GUARD_HOLDOUT_CASES;
  const evaluation = evaluateDeterministicGuards(cases);
  const gatePassed = split === 'development'
    ? deterministicGuardDevelopmentGate(evaluation)
    : deterministicGuardHoldoutGate(evaluation);
  const output = resolve(process.env['STORY_ECHO_GUARD_OUTPUT']?.trim()
    || `evals/results/deterministic-guards-${split}.json`);
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    split,
    gatePassed,
    evaluation,
    benchmark: benchmark(),
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(`${split}: ${evaluation.exactCases}/${evaluation.totalCases} exact；precision ${evaluation.overall.precision}；recall ${evaluation.overall.recall}；gate ${gatePassed ? 'PASS' : 'FAIL'}`);
  for (const item of evaluation.cases.filter((candidate) => !candidate.matched)) {
    console.log(`[MISMATCH] ${item.id}: expected=${item.expected.join(',') || 'clear'} predicted=${item.predicted.join(',') || 'clear'}`);
  }
  console.log(`benchmark p50/p95: ${result.benchmark.p50Ms}/${result.benchmark.p95Ms}ms；结果：${output}`);
  if (!gatePassed) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
