import type { TavernChatMessage } from '../core/types';
import { storyContent } from '../content/story-content';

const DEFAULT_SCENE_TAIL_CHARACTERS = 500;
const MAX_INTENT_CHARACTERS = 2_000;

const WEAK_INTENT_PATTERNS = [
  /^(继续|继续吧|继续下去|接着|接着说|然后|然后呢|往下|下一步|后续)$/u,
  /^(嗯+|哦+|啊+|好|好的|好吧|行|可以|没问题|知道了|明白了)$/u,
  /^(我)?(跟上去|跟过去|追上去|走过去|进去|过去|上前|点头|摇头|答应|拒绝|看看|听着|等着)$/u,
  /^(goon|continue|next|okay|ok)$/iu,
];

export interface RetrievalQueryPlan {
  intentQuery: string;
  sceneQuery: string;
  keywordIntentQuery: string;
  keywordSceneQuery: string;
  strategy: 'llm' | 'local';
  weakIntent: boolean;
  intentWeight: number;
  sceneWeight: number;
}

function normalizedIntent(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

export function isWeakRetrievalIntent(value: string): boolean {
  const normalized = normalizedIntent(value);
  return normalized.length === 0 || WEAK_INTENT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function previousAssistantMessage(
  messages: TavernChatMessage[],
  currentInputIndex: number,
): TavernChatMessage | undefined {
  for (let index = currentInputIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && !message.is_system && !message.is_user && message.mes.trim()) {
      return message;
    }
  }
  return undefined;
}

export function buildRetrievalQueryPlan(
  messages: TavernChatMessage[],
  currentInputIndex: number,
  sceneTailCharacters = DEFAULT_SCENE_TAIL_CHARACTERS,
): RetrievalQueryPlan {
  const current = messages[currentInputIndex];
  const intentQuery = current?.is_user && !current.is_system
    ? current.mes.trim().slice(0, MAX_INTENT_CHARACTERS)
    : '';
  const sceneTailLimit = Math.max(0, Math.floor(sceneTailCharacters));
  const assistant = previousAssistantMessage(messages, currentInputIndex);
  const scene = assistant ? storyContent(assistant) : '';
  const sceneQuery = sceneTailLimit > 0 ? scene.slice(-sceneTailLimit) : '';
  const weakIntent = isWeakRetrievalIntent(intentQuery);

  return {
    intentQuery,
    sceneQuery,
    keywordIntentQuery: intentQuery,
    keywordSceneQuery: sceneQuery,
    strategy: 'local',
    weakIntent,
    intentWeight: weakIntent ? 0.25 : 1,
    sceneWeight: weakIntent ? 1 : 0.35,
  };
}

export function withRewrittenRetrievalQuery(
  localPlan: RetrievalQueryPlan,
  rewrittenQuery: string,
): RetrievalQueryPlan {
  return {
    ...localPlan,
    intentQuery: rewrittenQuery.trim(),
    sceneQuery: '',
    strategy: 'llm',
    weakIntent: false,
    intentWeight: 1,
    sceneWeight: 0,
  };
}
