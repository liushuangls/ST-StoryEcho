import type { StageSummaryEntry } from '../src/core/types';
import { storyContent } from '../src/content/story-content';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { configuredSummaryCompactionThresholds, findSummaryCompactionCandidate, summaryCompactionSource } from '../src/summary/compaction-state';
import { buildStageSummaryPrompt, STAGE_SUMMARY_SYSTEM_PROMPT } from '../src/summary/prompts';
import { buildSummaryCompactionPrompt, summaryCompactionSystemPrompt } from '../src/summary/compaction-prompts';
import { buildChainProbeRequest, scoreChainProbe, type ChainComplete, type ChainNode, type ChainProbeResult, type ChainRequest } from './chains';
import type { DefaultChainCase } from './default-chain-case';
import { assertPromptEvalComplete } from './completion';
import { evalHash } from './protocol';

export interface DefaultChainResult {
  id: string;
  fixtureHash: string;
  sourceCharacters: number;
  fanIn: { level1: number; higherLevels: number };
  nodes: ChainNode[];
  frontier: StageSummaryEntry[];
  merges: { afterBatch: number; level: number; childCount: number; start: number; end: number }[];
  probes: ChainProbeResult[];
  firstObservedLoss: { probeId: string; stage: string }[];
  completed: boolean;
  passed: boolean;
  error?: string;
}

/** Exercises the production N+1 candidate selector, without touching chat state.
 * The fixture's L1 batch size is test-only; merge thresholds/budgets are defaults. */
export async function runDefaultPromptEvalChain(
  fixture: DefaultChainCase,
  complete: ChainComplete,
  onProgress: (result: DefaultChainResult, label: string) => Promise<void> = async () => {},
): Promise<DefaultChainResult> {
  const summary = DEFAULT_SETTINGS.summary;
  const fanIn = configuredSummaryCompactionThresholds(summary);
  const batchCount = (fanIn.higherLevels + 1) * fanIn.level1 + 1;
  if (fixture.batches.length !== batchCount || fixture.batches.some((batch) => !batch.length)) {
    throw new Error(`默认长链夹具必须含 ${batchCount} 个非空批次，以真实触发首次 L3。`);
  }
  if (!fixture.probes.length || new Set(fixture.probes.map((probe) => probe.id)).size !== fixture.probes.length
      || fixture.probes.some((probe) => !Number.isInteger(probe.availableAfterBatch) || probe.availableAfterBatch < 1 || probe.availableAfterBatch > batchCount)) {
    throw new Error('默认长链探针 ID 或生效批次无效。');
  }
  const sourceText = fixture.batches.flat().map(storyContent).join('\n');
  const result: DefaultChainResult = {
    id: fixture.id, fixtureHash: evalHash(fixture), sourceCharacters: Array.from(sourceText).length,
    fanIn, nodes: [], frontier: [], merges: [], probes: [], firstObservedLoss: [], completed: false, passed: false,
  };
  const probe = async (stage: string, context: string, afterBatch: number): Promise<void> => {
    const scoped = { ...fixture, probes: fixture.probes.filter((item) => item.availableAfterBatch <= afterBatch) };
    if (!scoped.probes.length) return;
    const response = await complete(buildChainProbeRequest(scoped, context), `probe-${stage}`);
    assertPromptEvalComplete(response);
    const scored = scoreChainProbe(scoped, context, response.text, stage);
    result.probes.push(scored);
    for (const answer of scored.answers.filter((item) => !item.correct)) {
      if (!result.firstObservedLoss.some((item) => item.probeId === answer.id)) result.firstObservedLoss.push({ probeId: answer.id, stage });
    }
    await onProgress(result, `probe-${stage}`);
  };
  const generate = async (request: ChainRequest, label: string, level: number, start: number, end: number, input: string): Promise<StageSummaryEntry> => {
    const completion = await complete(request, label);
    assertPromptEvalComplete(completion);
    result.nodes.push({
      label, level, sourceStartMessageId: start, sourceEndMessageId: end, text: completion.text,
      promptHash: evalHash(request), inputCharacters: Array.from(input).length,
      outputCharacters: Array.from(completion.text).length, completion,
    });
    return {
      text: completion.text, level, sourceStartMessageId: start, sourceEndMessageId: end,
      sourceHash: evalHash(input), updatedAt: '2026-01-01T00:00:00.000Z',
    };
  };
  const frontierText = (): string => result.frontier.map((entry) => entry.text).join('\n\n');
  try {
    await probe('original', sourceText, batchCount);
    if (result.probes[0]!.score !== 100) throw new Error('原文对照探针未全部通过；停止归因压缩损失。');
    let start = 0;
    let previousL1 = '';
    for (const [index, messages] of fixture.batches.entries()) {
      const label = `L1-${index + 1}`;
      const entry = await generate({
        system: STAGE_SUMMARY_SYSTEM_PROMPT,
        prompt: buildStageSummaryPrompt([...messages], start, fixture.identity, fixture.worldBackground, previousL1),
        maxTokens: summary.level1MaxTokens,
      }, label, 1, start, start + messages.length - 1, messages.map(storyContent).join('\n'));
      result.frontier.push(entry);
      previousL1 = entry.text;
      start += messages.length;
      await onProgress(result, label);
      for (;;) {
        const candidate = findSummaryCompactionCandidate(result.frontier, fanIn);
        if (!candidate) break;
        const level = candidate.level + 1;
        if (level === 3) await probe('before-L3', frontierText(), index + 1);
        const sources = candidate.entries.map(summaryCompactionSource);
        const startId = sources[0]!.sourceStartMessageId;
        const endId = sources.at(-1)!.sourceEndMessageId;
        const mergeLabel = `L${level}-${result.nodes.filter((node) => node.level === level).length + 1}`;
        const merged = await generate({
          system: summaryCompactionSystemPrompt(level),
          prompt: buildSummaryCompactionPrompt({ sources, targetLevel: level, worldBackground: fixture.worldBackground }),
          maxTokens: summary.higherLevelMaxTokens,
        }, mergeLabel, level, startId, endId, sources.map((source) => source.text).join('\n'));
        result.frontier.splice(candidate.startIndex, sources.length, merged);
        result.merges.push({ afterBatch: index + 1, level, childCount: sources.length, start: startId, end: endId });
        await onProgress(result, mergeLabel);
        if (result.merges.length === 1) await probe('first-L2', frontierText(), index + 1);
        if (level === 3) await probe('after-L3', frontierText(), index + 1);
      }
    }
    result.completed = true;
    result.passed = result.probes.every((item) => item.score === 100) && result.merges.some((merge) => merge.level === 3);
  } catch (error) {
    result.error = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
  }
  await onProgress(result, result.error ? 'error' : 'finished');
  return result;
}
