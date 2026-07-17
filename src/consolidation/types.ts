import type { ConsolidationOperation } from '../core/types';
import type { ExtractedMemoryCandidate } from '../extraction/types';

export interface ConsolidationDecision {
  candidateIndex: number;
  operation: ConsolidationOperation;
  targetMemoryId?: string;
  reason: string;
  result: ExtractedMemoryCandidate;
}
export interface ConsolidationDecisionResult {
  decisions: ConsolidationDecision[];
  usedLlm: boolean;
  durationMs: number;
  error?: string;
}
