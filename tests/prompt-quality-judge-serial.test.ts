import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestPromptEvalCompletion, type PromptEvalClientConfig } from '../evals/openai-compatible-client';
import { JudgeEvaluationError } from '../evals/judge-diagnostics';
import { runSerialIdentityProbe } from '../evals/judge-serial';
import { inputReceiptRequest, inspectInputReceipt } from '../evals/judge-input-receipt';
import { pairwiseControls } from '../evals/pairwise-inputs';
import { buildPairwisePrompt } from '../evals/pairwise';
import { candidateEvidenceSegments } from '../evals/evidence';

const config: PromptEvalClientConfig = { apiKey: 'test-key-not-real', baseUrl: 'https://example.com/v1', model: 'requested-model', timeoutMs: 1_000, maxTokenField: 'max_tokens' };
const request = { system: 'Judge', prompt: '合成剧情。', maxTokens: 128 };
const tie = '{"winner":"tie","acceptableA":true,"acceptableB":true,"reason":"两个候选完全相同","differences":[]}';
const completion = (text = tie) => ({ text, finishReason: 'stop', durationMs: 1 });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('local eval transport diagnostics', () => {
  it('hashes exactly the sent body and records only allowlisted metadata', async () => {
    const sent: RequestInit[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      sent.push(init!);
      return new Response(JSON.stringify({ id: 'chatcmpl-123', model: 'returned-model', system_fingerprint: 'fp-test', choices: [{ finish_reason: 'stop', message: { content: tie } }] }), {
        headers: { 'x-request-id': 'req-123', 'set-cookie': 'never-store-cookie', authorization: 'never-store-auth', 'openai-organization': 'never-store-org' },
      });
    };
    const first = await requestPromptEvalCompletion(config, request, fetcher);
    const second = await requestPromptEvalCompletion(config, request, fetcher);
    expect(first.transport).toMatchObject({ httpStatus: 200, serverRequestId: 'req-123', responseId: 'chatcmpl-123', returnedModel: 'returned-model', systemFingerprint: 'fp-test' });
    const sentBody = String(sent[0]!.body);
    expect(first.transport!.wireRequestHash).toBe(createHash('sha256').update(sentBody).digest('hex'));
    expect(first.transport!.wireRequestBytes).toBe(Buffer.byteLength(sentBody, 'utf8'));
    expect(second.transport!.wireRequestHash).toBe(first.transport!.wireRequestHash);
    expect(first.transport!.clientRequestId).not.toBe(second.transport!.clientRequestId);
    expect(new Headers(sent[0]!.headers).get('X-Client-Request-Id')).toBe(first.transport!.clientRequestId);
    expect(first.transport!.clientRequestId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(JSON.stringify(first.transport)).not.toMatch(/never-store|test-key-not-real|Authorization/iu);
    expect(sentBody).not.toContain(first.transport!.clientRequestId);
  });

  it('redacts metadata before bounding it and keeps absent fields absent', async () => {
    const secret = 'do-not-keep-this-test-key';
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({ model: `${'x'.repeat(250)}${secret}`, choices: [{ message: { content: tie } }] }), { headers: { 'x-request-id': secret } });
    const result = await requestPromptEvalCompletion({ ...config, apiKey: secret }, request, fetcher);
    expect(result.transport!.serverRequestId).toBe('[REDACTED]');
    expect(result.transport!.returnedModel!.length).toBeLessThanOrEqual(256);
    expect(result.transport!.returnedModel).not.toContain('do-not');
    expect(result.transport!.responseId).toBeUndefined();
    expect(result.transport!.systemFingerprint).toBeUndefined();
  });

  it('retains server IDs and body fingerprints on HTTP failure without retrying', async () => {
    const fetcher = vi.fn(async () => new Response('{"error":"unavailable"}', { status: 503, headers: { 'x-request-id': 'req-failed' } }));
    let caught: unknown;
    try { await requestPromptEvalCompletion(config, request, fetcher); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(JudgeEvaluationError);
    expect((caught as JudgeEvaluationError).diagnostic.transport).toMatchObject({ httpStatus: 503, serverRequestId: 'req-failed', clientRequestId: expect.any(String), wireRequestHash: expect.any(String), responseBodyHash: expect.any(String) });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('retains the client ID and body fingerprint when a request times out', async () => {
    vi.useFakeTimers();
    const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    const pending = requestPromptEvalCompletion(config, request, fetcher).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await pending as JudgeEvaluationError;
    expect(error.message).toContain('超时');
    expect(error.diagnostic.transport).toMatchObject({ clientRequestId: expect.any(String), wireRequestHash: expect.any(String) });
    expect(error.diagnostic.transport?.serverRequestId).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('bounded sequential identity diagnosis', () => {
  it('awaits each request and progress write, keeps identical payloads, and makes exactly 12 calls', async () => {
    let inFlight = 0;
    let maximum = 0;
    let writesInFlight = 0;
    const payloads: string[] = [];
    const savedCounts: number[] = [];
    const result = await runSerialIdentityProbe(async (value) => {
      expect(writesInFlight).toBe(0);
      inFlight++;
      maximum = Math.max(maximum, inFlight);
      await Promise.resolve();
      payloads.push(JSON.stringify(value));
      inFlight--;
      return completion();
    }, 'json_schema', async (progress) => {
      expect(inFlight).toBe(0);
      writesInFlight++;
      await Promise.resolve();
      savedCounts.push(progress.requests.length);
      writesInFlight--;
    });
    expect(result).toMatchObject({ completed: true, passed: true, maximumInFlight: 1, aggregate: { requests: 12, correctIdentityJudgements: 12, matchedPairs: 6 } });
    expect(maximum).toBe(1);
    expect(payloads).toHaveLength(12);
    expect(new Set(payloads).size).toBe(3);
    for (const count of Array.from({ length: 13 }, (_, index) => index)) expect(savedCounts).toContain(count);
    expect(result.requests.map((row) => row.reversed)).toEqual([false, true, false, true, false, true, true, false, true, false, true, false]);
  });

  it('does not overwrite failures with the later repeated sample', async () => {
    let calls = 0;
    const result = await runSerialIdentityProbe(async () => completion(calls++ === 0 ? 'invalid-json' : tie), 'text');
    expect(calls).toBe(12);
    expect(result.passed).toBe(false);
    expect(result.aggregate).toMatchObject({ errors: 1, validJudgements: 11, correctIdentityJudgements: 11, matchedPairs: 5 });
    expect(result.requests[0]!.diagnostic?.responsePreview).toBe('invalid-json');
    expect(result.pairs[0]!.orders[0]!.error).toBeDefined();
    expect(result.pairs[3]!.matched).toBe(true);
  });

  it('stops spending requests when progress persistence fails', async () => {
    const complete = vi.fn(async () => completion());
    await expect(runSerialIdentityProbe(complete, 'text', async (progress) => {
      if (progress.requests.length) throw new Error('disk full');
    })).rejects.toThrow('disk full');
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe('literal input receipt probe', () => {
  const input = pairwiseControls().find((item) => item.id === 'colony-reference-identity')!;
  const expected = candidateEvidenceSegments(input.left);
  it('keeps the same user payload as the failing Judge, without expected labels in the request', () => {
    const probe = inputReceiptRequest(input);
    expect(probe.prompt).toBe(buildPairwisePrompt(input, false));
    expect(probe.system).not.toContain('expected');
    expect(probe.responseFormat?.json_schema.strict).toBe(true);
    expect(probe.maxTokens).toBe(4_000);
  });
  it('requires every segment, exact wording, ids and order in both candidates', () => {
    const good = { candidateA: expected, candidateB: expected };
    expect(inspectInputReceipt(JSON.stringify(good), input).passed).toBe(true);
    for (const altered of [expected.slice(0, -1), [...expected].reverse(), [...expected, expected[0]], expected.map((item) => ({ ...item, text: `${item.text}改写` }))]) {
      expect(inspectInputReceipt(JSON.stringify({ ...good, candidateA: altered }), input).passed).toBe(false);
      expect(inspectInputReceipt(JSON.stringify({ ...good, candidateB: altered }), input).passed).toBe(false);
    }
    expect(() => inspectInputReceipt('{}', input)).toThrow('缺少');
  });
});
