import type { ExtractedMemoryCandidate } from './types';

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

function clauses(value: string): string[] {
  return unique(value.split(CLAUSE_SEPARATOR));
}

function safeContext(
  value: string,
  groupTerms: string[],
  otherTerms: string[],
): string {
  return clauses(value)
    .filter((clause) => (
      groupTerms.some((term) => mentions(clause, term)) &&
      !otherTerms.some((term) => mentions(clause, term))
    ))
    .join('；');
}

interface AtomicClause {
  text: string;
  entities: string[];
}

/**
 * Split an extraction candidate when its retrieval text contains multiple
 * disjoint entity facts. This is deliberately conservative: clauses that
 * share an entity stay together because they may describe one event.
 */
export function atomicizeMemoryCandidate(
  candidate: ExtractedMemoryCandidate,
): ExtractedMemoryCandidate[] {
  const atomicClauses: AtomicClause[] = clauses(candidate.retrievalText)
    .map((text) => ({
      text,
      entities: candidate.entities.filter((entity) => mentions(text, entity)),
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
    const aliases = candidate.aliases.filter((alias) => mentions(groupText, alias));
    const stateChanges = candidate.stateChanges.filter((change) => (
      groupTerms.some((term) => mentions(change.entity, term) || mentions(term, change.entity))
    ));
    const unresolvedThreads = candidate.unresolvedThreads.filter((thread) => (
      groupTerms.some((term) => mentions(thread, term)) &&
      !otherTerms.some((term) => mentions(thread, term))
    ));
    const participants = candidate.scene.participants.filter((participant) => (
      mentions(groupText, participant)
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
