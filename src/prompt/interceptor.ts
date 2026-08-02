import { DISPLAY_NAME } from '../core/constants';
import { logger } from '../core/logger';
import type {
  InspectionRecord,
  StoryEchoChatState,
  TavernChatMessage,
} from '../core/types';
import { emitDiagnosticsUpdated } from '../debug/events';
import { recordDebugTrace } from '../debug/metrics';
import {
  asksForEarlierStoryPhase,
  currentStoryPhaseStart,
} from '../history/story-phase';
import { isInternalGenerationRequest } from '../llm/internal-generation';
import { getContext, getCurrentChatId } from '../platform/sillytavern';
import { tauriTavernAgentBridge } from '../platform/tauritavern-agent';
import { storyEchoTaskCoordinator } from '../runtime/task-coordinator';
import { SettingsRepository } from '../settings/repository';
import { StoryStateRepository } from '../state/repository';
import { stageSummaryService } from '../summary/service';
import { storySkeletonService } from '../summary/skeleton-service';
import {
  archivedStageSummaryEntries,
  pendingArchivedStageSummaryEntries,
  storySkeletonIsUsable,
} from '../summary/skeleton-state';
import {
  estimateMessageTokens,
  estimateTokens,
  renderStorySkeletonBlock,
  renderStageSummaryBlock,
} from './render';
import {
  alignRetainedStartToTurn,
  countNonSystemMessages,
  removeMessagesAtIndices,
  selectRecentWindow,
} from './window';

const settingsRepository = new SettingsRepository();
const stateRepository = new StoryStateRepository();

function isSupportedGenerationType(type: string | undefined): boolean {
  return !type || type === 'normal' || type === 'regenerate' || type === 'swipe';
}

function createInspection(
  type: string | undefined,
  retainedStartIndex: number,
  endIndex: number,
  removedMessageCount: number,
  warnings: string[],
  durationMs: number,
  estimatedRemovedTokens: number,
  estimatedInjectedTokens: number,
  estimatedSummaryTokens: number,
  summaryCoveredThroughMessageId: number,
): InspectionRecord {
  return {
    createdAt: new Date().toISOString(),
    generationType: type || 'normal',
    retainedStartIndex,
    retainedEndIndex: endIndex,
    removedMessageCount,
    estimatedRemovedTokens,
    estimatedInjectedTokens,
    estimatedNetSavedTokens: Math.max(0, estimatedRemovedTokens - estimatedInjectedTokens),
    estimatedSummaryTokens,
    summaryCoveredThroughMessageId,
    durationMs,
    warnings,
  };
}

function safeSourceRetainedStart(
  sourceChat: TavernChatMessage[],
  minimumRetainedStart: number,
  state: StoryEchoChatState,
  unit: 'turns' | 'messages',
): number {
  const summaryBoundary = state.stageSummary.entries.length > 0
    ? Math.max(0, state.stageSummary.coveredThroughMessageId + 1)
    : 0;
  const proposed = Math.min(minimumRetainedStart, summaryBoundary);
  return unit === 'turns'
    ? alignRetainedStartToTurn(sourceChat, proposed)
    : proposed;
}

function requestSystemMessage(mes: string): TavernChatMessage {
  return {
    is_user: false,
    is_system: true,
    name: DISPLAY_NAME,
    send_date: Date.now(),
    mes,
    extra: {
      type: 'narrator',
      story_echo_injection: true,
      story_echo_injection_kind: 'summary',
    },
  };
}

async function prepareStoryEchoPrompt(
  chat: TavernChatMessage[],
  _contextSize: number,
  _abort: () => void,
  requestedChatId: string | null,
  type?: string,
): Promise<void> {
  const settings = settingsRepository.get();
  if (!settings.enabled || !isSupportedGenerationType(type)) {
    return;
  }

  try {
    const startedAt = performance.now();
    const sourceChat = getContext().chat;
    const minimumSourceWindow = selectRecentWindow(
      sourceChat,
      settings.recentWindow.size,
      settings.recentWindow.unit,
    );
    if (!minimumSourceWindow || minimumSourceWindow.removableIndices.length === 0) {
      return;
    }

    let state = await stateRepository.getOrCreate();
    if (!state) {
      return;
    }
    state = await stageSummaryService.reconcileHistory(state) ?? state;
    state = await storySkeletonService.reconcile(state) ?? state;

    const warnings: string[] = [];
    const desiredCoveredThrough = minimumSourceWindow.retainedStartIndex - 1;
    state.metrics.generationAttempts += 1;
    if (state.stageSummary.coveredThroughMessageId < desiredCoveredThrough) {
      warnings.push(
        `阶段总结只覆盖到消息 ${state.stageSummary.coveredThroughMessageId}，未总结原文暂不裁剪。`,
      );
    }

    const retainedSourceStart = safeSourceRetainedStart(
      sourceChat,
      minimumSourceWindow.retainedStartIndex,
      state,
      settings.recentWindow.unit,
    );
    const retainedHistoricalMessageCount = countNonSystemMessages(
      sourceChat,
      retainedSourceStart,
      minimumSourceWindow.currentInputIndex,
    );
    const window = selectRecentWindow(chat, retainedHistoricalMessageCount, 'messages');
    if (!window) {
      return;
    }

    if (window.removableIndices.length === 0) {
      state.lastInspection = createInspection(
        type,
        retainedSourceStart,
        minimumSourceWindow.currentInputIndex,
        0,
        warnings,
        Math.round(performance.now() - startedAt),
        0,
        0,
        0,
        state.stageSummary.coveredThroughMessageId,
      );
      state.metrics.generationsDeferred += 1;
      state.metrics.lastGenerationAt = new Date().toISOString();
      recordDebugTrace(state, settings.debug, 'interceptor', '阶段总结尚未覆盖裁剪边界，本次保留完整聊天。', {
        summaryCoveredThrough: state.stageSummary.coveredThroughMessageId,
        desiredCoveredThrough,
      });
      await stateRepository.save(state);
      emitDiagnosticsUpdated();
      return;
    }

    const summaryWindowSize = Math.max(1, Math.floor(settings.summary.windowSize));
    const activeStageSummaries = state.stageSummary.entries.filter((entry) => !entry.deleted);
    const archivedSummaries = archivedStageSummaryEntries(state, summaryWindowSize);
    const pendingArchivedSummaries = pendingArchivedStageSummaryEntries(state, summaryWindowSize);
    const recentSummaryPool = activeStageSummaries.slice(-summaryWindowSize);
    const currentInput = sourceChat[minimumSourceWindow.currentInputIndex]?.mes ?? '';
    const storyPhaseBoundary = currentStoryPhaseStart(
      sourceChat,
      minimumSourceWindow.currentInputIndex,
    );
    const includeEarlierPhase = asksForEarlierStoryPhase(currentInput);
    const summaryPool = storyPhaseBoundary !== null && !includeEarlierPhase
      ? recentSummaryPool.filter((entry) => entry.sourceStartMessageId >= storyPhaseBoundary)
      : recentSummaryPool;
    if (summaryPool.length < recentSummaryPool.length) {
      recordDebugTrace(state, settings.debug, 'interceptor', '当前剧情阶段已省略较早阶段总结。', {
        boundaryMessageId: storyPhaseBoundary ?? -1,
        excludedSummaries: recentSummaryPool.length - summaryPool.length,
      });
    }

    const summaryEntries = [...pendingArchivedSummaries, ...summaryPool];
    const skeletonBlock = storySkeletonIsUsable(state)
      ? renderStorySkeletonBlock(
          state.storySkeleton.text,
          state.storySkeleton.coveredThroughMessageId,
        )
      : '';
    if (state.storySkeleton.text && state.storySkeleton.stale) {
      warnings.push('全局剧情骨架来源已失效，重建成功前改为携带尚未合并的阶段总结。');
    }
    const summaryBlocks = summaryEntries
      .map((entry) => renderStageSummaryBlock(
        entry.text,
        entry.sourceStartMessageId,
        entry.sourceEndMessageId,
      ))
      .filter(Boolean);
    const estimatedRemovedTokens = estimateMessageTokens(chat, window.removableIndices);
    const estimatedSummaryTokens = (skeletonBlock ? estimateTokens(skeletonBlock) : 0) +
      summaryBlocks.reduce((total, block) => total + estimateTokens(block), 0);

    const retainedAnchor = chat[window.retainedStartIndex];
    removeMessagesAtIndices(chat, window.removableIndices);
    if (skeletonBlock || summaryBlocks.length > 0) {
      const anchorIndex = retainedAnchor ? chat.indexOf(retainedAnchor) : 0;
      chat.splice(
        Math.max(0, anchorIndex),
        0,
        ...(skeletonBlock ? [requestSystemMessage(skeletonBlock)] : []),
        ...summaryBlocks.map(requestSystemMessage),
      );
      tauriTavernAgentBridge.markStoryEchoSummaryInjected(
        requestedChatId,
        (skeletonBlock ? 1 : 0) + summaryBlocks.length,
      );
    }

    state.lastInspection = createInspection(
      type,
      retainedSourceStart,
      minimumSourceWindow.currentInputIndex,
      window.removableIndices.length,
      warnings,
      Math.round(performance.now() - startedAt),
      estimatedRemovedTokens,
      estimatedSummaryTokens,
      estimatedSummaryTokens,
      state.stageSummary.coveredThroughMessageId,
    );
    state.metrics.generationsTrimmed += 1;
    state.metrics.messagesRemoved += window.removableIndices.length;
    state.metrics.estimatedRemovedTokens += estimatedRemovedTokens;
    state.metrics.estimatedInjectedTokens += estimatedSummaryTokens;
    state.metrics.lastGenerationAt = new Date().toISOString();
    recordDebugTrace(state, settings.debug, 'interceptor', '上下文裁剪与历史总结注入完成。', {
      retainedSourceStart,
      removedMessages: window.removableIndices.length,
      summaryCoveredThrough: state.stageSummary.coveredThroughMessageId,
      summaryEntriesStored: activeStageSummaries.length,
      summaryEntriesDeleted: state.stageSummary.entries.length - activeStageSummaries.length,
      summaryEntriesInjected: summaryBlocks.length,
      summaryEntriesArchived: archivedSummaries.length,
      skeletonInjected: Boolean(skeletonBlock),
      skeletonCoveredThrough: state.storySkeleton.coveredThroughMessageId,
      skeletonPendingEntries: pendingArchivedSummaries.length,
      storyPhaseBoundary: storyPhaseBoundary ?? -1,
      estimatedRemovedTokens,
      estimatedSummaryTokens,
      durationMs: Math.round(performance.now() - startedAt),
    });
    try {
      await stateRepository.save(state);
      emitDiagnosticsUpdated();
    } catch (error) {
      logger.warn('保存上下文检查记录失败。', error);
    }
  } catch (error) {
    logger.error('生成拦截失败，已放行原始生成。', error);
  }
}

export async function storyEchoGenerateInterceptor(
  chat: TavernChatMessage[],
  contextSize: number,
  abort: () => void,
  type?: string,
): Promise<void> {
  tauriTavernAgentBridge.beginStoryEchoPreparation(null);
  const settings = settingsRepository.get();
  if (
    !settings.enabled ||
    !isSupportedGenerationType(type) ||
    isInternalGenerationRequest(chat)
  ) {
    return;
  }

  const requestedContext = getContext();
  const requestedChatId = getCurrentChatId(requestedContext);
  const requestedSourceChat = requestedContext.chat;
  tauriTavernAgentBridge.beginStoryEchoPreparation(requestedChatId);
  await storyEchoTaskCoordinator.enqueueForeground(
    '生成前上下文准备',
    async () => {
      const currentContext = getContext();
      const currentChatId = getCurrentChatId(currentContext);
      const sameChat = requestedChatId
        ? currentChatId === requestedChatId
        : currentContext.chat === requestedSourceChat;
      if (!sameChat) {
        logger.info('等待队列期间聊天已切换，已取消过期的上下文准备任务。');
        return false;
      }
      await prepareStoryEchoPrompt(chat, contextSize, abort, requestedChatId, type);
      return true;
    },
    { holdForegroundLease: (prepared) => prepared },
  );
}
