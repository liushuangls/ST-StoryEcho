import type { StoryMemory, TavernChatMessage } from '../core/types';
import { storyContent } from '../content/story-content';
import type { ExtractedMemoryCandidate } from './types';

export interface RejectedMemoryCandidate {
  candidate: ExtractedMemoryCandidate;
  reason: string;
}

export interface MemoryCandidateAssessment {
  accepted: ExtractedMemoryCandidate[];
  rejected: RejectedMemoryCandidate[];
  removedUnsupportedThreads: string[];
}

const EXPLICIT_UNRESOLVED_CUE = /[?？]|(?:尚未|仍未|还未|还没|不知|不清楚|不明|未解|待查|待确认|待解决|下落不明|去向不明|谜团|悬念)|(?:(?:需要|必须|打算|准备|试图|要).{0,12}(?:寻找|找到|调查|查明|确认|解决|追查))/u;
const INFERENCE_CUE = /(?:可能|也许|或许|似乎|看来|推测|推断|猜测|怀疑|判断|估计|大概|恐怕|假设|如果|除非|要么|还是|意味着|说明|暗示|未证实|尚未确认|无法确认)/u;
const USER_CONFIRMATION_CUE = /(?:确认|确实|没错|正确|正是|事实是|剧情更新|已经|已将|明确|纠正|更正)/u;
const GENERIC_ENTITY = /(?:用户|用户角色|助手|助手角色|叙述者|众人|团队|小组|一行人|失踪者|失踪男子|男子|男人|女人|少女|老人|侦探|警探|警官|医生|护士|店主|老板|列车长|站长|乘客|凶手|嫌疑人|袭击者|死者|受害者|未知人物)$/u;
const GENERIC_OBJECT_OR_PLACE_SUFFIX = /(?:文件袋|证物袋|钥匙|戒指|哨子|罗盘|箱|盒|匣|柜|室|街|路|桥|河|港|站|塔|店|铺|楼|馆|屋|房|门|窗|灯|车|船|枪|刀|剑|杯|信|纸|照片|证物|线索)$/u;
const NAME_TITLE = /^(?:侦探|警探|探长|警官|医生|先生|女士|小姐|太太|夫人|船长|教授|修士|女修|男修|列车长|站长|档案员|会计|守卫|领班|助理|信号员)+|(?:先生|女士|小姐|太太|夫人|侦探|警探|探长|警官|医生|船长|教授|列车长|站长|档案员|会计|守卫|领班|助理|信号员)$/gu;
const COMMON_CHINESE_SURNAME = /^[赵钱孙李周吴郑王冯陈蒋沈韩杨朱秦许何吕张孔曹严华金魏陶姜戚谢邹苏潘葛范彭鲁韦马苗方俞任袁柳史唐薛雷贺倪汤罗郝安常乐傅齐康伍余顾孟黄萧尹姚邵汪毛米贝戴宋熊舒屈项董梁杜蓝季贾江童颜郭梅盛林钟徐高夏蔡田樊胡霍虞万陆荣翁程邢裴莫刘叶白黎谭曾关欧阳司马上官诸葛东方独孤南宫]/u;
const TRANSLITERATED_NAME_ENDING = /(?:斯|特|尔|姆|德|克|森|顿|夫|娜|亚|娅|莎|拉|莉|丽|恩|丁|奇|维|沃|洛)$/u;

function hasDurableStructure(candidate: ExtractedMemoryCandidate): boolean {
  return Boolean(
    candidate.cause ||
    candidate.consequence ||
    candidate.stateChanges.length > 0 ||
    candidate.unresolvedThreads.length > 0 ||
    candidate.knownBy.length >= 2 ||
    candidate.entities.length >= 3
  );
}

function importanceFloor(candidate: ExtractedMemoryCandidate): number {
  if (candidate.type === 'event') {
    return hasDurableStructure(candidate) ? 0.65 : candidate.importance;
  }
  if (candidate.type === 'clue') {
    return 0.6;
  }
  return 0.7;
}

function normalizedEvidenceText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

export function normalizedStoryEntityName(value: string): string {
  return normalizedEvidenceText(value);
}

function likelySpecificName(value: string): boolean {
  const term = value.trim();
  if (term.length < 2 || GENERIC_ENTITY.test(term) || GENERIC_OBJECT_OR_PLACE_SUFFIX.test(term)) {
    return false;
  }
  const untitled = term.replace(NAME_TITLE, '').trim();
  return /[A-Za-z0-9]/u.test(untitled) ||
    untitled.includes('·') ||
    (/^[\u3400-\u9fff]{2,8}$/u.test(untitled) && (
      COMMON_CHINESE_SURNAME.test(untitled) || TRANSLITERATED_NAME_ENDING.test(untitled)
    ));
}

function stateValueSpecificTerms(value: string | undefined): string[] {
  const term = value?.trim() ?? '';
  if (!term) {
    return [];
  }
  const codes = term.match(/(?:[A-Za-z]+[-_]?\d+(?:[-_][A-Za-z0-9]+)*|\d+[-_]?[A-Za-z]+)/gu) ?? [];
  const middleDotNames = term.match(/[\p{L}]{1,16}(?:[·・][\p{L}]{1,16})+/gu) ?? [];
  const exactName = term.length <= 16 &&
    !/(?:存放|位于|藏|转入|移入|保管|持有|交给|归还|失窃|完成|取消|未知|不明|仍在|当前|现在)/u.test(term) &&
    likelySpecificName(term)
    ? [term]
    : [];
  return [...new Set([...codes, ...middleDotNames, ...exactName])];
}

function termIsGrounded(
  term: string,
  evidenceText: string,
  assistantSpeakerNames: readonly string[],
): boolean {
  const normalizedSource = normalizedEvidenceText(evidenceText);
  const normalizedTerm = normalizedEvidenceText(term);
  if (!normalizedTerm || normalizedSource.includes(normalizedTerm)) {
    return true;
  }
  if (assistantSpeakerNames.some((name) => (
    normalizedEvidenceText(name) === normalizedTerm ||
    normalizedEvidenceText(name).includes(normalizedTerm)
  ))) {
    return true;
  }
  const components = term
    .split(/[·・/／()（）【】\[\]“”"'：:]+/u)
    .flatMap((component) => [component, component.replace(NAME_TITLE, '')])
    .map(normalizedEvidenceText)
    .filter((component) => component.length >= 2);
  return components.some((component) => normalizedSource.includes(component));
}

function termIsSupported(
  term: string,
  evidence: CandidateEvidence,
  establishedNames: ReadonlySet<string>,
): boolean {
  return establishedNames.has(normalizedEvidenceText(term)) ||
    termIsGrounded(term, evidence.text, evidence.assistantSpeakerNames);
}

interface CandidateEvidence {
  text: string;
  userText: string;
  assistantText: string;
  assistantSpeakerNames: string[];
}

function candidateEvidence(
  candidate: ExtractedMemoryCandidate,
  messages: readonly TavernChatMessage[] | undefined,
  sourceStartMessageId: number,
  fallbackText: string,
): CandidateEvidence {
  if (!messages) {
    return {
      text: fallbackText,
      userText: '',
      assistantText: '',
      assistantSpeakerNames: [],
    };
  }
  const selected = candidate.sourceMessageIds.flatMap((messageId) => {
    const message = messages[messageId - sourceStartMessageId];
    return message && !message.is_system ? [message] : [];
  });
  const content = (message: TavernChatMessage): string => storyContent(message);
  return {
    text: selected.map(content).join('\n'),
    userText: selected.filter((message) => message.is_user).map(content).join('\n'),
    assistantText: selected.filter((message) => !message.is_user).map(content).join('\n'),
    assistantSpeakerNames: selected
      .filter((message) => !message.is_user)
      .map((message) => message.name?.trim() ?? '')
      .filter(Boolean),
  };
}

function normalizeEvidenceAuthority(
  candidate: ExtractedMemoryCandidate,
  evidence: CandidateEvidence,
  establishedNames: ReadonlySet<string>,
): ExtractedMemoryCandidate {
  const aliases = candidate.aliases.filter((alias) => (
    !likelySpecificName(alias) ||
    termIsSupported(alias, evidence, establishedNames)
  ));
  const sceneParticipants = candidate.scene.participants.filter((participant) => (
    !likelySpecificName(participant) ||
    termIsSupported(participant, evidence, establishedNames)
  ));
  const knownBy = candidate.knownBy.filter((entity) => (
    !likelySpecificName(entity) ||
    termIsSupported(entity, evidence, establishedNames)
  ));
  const candidateText = [
    candidate.event,
    candidate.cause,
    candidate.consequence,
    candidate.retrievalText,
    candidate.injectionText,
  ].join('\n');
  const groundingTerms = [...candidate.entities, ...candidate.stateChanges.map((change) => change.entity)]
    .map(normalizedEvidenceText)
    .filter((term) => term.length >= 2);
  const relevantAssistantText = evidence.assistantText
    .split(/(?<=[。.!！?？；;\n])/u)
    .filter((clause) => {
      const normalized = normalizedEvidenceText(clause);
      return groundingTerms.some((term) => normalized.includes(term));
    })
    .join('\n');
  const assistantInference = INFERENCE_CUE.test(candidateText) || (
    INFERENCE_CUE.test(relevantAssistantText) && [
      'event',
      'clue',
      'revelation',
      'state_change',
    ].includes(candidate.type)
  );
  const normalizedUserText = normalizedEvidenceText(evidence.userText);
  const directlySupportedState = candidate.stateChanges.some((change) => {
    const entity = normalizedEvidenceText(change.entity);
    const after = normalizedEvidenceText(change.after);
    return entity.length >= 2 && after.length >= 2 &&
      normalizedUserText.includes(entity) && normalizedUserText.includes(after);
  });
  const groundedUserEntities = [...new Set(candidate.entities.map(normalizedEvidenceText))]
    .filter((entity) => entity.length >= 2 && normalizedUserText.includes(entity));
  const userDirectSupport = USER_CONFIRMATION_CUE.test(evidence.userText) || (
    !/[?？]/u.test(evidence.userText) &&
    !INFERENCE_CUE.test(evidence.userText) &&
    (directlySupportedState || groundedUserEntities.length >= 2)
  );
  const unsupportedMixedConfirmation = candidate.evidenceRole === 'mixed' &&
    assistantInference &&
    !userDirectSupport;
  const shouldDemote = candidate.truthStatus === 'confirmed' && (
    (candidate.evidenceRole === 'assistant' && assistantInference) ||
    unsupportedMixedConfirmation
  );
  return {
    ...candidate,
    aliases,
    scene: { ...candidate.scene, participants: sceneParticipants },
    knownBy,
    truthStatus: shouldDemote ? 'inferred' : candidate.truthStatus,
  };
}

function unsupportedSpecificNames(
  candidate: {
    entities: readonly string[];
    stateChanges: ReadonlyArray<{ entity: string; before?: string; after: string }>;
  },
  evidence: CandidateEvidence,
  establishedNames: ReadonlySet<string> = new Set(),
): string[] {
  return [...new Set([
    ...candidate.entities,
    ...candidate.stateChanges.map((change) => change.entity),
    ...candidate.stateChanges.flatMap((change) => [
      ...stateValueSpecificTerms(change.before),
      ...stateValueSpecificTerms(change.after),
    ]),
  ].map((term) => term.trim()).filter((term) => (
    likelySpecificName(term) &&
    !termIsSupported(term, evidence, establishedNames)
  )))];
}

/**
 * Read-time guard for memories created by older plugin versions. It does not
 * mutate metadata; rebuilding automatic metadata will permanently remove an
 * unsupported record.
 */
export function unsupportedStoryMemoryNames(
  memory: StoryMemory,
  messages: readonly TavernChatMessage[],
  establishedNames: ReadonlySet<string> = new Set(),
): string[] {
  if (memory.manuallyEdited) {
    return [];
  }
  const selected = memory.sourceMessageIds.flatMap((messageId) => {
    const message = messages[messageId];
    return message && !message.is_system ? [message] : [];
  });
  const evidence: CandidateEvidence = {
    text: selected.map((message) => storyContent(message)).join('\n'),
    userText: selected.filter((message) => message.is_user).map(storyContent).join('\n'),
    assistantText: selected.filter((message) => !message.is_user).map(storyContent).join('\n'),
    assistantSpeakerNames: selected
      .filter((message) => !message.is_user)
      .map((message) => message.name?.trim() ?? '')
      .filter(Boolean),
  };
  return unsupportedSpecificNames(memory, evidence, establishedNames);
}

export function directlyGroundedStoryMemoryNames(
  memory: StoryMemory,
  messages: readonly TavernChatMessage[],
): string[] {
  const specific = [...new Set([
    ...memory.entities,
    ...memory.stateChanges.map((change) => change.entity),
  ].map((term) => term.trim()).filter(likelySpecificName))];
  const unsupported = new Set(unsupportedStoryMemoryNames(memory, messages));
  return specific.filter((name) => !unsupported.has(name));
}

function normalizedCandidate(
  candidate: ExtractedMemoryCandidate,
  sourceText: string,
  removedUnsupportedThreads: string[],
  validMessageIds?: ReadonlySet<number>,
): ExtractedMemoryCandidate {
  const keepUnresolved = !sourceText || EXPLICIT_UNRESOLVED_CUE.test(sourceText);
  if (!keepUnresolved && candidate.unresolvedThreads.length > 0) {
    removedUnsupportedThreads.push(...candidate.unresolvedThreads);
  }
  const normalized = {
    ...candidate,
    sourceMessageIds: [...new Set(candidate.sourceMessageIds)]
      .filter((messageId) => !validMessageIds || validMessageIds.has(messageId))
      .sort((left, right) => left - right),
    unresolvedThreads: keepUnresolved ? candidate.unresolvedThreads : [],
  };
  return {
    ...normalized,
    importance: Math.max(candidate.importance, importanceFloor(normalized)),
  };
}

function rejectionReason(
  candidate: ExtractedMemoryCandidate,
  requireSourceMessageIds: boolean,
): string | null {
  if (requireSourceMessageIds && candidate.sourceMessageIds.length === 0) {
    return `缺少有效源消息ID：${candidate.event.slice(0, 120)}`;
  }
  if (
    candidate.type === 'event' &&
    candidate.importance < 0.6 &&
    !hasDurableStructure(candidate)
  ) {
    return `低价值普通事件：${candidate.event.slice(0, 120)}`;
  }
  return null;
}

/**
 * Apply a conservative deterministic gate after LLM extraction.
 *
 * Models sometimes emit ordinary travel, meals, or "nothing happened" as a
 * generic event with the default importance. Those entries add vector noise
 * without helping future plot decisions. Typed changes and structurally rich
 * events remain eligible even when a provider omits a useful importance score.
 */
export function assessMemoryCandidates(
  candidates: ExtractedMemoryCandidate[],
  sourceText = '',
  validMessageIds?: readonly number[],
  sourceMessages?: readonly TavernChatMessage[],
  sourceStartMessageId = 0,
  establishedNames: ReadonlySet<string> = new Set(),
): MemoryCandidateAssessment {
  const accepted: ExtractedMemoryCandidate[] = [];
  const rejected: RejectedMemoryCandidate[] = [];
  const removedUnsupportedThreads: string[] = [];
  const validMessageIdSet = validMessageIds ? new Set(validMessageIds) : undefined;

  for (const candidate of candidates) {
    const prefiltered = normalizedCandidate(
      candidate,
      candidateEvidence(
        candidate,
        sourceMessages,
        sourceStartMessageId,
        sourceText,
      ).text || sourceText,
      removedUnsupportedThreads,
      validMessageIdSet,
    );
    const evidence = candidateEvidence(
      prefiltered,
      sourceMessages,
      sourceStartMessageId,
      sourceText,
    );
    const unsupportedNames = sourceMessages
      ? unsupportedSpecificNames(prefiltered, evidence, establishedNames)
      : [];
    if (unsupportedNames.length > 0) {
      rejected.push({
        candidate: prefiltered,
        reason: `引用楼层不支持专名：${unsupportedNames.join('、')}｜${prefiltered.event.slice(0, 120)}`,
      });
      continue;
    }
    const normalized = sourceMessages
      ? normalizeEvidenceAuthority(prefiltered, evidence, establishedNames)
      : prefiltered;
    const reason = rejectionReason(normalized, Boolean(validMessageIds));
    if (reason) {
      rejected.push({ candidate: normalized, reason });
      continue;
    }
    accepted.push(normalized);
  }

  return { accepted, rejected, removedUnsupportedThreads };
}
