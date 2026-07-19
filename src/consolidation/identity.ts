import type { MemoryType, StoryMemory } from '../core/types';
import type { ExtractedMemoryCandidate } from '../extraction/types';

interface IdentityInput {
  type: MemoryType;
  event: string;
  entities: string[];
  aliases: string[];
  stateChanges: Array<{
    entity: string;
    attribute: string;
    before?: string;
    after: string;
  }>;
  unresolvedThreads: string[];
  retrievalText: string;
  injectionText: string;
  logicalKey?: string;
}

export type CanonicalStateKind =
  | 'location'
  | 'holder'
  | 'knowledge'
  | 'commitment'
  | 'truth'
  | 'relationship'
  | `custom:${string}`;

export interface StateIdentity {
  key: string;
  kind: CanonicalStateKind;
  entity: string;
  after: string;
}

const SUBJECT_SUFFIX = /(?:当前位置|当前地点|所在位置|所在地点|藏处|存放位置|存放地点|存放处|安置处|位置|地点|持有者|持有人|保管者|保管人|所有者|知情者|知情范围|完成状态|履行状态|承诺状态|任务状态)$/u;
const COMMITMENT_CUE = /(承诺|约定|任务|义务|履行|兑现|按约|如约)/u;
const COMPLETION_CUE = /(已(?:经)?完成|完成了|已履行|履行完|已兑现|兑现了|按约|如约|已送达|已经?交付|已经?归还|任务结束|承诺完成)/u;

export function normalizeIdentityText(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function canonicalSubject(value: string): string {
  return normalizeIdentityText(value)
    .replace(SUBJECT_SUFFIX, '')
    .replace(/的$/u, '')
    .replace(/^关于/u, '');
}

export function canonicalStateKind(
  attribute: string,
  type?: MemoryType,
): CanonicalStateKind {
  const normalized = normalizeIdentityText(attribute);
  if (/(知情|知晓|知道|秘密.*范围)/u.test(normalized)) {
    return 'knowledge';
  }
  if (/(持有|保管者|保管人|所有者|归属|主人|携带者)/u.test(normalized)) {
    return 'holder';
  }
  if (/(位置|地点|所在|藏处|存放|安置|放置|藏匿|去向)/u.test(normalized)) {
    return 'location';
  }
  if (
    /(承诺|约定|任务|义务|履行|兑现)/u.test(normalized) ||
    (type === 'commitment' && /(状态|完成)/u.test(normalized))
  ) {
    return 'commitment';
  }
  if (/(真假|真伪|核验|传言|存在|是否|事实状态)/u.test(normalized)) {
    return 'truth';
  }
  if (/(关系|好感|信任|敌对|盟友)/u.test(normalized)) {
    return 'relationship';
  }
  return `custom:${normalized}`;
}

export function canonicalStateSlot(
  entity: string,
  attribute: string,
  type?: MemoryType,
): string {
  return `${canonicalStateKind(attribute, type)}\u0000${canonicalSubject(entity)}`;
}

export function stateIdentities(value: IdentityInput): StateIdentity[] {
  return value.stateChanges
    .map((change) => {
      const kind = canonicalStateKind(change.attribute, value.type);
      const entity = canonicalSubject(change.entity);
      return {
        key: `${kind}\u0000${entity}`,
        kind,
        entity,
        after: normalizeIdentityText(change.after),
      };
    })
    .filter((identity) => identity.entity.length >= 2);
}

function commitmentTerms(value: IdentityInput): Set<string> {
  return new Set([...value.entities, ...value.aliases]
    .map(canonicalSubject)
    .filter((term) => term.length >= 2));
}

export function isCommitmentLike(value: IdentityInput): boolean {
  return value.type === 'commitment' ||
    (typeof value.logicalKey === 'string' && value.logicalKey.startsWith('commitment:')) ||
    stateIdentities(value).some((identity) => identity.kind === 'commitment') ||
    COMMITMENT_CUE.test(`${value.event}\n${value.retrievalText}\n${value.injectionText}`);
}

export function isCommitmentCompletion(value: IdentityInput): boolean {
  if (!isCommitmentLike(value) || value.unresolvedThreads.length > 0) {
    return false;
  }
  const completionText = [
    value.event,
    value.retrievalText,
    value.injectionText,
    ...value.stateChanges.map((change) => `${change.attribute}:${change.after}`),
  ].join('\n');
  return COMPLETION_CUE.test(completionText);
}

export function deriveLogicalKey(value: IdentityInput): string {
  const identities = stateIdentities(value);
  const commitment = identities.find((identity) => identity.kind === 'commitment');
  if (commitment) {
    return `commitment:${commitment.entity}`;
  }
  if (value.type === 'commitment') {
    const terms = [...commitmentTerms(value)].sort();
    if (terms.length > 0) {
      return `commitment:${terms.join('|')}`;
    }
  }
  const preferred = identities.find((identity) => !identity.kind.startsWith('custom:')) ?? identities[0];
  if (preferred) {
    return `${preferred.kind}:${preferred.entity}`;
  }
  return `fact:${normalizeIdentityText(value.retrievalText || value.event).slice(0, 180)}`;
}

function storedLogicalKey(value: IdentityInput): string {
  const key = typeof value.logicalKey === 'string' ? value.logicalKey.trim() : '';
  return key || deriveLogicalKey(value);
}

export function commitmentsMatch(left: IdentityInput, right: IdentityInput): boolean {
  if (!isCommitmentLike(left) || !isCommitmentLike(right)) {
    return false;
  }
  const leftKey = storedLogicalKey(left);
  const rightKey = storedLogicalKey(right);
  if (leftKey.startsWith('commitment:') && leftKey === rightKey) {
    return true;
  }

  const leftSlots = new Set(stateIdentities(left)
    .filter((identity) => identity.kind === 'commitment')
    .map((identity) => identity.key));
  if (stateIdentities(right).some((identity) => leftSlots.has(identity.key))) {
    return true;
  }

  const leftTerms = commitmentTerms(left);
  const rightTerms = commitmentTerms(right);
  const shared = [...leftTerms].filter((term) => rightTerms.has(term)).length;
  const smaller = Math.min(leftTerms.size, rightTerms.size);
  return shared >= 3 || (shared >= 2 && shared === smaller && leftTerms.size === rightTerms.size);
}

export function matchingStateIdentities(
  left: IdentityInput,
  right: IdentityInput,
): Array<{ left: StateIdentity; right: StateIdentity }> {
  const rightByKey = new Map(stateIdentities(right).map((identity) => [identity.key, identity]));
  return stateIdentities(left).flatMap((identity) => {
    const match = rightByKey.get(identity.key);
    return match ? [{ left: identity, right: match }] : [];
  });
}

export function relatedMemoryTargets(
  candidate: ExtractedMemoryCandidate,
  memories: StoryMemory[],
): StoryMemory[] {
  return memories.filter((memory) => {
    if (
      memory.manuallyEdited ||
      memory.status === 'invalid' ||
      memory.status === 'superseded'
    ) {
      return false;
    }
    return matchingStateIdentities(candidate, memory).length > 0 ||
      commitmentsMatch(candidate, memory);
  });
}
