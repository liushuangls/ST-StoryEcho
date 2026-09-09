import { createHash } from 'node:crypto';
import type { PromptEvalCompletion, PromptEvalRequest, PromptEvalTransportDiagnostic } from './openai-compatible-client';
import { assertPromptEvalComplete } from './completion';

export interface JudgeFailureDiagnostic {
  responsePreview?: string;
  responseHash?: string;
  responseCharacters?: number;
  responseTruncated?: boolean;
  requestHash?: string;
  finishReason?: string;
  durationMs?: number;
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  transport?: PromptEvalTransportDiagnostic;
}

export function redactEvalSecrets(text: string, extraSecrets: readonly string[] = []): string {
  const secrets = [...new Set([...extraSecrets, ...Object.entries(process.env)
    .filter(([key, value]) => /API_KEY|SECRET|PASSWORD|(?:^|_)TOKEN$/iu.test(key) && value && value.length >= 8)
    .map(([, value]) => value!)])].filter(Boolean);
  const variants = [...new Set(secrets.flatMap((secret) => [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]))]
    .sort((left, right) => right.length - left.length);
  let result = text;
  for (const secret of variants) result = result.split(secret).join('[REDACTED]');
  return result.replace(/Bearer\s+[^\s"'<>]+/giu, 'Bearer [REDACTED]');
}

function hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }

export function responseDiagnostic(text: string, extraSecrets: readonly string[] = []): JudgeFailureDiagnostic {
  const safe = redactEvalSecrets(text, extraSecrets);
  return { responsePreview: safe.slice(0, 24_000), responseHash: hash(safe), responseCharacters: safe.length, responseTruncated: safe.length > 24_000 };
}

export function completionDiagnostic(completion: PromptEvalCompletion): JudgeFailureDiagnostic {
  const { text, ...metadata } = completion;
  return { ...responseDiagnostic(text), ...metadata };
}

export class JudgeEvaluationError extends Error {
  constructor(message: string, readonly diagnostic: JudgeFailureDiagnostic) {
    super(redactEvalSecrets(message).slice(0, 2_000));
    this.name = 'JudgeEvaluationError';
  }
}

/** One request only. Schema/refusal/parse failures never trigger a fallback or retry. */
export async function completeJudgeRequest<T>(
  complete: (request: PromptEvalRequest) => Promise<PromptEvalCompletion>,
  request: PromptEvalRequest,
  parse: (text: string) => T,
): Promise<{ completion: PromptEvalCompletion; judgement: T }> {
  let completion: PromptEvalCompletion | undefined;
  try {
    completion = await complete(request);
    assertPromptEvalComplete(completion);
    return { completion, judgement: parse(completion.text) };
  } catch (error) {
    const diagnostic = error instanceof JudgeEvaluationError ? error.diagnostic : {};
    throw new JudgeEvaluationError(error instanceof Error ? error.message : String(error), {
      ...diagnostic,
      ...(completion ? completionDiagnostic(completion) : {}),
      requestHash: hash(JSON.stringify(request)),
    });
  }
}
