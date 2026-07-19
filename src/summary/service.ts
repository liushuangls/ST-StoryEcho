import { sha256 } from '../core/hash';
import { logger } from '../core/logger';
import type { StoryEchoChatState, TavernChatMessage } from '../core/types';
import { storyContent } from '../content/story-content';
import { recordDebugTrace } from '../debug/metrics';
import { countCompletedTurns, planNextChunk } from '../extraction/chunk-planner';
import { completeWithConfiguredProvider } from '../llm/complete';
import { MemoryRepository } from '../memory/repository';
import { getContext, getCurrentChatId, type SillyTavernContext } from '../platform/sillytavern';
import { SettingsRepository } from '../settings/repository';
import { buildStageSummaryPrompt, STAGE_SUMMARY_SYSTEM_PROMPT } from './prompts';

const MAX_SUMMARY_SOURCE_CHARACTERS = 32_000;
const MAX_STORED_SUMMARY_CHARACTERS = 64_000;

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
  const sourceText = sourceMessages.map((message) => storyContent(message)).join('\n');
  const persona = userUiPersona.trim();
  const identitySafe = persona.length >= 2 && !sourceText.includes(persona)
    ? withoutWrapper.replace(new RegExp(escapedRegExp(persona), 'gu'), '用户角色')
    : withoutWrapper;
  if (identitySafe.length > MAX_STORED_SUMMARY_CHARACTERS) {
    throw new Error('阶段总结模型返回内容过长。');
  }
  return identitySafe;
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
    if (!state || !settings.summary.enabled) {
      return { state, updatedChunks: 0 };
    }
    assertChatOwner(state);

    // A summary never advances beyond the structured memory index. This makes
    // the existing indexed-prefix fingerprint authoritative for edit/delete
    // invalidation of both derived stores.
    const maximumEnd = Math.min(
      Math.floor(targetEndMessageId),
      state.indexedThroughMessageId,
      context.chat.length - 1,
    );
    let start = state.stageSummary.coveredThroughMessageId + 1;
    let updatedChunks = 0;
    if (start > maximumEnd) {
      return { state, updatedChunks };
    }

    try {
      while (start <= maximumEnd && updatedChunks < options.maxChunks) {
        const chunk = planNextChunk(
          context.chat,
          start,
          maximumEnd,
          settings.summary.targetTurnsPerUpdate,
          MAX_SUMMARY_SOURCE_CHARACTERS,
        );
        if (!chunk) {
          break;
        }
        const snapshot = context.chat
          .slice(chunk.startMessageId, chunk.endMessageId + 1)
          .map((message) => ({
            is_user: message.is_user,
            is_system: Boolean(message.is_system),
            ...(message.name ? { name: message.name } : {}),
            mes: message.mes,
          }));
        const hasFullTurnBatch = (
          countCompletedTurns(snapshot) >= settings.summary.targetTurnsPerUpdate
        );
        if (!hasFullTurnBatch) {
          break;
        }

        const startedAt = performance.now();
        const snapshotHash = await sha256(sourcePayload(snapshot, chunk.startMessageId));
        const identity = summaryIdentity(context);
        const raw = await completeWithConfiguredProvider(settings, {
          system: STAGE_SUMMARY_SYSTEM_PROMPT,
          prompt: buildStageSummaryPrompt(
            snapshot,
            chunk.startMessageId,
            identity,
          ),
          maxTokens: settings.summary.maxTokens,
        });
        const text = normalizeSummary(raw, snapshot, identity.userUiPersona);
        // Read the live chat again instead of trusting the context object
        // captured before the LLM call. SillyTavern can replace the chat array
        // when a message is edited or a branch is switched while generation is
        // in flight.
        const currentChat = getContext().chat;
        const currentHash = await sha256(sourcePayload(
          currentChat.slice(chunk.startMessageId, chunk.endMessageId + 1),
          chunk.startMessageId,
        ));
        if (currentHash !== snapshotHash) {
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
          personaLabelSanitized: text !== normalizeSummary(raw, snapshot),
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
