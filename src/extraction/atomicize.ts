import type { ExtractedMemoryCandidate } from './types';
import { canonicalStateKind, canonicalSubject } from '../consolidation/identity';
import { evidenceRoleRank } from './evidence';

const CLAUSE_SEPARATOR = /[；;。.!！?？\n]+/u;

function normalized(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function mentions(value: string, term: string): boolean {
  const normalizedValue = normalized(value);
  const normalizedTerm = normalized(term);
  return normalizedTerm.length >= 2 && normalizedValue.includes(normalizedTerm);
}

/**
 * Keep a shorter name only when it also occurs outside every matching longer
 * name. Thus “青石台” matches the place, while “青石在青石台” matches both the
 * person and the place.
 */
function distinctMentionedTerms(value: string, terms: string[]): string[] {
  const normalizedValue = normalized(value);
  const matches = new Map<string, string>();
  for (const term of unique(terms)) {
    const key = normalized(term);
    if (key.length >= 2 && normalizedValue.includes(key) && !matches.has(key)) {
      matches.set(key, term);
    }
  }

  return [...matches.entries()].flatMap(([key, term]) => {
    const longerKeys = [...matches.keys()].filter((other) => (
      other.length > key.length && other.includes(key)
    ));
    if (longerKeys.length === 0) {
      return [term];
    }
    let remainder = normalizedValue;
    for (const longer of longerKeys.sort((left, right) => right.length - left.length)) {
      remainder = remainder.split(longer).join('');
    }
    return remainder.includes(key) ? [term] : [];
  });
}

function clauses(value: string): string[] {
  return unique(value.split(CLAUSE_SEPARATOR));
}

function safeContext(
  value: string,
  groupTerms: string[],
  otherTerms: string[],
): string {
  const group = new Set(groupTerms.map(normalized));
  const other = new Set(otherTerms.map(normalized));
  return clauses(value)
    .filter((clause) => {
      const matched = distinctMentionedTerms(clause, [...groupTerms, ...otherTerms])
        .map(normalized);
      return matched.some((term) => group.has(term)) &&
        !matched.some((term) => other.has(term));
    })
    .join('；');
}

interface AtomicClause {
  text: string;
  entities: string[];
}

interface CustodyParts {
  location: string;
  holder: string;
}

function parseCustodyParts(value: string): CustodyParts {
  const normalizedValue = value.trim();
  let location = normalizedValue.match(
    /(?:存放|放置|安置|位于|藏于|藏在|转入|移入)(?:在|于)?\s*([^，,；;]+?)(?=\s*(?:[，,；;]|并?由|$))/u,
  )?.[1]?.trim() ?? '';
  let holder = normalizedValue.match(
    /(?:^|[，,；;]|并)\s*(?:交?由)\s*([^，,；;]+?)(?:负责)?(?:保管|持有|看管)(?:[。.]|$)/u,
  )?.[1]?.trim() ?? normalizedValue.match(
    /(?:保管人|保管者|持有人|持有者)\s*[:：为是]\s*([^，,；;（）()]+)/u,
  )?.[1]?.trim() ?? normalizedValue.match(
    /[（(]\s*([^（）()]+?)(?:负责)?(?:保管|持有|看管)\s*[）)]/u,
  )?.[1]?.trim() ?? '';
  if (!location && holder) {
    const markerIndex = normalizedValue.search(
      /[（(]|(?:[，,；;]\s*)?(?:交?由|保管人|保管者|持有人|持有者)/u,
    );
    location = (markerIndex >= 0 ? normalizedValue.slice(0, markerIndex) : normalizedValue)
      .replace(/^(?:当前|现在|现已|现|仍)?(?:存放|放置|安置|位于|藏于|藏在|转入|移入)?(?:在|于)?\s*/u, '')
      .trim();
  }
  location = location.replace(/[（(]+$/u, '').trim();
  holder = holder.replace(/[）)]+$/u, '').trim();
  return { location, holder };
}

function expandedStateChanges(
  candidate: ExtractedMemoryCandidate,
): ExtractedMemoryCandidate['stateChanges'] {
  return candidate.stateChanges.flatMap((change) => {
    if (!/(?:位置|地点|存放|保管|持有)/u.test(change.attribute)) {
      return [change];
    }
    const after = parseCustodyParts(change.after);
    if (!after.location || !after.holder) {
      return [change];
    }
    const before = parseCustodyParts(change.before ?? '');
    return [
      {
        entity: change.entity,
        attribute: '位置',
        before: before.location,
        after: after.location,
      },
      {
        entity: change.entity,
        attribute: '持有者',
        before: before.holder,
        after: after.holder,
      },
    ];
  });
}

function typeForStateChange(
  candidate: ExtractedMemoryCandidate,
  attribute: string,
): ExtractedMemoryCandidate['type'] {
  const kind = canonicalStateKind(attribute, candidate.type);
  if (kind === 'commitment') {
    return 'commitment';
  }
  if (kind === 'relationship') {
    return 'relationship_change';
  }
  return 'state_change';
}

function atomicizeStateChanges(
  candidate: ExtractedMemoryCandidate,
): ExtractedMemoryCandidate[] | null {
  if (candidate.stateChanges.length === 0) {
    return null;
  }

  const expandedChanges = expandedStateChanges(candidate);
  const uniqueChanges = expandedChanges.filter((change, index, changes) => {
    const key = `${normalized(change.entity)}\u0000${normalized(change.attribute)}`;
    return !changes.slice(index + 1).some((other) => (
      `${normalized(other.entity)}\u0000${normalized(other.attribute)}` === key
    ));
  });

  return uniqueChanges.map((change) => {
    const stateText = change.before
      ? `${change.entity}的${change.attribute}由${change.before}变为${change.after}`
      : `${change.entity}的${change.attribute}当前为${change.after}`;
    const kind = canonicalStateKind(change.attribute, candidate.type);
    const canonicalEntity = canonicalSubject(
      change.entity,
      kind !== 'relationship' && kind !== 'commitment',
    );
    const contextualEntities = distinctMentionedTerms(
      `${change.before ?? ''}\n${change.after}`,
      candidate.entities,
    );
    const groupTerms = unique([
      change.entity,
      ...candidate.entities.filter((entity) => normalized(entity) === canonicalEntity),
      ...contextualEntities,
    ]);
    const grouped = new Set(groupTerms.map(normalized));
    const otherTerms = unique(candidate.entities.filter((entity) => !grouped.has(normalized(entity))));
    const event = safeContext(candidate.event, groupTerms, otherTerms) || stateText;
    const retrievalText = safeContext(candidate.retrievalText, groupTerms, otherTerms) || stateText;
    const injection = safeContext(candidate.injectionText, groupTerms, otherTerms) || stateText;
    const consequence = safeContext(candidate.consequence, groupTerms, otherTerms);
    const cause = safeContext(candidate.cause, groupTerms, otherTerms);
    const aliasContext = `${change.entity}\n${change.before ?? ''}\n${change.after}\n${event}\n${retrievalText}`;
    const matchedAliases = new Set(distinctMentionedTerms(
      aliasContext,
      [...candidate.aliases, ...otherTerms],
    ).map(normalized));
    const aliases = candidate.aliases.filter((alias) => (
      grouped.has(normalized(alias)) || matchedAliases.has(normalized(alias))
    ));
    const unresolvedThreads = candidate.unresolvedThreads.filter((thread) => (
      Boolean(safeContext(thread, groupTerms, otherTerms))
    ));
    const matchedParticipants = new Set(distinctMentionedTerms(
      event,
      [...candidate.scene.participants, ...groupTerms, ...otherTerms],
    ).map(normalized));
    const participants = candidate.scene.participants.filter((participant) => (
      grouped.has(normalized(participant)) || matchedParticipants.has(normalized(participant))
    ));
    return {
      ...candidate,
      type: typeForStateChange(candidate, change.attribute),
      scene: {
        location: kind === 'location'
          ? change.after
          : safeContext(candidate.scene.location, groupTerms, otherTerms),
        time: candidate.scene.time,
        participants,
      },
      event,
      cause,
      consequence,
      entities: groupTerms,
      aliases,
      stateChanges: [change],
      unresolvedThreads,
      retrievalText,
      injectionText: /[。.!！?？]$/u.test(injection) ? injection : `${injection}。`,
    };
  });
}

/**
 * Split an extraction candidate when its retrieval text contains multiple
 * disjoint entity facts. This is deliberately conservative: clauses that
 * share an entity stay together because they may describe one event.
 */
export function atomicizeMemoryCandidate(
  candidate: ExtractedMemoryCandidate,
): ExtractedMemoryCandidate[] {
  const stateChangeMemories = atomicizeStateChanges(candidate);
  if (stateChangeMemories) {
    if (['event', 'conflict', 'revelation', 'clue'].includes(candidate.type)) {
      return [
        { ...candidate, stateChanges: [] },
        ...stateChangeMemories,
      ];
    }
    return stateChangeMemories;
  }

  // Narrative memories are semantic units. Splitting them by punctuation or
  // entity mentions destroys the scene/goal/causal chain and was the source
  // of fragmented real-chat metadata.
  if (['event', 'conflict', 'revelation', 'clue', 'commitment', 'relationship_change'].includes(candidate.type)) {
    return [candidate];
  }

  const atomicClauses: AtomicClause[] = clauses(candidate.retrievalText)
    .map((text) => ({
      text,
      entities: distinctMentionedTerms(text, candidate.entities),
    }))
    .filter((item) => item.entities.length > 0);

  if (atomicClauses.length < 2) {
    return [candidate];
  }

  // Ignore broad recap clauses when more specific clauses already cover the
  // same entities (for example “两件物品的位置均已确认”).
  const minimalClauses = atomicClauses.filter((item, index) => !atomicClauses.some(
    (other, otherIndex) => (
      otherIndex !== index &&
      other.entities.length < item.entities.length &&
      other.entities.every((entity) => item.entities.includes(entity))
    ),
  ));
  if (minimalClauses.length < 2) {
    return [candidate];
  }

  for (let left = 0; left < minimalClauses.length; left += 1) {
    for (let right = left + 1; right < minimalClauses.length; right += 1) {
      if (minimalClauses[left]!.entities.some(
        (entity) => minimalClauses[right]!.entities.includes(entity),
      )) {
        return [candidate];
      }
    }
  }

  return minimalClauses.map((item) => {
    const groupTerms = unique(item.entities);
    const otherTerms = unique(minimalClauses
      .filter((other) => other !== item)
      .flatMap((other) => other.entities));
    const groupText = item.text.trim();
    const injectionText = safeContext(candidate.injectionText, groupTerms, otherTerms) || groupText;
    const event = safeContext(candidate.event, groupTerms, otherTerms) || groupText;
    const cause = safeContext(candidate.cause, groupTerms, otherTerms);
    const consequence = safeContext(candidate.consequence, groupTerms, otherTerms);
    const aliases = distinctMentionedTerms(groupText, candidate.aliases);
    const groupIdentities = new Set(groupTerms.map(normalized));
    const stateChanges = candidate.stateChanges.filter((change) => (
      groupIdentities.has(normalized(change.entity))
    ));
    const unresolvedThreads = candidate.unresolvedThreads.filter((thread) => (
      groupTerms.some((term) => mentions(thread, term)) &&
      !otherTerms.some((term) => mentions(thread, term))
    ));
    const matchedParticipants = new Set(distinctMentionedTerms(
      groupText,
      [...candidate.scene.participants, ...candidate.entities],
    ).map(normalized));
    const participants = candidate.scene.participants.filter((participant) => (
      matchedParticipants.has(normalized(participant))
    ));
    const location = candidate.scene.location && mentions(groupText, candidate.scene.location)
      ? candidate.scene.location
      : '';
    const time = candidate.scene.time && mentions(groupText, candidate.scene.time)
      ? candidate.scene.time
      : '';

    return {
      ...candidate,
      scene: { location, time, participants },
      event,
      cause,
      consequence,
      entities: groupTerms,
      aliases,
      stateChanges,
      unresolvedThreads,
      retrievalText: groupText,
      injectionText: /[。.!！?？]$/u.test(injectionText) ? injectionText : `${injectionText}。`,
    };
  });
}

export function atomicizeMemoryCandidates(
  candidates: ExtractedMemoryCandidate[],
): ExtractedMemoryCandidate[] {
  return candidates.flatMap(atomicizeMemoryCandidate).slice(0, 30);
}

export const normalizeMemoryCandidateByType = atomicizeMemoryCandidate;

export function normalizeCandidatesByType(
  candidates: ExtractedMemoryCandidate[],
  maximumCandidates = 30,
): ExtractedMemoryCandidate[] {
  const typePriority: Record<ExtractedMemoryCandidate['type'], number> = {
    state_change: 7,
    commitment: 6,
    revelation: 5,
    relationship_change: 4,
    clue: 3,
    conflict: 2,
    event: 1,
  };
  const sorted = candidates
    .flatMap(normalizeMemoryCandidateByType)
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => {
      const priority = (candidate: ExtractedMemoryCandidate): number => {
        const explicitTransition = candidate.truthStatus === 'confirmed' &&
          candidate.stateChanges.some((change) => (
            Boolean(change.before?.trim()) && normalized(change.before ?? '') !== normalized(change.after)
          ));
        const truthPriority = candidate.truthStatus === 'confirmed'
          ? 3
          : candidate.truthStatus === 'claimed'
            ? 2
            : candidate.truthStatus === 'inferred'
              ? 1
              : 0;
        return (
          (explicitTransition ? 10_000 : 0) +
          typePriority[candidate.type] * 1_000 +
          truthPriority * 200 +
          candidate.importance * 100 +
          evidenceRoleRank(candidate.evidenceRole) * 10
        );
      };
      return priority(right.candidate) - priority(left.candidate) || left.index - right.index;
    });
  const limit = Math.max(0, Math.floor(maximumCandidates));
  if (sorted.length <= limit) {
    return sorted.map(({ candidate }) => candidate);
  }

  // Preserve at least one accepted memory from each represented semantic
  // class before filling the remaining slots by priority. This prevents a
  // dense list of atomic state facts from erasing the causal episode that
  // explains why those states changed.
  const selected = new Set<number>();
  const selectedTypes = new Set<ExtractedMemoryCandidate['type']>();
  for (const item of sorted) {
    if (!selectedTypes.has(item.candidate.type) && selected.size < limit) {
      selected.add(item.index);
      selectedTypes.add(item.candidate.type);
    }
  }
  for (const item of sorted) {
    if (selected.size >= limit) {
      break;
    }
    selected.add(item.index);
  }
  return sorted
    .filter((item) => selected.has(item.index))
    .map(({ candidate }) => candidate);
}
