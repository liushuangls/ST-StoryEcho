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

function jsonPayload(raw: string): string {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('抽取模型没有返回JSON对象。');
  }
  return trimmed.slice(start, end + 1);
}

export function parseMemoryCandidate(value: unknown): ExtractedMemoryCandidate | null {
    const item = record(value);
    const type = text(item['type']) as MemoryType;
    const truthStatus = text(item['truthStatus']) as TruthStatus;
    const scene = record(item['scene']);
    const event = text(item['event']);
    const retrievalText = text(item['retrievalText'], 4000);
    const injectionText = text(item['injectionText'], 2000);

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
      type,
      scene: {
        location: text(scene['location'], 300),
        time: text(scene['time'], 300),
        participants: textArray(scene['participants']),
      },
      event,
      cause: text(item['cause']),
      consequence: text(item['consequence']),
      entities: textArray(item['entities']),
      aliases: textArray(item['aliases']),
      stateChanges,
      unresolvedThreads: textArray(item['unresolvedThreads']),
      knownBy: textArray(item['knownBy']),
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

  const memories = record(parsed)['memories'];
  if (!Array.isArray(memories)) {
    throw new Error('抽取结果缺少memories数组。');
  }

  return memories.slice(0, 20).flatMap((value) => {
    const candidate = parseMemoryCandidate(value);
    return candidate ? [candidate] : [];
  });
}
