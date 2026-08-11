import { sha256 } from '../core/hash';
import { logger } from '../core/logger';
import type {
  StageSummaryEntry,
  StoryEchoChatState,
  StoryEchoSettings,
  SummaryCompactionSource,
  TavernChatMessage,
} from '../core/types';
import { mergeInternalLlmAttempts } from '../debug/internal-llm-attempts';
import { mergeDebugTraces, recordDebugTrace } from '../debug/metrics';
import { completeObservedInternalRequest } from '../llm/observed-completion';
import { getContext, getCurrentChatId } from '../platform/sillytavern';
import { buildSummaryCompactionWorldInfoReferenceContext } from '../reference/context';
import { isStoryEchoTaskCancelledError } from '../runtime/task-cancellation';
import { SettingsRepository } from '../settings/repository';
import { StoryStateRepository } from '../state/repository';
import {
  buildSummaryCompactionPrompt,
  summaryCompactionSystemPrompt,
} from './compaction-prompts';
import {
  configuredSummaryCompactionThresholds,
  findSummaryCompactionCandidate,
  sameSummaryEntries,
  summaryCompactionDue,
  summaryCompactionInput,
  summaryCompactionSource,
} from './compaction-state';
import { SUMMARY_LLM_TIMEOUT_MS } from './constants';
import { normalizeSummary } from './service';
import { summarySourcePayload } from './source';

export interface SummaryCompactionProgress {
  sourceStartMessageId: number;
  sourceEndMessageId: number;
  sourceLevel: number;
  targetLevel: number;
  pending: boolean;
}

export interface SummaryCompactionRunResult {
  state: StoryEchoChatState | null;
  compactedChunks: number;
  pending: boolean;
}

export interface SummaryCompactionRegenerationResult {
  state: StoryEchoChatState;
  entry: StageSummaryEntry;
  previousCharacterCount: number;
}

interface GeneratedCompaction {
  text: string;
  generation?: StageSummaryEntry['generation'];
  durationMs: number;
}

function assertChatOwner(state: StoryEchoChatState): void {
  if (getCurrentChatId() !== state.ownerChatId) {
    throw new Error('高层总结压缩期间聊天发生切换，已取消写入。');
  }
}

function updateSummaryCoverage(state: StoryEchoChatState): void {
  const latest = state.stageSummary.entries.at(-1);
  const rebuildCheckpoint = state.stageSummary.rebuildCheckpoint;
  state.stageSummary = {
    entries: state.stageSummary.entries,
    coveredThroughMessageId: latest?.sourceEndMessageId ?? -1,
    coveredThroughHash: latest?.sourceHash ?? '',
    ...(latest ? { updatedAt: latest.updatedAt } : {}),
    ...(rebuildCheckpoint ? { rebuildCheckpoint } : {}),
  };
}

export class SummaryCompactionService {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly settingsRepository = new SettingsRepository();
  private readonly stateRepository = new StoryStateRepository();

  processNextIfNeeded(
    onProgress?: (progress: SummaryCompactionProgress) => void,
  ): Promise<SummaryCompactionRunResult> {
    return this.enqueue(1, onProgress);
  }

  processAllPending(
    onProgress?: (progress: SummaryCompactionProgress) => void,
  ): Promise<SummaryCompactionRunResult> {
    return this.enqueue(Number.MAX_SAFE_INTEGER, onProgress);
  }

  private enqueue(
    maxChunks: number,
    onProgress?: (progress: SummaryCompactionProgress) => void,
  ): Promise<SummaryCompactionRunResult> {
    const requestedChatId = getCurrentChatId();
    const operation = this.queue.then(
      () => this.processNow(requestedChatId, maxChunks, onProgress),
      () => this.processNow(requestedChatId, maxChunks, onProgress),
    );
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async buildWorldBackground(
    state: StoryEchoChatState,
    sources: readonly SummaryCompactionSource[],
    settings: StoryEchoSettings,
  ): Promise<string> {
    const referenceMessages: TavernChatMessage[] = sources
      .filter((source) => !source.deleted && source.text.trim())
      .map((source) => ({ is_user: false, is_system: false, mes: source.text }));
    if (referenceMessages.length === 0) {
      return '';
    }
    try {
      const reference = await buildSummaryCompactionWorldInfoReferenceContext(
        referenceMessages,
        settings.summary.reference,
      );
      recordDebugTrace(state, settings.debug, 'summary', '高层总结世界书背景已构建。', {
        tokens: reference.tokenCount,
        worldInfoEntries: reference.worldInfoEntries.join(',') || '-',
        truncated: reference.truncated,
        warnings: reference.warnings.join(' | ') || '-',
      });
      return reference.text;
    } catch (error) {
      recordDebugTrace(state, settings.debug, 'error', '高层总结世界书背景构建失败，继续仅使用来源总结。', {
        error: error instanceof Error ? error.message : String(error),
      });
      return '';
    }
  }

  private async generate(
    state: StoryEchoChatState,
    settings: StoryEchoSettings,
    sources: readonly SummaryCompactionSource[],
    targetLevel: number,
  ): Promise<GeneratedCompaction> {
    if (sources.every((source) => source.deleted)) {
      return { text: '', durationMs: 0 };
    }
    const startedAt = performance.now();
    const worldBackground = await this.buildWorldBackground(state, sources, settings);
    const completion = await completeObservedInternalRequest(state, settings, {
      system: summaryCompactionSystemPrompt(targetLevel),
      prompt: buildSummaryCompactionPrompt({ sources, targetLevel, worldBackground }),
      maxTokens: settings.summary.higherLevelMaxTokens,
      timeoutMs: SUMMARY_LLM_TIMEOUT_MS,
    }, {
      task: 'summary-compaction',
      sourceStartMessageId: sources[0]!.sourceStartMessageId,
      sourceEndMessageId: sources.at(-1)!.sourceEndMessageId,
    });
    return {
      text: normalizeSummary(completion.text),
      generation: completion.metadata,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  }

  private async rawSourceHash(
    sourceStartMessageId: number,
    sourceEndMessageId: number,
  ): Promise<string> {
    const chat = getContext().chat;
    if (sourceEndMessageId >= chat.length) {
      throw new Error('高层总结来源范围已超出当前聊天，已取消写入。');
    }
    return sha256(summarySourcePayload(
      chat.slice(sourceStartMessageId, sourceEndMessageId + 1),
      sourceStartMessageId,
    ));
  }

  private async assertChildSourceRevisions(
    entries: readonly StageSummaryEntry[],
  ): Promise<void> {
    for (const entry of entries) {
      const actualHash = await this.rawSourceHash(
        entry.sourceStartMessageId,
        entry.sourceEndMessageId,
      );
      if (entry.sourceHash && entry.sourceHash !== actualHash) {
        throw new Error(
          `L${entry.level}总结来源消息 ${entry.sourceStartMessageId}～${entry.sourceEndMessageId} 已变化，请先刷新并重新处理历史。`,
        );
      }
    }
  }

  private async processNow(
    requestedChatId: string | null,
    maxChunks: number,
    onProgress?: (progress: SummaryCompactionProgress) => void,
  ): Promise<SummaryCompactionRunResult> {
    if (!requestedChatId || getCurrentChatId() !== requestedChatId) {
      throw new Error('等待高层总结压缩期间聊天发生切换，已取消任务。');
    }
    const settings = this.settingsRepository.get();
    let state = await this.stateRepository.getOrCreate();
    if (!state) {
      return { state, compactedChunks: 0, pending: false };
    }
    let compactedChunks = 0;
    try {
      while (compactedChunks < maxChunks) {
        assertChatOwner(state);
        const candidate = findSummaryCompactionCandidate(
          state.stageSummary.entries,
          configuredSummaryCompactionThresholds(settings.summary),
        );
        if (!candidate) {
          break;
        }
        const entriesSnapshot = structuredClone(state.stageSummary.entries);
        const sources = candidate.entries.map(summaryCompactionSource);
        const inputHash = await sha256(summaryCompactionInput(sources));
        const sourceStartMessageId = sources[0]!.sourceStartMessageId;
        const sourceEndMessageId = sources.at(-1)!.sourceEndMessageId;
        const rawHashBefore = await this.rawSourceHash(sourceStartMessageId, sourceEndMessageId);
        await this.assertChildSourceRevisions(candidate.entries);
        const rawHashAfterChildValidation = await this.rawSourceHash(
          sourceStartMessageId,
          sourceEndMessageId,
        );
        if (rawHashBefore !== rawHashAfterChildValidation) {
          throw new Error('校验高层总结来源期间原文发生变化，已保留原总结。');
        }
        const generated = await this.generate(
          state,
          settings,
          sources,
          candidate.level + 1,
        );
        const rawHashAfter = await this.rawSourceHash(sourceStartMessageId, sourceEndMessageId);
        if (rawHashAfterChildValidation !== rawHashAfter) {
          throw new Error('高层总结压缩期间源消息发生变化，已丢弃本次结果。');
        }
        const live = this.stateRepository.getExisting();
        if (!live || live.ownerChatId !== state.ownerChatId) {
          throw new Error('高层总结压缩期间聊天发生切换，已丢弃本次结果。');
        }
        if (!sameSummaryEntries(live.stageSummary.entries, entriesSnapshot)) {
          throw new Error('高层总结压缩期间阶段总结发生变化，已丢弃本次结果。');
        }
        mergeInternalLlmAttempts(live, state);
        live.debugTraces = mergeDebugTraces(live.debugTraces, state.debugTraces);
        const updatedAt = new Date().toISOString();
        const allDeleted = sources.every((source) => source.deleted);
        const parent: StageSummaryEntry = {
          text: allDeleted ? '' : generated.text,
          level: candidate.level + 1,
          characterCount: allDeleted ? 0 : Array.from(generated.text).length,
          ...(generated.generation ? { generation: generated.generation } : {}),
          sourceStartMessageId,
          sourceEndMessageId,
          sourceHash: rawHashAfter,
          updatedAt,
          compaction: {
            sourceLevel: candidate.level,
            sourceEntryCount: sources.length,
            inputHash,
            sources,
          },
          ...(allDeleted ? { deleted: true } : {}),
        };
        live.stageSummary.entries.splice(
          candidate.startIndex,
          candidate.entries.length,
          parent,
        );
        updateSummaryCoverage(live);
        live.metrics.summaryCompactions += 1;
        live.metrics.totalSummaryCompactionMs += generated.durationMs;
        live.metrics.lastSummaryCompactionAt = updatedAt;
        delete live.lastInspection;
        recordDebugTrace(live, settings.debug, 'summary', `L${candidate.level}总结已压缩为L${candidate.level + 1}。`, {
          sourceRange: `${sourceStartMessageId}-${sourceEndMessageId}`,
          sourceEntries: sources.length,
          sourceCharacters: sources.reduce((total, source) => total + Array.from(source.text).length, 0),
          outputCharacters: parent.characterCount ?? 0,
          higherLevelMaxTokens: settings.summary.higherLevelMaxTokens,
          allDeleted,
        });
        await this.stateRepository.save(live);
        state = live;
        compactedChunks += 1;
        const pending = summaryCompactionDue(
          state.stageSummary.entries,
          configuredSummaryCompactionThresholds(settings.summary),
        );
        onProgress?.({
          sourceStartMessageId,
          sourceEndMessageId,
          sourceLevel: candidate.level,
          targetLevel: candidate.level + 1,
          pending,
        });
      }
      return {
        state,
        compactedChunks,
        pending: summaryCompactionDue(
          state.stageSummary.entries,
          configuredSummaryCompactionThresholds(settings.summary),
        ),
      };
    } catch (error) {
      const live = this.stateRepository.getExisting();
      if (live?.ownerChatId === state.ownerChatId) {
        mergeInternalLlmAttempts(live, state);
        live.debugTraces = mergeDebugTraces(live.debugTraces, state.debugTraces);
        if (!isStoryEchoTaskCancelledError(error)) {
          live.metrics.summaryCompactionFailures += 1;
          recordDebugTrace(live, settings.debug, 'error', '高层总结压缩失败，已保留原总结。', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        try {
          await this.stateRepository.save(live);
        } catch (saveError) {
          logger.warn('保存高层总结压缩诊断时聊天已切换或元数据不可用。', saveError);
        }
      }
      throw error;
    }
  }

  regenerateEntry(
    sourceStartMessageId: number,
    expectedUpdatedAt?: string,
  ): Promise<SummaryCompactionRegenerationResult> {
    const requestedChatId = getCurrentChatId();
    const operation = this.queue.then(
      () => this.regenerateNow(sourceStartMessageId, requestedChatId, expectedUpdatedAt),
      () => this.regenerateNow(sourceStartMessageId, requestedChatId, expectedUpdatedAt),
    );
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async regenerateNow(
    sourceStartMessageId: number,
    requestedChatId: string | null,
    expectedUpdatedAt?: string,
  ): Promise<SummaryCompactionRegenerationResult> {
    if (!requestedChatId || getCurrentChatId() !== requestedChatId) {
      throw new Error('等待重新生成高层总结期间聊天发生切换，已取消任务。');
    }
    const settings = this.settingsRepository.get();
    const state = await this.stateRepository.getOrCreate();
    if (!state) {
      throw new Error('当前没有可用聊天。');
    }
    assertChatOwner(state);
    const index = state.stageSummary.entries.findIndex(
      (entry) => entry.sourceStartMessageId === sourceStartMessageId && !entry.deleted,
    );
    const current = index >= 0 ? state.stageSummary.entries[index] : undefined;
    if (!current || current.level < 2 || !current.compaction) {
      throw new Error('要重新生成的高层总结不存在或缺少来源记录。');
    }
    if (expectedUpdatedAt && current.updatedAt !== expectedUpdatedAt) {
      throw new Error('高层总结已在其他操作中发生变化，请刷新后重试。');
    }
    const entriesSnapshot = structuredClone(state.stageSummary.entries);
    const sources = structuredClone(current.compaction.sources);
    const inputHash = await sha256(summaryCompactionInput(sources));
    if (inputHash !== current.compaction.inputHash) {
      throw new Error('高层总结的来源记录校验失败，已保留原结果。');
    }
    const rawHash = await this.rawSourceHash(
      current.sourceStartMessageId,
      current.sourceEndMessageId,
    );
    if (current.sourceHash && current.sourceHash !== rawHash) {
      throw new Error('高层总结来源消息已经变化，请先刷新并重新处理历史。');
    }
    const priorAttemptId = state.recentInternalLlmAttempts.at(-1)?.id;
    try {
      const generated = await this.generate(state, settings, sources, current.level);
      const commitHash = await this.rawSourceHash(
        current.sourceStartMessageId,
        current.sourceEndMessageId,
      );
      if (commitHash !== rawHash) {
        throw new Error('重新生成高层总结期间源消息发生变化，已丢弃本次结果。');
      }
      const live = this.stateRepository.getExisting();
      if (!live || live.ownerChatId !== state.ownerChatId) {
        throw new Error('重新生成高层总结期间聊天发生切换，已丢弃本次结果。');
      }
      if (!sameSummaryEntries(live.stageSummary.entries, entriesSnapshot)) {
        throw new Error('重新生成高层总结期间已有总结发生变化，已丢弃本次结果。');
      }
      mergeInternalLlmAttempts(live, state);
      live.debugTraces = mergeDebugTraces(live.debugTraces, state.debugTraces);
      const previousCharacterCount = current.characterCount ?? Array.from(current.text).length;
      const updatedAt = new Date().toISOString();
      const replacement: StageSummaryEntry = {
        ...current,
        text: generated.text,
        characterCount: Array.from(generated.text).length,
        ...(generated.generation ? { generation: generated.generation } : {}),
        sourceHash: commitHash,
        updatedAt,
        compaction: {
          ...current.compaction,
          inputHash,
          sources,
        },
      };
      delete replacement.manuallyEdited;
      live.stageSummary.entries[index] = replacement;
      updateSummaryCoverage(live);
      live.metrics.summaryCompactions += 1;
      live.metrics.totalSummaryCompactionMs += generated.durationMs;
      live.metrics.lastSummaryCompactionAt = updatedAt;
      delete live.lastInspection;
      recordDebugTrace(live, settings.debug, 'summary', `L${current.level}总结已重新生成。`, {
        sourceRange: `${current.sourceStartMessageId}-${current.sourceEndMessageId}`,
        previousCharacters: previousCharacterCount,
        outputCharacters: replacement.characterCount ?? 0,
      });
      await this.stateRepository.save(live);
      return { state: live, entry: replacement, previousCharacterCount };
    } catch (error) {
      const attemptRecorded = state.recentInternalLlmAttempts.at(-1)?.id !== priorAttemptId;
      const live = this.stateRepository.getExisting();
      if (attemptRecorded && live?.ownerChatId === state.ownerChatId) {
        mergeInternalLlmAttempts(live, state);
        live.debugTraces = mergeDebugTraces(live.debugTraces, state.debugTraces);
        if (!isStoryEchoTaskCancelledError(error)) {
          live.metrics.summaryCompactionFailures += 1;
          recordDebugTrace(live, settings.debug, 'error', `重新生成L${current.level}总结失败，已保留原结果。`, {
            sourceRange: `${current.sourceStartMessageId}-${current.sourceEndMessageId}`,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        try {
          await this.stateRepository.save(live);
        } catch (saveError) {
          logger.warn('保存高层总结重新生成诊断时聊天已切换或元数据不可用。', saveError);
        }
      }
      throw error;
    }
  }
}

export const summaryCompactionService = new SummaryCompactionService();
