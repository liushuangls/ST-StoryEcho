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
import { CALIBRATION_CONTROLS, calibrationCase, calibrationMismatches } from '../evals/calibration';
import { assertCompatibleEvaluationProtocol, caseEvaluationHash, PROMPT_EVAL_PROTOCOL_HASH } from '../evals/protocol';
import { clientConfiguration } from '../evals/config';
import { candidateEvidenceSegments, resolveEvidenceIds } from '../evals/evidence';
import { assertPromptEvalComplete, isPromptEvalTruncated } from '../evals/completion';

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
        if (definition.kind !== 'l1') {
          expect(definition.sources.every((source) => source.level === definition.targetLevel - 1)).toBe(true);
        }
        expect(testCase.prompt).toContain('<source_summaries>');
        expect(testCase.maxTokens).toBe(8_000);
      }
    }
  });

  it('keeps the prompt contracts that protect evidence and Level 2 detail', () => {
    const l1 = buildPromptEvalCase(PROMPT_EVAL_CASES.find((item) => item.kind === 'l1')!);
    const l2 = buildPromptEvalCase(PROMPT_EVAL_CASES.find((item) => item.kind === 'l2')!);
    const l3 = buildPromptEvalCase(PROMPT_EVAL_CASES.find((item) => item.kind === 'l3plus')!);

    expect(l1.system).toContain('注明持有者及确定程度');
    expect(l1.system).toContain('提议、请求或指示、答应或决定、开始执行、已经完成或生效是不同阶段');
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
      compressionEfficiency: null,
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

  it('reports density separately without rewarding or penalizing factual fidelity by length alone', () => {
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
    expect(overlong.overall).toBe(100);
    expect(tooShort.passed).toBe(true);
    expect(scorePromptEvalJudgement(passing, definition.rubric, { compressionRatio: 0.8 }).compressionEfficiency).toBeNull();
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

  it.each([
    '候选总结片段一但钥匙属于顾岚',
    '候选总结片段一……完全捏造的一段话',
    '候选总结片段二……候选总结片段一',
    '温度是-3.5度',
    '温度是35度',
  ])('rejects partially matching or altered evidence: %s', (evidence) => {
    const invalid = structuredClone(passing);
    invalid.requiredFacts[0]!.evidence = evidence;
    expect(() => parsePromptEvalJudgement(JSON.stringify(invalid), definition.rubric,
      '候选总结片段一；候选总结片段二。温度是3.5度。')).toThrow('逐字片段');
  });

  it('allows short exact names and whitespace-only differences', () => {
    const valid = structuredClone(passing);
    valid.requiredFacts[0]!.evidence = '陈默';
    valid.requiredFacts[1]!.evidence = 'E-19证物袋';
    expect(() => parsePromptEvalJudgement(JSON.stringify(valid), definition.rubric,
      '候选总结：陈默保管 E-19 证物袋。')).not.toThrow();
  });

  it('resolves numbered evidence without allowing the judge to rewrite the candidate', () => {
    const ids = JSON.parse(JSON.stringify(passing)) as Record<string, { evidence?: string; evidenceIds?: number[] }[]>;
    for (const dimension of ['requiredFacts', 'requiredCausalChains', 'uncertaintyRules', 'focusRules']) {
      for (const item of ids[dimension]!) {
        delete item.evidence;
        item.evidenceIds = [2, 1];
      }
    }
    const parsed = parsePromptEvalJudgement(JSON.stringify(ids), definition.rubric, '陈默保管钥匙。顾岚未证实所有权。');
    expect(parsed.requiredFacts[0]!.evidence).toBe('陈默保管钥匙。……顾岚未证实所有权。');
    ids['requiredFacts']![0]!.evidenceIds = [999];
    expect(() => parsePromptEvalJudgement(JSON.stringify(ids), definition.rubric, '陈默保管钥匙。')).toThrow('evidenceIds');
  });

  it('treats the candidate and source as data in the judge request', () => {
    const prompt = buildPromptEvalJudgePrompt(testCase, '候选总结');
    expect(prompt).toContain('<source_evidence>');
    expect(prompt).toContain('<rubric>');
    expect(prompt).toContain('<candidate_summary>\n候选总结\n</candidate_summary>');
  });
});

describe('calibration controls and protocol', () => {
  it('rejects all supported truncated finish reasons even when the JSON looks complete', () => {
    for (const finishReason of ['length', 'max_token', 'MAX-TOKENS', 'max output tokens', 'token_limit', 'output_token_limit']) {
      expect(isPromptEvalTruncated(finishReason)).toBe(true);
      expect(() => assertPromptEvalComplete({ text: '{}', finishReason, durationMs: 1 })).toThrow('输出上限');
    }
    expect(isPromptEvalTruncated('stop')).toBe(false);
    expect(() => assertPromptEvalComplete({ text: ' ', finishReason: 'stop', durationMs: 1 })).toThrow('为空');
  });
  it('keeps numbered snippets exact, Unicode safe and bounded', () => {
    const source = `温度是-3.5度。${'🎭'.repeat(300)}\n陈默保管钥匙！`;
    const segments = candidateEvidenceSegments(source);
    expect(segments.every((item) => source.includes(item.text))).toBe(true);
    expect(segments.every((item) => Array.from(item.text).length <= 240)).toBe(true);
    expect(resolveEvidenceIds([1], source)).toBe('温度是-3.5度。');
    for (const bad of [[0], [1, 1], ['1'], [1.5], [-1], Array.from({ length: 25 }, (_, i) => i + 1)]) {
      expect(() => resolveEvidenceIds(bad, source)).toThrow('evidenceIds');
    }
  });
  it('has blinded positive/omission/contradiction/verbose-error controls across three levels', () => {
    expect(CALIBRATION_CONTROLS).toHaveLength(12);
    expect(new Set(CALIBRATION_CONTROLS.map((item) => item.id)).size).toBe(12);
    for (const control of CALIBRATION_CONTROLS) {
      const built = calibrationCase(control);
      const prompt = buildPromptEvalJudgePrompt(built, control.candidate);
      expect(prompt).not.toContain(control.id);
      expect(prompt).not.toContain('expectedPass');
      expect(prompt).not.toContain('expectedVerdicts');
      expect(control.expectedPass).toBe(control.variant === 'reference');
      if (!control.expectedPass) expect(control.expectedVerdicts.length).toBeGreaterThan(0);
      for (const expected of control.expectedVerdicts) {
        expect(built.rubric[expected.dimension][expected.index]).toBeDefined();
      }
    }
  });

  it('cannot pass a negative control just because the overall score looks high', () => {
    const control = CALIBRATION_CONTROLS.find((item) => item.variant === 'omission')!;
    const rubric = calibrationCase(control).rubric;
    const positive = (criteria: readonly unknown[]) => criteria.map((_, criterionIndex) => ({ criterionIndex, verdict: 'complete' as const, evidence: '证据', reason: '理由' }));
    const judgement: PromptEvalJudgement = {
      requiredFacts: positive(rubric.requiredFacts), requiredCausalChains: positive(rubric.requiredCausalChains),
      uncertaintyRules: positive(rubric.uncertaintyRules), focusRules: positive(rubric.focusRules),
      forbiddenClaims: rubric.forbiddenClaims.map((_, criterionIndex) => ({ criterionIndex, verdict: 'clear', evidence: '', reason: '' })),
      hallucinations: [], chronologyErrors: [], notes: '',
    };
    expect(calibrationMismatches(control, judgement, scorePromptEvalJudgement(judgement, rubric)).length).toBeGreaterThan(1);
  });

  it('fingerprints rubric/source changes but permits production prompt A/B comparisons', () => {
    const built = buildPromptEvalCase(PROMPT_EVAL_CASES[0]!);
    expect(caseEvaluationHash({ ...built, system: 'changed', prompt: 'changed' })).toBe(caseEvaluationHash(built));
    expect(caseEvaluationHash({ ...built, sourceEvidence: 'changed' })).not.toBe(caseEvaluationHash(built));
    expect(caseEvaluationHash({ ...built, rubric: { ...built.rubric, focusRules: [] } })).not.toBe(caseEvaluationHash(built));
    expect(() => assertCompatibleEvaluationProtocol(undefined)).toThrow('协议');
    expect(() => assertCompatibleEvaluationProtocol(PROMPT_EVAL_PROTOCOL_HASH)).not.toThrow();
  });

  it('does not forward the generator key to a separately configured Judge host', () => {
    vi.stubEnv('STORY_ECHO_EVAL_JUDGE_BASE_URL', 'https://another.example/v1');
    vi.stubEnv('STORY_ECHO_EVAL_JUDGE_API_KEY', '');
    try {
      expect(() => clientConfiguration('JUDGE_', {
        apiKey: 'generator-secret', baseUrl: 'https://original.example/v1', model: 'model', timeoutMs: 1000, maxTokenField: 'max_tokens',
      })).toThrow('必须显式配置');
    } finally { vi.unstubAllEnvs(); }
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

  it('redacts a reflected key before truncating an HTTP error detail', async () => {
    const apiKey = 'secret-eval-' + 'z'.repeat(80);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      message: 'x'.repeat(960) + apiKey,
    }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
    try {
      await requestPromptEvalCompletion({ apiKey, baseUrl: 'https://api.example.com/v1', model: 'model', timeoutMs: 1000, maxTokenField: 'max_tokens' },
        { system: '', prompt: '', maxTokens: 100 }, fetchMock);
      expect.fail('Expected HTTP error');
    } catch (error) {
      expect(String(error)).toContain('HTTP 400');
      expect(String(error)).not.toContain('secret-eval-');
    }
  });
});

describe('eval isolation from CI', () => {
  it('keeps real-model evals outside the normal check and GitHub workflow', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(packageJson.scripts['eval:prompts']).toContain('evals/run.ts');
    expect(packageJson.scripts['eval:generate']).toContain('evals/generate-run.ts');
    expect(packageJson.scripts['eval:calibrate']).toContain('evals/calibrate-run.ts');
    expect(packageJson.scripts['eval:chains']).toContain('evals/chains-run.ts');
    expect(packageJson.scripts['eval:chains:default']).toContain('evals/default-chain-run.ts');
    expect(packageJson.scripts['eval:pairwise']).toContain('evals/pairwise-run.ts');
    expect(packageJson.scripts['eval:judge:smoke']).toContain('evals/judge-smoke-run.ts');
    expect(packageJson.scripts['eval:judge:serial']).toContain('evals/judge-serial-run.ts');
    expect(packageJson.scripts['eval:judge:receipt']).toContain('evals/judge-input-receipt-run.ts');
    expect(packageJson.scripts['eval:judge:layout']).toContain('evals/judge-layout-run.ts');
    expect(packageJson.scripts['check']).not.toContain('eval:prompts');
    expect(workflow).not.toContain('eval:prompts');
    expect(packageJson.scripts['check']).not.toContain('eval:generate');
    expect(workflow).not.toContain('eval:generate');
    expect(packageJson.scripts['check']).not.toContain('eval:calibrate');
    expect(workflow).not.toContain('eval:calibrate');
    expect(packageJson.scripts['check']).not.toContain('eval:chains');
    expect(workflow).not.toContain('eval:chains');
    expect(packageJson.scripts['check']).not.toContain('eval:pairwise');
    expect(workflow).not.toContain('eval:pairwise');
    expect(packageJson.scripts['check']).not.toContain('eval:judge:smoke');
    expect(workflow).not.toContain('eval:judge:smoke');
    expect(packageJson.scripts['check']).not.toContain('eval:judge:serial');
    expect(workflow).not.toContain('eval:judge:serial');
    expect(packageJson.scripts['check']).not.toContain('eval:judge:receipt');
    expect(workflow).not.toContain('eval:judge:receipt');
    expect(packageJson.scripts['check']).not.toContain('eval:judge:layout');
    expect(workflow).not.toContain('eval:judge:layout');
    expect(readFileSync('.gitignore', 'utf8')).toContain('evals/results/');
  });
});
