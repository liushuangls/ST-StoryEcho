import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { assertCompatibleCompressionMetric, measurePromptEvalText, PROMPT_EVAL_COMPRESSION_METRIC } from '../evals/measurements';
import { storyContent } from '../src/content/story-content';
import {
  buildPromptEvalCase,
  PROMPT_EVAL_CASES,
} from '../evals/cases';
import {
  buildPromptEvalJudgePrompt,
  parsePromptEvalJudgement,
  scorePromptEvalJudgement,
} from '../evals/evaluator';
import {
  promptEvalChatCompletionsUrl,
  requestPromptEvalCompletion,
} from '../evals/openai-compatible-client';
import type { PromptEvalJudgement } from '../evals/types';

describe('prompt quality regression fixtures', () => {
  it('covers twelve varied Tavern-style L1, L2, and L3+ cases with valid rubrics', () => {
    expect(PROMPT_EVAL_CASES).toHaveLength(12);
    expect(new Set(PROMPT_EVAL_CASES.map((testCase) => testCase.id)).size)
      .toBe(PROMPT_EVAL_CASES.length);
    expect(new Set(PROMPT_EVAL_CASES.map((testCase) => testCase.kind)))
      .toEqual(new Set(['l1', 'l2', 'l3plus']));
    expect(Object.fromEntries(['l1', 'l2', 'l3plus'].map((kind) => [
      kind,
      PROMPT_EVAL_CASES.filter((testCase) => testCase.kind === kind).length,
    ]))).toEqual({ l1: 4, l2: 4, l3plus: 4 });

    for (const definition of PROMPT_EVAL_CASES) {
      const testCase = buildPromptEvalCase(definition);
      expect(testCase.system).not.toContain('最大输出');
      expect(testCase.system).not.toContain('Token');
      expect(testCase.prompt).not.toContain('最大输出预算');
      expect(testCase.rubric.requiredFacts.length).toBeGreaterThan(0);
      expect(testCase.rubric.requiredCausalChains.length).toBeGreaterThan(0);
      expect(testCase.rubric.uncertaintyRules.length).toBeGreaterThan(0);
      expect(testCase.rubric.focusRules.length).toBeGreaterThanOrEqual(2);
      expect(testCase.rubric.forbiddenClaims.length).toBeGreaterThan(0);
      expect(Object.values(testCase.rubric).flat().every((criterion) => (
        criterion.description.length > 0 &&
        criterion.weight >= 1 &&
        criterion.weight <= 5
      ))).toBe(true);
      expect(Object.values(testCase.rubric).flat().some((criterion) => criterion.critical))
        .toBe(true);
      expect(testCase.sourceEvidence.length).toBeGreaterThan(100);

      if (testCase.kind === 'l1') {
        expect(testCase.prompt).toContain('<history_messages>');
        expect(testCase.maxTokens).toBe(3_000);
      } else {
        expect(testCase.prompt).toContain('<source_summaries>');
        expect(testCase.maxTokens).toBe(8_000);
      }
    }
  });

  it('keeps the prompt contracts that protect evidence and Level 2 detail', () => {
    const l1 = buildPromptEvalCase(PROMPT_EVAL_CASES.find((item) => item.kind === 'l1')!);
    const l2 = buildPromptEvalCase(PROMPT_EVAL_CASES.find((item) => item.kind === 'l2')!);
    const l3 = buildPromptEvalCase(PROMPT_EVAL_CASES.find((item) => item.kind === 'l3plus')!);

    expect(l1.system).toContain('说法、怀疑、误认和推测注明持有者及确定程度');
    expect(l1.system).toContain('分别表述为候选路径、既定方案和已执行事件');
    expect(l2.system).toContain('覆盖每条来源总结中的独有重要信息');
    expect(l2.system).toContain('起因—关键转折或选择—结果');
    expect(l2.system).not.toContain('只保留答案为“是”的事实');
    expect(l3.system).toContain('高层级意味着更强压缩');
    expect(l3.system).toContain('不得为追求短而切断关键状态链');
  });
});

describe('prompt quality measurements', () => {
  it('uses only production narrative bodies as the compression denominator for all 12 cases', () => {
    for (const definition of PROMPT_EVAL_CASES) {
      const body = definition.kind === 'l1'
        ? definition.messages.filter((message) => !message.is_system).map(storyContent).filter(Boolean).join('\n')
        : definition.sources.filter((source) => !source.deleted).map((source) => source.text.trim()).filter(Boolean).join('\n');
      const built = buildPromptEvalCase(definition);
      const measurement = measurePromptEvalText(built, body);
      expect(measurement.sourceCharacters).toBe(Array.from(body).length);
      expect(measurement.compressionRatio).toBe(1);
      expect(measurement.sourceEvidenceCharacters).toBeGreaterThan(measurement.sourceCharacters);
      expect(measurement.requestCharacters).toBe(Array.from(`${built.system}\n${built.prompt}`).length);
    }
  });

  it('does not reward compression of hashes, world-book or previous-summary text', () => {
    const definition = PROMPT_EVAL_CASES.find((item) => item.id === 'l2-ten-source-parallel-arcs')!;
    const built = buildPromptEvalCase(definition);
    expect(measurePromptEvalText(built, '文'.repeat(371)).compressionRatio).toBeGreaterThan(1);
    const padded = { ...built, sourceEvidence: built.sourceEvidence + '背景'.repeat(10_000) };
    expect(measurePromptEvalText(padded, '文'.repeat(371)).compressionRatio)
      .toBe(measurePromptEvalText(built, '文'.repeat(371)).compressionRatio);
  });

  it('excludes system messages, deleted sources and Unicode surrogate inflation', () => {
    const l1 = PROMPT_EVAL_CASES.find((item) => item.kind === 'l1')!;
    const l2 = PROMPT_EVAL_CASES.find((item) => item.kind === 'l2')!;
    if (l2.kind === 'l1') throw new Error('Expected compaction fixture');
    const first = buildPromptEvalCase({ ...l1, previousSummary: '旧事'.repeat(1000), worldBackground: '背景'.repeat(1000), messages: [
      { is_user: false, is_system: true, mes: '系统内容不算正文' },
      { is_user: true, mes: '剧情🎭' },
    ] });
    const second = buildPromptEvalCase({ ...l2, sources: [
      { ...l2.sources[0]!, text: '剧情🎭' },
      { ...l2.sources[1]!, text: '已删除正文', deleted: true },
    ] });
    expect(first.sourceCharacters).toBe(3);
    expect(second.sourceCharacters).toBe(3);
    expect(measurePromptEvalText(first, '剧情🎭').compressionRatio).toBe(1);
  });

  it('rejects old baseline metrics rather than reporting a fake regression', () => {
    expect(() => assertCompatibleCompressionMetric(undefined)).toThrow('旧版或不同');
    expect(() => assertCompatibleCompressionMetric('json-evidence')).toThrow('旧版或不同');
    expect(() => assertCompatibleCompressionMetric(PROMPT_EVAL_COMPRESSION_METRIC)).not.toThrow();
  });
});

describe('prompt quality judge', () => {
  const definition = PROMPT_EVAL_CASES[0]!;
  const testCase = buildPromptEvalCase(definition);
  const passing: PromptEvalJudgement = {
    requiredFacts: definition.rubric.requiredFacts.map((_, criterionIndex) => ({
      criterionIndex,
      verdict: 'complete',
      evidence: '候选总结',
      reason: '已保留',
    })),
    requiredCausalChains: definition.rubric.requiredCausalChains.map((_, criterionIndex) => ({
      criterionIndex,
      verdict: 'complete',
      evidence: '候选总结',
      reason: '已保留',
    })),
    uncertaintyRules: definition.rubric.uncertaintyRules.map((_, criterionIndex) => ({
      criterionIndex,
      verdict: 'complete',
      evidence: '候选总结',
      reason: '未确定化',
    })),
    focusRules: definition.rubric.focusRules.map((_, criterionIndex) => ({
      criterionIndex,
      verdict: 'complete',
      evidence: '候选总结',
      reason: '重点清楚',
    })),
    forbiddenClaims: definition.rubric.forbiddenClaims.map((_, criterionIndex) => ({
      criterionIndex,
      verdict: 'clear',
      evidence: '',
      reason: '未出现',
    })),
    hallucinations: [],
    chronologyErrors: [],
    notes: '通过',
  };

  it('parses fenced compatible JSON and computes scores locally', () => {
    const judgement = parsePromptEvalJudgement(
      `\n\`\`\`json\n${JSON.stringify(passing)}\n\`\`\`\n`,
      definition.rubric,
    );
    expect(scorePromptEvalJudgement(judgement, definition.rubric)).toEqual({
      factRetention: 100,
      causalContinuity: 100,
      uncertaintyPrecision: 100,
      focusAndUsability: 100,
      forbiddenClaimSafety: 100,
      compressionEfficiency: 100,
      errorPenalty: 0,
      overall: 100,
      passed: true,
    });
  });

  it('rejects missing or duplicate criterion results', () => {
    const incomplete = structuredClone(passing);
    incomplete.requiredFacts.pop();
    expect(() => parsePromptEvalJudgement(JSON.stringify(incomplete), definition.rubric))
      .toThrow('不完整或存在重复索引');

    const duplicate = structuredClone(passing);
    duplicate.requiredFacts[1]!.criterionIndex = 0;
    expect(() => parsePromptEvalJudgement(JSON.stringify(duplicate), definition.rubric))
      .toThrow('不完整或存在重复索引');
  });

  it('fails locally when a forbidden conclusion or hallucination is reported', () => {
    const unsafe = structuredClone(passing);
    unsafe.forbiddenClaims[0]!.verdict = 'violated';
    unsafe.forbiddenClaims[0]!.evidence = '候选总结';
    unsafe.hallucinations.push({
      severity: 'major',
      evidence: '候选总结',
      reason: '来源不存在的新事实',
    });
    const judgement = parsePromptEvalJudgement(JSON.stringify(unsafe), definition.rubric);
    expect(scorePromptEvalJudgement(judgement, definition.rubric)).toMatchObject({
      forbiddenClaimSafety: expect.any(Number),
      errorPenalty: 8,
      passed: false,
    });
  });

  it('uses weighted granular verdicts instead of turning near-misses into 100', () => {
    const mixed = structuredClone(passing);
    mixed.requiredFacts[0]!.verdict = 'mostly';
    mixed.requiredFacts[1]!.verdict = 'partial';
    mixed.focusRules[0]!.verdict = 'mostly';
    const scores = scorePromptEvalJudgement(mixed, definition.rubric);
    expect(scores.factRetention).toBeGreaterThan(0);
    expect(scores.factRetention).toBeLessThan(100);
    expect(scores.focusAndUsability).toBeLessThan(100);
    expect(scores.overall).toBeLessThan(100);
  });

  it('scores overlong and overcompressed outputs below the ideal density band', () => {
    const overlong = scorePromptEvalJudgement(passing, definition.rubric, {
      compressionRatio: 0.60,
      idealCompressionRatio: { min: 0.16, max: 0.30 },
    });
    const tooShort = scorePromptEvalJudgement(passing, definition.rubric, {
      compressionRatio: 0.08,
      idealCompressionRatio: { min: 0.16, max: 0.30 },
    });
    expect(overlong.compressionEfficiency).toBe(0);
    expect(tooShort.compressionEfficiency).toBe(50);
    expect(overlong.overall).toBeLessThan(100);
    expect(tooShort.passed).toBe(false);
  });

  it('rejects Judge evidence that was not quoted from the candidate summary', () => {
    const ungrounded = structuredClone(passing);
    ungrounded.requiredFacts[0]!.evidence = '候选中不存在的片段';
    expect(() => parsePromptEvalJudgement(
      JSON.stringify(ungrounded),
      definition.rubric,
      '候选总结',
    )).toThrow('逐字片段');
  });

  it('accepts multiple exact candidate fragments joined by an ellipsis', () => {
    const grounded = structuredClone(passing);
    for (const item of [
      ...grounded.requiredFacts,
      ...grounded.requiredCausalChains,
      ...grounded.uncertaintyRules,
      ...grounded.focusRules,
    ]) {
      item.evidence = '候选总结片段一……候选总结片段二';
    }
    expect(() => parsePromptEvalJudgement(
      JSON.stringify(grounded),
      definition.rubric,
      '候选总结片段一，其他文字，候选总结片段二。',
    )).not.toThrow();
  });

  it('treats the candidate and source as data in the judge request', () => {
    const prompt = buildPromptEvalJudgePrompt(testCase, '候选总结');
    expect(prompt).toContain('<source_evidence>');
    expect(prompt).toContain('<rubric>');
    expect(prompt).toContain('<candidate_summary>\n候选总结\n</candidate_summary>');
  });
});

describe('local OpenAI-compatible eval client', () => {
  it('normalizes safe endpoints and rejects remote cleartext HTTP', () => {
    expect(promptEvalChatCompletionsUrl('https://api.example.com/v1'))
      .toBe('https://api.example.com/v1/chat/completions');
    expect(promptEvalChatCompletionsUrl('http://localhost:11434/v1'))
      .toBe('http://localhost:11434/v1/chat/completions');
    expect(() => promptEvalChatCompletionsUrl('http://api.example.com/v1'))
      .toThrow('必须使用 HTTPS');
  });

  it('sends the key only as a bearer header and parses completion metadata', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer secret-key' });
      expect(String(init?.body)).not.toContain('secret-key');
      expect(body).toMatchObject({ model: 'eval-model', max_tokens: 123, stream: false });
      expect(body).not.toHaveProperty('thinking');
      return new Response(JSON.stringify({
        choices: [{ message: { content: '总结结果' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    await expect(requestPromptEvalCompletion({
      apiKey: 'secret-key',
      baseUrl: 'https://api.example.com/v1',
      model: 'eval-model',
      timeoutMs: 5_000,
      maxTokenField: 'max_tokens',
    }, {
      system: 'system',
      prompt: 'prompt',
      maxTokens: 123,
    }, fetchMock)).resolves.toMatchObject({
      text: '总结结果',
      finishReason: 'stop',
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
    });
  });

  it('disables DeepSeek thinking so reasoning does not consume the output budget', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body['thinking']).toEqual({ type: 'disabled' });
      return new Response(JSON.stringify({
        choices: [{ message: { content: '总结结果' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    await requestPromptEvalCompletion({
      apiKey: 'secret-key',
      baseUrl: 'https://api.example.com/v1',
      model: 'deepseek-v4-flash',
      timeoutMs: 5_000,
      maxTokenField: 'max_tokens',
    }, {
      system: 'system',
      prompt: 'prompt',
      maxTokens: 123,
    }, fetchMock);
  });
});

describe('eval isolation from CI', () => {
  it('keeps real-model evals outside the normal check and GitHub workflow', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(packageJson.scripts['eval:prompts']).toContain('evals/run.ts');
    expect(packageJson.scripts['check']).not.toContain('eval:prompts');
    expect(workflow).not.toContain('eval:prompts');
    expect(readFileSync('.gitignore', 'utf8')).toContain('evals/results/');
  });
});
