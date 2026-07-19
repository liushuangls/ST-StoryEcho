import type { StoryEchoSettings, StoryMemory } from '../core/types';
import type { ExtractedMemoryCandidate } from '../extraction/types';
import { completeStructuredWithConfiguredProvider } from '../llm/complete';
import { parseConsolidationResponse, fallbackConsolidationDecisions } from './parser';
import { isCommitmentLike, stateIdentities } from './identity';
import { buildConsolidationPrompt, CONSOLIDATION_SYSTEM_PROMPT } from './prompts';
import { CONSOLIDATION_SCHEMA } from './schema';
import { normalizedFact } from './shortlist';
import type { ConsolidationDecisionResult } from './types';

export async function decideConsolidation(
  settings: StoryEchoSettings,
  candidates: ExtractedMemoryCandidate[],
  memories: StoryMemory[],
): Promise<ConsolidationDecisionResult> {
  const fallback = fallbackConsolidationDecisions(candidates, memories);
  if (memories.length === 0 || fallback.every((decision) => decision.operation === 'IGNORE')) {
    return { decisions: fallback, usedLlm: false, durationMs: 0 };
  }

  const deterministicIndices = new Set(candidates.flatMap((candidate, candidateIndex) => {
    const exact = memories.some((memory) => (
      normalizedFact(memory.retrievalText) === normalizedFact(candidate.retrievalText)
    ));
    const stableIdentity = stateIdentities(candidate).length > 0 || isCommitmentLike(candidate);
    return exact || stableIdentity ? [candidateIndex] : [];
  }));
  const ambiguous = candidates.flatMap((candidate, candidateIndex) => (
    deterministicIndices.has(candidateIndex) || fallback[candidateIndex]?.operation !== 'MERGE'
      ? []
      : [{ candidate, candidateIndex }]
  ));
  if (ambiguous.length === 0) {
    return { decisions: fallback, usedLlm: false, durationMs: 0 };
  }

  const startedAt = performance.now();
  try {
    const ambiguousCandidates = ambiguous.map((item) => item.candidate);
    const decisions = await completeStructuredWithConfiguredProvider(settings, {
      system: CONSOLIDATION_SYSTEM_PROMPT,
      prompt: buildConsolidationPrompt(ambiguousCandidates, memories),
      jsonSchema: CONSOLIDATION_SCHEMA,
      maxTokens: 2_048,
    }, (raw) => parseConsolidationResponse(raw, ambiguousCandidates, memories));
    const remapped = new Map(decisions.map((decision) => {
      const originalIndex = ambiguous[decision.candidateIndex]?.candidateIndex;
      return originalIndex === undefined
        ? [-1, decision] as const
        : [originalIndex, { ...decision, candidateIndex: originalIndex }] as const;
    }));
    return {
      decisions: fallback.map((decision) => remapped.get(decision.candidateIndex) ?? decision),
      usedLlm: true,
      durationMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return {
      decisions: fallback,
      usedLlm: true,
      durationMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : '整理模型调用失败。',
    };
  }
}
