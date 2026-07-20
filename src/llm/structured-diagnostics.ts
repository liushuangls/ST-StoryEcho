import type { LlmProviderId, LlmStructuredOutputMode } from '../core/types';
import { emitDiagnosticsUpdated } from '../debug/events';

type ModeCounts = Record<LlmStructuredOutputMode, number>;

export interface StructuredOutputDiagnostics {
  attempts: ModeCounts;
  successes: ModeCounts;
  failures: ModeCounts;
  providerFallbacks: number;
  adaptiveSplits: number;
  localJsonRepairs: number;
  backgroundYields: number;
  extractionCooldownSkips: number;
  lastProvider: LlmProviderId | null;
  lastMode: LlmStructuredOutputMode | null;
  lastOutcome: 'success' | 'failure' | null;
  lastUpdatedAt: string | null;
}

function emptyModeCounts(): ModeCounts {
  return { 'json-object': 0, 'json-schema': 0, text: 0 };
}

function createDiagnostics(): StructuredOutputDiagnostics {
  return {
    attempts: emptyModeCounts(),
    successes: emptyModeCounts(),
    failures: emptyModeCounts(),
    providerFallbacks: 0,
    adaptiveSplits: 0,
    localJsonRepairs: 0,
    backgroundYields: 0,
    extractionCooldownSkips: 0,
    lastProvider: null,
    lastMode: null,
    lastOutcome: null,
    lastUpdatedAt: null,
  };
}

let diagnostics = createDiagnostics();

function touch(provider: LlmProviderId, mode: LlmStructuredOutputMode): void {
  diagnostics.lastProvider = provider;
  diagnostics.lastMode = mode;
  diagnostics.lastUpdatedAt = new Date().toISOString();
}

export function recordStructuredAttempt(
  provider: LlmProviderId,
  mode: LlmStructuredOutputMode,
): void {
  diagnostics.attempts[mode] += 1;
  touch(provider, mode);
  emitDiagnosticsUpdated();
}

export function recordStructuredSuccess(
  provider: LlmProviderId,
  mode: LlmStructuredOutputMode,
): void {
  diagnostics.successes[mode] += 1;
  diagnostics.lastOutcome = 'success';
  touch(provider, mode);
  emitDiagnosticsUpdated();
}

export function recordStructuredFailure(
  provider: LlmProviderId,
  mode: LlmStructuredOutputMode,
): void {
  diagnostics.failures[mode] += 1;
  diagnostics.lastOutcome = 'failure';
  touch(provider, mode);
  emitDiagnosticsUpdated();
}

export function recordStructuredProviderFallback(): void {
  diagnostics.providerFallbacks += 1;
  diagnostics.lastUpdatedAt = new Date().toISOString();
  emitDiagnosticsUpdated();
}

export function recordAdaptiveExtractionSplit(): void {
  diagnostics.adaptiveSplits += 1;
  diagnostics.lastUpdatedAt = new Date().toISOString();
  emitDiagnosticsUpdated();
}

export function recordLocalJsonRepair(): void {
  diagnostics.localJsonRepairs += 1;
  diagnostics.lastUpdatedAt = new Date().toISOString();
  emitDiagnosticsUpdated();
}

export function recordBackgroundYield(): void {
  diagnostics.backgroundYields += 1;
  diagnostics.lastUpdatedAt = new Date().toISOString();
  emitDiagnosticsUpdated();
}

export function recordExtractionCooldownSkip(): void {
  diagnostics.extractionCooldownSkips += 1;
  diagnostics.lastUpdatedAt = new Date().toISOString();
  emitDiagnosticsUpdated();
}

export function structuredOutputDiagnosticsSnapshot(): StructuredOutputDiagnostics {
  return structuredClone(diagnostics);
}

export function resetStructuredOutputDiagnostics(): void {
  diagnostics = createDiagnostics();
  emitDiagnosticsUpdated();
}
