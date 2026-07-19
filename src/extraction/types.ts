import type { MemoryType, TruthStatus } from '../core/types';

export interface ExtractedMemoryCandidate {
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
