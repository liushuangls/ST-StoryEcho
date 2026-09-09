import { describe, expect, it } from 'vitest';
import {
  DETERMINISTIC_GUARD_CASES,
  DETERMINISTIC_GUARD_DEVELOPMENT_CASES,
  DETERMINISTIC_GUARD_HOLDOUT_CASES,
} from '../evals/deterministic-guard-cases';
import {
  deterministicGuardDevelopmentGate,
  deterministicGuardHoldoutGate,
  evaluateDeterministicGuards,
} from '../evals/deterministic-guard-eval';
import { inspectDeterministicSummaryGuards } from '../evals/deterministic-guards';

describe('deterministic summary guards', () => {
  it('freezes separate development and holdout sets with both labels represented', () => {
    expect(DETERMINISTIC_GUARD_DEVELOPMENT_CASES).toHaveLength(20);
    expect(DETERMINISTIC_GUARD_HOLDOUT_CASES).toHaveLength(10);
    expect(new Set(DETERMINISTIC_GUARD_CASES.map((item) => item.id)).size).toBe(30);
    for (const cases of [DETERMINISTIC_GUARD_DEVELOPMENT_CASES, DETERMINISTIC_GUARD_HOLDOUT_CASES]) {
      expect(cases.some((item) => item.expected.includes('pending-action-upgraded'))).toBe(true);
      expect(cases.some((item) => item.expected.includes('explicit-boundary-lost'))).toBe(true);
      expect(cases.some((item) => item.expected.length === 0)).toBe(true);
    }
  });

  it('distinguishes a completed instruction from a completed underlying action', () => {
    expect(inspectDeterministicSummaryGuards(
      '唐蔚让运营归档评论区截图。',
      '运营已归档评论区截图。',
    ).map((item) => item.kind)).toContain('pending-action-upgraded');
    expect(inspectDeterministicSummaryGuards(
      '陆朔已要求运营撤下旧预告，是否撤下仍未知。',
      '陆朔已要求运营撤下旧预告，结果仍未知。',
    )).toEqual([]);
  });

  it('accepts explicit negative paraphrases and reports omitted boundaries', () => {
    expect(inspectDeterministicSummaryGuards(
      '顾禾明确不授权周宁代签任何治疗同意书。',
      '顾禾未授权周宁代签任何治疗同意书。',
    )).toEqual([]);
    expect(inspectDeterministicSummaryGuards(
      '顾禾只授权周宁代领监测器，明确不授权她代签任何治疗同意书。',
      '周宁获授权代领监测器和检查单。',
    ).map((item) => item.kind)).toContain('explicit-boundary-lost');
  });

  it('does not turn meta no-change prose into a required boundary', () => {
    expect(inspectDeterministicSummaryGuards(
      '两人争论夜宵吃什么，这段闲聊没有改变训练安排。',
      '训练按原计划继续。',
    )).toEqual([]);
  });

  it('computes precision and recall gates without accuracy dilution', () => {
    const perfect = evaluateDeterministicGuards([
      DETERMINISTIC_GUARD_DEVELOPMENT_CASES[0]!,
      DETERMINISTIC_GUARD_DEVELOPMENT_CASES[1]!,
    ]);
    expect(perfect.overall.truePositive + perfect.overall.falseNegative).toBeGreaterThan(0);
    expect(perfect.overall.trueNegative + perfect.overall.falsePositive).toBeGreaterThan(0);
    expect(deterministicGuardDevelopmentGate(perfect)).toBeTypeOf('boolean');
    expect(deterministicGuardHoldoutGate(perfect)).toBeTypeOf('boolean');
  });
});
