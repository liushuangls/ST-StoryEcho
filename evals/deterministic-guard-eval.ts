import type { DeterministicGuardEvalCase } from './deterministic-guard-cases';
import {
  inspectDeterministicSummaryGuards,
  type DeterministicGuardFinding,
  type DeterministicGuardKind,
} from './deterministic-guards';

const KINDS: readonly DeterministicGuardKind[] = [
  'pending-action-upgraded',
  'explicit-boundary-lost',
];

export interface DeterministicGuardMetrics {
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface DeterministicGuardCaseResult {
  id: string;
  expected: readonly DeterministicGuardKind[];
  predicted: readonly DeterministicGuardKind[];
  findings: readonly DeterministicGuardFinding[];
  matched: boolean;
}

export interface DeterministicGuardEvaluation {
  totalCases: number;
  exactCases: number;
  metrics: Record<DeterministicGuardKind, DeterministicGuardMetrics>;
  overall: DeterministicGuardMetrics;
  cases: DeterministicGuardCaseResult[];
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function metrics(tp: number, fp: number, tn: number, fn: number): DeterministicGuardMetrics {
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  return {
    truePositive: tp,
    falsePositive: fp,
    trueNegative: tn,
    falseNegative: fn,
    precision: rounded(precision),
    recall: rounded(recall),
    f1: rounded(precision + recall ? (2 * precision * recall) / (precision + recall) : 0),
  };
}

export function evaluateDeterministicGuards(
  cases: readonly DeterministicGuardEvalCase[],
): DeterministicGuardEvaluation {
  const results = cases.map((testCase): DeterministicGuardCaseResult => {
    const findings = inspectDeterministicSummaryGuards(testCase.source, testCase.summary);
    const predicted = KINDS.filter((kind) => findings.some((finding) => finding.kind === kind));
    return {
      id: testCase.id,
      expected: testCase.expected,
      predicted,
      findings,
      matched: KINDS.every((kind) => testCase.expected.includes(kind) === predicted.includes(kind)),
    };
  });
  const byKind = Object.fromEntries(KINDS.map((kind) => {
    let tp = 0;
    let fp = 0;
    let tn = 0;
    let fn = 0;
    for (const result of results) {
      const expected = result.expected.includes(kind);
      const predicted = result.predicted.includes(kind);
      if (expected && predicted) tp += 1;
      else if (!expected && predicted) fp += 1;
      else if (!expected) tn += 1;
      else fn += 1;
    }
    return [kind, metrics(tp, fp, tn, fn)];
  })) as Record<DeterministicGuardKind, DeterministicGuardMetrics>;
  const overall = metrics(
    KINDS.reduce((sum, kind) => sum + byKind[kind].truePositive, 0),
    KINDS.reduce((sum, kind) => sum + byKind[kind].falsePositive, 0),
    KINDS.reduce((sum, kind) => sum + byKind[kind].trueNegative, 0),
    KINDS.reduce((sum, kind) => sum + byKind[kind].falseNegative, 0),
  );
  return {
    totalCases: cases.length,
    exactCases: results.filter((result) => result.matched).length,
    metrics: byKind,
    overall,
    cases: results,
  };
}

export function deterministicGuardDevelopmentGate(
  evaluation: DeterministicGuardEvaluation,
): boolean {
  return evaluation.overall.precision >= 0.95
    && evaluation.overall.recall >= 0.7
    && KINDS.every((kind) => evaluation.metrics[kind].precision >= 0.9)
    && evaluation.overall.falsePositive <= 1;
}

export function deterministicGuardHoldoutGate(
  evaluation: DeterministicGuardEvaluation,
): boolean {
  return evaluation.overall.precision >= 0.9
    && evaluation.overall.recall >= 0.6
    && KINDS.every((kind) => evaluation.metrics[kind].precision >= 0.85)
    && evaluation.overall.falsePositive <= 1;
}
