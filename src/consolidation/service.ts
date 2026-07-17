import type { StoryEchoSettings, StoryMemory } from '../core/types';
import type { ExtractedMemoryCandidate } from '../extraction/types';
import { completeWithConfiguredProvider } from '../llm/complete';
import { parseConsolidationResponse, fallbackConsolidationDecisions } from './parser';
import { buildConsolidationPrompt, CONSOLIDATION_SYSTEM_PROMPT } from './prompts';
import { CONSOLIDATION_SCHEMA } from './schema';
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

  const startedAt = performance.now();
  try {
    const raw = await completeWithConfiguredProvider(settings, {
      system: CONSOLIDATION_SYSTEM_PROMPT,
      prompt: buildConsolidationPrompt(candidates, memories),
      jsonSchema: CONSOLIDATION_SCHEMA,
    });
    return {
      decisions: parseConsolidationResponse(raw, candidates, memories),
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
