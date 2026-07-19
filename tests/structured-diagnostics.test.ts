import { beforeEach, describe, expect, it } from 'vitest';
import {
  recordAdaptiveExtractionSplit,
  recordExtractionCooldownSkip,
  recordStructuredAttempt,
  recordStructuredFailure,
  recordStructuredProviderFallback,
  recordStructuredSuccess,
  resetStructuredOutputDiagnostics,
  structuredOutputDiagnosticsSnapshot,
} from '../src/llm/structured-diagnostics';

beforeEach(() => resetStructuredOutputDiagnostics());

describe('structured output diagnostics', () => {
  it('records bounded mode and fallback counters without request content', () => {
    recordStructuredAttempt('main', 'json-object');
    recordStructuredFailure('main', 'json-object');
    recordStructuredAttempt('openai-compatible', 'json-schema');
    recordStructuredSuccess('openai-compatible', 'json-schema');
    recordStructuredProviderFallback();
    recordAdaptiveExtractionSplit();
    recordExtractionCooldownSkip();

    const snapshot = structuredOutputDiagnosticsSnapshot();
    expect(snapshot.attempts).toEqual({ 'json-object': 1, 'json-schema': 1, text: 0 });
    expect(snapshot.failures['json-object']).toBe(1);
    expect(snapshot.successes['json-schema']).toBe(1);
    expect(snapshot.providerFallbacks).toBe(1);
    expect(snapshot.adaptiveSplits).toBe(1);
    expect(snapshot.extractionCooldownSkips).toBe(1);
    expect(snapshot.lastProvider).toBe('openai-compatible');
    expect(snapshot.lastMode).toBe('json-schema');
  });
});
