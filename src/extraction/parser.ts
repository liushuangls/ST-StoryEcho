import type { MemoryType, TruthStatus } from '../core/types';
import type { ExtractedMemoryCandidate } from './types';

const MEMORY_TYPES = new Set<MemoryType>([
  'event',
  'state_change',
  'relationship_change',
  'commitment',
  'revelation',
  'clue',
  'conflict',
]);
const TRUTH_STATUSES = new Set<TruthStatus>(['confirmed', 'claimed', 'inferred', 'uncertain']);
const MEMORY_TYPE_ALIASES: Readonly<Record<string, MemoryType>> = {
  event: 'event',
  fact: 'event',
  state: 'state_change',
  state_change: 'state_change',
  relationship: 'relationship_change',
  relationship_change: 'relationship_change',
  promise: 'commitment',
  commitment: 'commitment',
  secret: 'revelation',
  revelation: 'revelation',
  clue: 'clue',
  conflict: 'conflict',
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown, maxLength = 2000): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function textArray(value: unknown, maxItems = 50): string[] {
  return Array.isArray(value)
    ? [...new Set(value.slice(0, maxItems).map((item) => text(item, 200)).filter(Boolean))]
    : [];
}

function integerArray(value: unknown, maxItems = 50): number[] {
  return Array.isArray(value)
    ? [...new Set(value
      .slice(0, maxItems)
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item >= 0))]
    : [];
}

function jsonPayload(raw: string): string {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const objectStart = trimmed.indexOf('{');
  const arrayStart = trimmed.indexOf('[');
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  const start = starts.length > 0 ? Math.min(...starts) : -1;
  const end = start >= 0 && trimmed[start] === '['
    ? trimmed.lastIndexOf(']')
    : trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('抽取模型没有返回JSON对象。');
  }
  return trimmed.slice(start, end + 1);
}

export function parseMemoryCandidate(value: unknown): ExtractedMemoryCandidate | null {
    const item = record(value);
    const declaredType = text(item['type']);
    const normalizedDeclaredType = MEMORY_TYPE_ALIASES[declaredType.toLowerCase()] ?? '';
    const declaredTruthStatus = text(
      item['truthStatus'] ?? item['confirmationLevel'] ?? item['confidence'],
    );
    const truthStatus = (
      TRUTH_STATUSES.has(declaredTruthStatus as TruthStatus)
        ? declaredTruthStatus
        : item['confirmed'] === true
          ? 'confirmed'
          : item['confirmed'] === false
            ? 'uncertain'
            : ''
    ) as TruthStatus;
    const scene = record(item['scene']);
    const retrievalText = text(item['retrievalText'], 4000);
    const injectionText = text(item['injectionText'], 2000);
    const event = text(
      item['event'] ?? item['content'] ?? item['details'] ?? item['summary'] ?? item['fact'],
    ) || [
      text(item['entity'], 300),
      text(item['action'], 500),
    ].filter(Boolean).join('：') || (
      normalizedDeclaredType && truthStatus ? retrievalText : ''
    );
    const knownBy = textArray(item['knownBy']);
    const canInferEventType = (
      !declaredType &&
      truthStatus === 'confirmed' &&
      knownBy.length >= 2 &&
      Boolean(text(item['details']) || text(item['action']))
    );
    const type = (
      normalizedDeclaredType || (canInferEventType ? 'event' : '')
    ) as MemoryType;

    if (
      !MEMORY_TYPES.has(type) ||
      !TRUTH_STATUSES.has(truthStatus) ||
      !event ||
      !retrievalText ||
      !injectionText
    ) {
      return null;
    }

    const stateChanges = Array.isArray(item['stateChanges'])
      ? item['stateChanges'].slice(0, 30).flatMap((stateChange) => {
          const change = record(stateChange);
          const entity = text(change['entity'], 200);
          const attribute = text(change['attribute'], 200);
          const after = text(change['after'], 500);
          if (!entity || !attribute || !after) {
            return [];
          }
          return [{
            entity,
            attribute,
            before: text(change['before'], 500),
            after,
          }];
        })
      : [];

    const importanceValue = Number(item['importance']);
    return {
      sourceMessageIds: integerArray(
        item['sourceMessageIds'] ?? item['source_message_ids'] ?? item['messageIds'],
      ),
      type,
      scene: {
        location: text(scene['location'], 300),
        time: text(scene['time'], 300),
        participants: textArray(scene['participants']),
      },
      event,
      cause: text(item['cause']),
      consequence: text(item['consequence']),
      entities: textArray(item['entities']).length > 0
        ? textArray(item['entities'])
        : textArray([item['entity'], ...(
            Array.isArray(item['objects']) ? item['objects'] : []
          )]),
      aliases: textArray(item['aliases']),
      stateChanges,
      unresolvedThreads: textArray(item['unresolvedThreads']),
      knownBy,
      truthStatus,
      importance: Number.isFinite(importanceValue)
        ? Math.min(1, Math.max(0, importanceValue))
        : 0.5,
      retrievalText,
      injectionText,
    };
}

export function parseExtractionResponse(raw: string): ExtractedMemoryCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonPayload(raw));
  } catch (error) {
    throw new Error('抽取模型返回的JSON无法解析。', { cause: error });
  }

  const root = record(parsed);
  const namedMemories =
    root['memories'] ??
    root['events'] ??
    root['items'] ??
    root['results'] ??
    root['facts'];
  const firstArray = Object.values(root).find(Array.isArray);
  const singleCandidate = parseMemoryCandidate(root);
  const memories = Array.isArray(parsed)
    ? parsed
    : Array.isArray(namedMemories)
      ? namedMemories
      : singleCandidate
        ? [root]
        : Array.isArray(firstArray)
          ? firstArray
          : null;
  if (!memories) {
    throw new Error('抽取结果缺少memories数组。');
  }

  return memories.slice(0, 20).flatMap((value) => {
    const candidate = parseMemoryCandidate(value);
    return candidate ? [candidate] : [];
  });
}
