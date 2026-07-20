import { sha256 } from '../core/hash';
import { logger } from '../core/logger';
import type { StoryEchoChatState, TavernChatMessage } from '../core/types';
import { storyContent } from '../content/story-content';
import { recordDebugTrace } from '../debug/metrics';
import { countCompletedTurns, planNextChunk } from '../extraction/chunk-planner';
import { completeWithConfiguredProvider } from '../llm/complete';
import { MemoryRepository } from '../memory/repository';
import { getContext, getCurrentChatId, type SillyTavernContext } from '../platform/sillytavern';
import { firstStoryPhaseBoundary } from '../retrieval/story-phase';
import { SettingsRepository } from '../settings/repository';
import {
  buildStageSummaryGrounding,
  buildStageSummaryPrompt,
  STAGE_SUMMARY_SYSTEM_PROMPT,
} from './prompts';

const MAX_SUMMARY_SOURCE_CHARACTERS = 32_000;
const MAX_STORED_SUMMARY_CHARACTERS = 64_000;
export const REQUIRED_SUMMARY_HEADINGS = [
  '【已确认剧情】',
  '【当前状态】',
  '【未解决线索】',
  '【角色主张与推测】',
  '【已失效或否定事实】',
] as const;

const UNRESOLVED_CUE = /(?:仍|尚|还)?(?:未知|未明|不清楚|未确认|待确认|有待查明)/u;
const SUMMARY_SENTENCE = /[^。.!！?？；;\n]+/gu;
const SUMMARY_STABLE_IDENTIFIER = /(?:[A-Za-z]+[-_]?\d+(?:[-_][A-Za-z0-9]+)*|\d+[-_]?[A-Za-z]+)/gu;
const NEGATED_RESOLUTION = /(?:未|没有|并未|无法|不能|不可).{0,6}(?:确认|查明|使用|利用|用于|用来|找到|确定)/u;
const UNRESOLVED_RESOLUTION_RESULT = /(?:不在|未在|没有找到|尚未找到)|(?:(?:使用|利用).{0,30}(?:失败|未成功|没有成功|没有结果|仍未|未知|未明))|(?:(?:下落|位置|身份|用途|真伪).{0,8}(?:仍|尚|还)?(?:未知|未明|未确认))/u;
const UNRESOLVED_ATTRIBUTES = [
  {
    cue: /(?:用途|作用)/u,
    resolved: /(?:用途(?:是|为)|用于|用来|可用于|使用|利用|凭借).{0,36}(?:打开|开启|解锁|进入|启动|验证|证明|定位|追踪|交换|识别)?/u,
  },
  {
    cue: /(?:位置|地点|下落|去向)/u,
    resolved: /(?:位于|在|藏于|藏在|存放于|存放在|移到|转移到|交到)/u,
  },
  {
    cue: /(?:持有者|保管者|归属)/u,
    resolved: /(?:由.{0,16}(?:持有|保管|携带)|交给|交由|归还给|归属)/u,
  },
  {
    cue: /(?:身份|姓名|真名)/u,
    resolved: /(?:身份(?:是|为)|名叫|姓名(?:是|为)|真名(?:是|为)|就是)/u,
  },
  {
    cue: /(?:真伪|真假)/u,
    resolved: /(?:确认为|证实为|是真|是伪|伪造|真品|赝品)/u,
  },
] as const;

export interface StageSummaryProgress {
  startMessageId: number;
  endMessageId: number;
  targetEndMessageId: number;
}

export interface StageSummaryRunResult {
  state: StoryEchoChatState | null;
  updatedChunks: number;
}

interface StageSummaryRunOptions {
  maxChunks: number;
  onProgress?: (progress: StageSummaryProgress) => void;
}

function sourcePayload(messages: TavernChatMessage[], sourceStartMessageId: number): string {
  return JSON.stringify(messages.map((message, offset) => ({
    messageId: sourceStartMessageId + offset,
    isUser: message.is_user,
    isSystem: Boolean(message.is_system),
    name: message.name || '',
    content: message.mes,
  })));
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizedSummaryTerm(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function sectionBodies(summary: string): Array<{ heading: string; body: string }> | null {
  const positions = REQUIRED_SUMMARY_HEADINGS.map((heading) => summary.indexOf(heading));
  if (positions.some((position) => position < 0)) {
    return null;
  }
  return REQUIRED_SUMMARY_HEADINGS.map((heading, index) => ({
    heading,
    body: summary.slice(
      positions[index]! + heading.length,
      positions[index + 1] ?? summary.length,
    ).trim(),
  }));
}

function unresolvedSubjects(line: string, attributeCue: RegExp): string[] {
  const identifiers = line.match(SUMMARY_STABLE_IDENTIFIER) ?? [];
  const attributeIndex = line.search(attributeCue);
  const prefix = attributeIndex > 0
    ? line.slice(Math.max(0, attributeIndex - 32), attributeIndex)
      .replace(/^[\s\-*•·：:，,；;。.!！?？]+/u, '')
      .replace(/(?:的)$/u, '')
      .trim()
    : '';
  return [...new Set([...identifiers, ...(prefix.length >= 2 ? [prefix] : [])])]
    .map(normalizedSummaryTerm)
    .filter((term) => term.length >= 2);
}

function unresolvedLineWasResolved(line: string, resolvedText: string): boolean {
  if (!UNRESOLVED_CUE.test(line)) {
    return false;
  }
  const rule = UNRESOLVED_ATTRIBUTES.find(({ cue }) => cue.test(line));
  if (!rule) {
    return false;
  }
  const subjects = unresolvedSubjects(line, rule.cue);
  if (subjects.length === 0) {
    return false;
  }
  return (resolvedText.match(SUMMARY_SENTENCE) ?? []).some((sentence) => {
    const normalizedSentence = normalizedSummaryTerm(sentence);
    return subjects.some((subject) => normalizedSentence.includes(subject)) &&
      !NEGATED_RESOLUTION.test(sentence) &&
      !UNRESOLVED_RESOLUTION_RESULT.test(sentence) &&
      rule.resolved.test(sentence);
  });
}

/** Remove only a clearly resolved attribute accidentally repeated as unresolved. */
export function removeResolvedSummaryThreads(summary: string): string {
  const sections = sectionBodies(summary);
  if (!sections) {
    return summary;
  }
  const resolvedText = sections
    .filter(({ heading }) => heading === '【已确认剧情】' || heading === '【当前状态】')
    .map(({ body }) => body)
    .join('\n');
  let removedThread = false;
  const rebuilt = sections.map(({ heading, body }) => {
    if (heading !== '【未解决线索】') {
      return `${heading}\n${body || '无'}`;
    }
    const originalLines = body.split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const lines = originalLines.filter((line) => !unresolvedLineWasResolved(line, resolvedText));
    removedThread ||= lines.length < originalLines.length;
    return `${heading}\n${lines.length > 0 ? lines.join('\n') : '无'}`;
  });
  return removedThread ? rebuilt.join('\n') : summary;
}

function summaryIdentity(context: SillyTavernContext): {
  userUiPersona: string;
  assistantCharacter: string;
} {
  const character = Number.isInteger(context.characterId)
    ? context.characters?.[context.characterId!]
    : undefined;
  return {
    userUiPersona: context.name1?.trim() ?? '',
    assistantCharacter: context.name2?.trim() || character?.name?.trim() || '',
  };
}

export function normalizeSummary(
  raw: string,
  sourceMessages: TavernChatMessage[] = [],
  userUiPersona = '',
  requireSections = false,
): string {
  const withoutFence = raw
    .trim()
    .replace(/^```(?:text|markdown|md)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const withoutWrapper = withoutFence
    .replace(/^<story_echo_summary>\s*/i, '')
    .replace(/\s*<\/story_echo_summary>$/i, '')
    .replace(/<\/?story_echo_(?:summary|recall)>/gi, '')
    .trim();
  if (!withoutWrapper) {
    throw new Error('阶段总结模型返回了空内容。');
  }
  if (requireSections) {
    let previousIndex = -1;
    for (const heading of REQUIRED_SUMMARY_HEADINGS) {
      const index = withoutWrapper.indexOf(heading);
      if (index < 0 || index <= previousIndex) {
        throw new Error(`阶段总结缺少或打乱分级标题：${heading}`);
      }
      previousIndex = index;
    }
  }
  const sourceText = sourceMessages.map((message) => storyContent(message)).join('\n');
  const persona = userUiPersona.trim();
  const identitySafe = persona.length >= 2 && !sourceText.includes(persona)
    ? withoutWrapper.replace(new RegExp(escapedRegExp(persona), 'gu'), '用户角色')
    : withoutWrapper;
  const consistencySafe = requireSections
    ? removeResolvedSummaryThreads(identitySafe)
    : identitySafe;
  if (consistencySafe.length > MAX_STORED_SUMMARY_CHARACTERS) {
    throw new Error('阶段总结模型返回内容过长。');
  }
  return consistencySafe;
}

function assertChatOwner(state: StoryEchoChatState): void {
  if (getCurrentChatId() !== state.ownerChatId) {
    throw new Error('阶段总结期间聊天发生切换，已取消写入。');
  }
}

export class StageSummaryService {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly settingsRepository = new SettingsRepository();
  private readonly memoryRepository = new MemoryRepository();

  /**
   * Validate summary entries independently from the structured-memory index.
   * This is required by the LLM-only mode, where indexedThroughMessageId is
   * intentionally left untouched because extraction and vectors are disabled.
   */
  async reconcileHistory(
    state?: StoryEchoChatState,
  ): Promise<StoryEchoChatState | null> {
    const current = state ?? await this.memoryRepository.getOrCreate();
    if (!current || current.stageSummary.entries.length === 0) {
      return current;
    }
    if (getCurrentChatId() !== current.ownerChatId) {
      throw new Error('校验阶段总结期间聊天发生切换，已取消任务。');
    }

    const context = getContext();
    let validEntries = 0;
    let initializedHashes = 0;
    for (const entry of current.stageSummary.entries) {
      if (
        entry.sourceStartMessageId < 0 ||
        entry.sourceEndMessageId < entry.sourceStartMessageId ||
        entry.sourceEndMessageId >= context.chat.length
      ) {
        break;
      }
      const actualHash = await sha256(sourcePayload(
        context.chat.slice(entry.sourceStartMessageId, entry.sourceEndMessageId + 1),
        entry.sourceStartMessageId,
      ));
      if (entry.sourceHash && entry.sourceHash !== actualHash) {
        break;
      }
      if (!entry.sourceHash) {
        entry.sourceHash = actualHash;
        initializedHashes += 1;
      }
      validEntries += 1;
    }

    if (validEntries === current.stageSummary.entries.length) {
      if (initializedHashes > 0) {
        const latest = current.stageSummary.entries.at(-1)!;
        current.stageSummary.coveredThroughHash = latest.sourceHash;
        await this.memoryRepository.save(current);
      }
      return current;
    }

    const removedEntries = current.stageSummary.entries.length - validEntries;
    const entries = current.stageSummary.entries.slice(0, validEntries);
    const latest = entries.at(-1);
    current.stageSummary = {
      entries,
      coveredThroughMessageId: latest?.sourceEndMessageId ?? -1,
      coveredThroughHash: latest?.sourceHash ?? '',
      ...(latest ? { updatedAt: latest.updatedAt } : {}),
    };
    delete current.lastInspection;
    recordDebugTrace(current, this.settingsRepository.get().debug, 'summary', '聊天历史变化后已截断失效阶段总结。', {
      removedEntries,
      coveredThroughMessageId: current.stageSummary.coveredThroughMessageId,
    });
    await this.memoryRepository.save(current);
    return current;
  }

  processNextThrough(
    targetEndMessageId: number,
    onProgress?: (progress: StageSummaryProgress) => void,
  ): Promise<StageSummaryRunResult> {
    return this.enqueue(targetEndMessageId, {
      maxChunks: 1,
      ...(onProgress ? { onProgress } : {}),
    });
  }

  processAllThrough(
    targetEndMessageId: number,
    onProgress?: (progress: StageSummaryProgress) => void,
  ): Promise<StageSummaryRunResult> {
    return this.enqueue(targetEndMessageId, {
      maxChunks: Number.MAX_SAFE_INTEGER,
      ...(onProgress ? { onProgress } : {}),
    });
  }

  private enqueue(
    targetEndMessageId: number,
    options: StageSummaryRunOptions,
  ): Promise<StageSummaryRunResult> {
    const requestedChatId = getCurrentChatId();
    const operation = this.queue.then(
      () => this.processNow(targetEndMessageId, requestedChatId, options),
      () => this.processNow(targetEndMessageId, requestedChatId, options),
    );
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async processNow(
    targetEndMessageId: number,
    requestedChatId: string | null,
    options: StageSummaryRunOptions,
  ): Promise<StageSummaryRunResult> {
    if (!requestedChatId || getCurrentChatId() !== requestedChatId) {
      throw new Error('等待阶段总结期间聊天发生切换，已取消任务。');
    }
    const context = getContext();
    const settings = this.settingsRepository.get();
    let state = await this.memoryRepository.getOrCreate();
    if (!state) {
      return { state, updatedChunks: 0 };
    }
    assertChatOwner(state);

    // Full memory mode waits for structured extraction so the summary can use
    // its authoritative correction ledger. LLM-only mode owns an independent
    // source hash and can advance without touching the extraction cursor.
    const memoryCoverageLimit = settings.memory.enabled
      ? state.indexedThroughMessageId
      : Math.floor(targetEndMessageId);
    const maximumEnd = Math.min(
      Math.floor(targetEndMessageId),
      memoryCoverageLimit,
      context.chat.length - 1,
    );
    let start = state.stageSummary.coveredThroughMessageId + 1;
    let updatedChunks = 0;
    if (start > maximumEnd) {
      return { state, updatedChunks };
    }

    try {
      while (start <= maximumEnd && updatedChunks < options.maxChunks) {
        const plannedChunk = planNextChunk(
          context.chat,
          start,
          maximumEnd,
          settings.summary.targetTurnsPerUpdate,
          MAX_SUMMARY_SOURCE_CHARACTERS,
        );
        if (!plannedChunk) {
          break;
        }
        const boundaryMessageId = firstStoryPhaseBoundary(
          context.chat,
          plannedChunk.startMessageId + 1,
          plannedChunk.endMessageId,
        );
        const splitBeforeBoundary = boundaryMessageId !== null &&
          boundaryMessageId > plannedChunk.startMessageId;
        const chunk = splitBeforeBoundary
          ? { ...plannedChunk, endMessageId: boundaryMessageId - 1 }
          : plannedChunk;
        const snapshot = context.chat
          .slice(chunk.startMessageId, chunk.endMessageId + 1)
          .map((message) => ({
            is_user: message.is_user,
            is_system: Boolean(message.is_system),
            ...(message.name ? { name: message.name } : {}),
            mes: message.mes,
          }));
        // An explicit story-phase transition closes the preceding summary even
        // when it contains fewer than N turns. This prevents one immutable
        // summary entry from mixing facts from two otherwise isolated phases.
        const hasFullTurnBatch = countCompletedTurns(snapshot) >= settings.summary.targetTurnsPerUpdate ||
          (splitBeforeBoundary && snapshot.some((message) => (
            !message.is_system && storyContent(message).length > 0
          )));
        if (!hasFullTurnBatch) {
          break;
        }

        const startedAt = performance.now();
        const snapshotHash = await sha256(sourcePayload(snapshot, chunk.startMessageId));
        const identity = summaryIdentity(context);
        const authoritativeFacts = settings.memory.enabled
          ? buildStageSummaryGrounding(
              state.memories,
              chunk.startMessageId,
              chunk.endMessageId,
            )
          : '';
        const raw = await completeWithConfiguredProvider(settings, {
          system: STAGE_SUMMARY_SYSTEM_PROMPT,
          prompt: buildStageSummaryPrompt(
            snapshot,
            chunk.startMessageId,
            identity,
            authoritativeFacts,
          ),
          maxTokens: settings.summary.maxTokens,
        });
        // Detect a branch/edit before accepting even the summary format, so a
        // stale request is always reported and discarded for the right cause.
        const currentChat = getContext().chat;
        const currentHash = await sha256(sourcePayload(
          currentChat.slice(chunk.startMessageId, chunk.endMessageId + 1),
          chunk.startMessageId,
        ));
        if (currentHash !== snapshotHash) {
          throw new Error('阶段总结期间源消息发生变化，已丢弃本次结果。');
        }
        const text = normalizeSummary(raw, snapshot, identity.userUiPersona, true);
        const identitySafeWithoutConsistency = normalizeSummary(
          raw,
          snapshot,
          identity.userUiPersona,
        );
        const withoutPersonaSanitization = normalizeSummary(raw, snapshot, '', true);
        // Read the live chat again instead of trusting the context object
        // captured before the LLM call. SillyTavern can replace the chat array
        // when a message is edited or a branch is switched while generation is
        // in flight.
        const commitChat = getContext().chat;
        const commitHash = await sha256(sourcePayload(
          commitChat.slice(chunk.startMessageId, chunk.endMessageId + 1),
          chunk.startMessageId,
        ));
        if (commitHash !== snapshotHash) {
          throw new Error('阶段总结期间源消息发生变化，已丢弃本次结果。');
        }

        assertChatOwner(state);
        const updatedAt = new Date().toISOString();
        state.stageSummary.entries.push({
          text,
          sourceStartMessageId: chunk.startMessageId,
          sourceEndMessageId: chunk.endMessageId,
          sourceHash: snapshotHash,
          updatedAt,
        });
        state.stageSummary = {
          entries: state.stageSummary.entries,
          coveredThroughMessageId: chunk.endMessageId,
          coveredThroughHash: snapshotHash,
          updatedAt,
        };
        state.metrics.summaryUpdates += 1;
        state.metrics.summaryMessagesCovered += snapshot.length;
        state.metrics.totalSummaryMs += Math.round(performance.now() - startedAt);
        state.metrics.lastSummaryAt = updatedAt;
        recordDebugTrace(state, settings.debug, 'summary', '阶段总结条目已生成。', {
          range: `${chunk.startMessageId}-${chunk.endMessageId}`,
          summaryCharacters: text.length,
          summaryEntries: state.stageSummary.entries.length,
          personaLabelSanitized: text !== withoutPersonaSanitization,
          summaryConsistencyAdjusted: text !== identitySafeWithoutConsistency,
          authoritativeFactCharacters: authoritativeFacts.length,
        });
        await this.memoryRepository.save(state);
        updatedChunks += 1;
        options.onProgress?.({
          startMessageId: chunk.startMessageId,
          endMessageId: chunk.endMessageId,
          targetEndMessageId: maximumEnd,
        });
        start = chunk.endMessageId + 1;
      }
    } catch (error) {
      state.metrics.summaryFailures += 1;
      recordDebugTrace(state, settings.debug, 'error', '阶段总结条目生成失败。', {
        error: error instanceof Error ? error.message : String(error),
        startMessageId: start,
        targetEndMessageId: maximumEnd,
      });
      try {
        assertChatOwner(state);
        await this.memoryRepository.save(state);
      } catch (saveError) {
        logger.warn('保存阶段总结失败统计时聊天已切换或元数据不可用。', saveError);
      }
      throw error;
    }

    return { state, updatedChunks };
  }
}

export const stageSummaryService = new StageSummaryService();
