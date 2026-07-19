import type { StoryMemory, TavernChatMessage } from '../core/types';
import {
  normalizeIdentityText,
  stateIdentities,
  type CanonicalStateKind,
} from '../consolidation/identity';

const QUESTION_CUE = /[?？]|(?:什么|哪里|何处|谁|是否|怎样|怎么|哪一个|哪件|几人|多少|有没有|是不是|能否|可否)|(?:吗|呢|么|没(?:有)?)$/u;
const ASSERTIVE_UPDATE_CUE = /(?:剧情更新|事实更新|纠正|更正|改为|变为|移到|转移|藏进|放入|取出|取走|交给|交由|转交|新增|不再|已经|已将|仍由|仍在|依然|现由|现位于|当前由|当前位于|知情者|告诉了|完成了|履行了|兑现了|按时归来|并没有|并未|不是|未死|被捕|收服)/u;
const STRONG_CLAUSE = /[^。.!！?？；;\n]+[?？]?/gu;
const COMMA_SEPARATOR = /[，,]+/u;

const KIND_CUES: Record<string, RegExp> = {
  location: /(?:位置|地点|藏处|存放|安置|放置|移到|转移|藏进|放入|取出|位于|藏于|暗格|密室|匣|盒)/u,
  holder: /(?:持有|保管|携带|交给|交由|转交|拿到|取走|不再持有|归属)/u,
  knowledge: /(?:知情|知道|知晓|得知|告诉|秘密|隐瞒|泄露)/u,
  commitment: /(?:承诺|约定|任务|侦查|完成|履行|兑现|如约|按时归来|回报)/u,
  truth: /(?:谣言|事实|确认|否定|并非|并没有|并未|不是|未死|被捕|收服)/u,
  relationship: /(?:关系|信任|敌对|盟友|背叛|和解)/u,
};

function logicalKeyKind(memory: StoryMemory): CanonicalStateKind | null {
  if (memory.logicalKey.startsWith('custom:')) {
    return memory.logicalKey.split(':').slice(0, 2).join(':') as CanonicalStateKind;
  }
  const kind = memory.logicalKey.split(':', 1)[0];
  return ['location', 'holder', 'knowledge', 'commitment', 'truth', 'relationship'].includes(kind ?? '')
    ? kind as CanonicalStateKind
    : null;
}

function memoryKinds(memory: StoryMemory): CanonicalStateKind[] {
  const kinds = stateIdentities(memory).map((identity) => identity.kind);
  const fallback = logicalKeyKind(memory);
  return [...new Set(fallback ? [...kinds, fallback] : kinds)];
}

function memoryTerms(memory: StoryMemory): string[] {
  return [...new Set([
    ...memory.entities,
    ...memory.aliases,
    ...memory.stateChanges.map((change) => change.entity),
  ])]
    .map(normalizeIdentityText)
    .filter((term) => term.length >= 2);
}

function kindIsAsserted(text: string, kind: CanonicalStateKind): boolean {
  if (kind.startsWith('custom:')) {
    return ASSERTIVE_UPDATE_CUE.test(text);
  }
  return KIND_CUES[kind]?.test(text) ?? ASSERTIVE_UPDATE_CUE.test(text);
}

/**
 * A recent explicit User update is more authoritative than an older memory.
 * This conservative shadow only fires for assertions, never for a question
 * that merely names the entity while asking StoryEcho to recall it.
 */
export function isShadowedByRecentUserFact(
  memory: StoryMemory,
  messages: TavernChatMessage[],
  startMessageId: number,
  endMessageId: number,
): boolean {
  const terms = memoryTerms(memory);
  const kinds = memoryKinds(memory);
  if (terms.length === 0 || kinds.length === 0) {
    return false;
  }

  const start = Math.max(0, Math.floor(startMessageId));
  const end = Math.min(messages.length - 1, Math.floor(endMessageId));
  for (let index = start; index <= end; index += 1) {
    const message = messages[index];
    if (!message?.is_user || message.is_system) {
      continue;
    }
    const clauses = (message.mes.match(STRONG_CLAUSE) ?? [])
      .map((clause) => clause.trim())
      .filter(Boolean)
      .flatMap((clause) => (
        QUESTION_CUE.test(clause)
          ? clause.split(COMMA_SEPARATOR).map((part) => part.trim()).filter(Boolean)
          : [clause]
      ));
    for (const clause of clauses) {
      const normalized = normalizeIdentityText(clause);
      if (!terms.some((term) => normalized.includes(term)) || QUESTION_CUE.test(clause)) {
        continue;
      }
      if (
        ASSERTIVE_UPDATE_CUE.test(clause) &&
        kinds.some((kind) => kindIsAsserted(clause, kind))
      ) {
        return true;
      }
    }
  }
  return false;
}
