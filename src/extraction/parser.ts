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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function typedScene(item: Record<string, unknown>): Record<string, unknown> {
  const scene = record(item['scene']);
  return {
    location: text(scene['location'], 300),
    time: text(scene['time'], 300),
    participants: textArray(scene['participants']),
  };
}

function typedCommon(item: Record<string, unknown>): Record<string, unknown> {
  return {
    sourceMessageIds: integerArray(item['sourceMessageIds']),
    scene: typedScene(item),
    knownBy: textArray(item['knownBy']),
    truthStatus: text(item['truthStatus']),
    importance: item['importance'],
  };
}

function sentence(value: string): string {
  const trimmed = value.trim().replace(/[；;]+$/u, '');
  return !trimmed || /[。.!！?？]$/u.test(trimmed) ? trimmed : `${trimmed}。`;
}

function sceneText(item: Record<string, unknown>): string {
  const scene = typedScene(item);
  return [
    text(scene['time']) ? `时间：${text(scene['time'])}` : '',
    text(scene['location']) ? `地点：${text(scene['location'])}` : '',
    textArray(scene['participants']).length > 0
      ? `参与者：${textArray(scene['participants']).join('、')}`
      : '',
  ].filter(Boolean).join('；');
}

function parseTypedEpisode(value: unknown): ExtractedMemoryCandidate | null {
  const item = record(value);
  const action = text(item['action']);
  const kind = text(item['kind']) === 'conflict' ? 'conflict' : 'event';
  if (!action) {
    return null;
  }
  const cause = text(item['cause']);
  const consequence = text(item['consequence']);
  const context = sceneText(item);
  return parseMemoryCandidate({
    ...typedCommon(item),
    type: kind,
    event: action,
    cause,
    consequence,
    entities: textArray(item['entities']),
    aliases: textArray(item['aliases']),
    stateChanges: [],
    unresolvedThreads: textArray(item['unresolvedThreads']),
    retrievalText: [context, `剧情：${action}`, cause ? `原因：${cause}` : '', consequence ? `结果：${consequence}` : '']
      .filter(Boolean).join('；'),
    injectionText: sentence([context, action, cause ? `起因是${cause}` : '', consequence ? `结果是${consequence}` : '']
      .filter(Boolean).join('；')),
  });
}

function parseTypedStateFact(value: unknown): ExtractedMemoryCandidate | null {
  const item = record(value);
  const entity = text(item['entity'], 300);
  const attribute = text(item['attribute'], 300);
  const before = text(item['before'], 500);
  const after = text(item['after'], 500);
  if (!entity || !attribute || !after) {
    return null;
  }
  const fact = before
    ? `${entity}的${attribute}由${before}变为${after}`
    : `${entity}的${attribute}当前为${after}`;
  return parseMemoryCandidate({
    ...typedCommon(item),
    type: 'state_change',
    event: fact,
    cause: '',
    consequence: '',
    entities: [entity],
    aliases: textArray(item['aliases']),
    stateChanges: [{ entity, attribute, before, after }],
    unresolvedThreads: [],
    retrievalText: [sceneText(item), `状态：${fact}`].filter(Boolean).join('；'),
    injectionText: sentence(fact),
  });
}

function stablePair(left: string, right: string): string {
  return [left, right]
    .sort((a, b) => a.normalize('NFKC').localeCompare(b.normalize('NFKC'), 'zh-CN'))
    .join('与');
}

function parseTypedRelationship(value: unknown): ExtractedMemoryCandidate | null {
  const item = record(value);
  const left = text(item['leftEntity'], 300);
  const right = text(item['rightEntity'], 300);
  const relationType = text(item['relationType'], 200) || '关系';
  const before = text(item['before'], 500);
  const after = text(item['after'], 500);
  if (!left || !right || !after) {
    return null;
  }
  const pair = stablePair(left, right);
  const fact = before
    ? `${left}与${right}的${relationType}关系由${before}变为${after}`
    : `${left}与${right}当前为${after}的${relationType}关系`;
  return parseMemoryCandidate({
    ...typedCommon(item),
    type: 'relationship_change',
    event: fact,
    cause: '',
    consequence: '',
    entities: [left, right],
    aliases: [],
    stateChanges: [{
      entity: pair,
      attribute: `${relationType}关系`,
      before,
      after,
    }],
    unresolvedThreads: [],
    retrievalText: [sceneText(item), `关系：${fact}`].filter(Boolean).join('；'),
    injectionText: sentence(fact),
  });
}

const COMMITMENT_STATUS: Readonly<Record<string, string>> = {
  pending: '未完成',
  completed: '已完成',
  cancelled: '已取消',
  failed: '已失败',
};

function parseTypedCommitment(value: unknown): ExtractedMemoryCandidate | null {
  const item = record(value);
  const actor = text(item['actor'], 300);
  const beneficiary = text(item['beneficiary'], 300);
  const action = text(item['action'], 500);
  const object = text(item['object'], 300);
  const rawStatus = text(item['status']);
  const status = COMMITMENT_STATUS[rawStatus] ?? '';
  const previousStatus = COMMITMENT_STATUS[text(item['previousStatus'])]
    ?? text(item['previousStatus'], 100);
  if (!actor || !action || !status) {
    return null;
  }
  const subject = [actor, beneficiary, action, object, '承诺'].filter(Boolean).join('·');
  const task = `${actor}${beneficiary ? `向${beneficiary}` : ''}承诺${action}${object}`;
  const event = rawStatus === 'pending'
    ? `${task}，当前尚未完成`
    : `${task}，当前${status}`;
  return parseMemoryCandidate({
    ...typedCommon(item),
    type: 'commitment',
    event,
    cause: '',
    consequence: '',
    entities: [actor, beneficiary, object].filter(Boolean),
    aliases: [],
    stateChanges: [{
      entity: subject,
      attribute: '完成状态',
      before: previousStatus,
      after: status,
    }],
    unresolvedThreads: rawStatus === 'pending' ? [`${task}仍待完成`] : [],
    retrievalText: [sceneText(item), `承诺：${task}`, `状态：${status}`].filter(Boolean).join('；'),
    injectionText: sentence(event),
  });
}

function parseTypedRevelation(value: unknown): ExtractedMemoryCandidate | null {
  const item = record(value);
  const proposition = text(item['proposition'], 2_000);
  if (!proposition) {
    return null;
  }
  const knownBy = textArray(item['knownBy']);
  const knowledgeState = knownBy.length > 0
    ? [{
        entity: `秘密·${proposition.slice(0, 180)}`,
        attribute: '知情范围',
        before: '',
        after: knownBy.join('、'),
      }]
    : [];
  return parseMemoryCandidate({
    ...typedCommon(item),
    type: 'revelation',
    event: proposition,
    cause: '',
    consequence: '',
    entities: textArray(item['entities']),
    aliases: textArray(item['aliases']),
    stateChanges: knowledgeState,
    unresolvedThreads: [],
    retrievalText: [
      sceneText(item),
      `揭示：${proposition}`,
      knownBy.length > 0 ? `知情者：${knownBy.join('、')}` : '',
    ].filter(Boolean).join('；'),
    injectionText: sentence([
      proposition,
      knownBy.length > 0 ? `此事由${knownBy.join('、')}知情` : '',
    ].filter(Boolean).join('；')),
  });
}

function parseTypedClue(value: unknown): ExtractedMemoryCandidate | null {
  const item = record(value);
  const evidence = text(item['evidence'], 500);
  const observation = text(item['observation'], 1_000);
  const implication = text(item['implication'], 1_000);
  if (!evidence || !observation) {
    return null;
  }
  const event = `${evidence}：${observation}`;
  return parseMemoryCandidate({
    ...typedCommon(item),
    type: 'clue',
    event,
    cause: '',
    consequence: implication,
    entities: [...new Set([evidence, ...textArray(item['entities'])])],
    aliases: textArray(item['aliases']),
    stateChanges: [],
    unresolvedThreads: textArray(item['unresolvedThreads']),
    retrievalText: [sceneText(item), `线索：${event}`, implication ? `含义：${implication}` : '']
      .filter(Boolean).join('；'),
    injectionText: sentence([event, implication ? `它表明${implication}` : ''].filter(Boolean).join('；')),
  });
}

const TYPED_ROOT_KEYS = [
  'episodes',
  'stateFacts',
  'relationships',
  'commitments',
  'revelations',
  'clues',
] as const;

type TypedRootKey = typeof TYPED_ROOT_KEYS[number];

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function hasString(item: Record<string, unknown>, key: string, allowEmpty = true): boolean {
  return typeof item[key] === 'string' && (allowEmpty || Boolean(text(item[key])));
}

function validateTypedCommon(item: Record<string, unknown>): boolean {
  const sourceMessageIds = item['sourceMessageIds'];
  const scene = item['scene'];
  const importance = item['importance'];
  return Array.isArray(sourceMessageIds)
    && sourceMessageIds.length > 0
    && sourceMessageIds.every((id) => Number.isInteger(id) && Number(id) >= 0)
    && isRecord(scene)
    && hasString(scene, 'location')
    && hasString(scene, 'time')
    && isStringArray(scene['participants'])
    && isStringArray(item['knownBy'])
    && TRUTH_STATUSES.has(item['truthStatus'] as TruthStatus)
    && typeof importance === 'number'
    && Number.isFinite(importance)
    && importance >= 0
    && importance <= 1;
}

function validateTypedItem(key: TypedRootKey, value: unknown): boolean {
  if (!isRecord(value) || !validateTypedCommon(value)) {
    return false;
  }
  switch (key) {
    case 'episodes':
      return (value['kind'] === 'event' || value['kind'] === 'conflict')
        && hasString(value, 'action', false)
        && hasString(value, 'cause')
        && hasString(value, 'consequence')
        && isStringArray(value['entities'])
        && isStringArray(value['aliases'])
        && isStringArray(value['unresolvedThreads']);
    case 'stateFacts':
      return hasString(value, 'entity', false)
        && hasString(value, 'attribute', false)
        && hasString(value, 'before')
        && hasString(value, 'after', false)
        && isStringArray(value['aliases']);
    case 'relationships':
      return hasString(value, 'leftEntity', false)
        && hasString(value, 'rightEntity', false)
        && hasString(value, 'relationType')
        && hasString(value, 'before')
        && hasString(value, 'after', false);
    case 'commitments':
      return hasString(value, 'actor', false)
        && hasString(value, 'beneficiary')
        && hasString(value, 'action', false)
        && hasString(value, 'object')
        && hasString(value, 'previousStatus')
        && typeof value['status'] === 'string'
        && Object.prototype.hasOwnProperty.call(COMMITMENT_STATUS, value['status']);
    case 'revelations':
      return hasString(value, 'proposition', false)
        && isStringArray(value['entities'])
        && isStringArray(value['aliases']);
    case 'clues':
      return hasString(value, 'evidence', false)
        && hasString(value, 'observation', false)
        && hasString(value, 'implication')
        && isStringArray(value['entities'])
        && isStringArray(value['aliases'])
        && isStringArray(value['unresolvedThreads']);
  }
}

function parseTypedRoot(root: Record<string, unknown>): ExtractedMemoryCandidate[] | null {
  if (!TYPED_ROOT_KEYS.some((key) => Object.prototype.hasOwnProperty.call(root, key))) {
    return null;
  }
  const parseArray = (
    key: TypedRootKey,
    parse: (value: unknown) => ExtractedMemoryCandidate | null,
  ): ExtractedMemoryCandidate[] => {
    const values = root[key];
    if (!Array.isArray(values)) {
      throw new Error(`抽取结果的${key}必须是数组。`);
    }
    return values.flatMap((value, index) => {
      if (!validateTypedItem(key, value)) {
        throw new Error(`抽取结果的${key}[${index}]不符合结构。`);
      }
      const candidate = parse(value);
      if (!candidate) {
        throw new Error(`抽取结果的${key}[${index}]无法转换为剧情记忆。`);
      }
      return [candidate];
    });
  };
  return [
    ...parseArray('episodes', parseTypedEpisode),
    ...parseArray('stateFacts', parseTypedStateFact),
    ...parseArray('relationships', parseTypedRelationship),
    ...parseArray('commitments', parseTypedCommitment),
    ...parseArray('revelations', parseTypedRevelation),
    ...parseArray('clues', parseTypedClue),
  ].slice(0, 72);
}

export function parseExtractionResponse(raw: string): ExtractedMemoryCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonPayload(raw));
  } catch (error) {
    throw new Error('抽取模型返回的JSON无法解析。', { cause: error });
  }

  const root = record(parsed);
  const typed = parseTypedRoot(root);
  if (typed) {
    return typed;
  }
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

  const candidates = memories.slice(0, 20).flatMap((value) => {
    const candidate = parseMemoryCandidate(value);
    return candidate ? [candidate] : [];
  });
  if (memories.length > 0 && candidates.length === 0) {
    throw new Error('抽取结果包含项目，但没有得到任何合法剧情记忆。');
  }
  return candidates;
}
