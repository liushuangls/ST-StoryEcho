import type { StoryMemory } from '../core/types';
import type { ExtractedMemoryCandidate } from '../extraction/types';

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

function safeClauses(value: string, residualTerms: string[], changedTerms: string[]): string[] {
  return clauses(value).filter((clause) => (
    residualTerms.some((term) => mentions(clause, term)) &&
    !changedTerms.some((term) => mentions(clause, term))
  ));
}

function candidateText(candidate: ExtractedMemoryCandidate): string {
  return [
    candidate.event,
    candidate.cause,
    candidate.consequence,
    candidate.retrievalText,
    candidate.injectionText,
    ...candidate.entities,
    ...candidate.aliases,
    ...candidate.stateChanges.flatMap((change) => [
      change.entity,
      change.attribute,
      change.before,
      change.after,
    ]),
  ].join('\n');
}

/**
 * Preserve a fact that shares a legacy composite memory with a superseded
 * fact. Text is only retained when it forms a self-contained clause that
 * mentions residual entities and no entity touched by the replacement.
 */
export function deriveResidualCandidate(
  target: StoryMemory,
  replacement: ExtractedMemoryCandidate,
): ExtractedMemoryCandidate | null {
  const replacementContent = candidateText(replacement);
  const targetTerms = unique([...target.entities, ...target.aliases]);
  const changedTerms = targetTerms.filter((term) => mentions(replacementContent, term));
  const residualTerms = targetTerms.filter((term) => !changedTerms.includes(term));
  if (changedTerms.length === 0 || residualTerms.length === 0) {
    return null;
  }

  const retrievalClauses = safeClauses(target.retrievalText, residualTerms, changedTerms);
  if (retrievalClauses.length === 0) {
    return null;
  }
  const retrievalText = retrievalClauses.join('；');
  const residualEntities = target.entities.filter((entity) => mentions(retrievalText, entity));
  if (residualEntities.length === 0) {
    return null;
  }
  const residualAliases = target.aliases.filter((alias) => mentions(retrievalText, alias));
  const retainedTerms = unique([...residualEntities, ...residualAliases]);
  const event = safeClauses(target.event, retainedTerms, changedTerms).join('；') || retrievalText;
  const cause = safeClauses(target.cause ?? '', retainedTerms, changedTerms).join('；');
  const consequence = safeClauses(target.consequence ?? '', retainedTerms, changedTerms).join('；');
  const injection = safeClauses(target.injectionText, retainedTerms, changedTerms).join('；') || retrievalText;
  const unresolvedThreads = target.unresolvedThreads.filter((thread) => (
    retainedTerms.some((term) => mentions(thread, term)) &&
    !changedTerms.some((term) => mentions(thread, term))
  ));
  const stateChanges = target.stateChanges
    .filter((change) => retainedTerms.some((term) => (
      mentions(change.entity, term) || mentions(term, change.entity)
    )))
    .map((change) => ({
      entity: change.entity,
      attribute: change.attribute,
      before: change.before ?? '',
      after: change.after,
    }));
  const participants = target.scene.participants.filter((participant) => (
    mentions(retrievalText, participant)
  ));
  const location = target.scene.location && mentions(retrievalText, target.scene.location)
    ? target.scene.location
    : '';
  const time = target.scene.time && mentions(retrievalText, target.scene.time)
    ? target.scene.time
    : '';

  return {
    type: target.type,
    scene: { location, time, participants },
    event,
    cause,
    consequence,
    entities: residualEntities,
    aliases: residualAliases,
    stateChanges,
    unresolvedThreads,
    knownBy: [...target.knownBy],
    truthStatus: target.truthStatus,
    importance: target.importance,
    retrievalText,
    injectionText: /[。.!！?？]$/u.test(injection) ? injection : `${injection}。`,
  };
}
