import type { EvidenceRole, MemoryType, TruthStatus } from '../core/types';

export interface ExtractedMemoryCandidate {
  /** Added locally after parsing; it is not requested from the extraction LLM. */
  evidenceRole?: EvidenceRole;
  sourceMessageIds: number[];
  type: MemoryType;
  scene: {
    location: string;
    time: string;
    participants: string[];
  };
  event: string;
  cause: string;
  consequence: string;
  entities: string[];
  aliases: string[];
  stateChanges: Array<{
    entity: string;
    attribute: string;
    before: string;
    after: string;
  }>;
  unresolvedThreads: string[];
  knownBy: string[];
  truthStatus: TruthStatus;
  importance: number;
  retrievalText: string;
  injectionText: string;
}
