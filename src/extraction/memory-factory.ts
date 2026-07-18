import { allocateVectorHash, sha256 } from '../core/hash';
import type { ConsolidationOperation, StoryMemory, StoryMemorySource } from '../core/types';
import { createUuid } from '../core/uuid';
import type { ExtractedMemoryCandidate } from './types';

export interface MemoryFactoryOptions {
  id?: string;
  createdAt?: string;
  sourceHistory?: StoryMemorySource[];
  supersedesMemoryIds?: string[];
  lastOperation?: ConsolidationOperation;
}

export async function createStoryMemory(
  candidate: ExtractedMemoryCandidate,
  source: { startMessageId: number; endMessageId: number; sourceHash: string },
  occupiedVectorHashes: ReadonlySet<number>,
  options: MemoryFactoryOptions = {},
): Promise<StoryMemory> {
  const now = new Date().toISOString();
  const id = options.id ?? `mem_${createUuid()}`;
  const retrievalHash = await sha256(candidate.retrievalText);
  const vectorHash = allocateVectorHash(`${id}:${retrievalHash}`, occupiedVectorHashes);
  const location = candidate.scene.location.trim();
  const time = candidate.scene.time.trim();
  const cause = candidate.cause.trim();
  const consequence = candidate.consequence.trim();

  return {
    id,
    type: candidate.type,
    source,
    sourceHistory: options.sourceHistory ?? [source],
    scene: {
      ...(location ? { location } : {}),
      ...(time ? { time } : {}),
      participants: candidate.scene.participants,
    },
    event: candidate.event,
    ...(cause ? { cause } : {}),
    ...(consequence ? { consequence } : {}),
    entities: candidate.entities,
    aliases: candidate.aliases,
    stateChanges: candidate.stateChanges.map((change) => ({
      entity: change.entity,
      attribute: change.attribute,
      ...(change.before ? { before: change.before } : {}),
      after: change.after,
    })),
    unresolvedThreads: candidate.unresolvedThreads,
    knownBy: candidate.knownBy,
    truthStatus: candidate.truthStatus,
    importance: candidate.importance,
    status: 'active',
    retrievalText: candidate.retrievalText,
    injectionText: candidate.injectionText,
    vectorHash,
    retrievalHash,
    pinned: false,
    excluded: false,
    manuallyEdited: false,
    supersedesMemoryIds: options.supersedesMemoryIds ?? [],
    lastOperation: options.lastOperation ?? 'CREATE',
    createdAt: options.createdAt ?? now,
    updatedAt: now,
  };
}
