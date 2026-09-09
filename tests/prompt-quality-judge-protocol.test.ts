import { afterEach, describe, expect, it, vi } from 'vitest';
import { CALIBRATION_CONTROLS, calibrationCase } from '../evals/calibration';
import { indexedRubric, pairwiseJudgeResponseFormat, RULE_DIMENSIONS, singleJudgeResponseFormat } from '../evals/judge-schema';
import { buildPromptEvalJudgePrompt, parsePromptEvalJudgement } from '../evals/evaluator';
import { judgeOutputMode } from '../evals/config';
import { completeJudgeRequest, JudgeEvaluationError, redactEvalSecrets, responseDiagnostic } from '../evals/judge-diagnostics';
import { requestPromptEvalCompletion, type PromptEvalClientConfig } from '../evals/openai-compatible-client';
import { candidateEvidenceSegments } from '../evals/evidence';
import { evaluatePairwise, PAIRWISE_JUDGE_SYSTEM } from '../evals/pairwise';
import { pairwiseControls } from '../evals/pairwise-inputs';
import { caseEvaluationHash } from '../evals/protocol';

const control = CALIBRATION_CONTROLS[0]!;
const built = calibrationCase(control);
const config: PromptEvalClientConfig = { apiKey: 'test-key-not-real', baseUrl: 'https://example.com/v1', model: 'test-judge', timeoutMs: 1_000, maxTokenField: 'max_tokens' };
const request = { system: 'Judge', prompt: 'Synthetic data', maxTokens: 128 };
const completed = (text: string, finishReason = 'stop') => ({ text, finishReason, durationMs: 7, totalTokens: 15 });
function mapJudgement(): Record<string, unknown> {
  return { ...Object.fromEntries(RULE_DIMENSIONS.map((dimension) => [dimension,
    Object.fromEntries(built.rubric[dimension].map((_, index) => [String(index), {
      verdict: dimension === 'forbiddenClaims' ? 'clear' : 'complete',
      evidenceIds: dimension === 'forbiddenClaims' ? [] : [1], reason: '规则证据',
    }])),
  ])), hallucinations: [], chronologyErrors: [], notes: '测试' };
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('explicit Judge wire protocol', () => {
  it('numbers all rules without changing source/rubric comparison hashes', () => {
    const before = caseEvaluationHash(built);
    const indexed = indexedRubric(built.rubric);
    for (const dimension of RULE_DIMENSIONS) {
      expect(indexed[dimension]).toEqual(built.rubric[dimension].map((rule, criterionIndex) => ({ ...rule, criterionIndex, criterionId: `${dimension}:${criterionIndex}` })));
    }
    expect(buildPromptEvalJudgePrompt(built, control.candidate)).toContain('"criterionId":"requiredFacts:1"');
    expect(caseEvaluationHash(built)).toBe(before);
    expect(PAIRWISE_JUDGE_SYSTEM).toContain('evidenceAIds 只引用 candidate_A_segments');
    expect(PAIRWISE_JUDGE_SYSTEM).toContain('evidenceBIds 只引用 candidate_B_segments');
  });

  it('requires exact rule keys and closes every object in the strict schema', () => {
    for (const item of CALIBRATION_CONTROLS) {
      const testCase = calibrationCase(item);
      const format = singleJudgeResponseFormat(testCase.rubric, item.candidate);
      expect(format).toMatchObject({ type: 'json_schema', json_schema: { strict: true } });
      const schema = format.json_schema.schema;
      const props = schema['properties'] as Record<string, Record<string, unknown>>;
      for (const dimension of RULE_DIMENSIONS) {
        expect(props[dimension]!['required']).toEqual(testCase.rubric[dimension].map((_, index) => String(index)));
      }
      const visit = (value: unknown): void => {
        if (!value || typeof value !== 'object') return;
        const node = value as Record<string, unknown>;
        if (node['type'] === 'object') {
          expect(node['additionalProperties']).toBe(false);
          expect(node['required']).toEqual(Object.keys(node['properties'] as object));
        }
        for (const child of Object.values(value)) visit(child);
      };
      visit(schema);
    }
  });

  it('normalizes keyed verdicts but still rejects omissions, wrong keys and invalid citations', () => {
    const wire = mapJudgement();
    const result = parsePromptEvalJudgement(JSON.stringify(wire), built.rubric, control.candidate);
    expect(result.requiredFacts.map((item) => item.criterionIndex)).toEqual(built.rubric.requiredFacts.map((_, index) => index));
    expect(result.requiredFacts[0]!.evidence).toBe(candidateEvidenceSegments(control.candidate)[0]!.text);
    const facts = wire['requiredFacts'] as Record<string, unknown>;
    facts['01'] = facts['0'];
    expect(() => parsePromptEvalJudgement(JSON.stringify(wire), built.rubric, control.candidate)).toThrow('规则键');
    delete facts['01'];
    delete facts['0'];
    expect(() => parsePromptEvalJudgement(JSON.stringify(wire), built.rubric, control.candidate)).toThrow('不完整');
    facts['0'] = { verdict: 'complete', evidenceIds: [999], reason: '越界' };
    expect(() => parsePromptEvalJudgement(JSON.stringify(wire), built.rubric, control.candidate)).toThrow();
    facts['0'] = { verdict: 'complete', evidenceIds: [], reason: '无引用' };
    expect(() => parsePromptEvalJudgement(JSON.stringify(wire), built.rubric, control.candidate)).toThrow('缺少');
  });

  it('bounds A/B evidence independently and swaps schemas with the candidates', async () => {
    const input = { ...pairwiseControls()[0]!, left: '一句。', right: '第一句。第二句。第三句。' };
    const expected = pairwiseJudgeResponseFormat(input.testCase.rubric, input.left, input.right);
    const properties = expected.json_schema.schema['properties'] as Record<string, Record<string, unknown>>;
    const difference = properties['differences']!['items'] as Record<string, Record<string, Record<string, unknown>>>;
    expect(difference['properties']!['evidenceAIds']!['items']).toMatchObject({ maximum: 1 });
    expect(difference['properties']!['evidenceBIds']!['items']).toMatchObject({ maximum: 3 });
    expect(difference['properties']!['criterion']!['enum']).toContain('requiredFacts:1');
    const complete = vi.fn(async () => completed('{"winner":"tie","acceptableA":true,"acceptableB":true,"reason":"同质","differences":[]}'));
    await evaluatePairwise(input, 1, complete, 'json_schema');
    expect(complete.mock.calls).toHaveLength(2);
    expect(complete).toHaveBeenNthCalledWith(1, expect.objectContaining({ responseFormat: expected }));
    expect(complete).toHaveBeenNthCalledWith(2, expect.objectContaining({ responseFormat: pairwiseJudgeResponseFormat(input.testCase.rubric, input.right, input.left) }));
  });

  it('uses opt-in structured mode without changing generation requests', async () => {
    vi.stubEnv('STORY_ECHO_EVAL_JUDGE_OUTPUT_MODE', '');
    expect(judgeOutputMode()).toBe('text');
    vi.stubEnv('STORY_ECHO_EVAL_JUDGE_OUTPUT_MODE', 'json_schema');
    expect(judgeOutputMode()).toBe('json_schema');
    vi.stubEnv('STORY_ECHO_EVAL_JUDGE_OUTPUT_MODE', 'auto');
    expect(() => judgeOutputMode()).toThrow('输出模式');
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })));
    await requestPromptEvalCompletion(config, request, fetcher);
    const responseFormat = singleJudgeResponseFormat(built.rubric, control.candidate);
    await requestPromptEvalCompletion(config, { ...request, responseFormat }, fetcher);
    const bodies = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(JSON.parse(String(bodies[0]![1].body))).not.toHaveProperty('response_format');
    expect(JSON.parse(String(bodies[1]![1].body)).response_format).toEqual(responseFormat);
  });

  it('sends every candidate segment through the HTTP path in both orientations', async () => {
    const input = pairwiseControls().find((item) => item.id === 'colony-reference-vs-omission')!;
    const payloads: Record<string, unknown>[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      payloads.push(JSON.parse(body.messages[1].content));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"winner":"tie","acceptableA":false,"acceptableB":false,"reason":"仅验证请求传输","differences":[]}' }, finish_reason: 'stop' }] }));
    };
    await evaluatePairwise(input, 1, (value) => requestPromptEvalCompletion(config, value, fetcher), 'json_schema');
    expect(payloads).toHaveLength(2);
    expect(payloads[0]!['candidate_A_segments']).toEqual(candidateEvidenceSegments(input.left));
    expect(payloads[0]!['candidate_B_segments']).toEqual(candidateEvidenceSegments(input.right));
    expect(payloads[1]!['candidate_A_segments']).toEqual(candidateEvidenceSegments(input.right));
    expect(payloads[1]!['candidate_B_segments']).toEqual(candidateEvidenceSegments(input.left));
    const full = JSON.stringify(payloads[0]!['candidate_A_segments']);
    expect(full).toContain('目前余六天');
    expect(full).toContain('现余二十小时');
    expect(full).toContain('已运到但未安装');
  });
});

describe('bounded, redacted Judge failure evidence', () => {
  it('redacts raw, JSON-escaped and encoded secrets before truncating', () => {
    const secret = 'private-"key/with spaces-123456';
    vi.stubEnv('STORY_ECHO_EVAL_JUDGE_API_KEY', secret);
    const raw = 'x'.repeat(23_990) + secret + JSON.stringify(secret) + encodeURIComponent(secret);
    const diagnostic = responseDiagnostic(raw);
    expect(diagnostic.responseTruncated).toBe(true);
    expect(diagnostic.responsePreview!.length).toBeLessThanOrEqual(24_000);
    expect(diagnostic.responsePreview).not.toContain('private-');
    const redacted = redactEvalSecrets(raw);
    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain(encodeURIComponent(secret));
    expect(redacted).not.toContain(JSON.stringify(secret));
    expect(redactEvalSecrets('Bearer unknown-credential')).toBe('Bearer [REDACTED]');
    vi.stubEnv('STORY_ECHO_EVAL_JUDGE_MAX_TOKEN_FIELD', 'max_completion_tokens');
    expect(redactEvalSecrets('max_completion_tokens')).toBe('max_completion_tokens');
  });

  it.each(['invalid-json', 'length'])('keeps a failed %s response and usage without retry', async (failure) => {
    const complete = vi.fn(async () => completed('partial response', failure === 'length' ? 'length' : 'stop'));
    let error: unknown;
    try { await completeJudgeRequest(complete, request, JSON.parse); } catch (caught) { error = caught; }
    expect(complete).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(JudgeEvaluationError);
    expect((error as JudgeEvaluationError).diagnostic).toMatchObject({ responsePreview: 'partial response', totalTokens: 15, durationMs: 7, requestHash: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  });

  it.each([
    [400, '{"error":"unsupported response_format"}'],
    [502, '<html>gateway failure</html>'],
    [200, '{"choices":[{"message":{"refusal":"declined","content":"{}"},"finish_reason":"stop"}]}'],
    [200, '{"choices":[{"message":{"content":""},"finish_reason":"length"}]}'],
  ])('keeps provider failure evidence for HTTP %s without fallback', async (status, body) => {
    const fetcher = vi.fn(async () => new Response(body, { status }));
    const structured = { ...request, responseFormat: singleJudgeResponseFormat(built.rubric, control.candidate) };
    let error: unknown;
    try { await completeJudgeRequest((value) => requestPromptEvalCompletion(config, value, fetcher), structured, JSON.parse); } catch (caught) { error = caught; }
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(JudgeEvaluationError);
    expect((error as JudgeEvaluationError).diagnostic.responsePreview).toBe(body);
    expect((error as JudgeEvaluationError).diagnostic.requestHash).toBeDefined();
  });
});
