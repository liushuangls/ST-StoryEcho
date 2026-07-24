import { MODULE_ID, VECTOR_COLLECTION_PREFIX } from '../core/constants';
import { getContext } from '../platform/sillytavern';

const REGISTRY_KEY = `${MODULE_ID}_vector_registry`;
const REGISTRY_VERSION = 1;
const MAX_REGISTRY_ENTRIES = 10_000;

interface VectorCollectionRegistration {
  ownerChatId: string;
  collectionId: string;
}

interface StoredVectorCollectionRegistry {
  version: number;
  collections: VectorCollectionRegistration[];
  pendingPurges: string[];
}

export interface VectorCollectionPurgeFailure {
  collectionId: string;
  error: unknown;
}

function validOwnerChatId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2_048;
}

function validCollectionId(value: unknown): value is string {
  return typeof value === 'string'
    && value.startsWith(`${VECTOR_COLLECTION_PREFIX}_`)
    && value.length <= 256;
}

function normalizedRegistry(value: unknown): StoredVectorCollectionRegistry {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const collections: VectorCollectionRegistration[] = [];
  const seenOwners = new Set<string>();
  if (Array.isArray(record['collections'])) {
    for (const candidate of record['collections'].slice(-MAX_REGISTRY_ENTRIES)) {
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
        continue;
      }
      const entry = candidate as Record<string, unknown>;
      if (
        !validOwnerChatId(entry['ownerChatId'])
        || !validCollectionId(entry['collectionId'])
        || seenOwners.has(entry['ownerChatId'])
      ) {
        continue;
      }
      seenOwners.add(entry['ownerChatId']);
      collections.push({
        ownerChatId: entry['ownerChatId'],
        collectionId: entry['collectionId'],
      });
    }
  }
  const pendingPurges = Array.isArray(record['pendingPurges'])
    ? [...new Set(record['pendingPurges'].filter(validCollectionId))].slice(-MAX_REGISTRY_ENTRIES)
    : [];
  return {
    version: REGISTRY_VERSION,
    collections,
    pendingPurges,
  };
}

export class VectorCollectionRegistry {
  remember(ownerChatId: string, collectionId: string): void {
    if (!validOwnerChatId(ownerChatId) || !validCollectionId(collectionId)) {
      return;
    }
    const registry = this.read();
    const existing = registry.collections.find((entry) => entry.ownerChatId === ownerChatId);
    if (existing?.collectionId === collectionId) {
      return;
    }
    registry.collections = registry.collections.filter((entry) => entry.ownerChatId !== ownerChatId);
    registry.collections.push({ ownerChatId, collectionId });
    if (registry.collections.length > MAX_REGISTRY_ENTRIES) {
      registry.collections.splice(0, registry.collections.length - MAX_REGISTRY_ENTRIES);
    }
    this.write(registry);
  }

  rename(oldOwnerChatId: string, newOwnerChatId: string): void {
    if (!validOwnerChatId(oldOwnerChatId) || !validOwnerChatId(newOwnerChatId)) {
      return;
    }
    const registry = this.read();
    const existing = registry.collections.find((entry) => entry.ownerChatId === oldOwnerChatId);
    if (!existing) {
      return;
    }
    registry.collections = registry.collections.filter(
      (entry) => entry.ownerChatId !== oldOwnerChatId && entry.ownerChatId !== newOwnerChatId,
    );
    registry.collections.push({
      ownerChatId: newOwnerChatId,
      collectionId: existing.collectionId,
    });
    this.write(registry);
  }

  queuePurge(ownerChatId: string): string | null {
    if (!validOwnerChatId(ownerChatId)) {
      return null;
    }
    const registry = this.read();
    const matches = registry.collections.filter((entry) => entry.ownerChatId === ownerChatId);
    if (matches.length === 0) {
      return null;
    }
    registry.collections = registry.collections.filter((entry) => entry.ownerChatId !== ownerChatId);
    registry.pendingPurges = [...new Set([
      ...registry.pendingPurges,
      ...matches.map((entry) => entry.collectionId),
    ])].slice(-MAX_REGISTRY_ENTRIES);
    this.write(registry);
    return matches.at(-1)?.collectionId ?? null;
  }

  async drainPending(
    purge: (collectionId: string) => Promise<void>,
  ): Promise<VectorCollectionPurgeFailure[]> {
    const registry = this.read();
    if (registry.pendingPurges.length === 0) {
      return [];
    }
    const completed = new Set<string>();
    const failures: VectorCollectionPurgeFailure[] = [];
    for (const collectionId of registry.pendingPurges) {
      try {
        await purge(collectionId);
        completed.add(collectionId);
      } catch (error) {
        failures.push({ collectionId, error });
      }
    }
    if (completed.size > 0) {
      const latest = this.read();
      latest.pendingPurges = latest.pendingPurges.filter(
        (collectionId) => !completed.has(collectionId),
      );
      // A stale task may have re-registered the deleted chat while its purge
      // was in flight. Do not leave that obsolete owner mapping behind.
      latest.collections = latest.collections.filter(
        (entry) => !completed.has(entry.collectionId),
      );
      this.write(latest);
    }
    return failures;
  }

  pendingCount(): number {
    return this.read().pendingPurges.length;
  }

  private read(): StoredVectorCollectionRegistry {
    return normalizedRegistry(getContext().extensionSettings[REGISTRY_KEY]);
  }

  private write(registry: StoredVectorCollectionRegistry): void {
    const context = getContext();
    context.extensionSettings[REGISTRY_KEY] = registry;
    context.saveSettingsDebounced();
  }
}

export const vectorCollectionRegistry = new VectorCollectionRegistry();
