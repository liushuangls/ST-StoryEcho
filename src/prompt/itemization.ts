import type { SillyTavernContext } from '../platform/sillytavern';
import { getContext, getCurrentChatId } from '../platform/sillytavern';
import {
  tauriTavernAgentBridge,
  type TauriAgentPromptSnapshot,
} from '../platform/tauritavern-agent';
import { estimateTokens } from './render';

export type PromptTokenCategoryId =
  | 'system'
  | 'character'
  | 'world-info'
  | 'examples'
  | 'recent-context'
  | 'story-echo-summary'
  | 'other-prompts'
  | 'unclassified';

export interface PromptTokenCategory {
  id: PromptTokenCategoryId;
  tokens: number;
  percentage: number;
}

export interface StoryEchoPromptTokenDetail {
  /** Raw retained chat after StoryEcho trimming. Null means ST did not expose a separable chat bucket. */
  contextTokens: number | null;
  summaryTokens: number;
}

export interface LatestPromptTokenBreakdown {
  messageId: number;
  totalTokens: number;
  categories: PromptTokenCategory[];
  storyEcho: StoryEchoPromptTokenDetail;
  api: string;
  model: string;
  tokenizer: string;
  preset: string;
  agentProfile: string;
  detailed: boolean;
  estimated: boolean;
  origin: 'sillytavern-itemization' | 'tauritavern-agent';
  totalMeasured: boolean;
  agentContextTrimmed: boolean;
}

interface ItemizedPromptRecord extends Record<string, unknown> {
  mesId?: unknown;
  rawPrompt?: unknown;
}

interface ItemizedPromptsModule {
  itemizedPrompts?: unknown;
}

type ItemizedPromptsLoader = () => Promise<ItemizedPromptsModule>;

interface AgentPromptLookup {
  promptForLatestMessage(context: SillyTavernContext): TauriAgentPromptSnapshot | null;
  latestMessageBelongsToAgent?(context: SillyTavernContext): boolean;
}

interface CountedText {
  tokens: number;
  estimated: boolean;
}

interface AllocationSeed<T extends string> {
  id: T;
  tokens: number;
}

const ITEMIZED_PROMPTS_MODULE_URL = '/scripts/itemized-prompts.js';
const CATEGORY_ORDER: readonly PromptTokenCategoryId[] = [
  'system',
  'character',
  'world-info',
  'examples',
  'recent-context',
  'story-echo-summary',
  'other-prompts',
  'unclassified',
];

async function loadItemizedPromptsModule(): Promise<ItemizedPromptsModule> {
  return import(/* @vite-ignore */ ITEMIZED_PROMPTS_MODULE_URL) as Promise<ItemizedPromptsModule>;
}

function finiteTokens(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function messageIdValue(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function promptText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(promptText).filter(Boolean).join('\n');
  }
  if (!value || typeof value !== 'object') {
    return '';
  }
  const record = value as Record<string, unknown>;
  if ('content' in record) {
    return promptText(record['content']);
  }
  if (typeof record['text'] === 'string') {
    return record['text'];
  }
  return '';
}

function taggedBlocks(text: string, tag: string): string {
  const pattern = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'giu');
  return (text.match(pattern) ?? []).join('\n');
}

function removeExactBlocks(text: string, blocks: readonly string[]): string {
  let result = text;
  for (const block of blocks) {
    if (block.trim()) {
      result = result.split(block).join('');
    }
  }
  return result;
}

function proportionalAllocation<T extends string>(
  seeds: readonly AllocationSeed<T>[],
  budget: number,
): Map<T, number> {
  const normalizedBudget = Math.max(0, Math.round(budget));
  const normalized = seeds.map((seed) => ({
    id: seed.id,
    tokens: Math.max(0, Math.round(seed.tokens)),
  }));
  const sum = normalized.reduce((total, seed) => total + seed.tokens, 0);
  const result = new Map<T, number>(normalized.map((seed) => [seed.id, 0]));
  if (sum === 0 || normalizedBudget === 0) {
    return result;
  }
  if (sum <= normalizedBudget) {
    for (const seed of normalized) {
      result.set(seed.id, seed.tokens);
    }
    return result;
  }

  const scaled = normalized.map((seed, index) => {
    const exact = seed.tokens * normalizedBudget / sum;
    return { id: seed.id, index, floor: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let remaining = normalizedBudget - scaled.reduce((total, seed) => total + seed.floor, 0);
  scaled.sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (const seed of scaled) {
    const extra = remaining > 0 ? 1 : 0;
    result.set(seed.id, seed.floor + extra);
    remaining -= extra;
  }
  return result;
}

function allocationTotal<T extends string>(allocation: ReadonlyMap<T, number>): number {
  return [...allocation.values()].reduce((total, tokens) => total + tokens, 0);
}

function latestRecord(
  value: unknown,
  latestChatMessageId: number,
): ItemizedPromptRecord | null {
  if (!Array.isArray(value) || latestChatMessageId < 0) {
    return null;
  }
  // SillyTavern appends itemization records in message order and replaces a
  // swipe in place. Walking backwards makes the common long-chat path O(1),
  // while still skipping a stopped/pending request whose future mesId has not
  // become an actual chat floor.
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const candidate = value[index];
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }
    const record = candidate as ItemizedPromptRecord;
    const messageId = messageIdValue(record.mesId);
    if (messageId === null || messageId > latestChatMessageId) {
      continue;
    }
    return record;
  }
  return null;
}

function categoryList(values: Partial<Record<PromptTokenCategoryId, number>>, total: number): PromptTokenCategory[] {
  const normalizedTotal = Math.max(0, Math.round(total));
  return CATEGORY_ORDER.map((id) => {
    const tokens = Math.max(0, Math.round(values[id] ?? 0));
    return {
      id,
      tokens,
      percentage: normalizedTotal > 0 ? tokens * 100 / normalizedTotal : 0,
    };
  }).filter((category) => category.tokens > 0);
}

function connectionMetadata(
  record: ItemizedPromptRecord,
  context: SillyTavernContext,
  messageId: number,
): Pick<
  LatestPromptTokenBreakdown,
  'api' | 'model' | 'tokenizer' | 'preset' | 'agentProfile'
> {
  const message = context.chat[messageId];
  const extra = message?.extra ?? {};
  return {
    api: stringValue(extra['api']) || stringValue(record['main_api']),
    model: stringValue(extra['model']),
    tokenizer: stringValue(record['tokenizer']),
    preset: stringValue(record['presetName']),
    agentProfile: '',
  };
}

async function buildBreakdown(
  record: ItemizedPromptRecord,
  context: SillyTavernContext,
): Promise<LatestPromptTokenBreakdown | null> {
  const tokenCache = new Map<string, Promise<CountedText>>();
  const count = (text: string): Promise<CountedText> => {
    const normalized = text.trim();
    if (!normalized) {
      return Promise.resolve({ tokens: 0, estimated: false });
    }
    const cached = tokenCache.get(normalized);
    if (cached) {
      return cached;
    }
    const pending = (async (): Promise<CountedText> => {
      if (context.getTokenCountAsync) {
        try {
          const tokens = await context.getTokenCountAsync(normalized, 0);
          if (Number.isFinite(tokens) && tokens >= 0) {
            return { tokens: Math.round(tokens), estimated: false };
          }
        } catch {
          // Fall through to the bounded local diagnostic estimate.
        }
      }
      return { tokens: estimateTokens(normalized), estimated: true };
    })();
    tokenCache.set(normalized, pending);
    return pending;
  };

  const rawText = promptText(record.rawPrompt ?? record['finalPrompt']);
  if (!rawText.trim()) {
    return null;
  }
  const skeletonText = taggedBlocks(rawText, 'story_echo_skeleton');
  const stageSummaryText = taggedBlocks(rawText, 'story_echo_summary');
  const summaryText = [skeletonText, stageSummaryText].filter(Boolean).join('\n');
  const characterText = [
    stringValue(record['charDescription']),
    stringValue(record['charPersonality']),
    stringValue(record['scenarioText']),
    stringValue(record['userPersona']),
  ].filter(Boolean).join('\n');
  const worldInfoText = stringValue(record['worldInfoString']);
  const examplesText = stringValue(record['examplesString']);
  const anchorsText = stringValue(record['allAnchors']);
  const anchorsWithoutKnown = removeExactBlocks(anchorsText, [
    skeletonText,
    stageSummaryText,
    ...(worldInfoText && anchorsText.includes(worldInfoText) ? [worldInfoText] : []),
  ]);
  const instructionText = [
    stringValue(record['instruction']),
    stringValue(record['generatedPromptCache']),
    stringValue(record['promptBias']),
  ].filter(Boolean).join('\n');
  const storyText = stringValue(record['storyString']);
  const chatText = stringValue(record['mesSendString']);

  const counted = await Promise.all([
    count(rawText),
    count(summaryText),
    count(characterText),
    count(worldInfoText),
    count(examplesText),
    count(anchorsWithoutKnown),
    count(instructionText),
    count(storyText),
    count(chatText),
  ]);
  const [
    raw,
    summary,
    character,
    worldInfo,
    examples,
    otherAnchors,
    instruction,
    story,
    chat,
  ] = counted as [CountedText, CountedText, CountedText, CountedText, CountedText,
    CountedText, CountedText, CountedText, CountedText];
  const counterEstimated = counted.some((value) => value.estimated);
  const mainApi = stringValue(record['main_api']);
  const storedTotal = finiteTokens(record['oaiTotalTokens']);
  const hasChatCompletionBreakdown = mainApi === 'openai' && storedTotal > 0;
  const messageId = messageIdValue(record.mesId);
  if (messageId === null) {
    return null;
  }
  const metadata = connectionMetadata(record, context, messageId);

  if (hasChatCompletionBreakdown) {
    const total = storedTotal;
    const systemSeed = [
      'oaiStartTokens',
      'oaiMainTokens',
      'oaiNsfwTokens',
      'oaiJailbreakTokens',
      'oaiImpersonateTokens',
      'oaiNudgeTokens',
      'oaiBiasTokens',
    ].reduce((sum, key) => sum + finiteTokens(record[key]), 0);
    const examplesSeed = finiteTokens(record['oaiExamplesTokens']);
    const conversationSeed = finiteTokens(record['oaiConversationTokens']);
    const fixed = proportionalAllocation([
      { id: 'system', tokens: systemSeed },
      { id: 'examples', tokens: examplesSeed },
      { id: 'conversation', tokens: conversationSeed },
    ] as const, total);
    const systemTokens = fixed.get('system') ?? 0;
    const exampleTokens = fixed.get('examples') ?? 0;
    const conversationTokens = fixed.get('conversation') ?? 0;
    const promptBudget = Math.max(0, total - allocationTotal(fixed));
    const promptParts = proportionalAllocation([
      { id: 'character', tokens: character.tokens },
      { id: 'world-info', tokens: worldInfo.tokens },
    ] as const, promptBudget);
    const characterTokens = promptParts.get('character') ?? 0;
    const worldInfoTokens = promptParts.get('world-info') ?? 0;
    const otherPromptTokens = Math.max(0, promptBudget - allocationTotal(promptParts));

    const conversationParts = proportionalAllocation([
      { id: 'story-echo-summary', tokens: summary.tokens },
      { id: 'other-prompts', tokens: otherAnchors.tokens },
    ] as const, conversationTokens);
    const summaryTokens = conversationParts.get('story-echo-summary') ?? 0;
    const conversationOtherTokens = conversationParts.get('other-prompts') ?? 0;
    const recentContextTokens = Math.max(0, conversationTokens - allocationTotal(conversationParts));
    const categories = categoryList({
      system: systemTokens,
      character: characterTokens,
      'world-info': worldInfoTokens,
      examples: exampleTokens,
      'recent-context': recentContextTokens,
      'story-echo-summary': summaryTokens,
      'other-prompts': otherPromptTokens + conversationOtherTokens,
    }, total);
    return {
      messageId,
      totalTokens: total,
      categories,
      storyEcho: {
        contextTokens: recentContextTokens,
        summaryTokens,
      },
      ...metadata,
      detailed: true,
      estimated: counterEstimated,
      origin: 'sillytavern-itemization',
      totalMeasured: true,
      agentContextTrimmed: false,
    };
  }

  const total = raw.tokens;
  if (total <= 0) {
    return null;
  }
  if (mainApi !== 'openai' && (story.tokens > 0 || chat.tokens > 0)) {
    const outer = proportionalAllocation([
      { id: 'story', tokens: story.tokens },
      { id: 'examples', tokens: examples.tokens },
      { id: 'chat', tokens: chat.tokens },
    ] as const, total);
    const storyBudget = outer.get('story') ?? 0;
    const examplesBudget = outer.get('examples') ?? 0;
    const chatBudget = outer.get('chat') ?? 0;
    const storyParts = proportionalAllocation([
      { id: 'system', tokens: instruction.tokens },
      { id: 'character', tokens: character.tokens },
      { id: 'world-info', tokens: worldInfo.tokens },
    ] as const, storyBudget);
    const chatParts = proportionalAllocation([
      { id: 'story-echo-summary', tokens: summary.tokens },
      { id: 'other-prompts', tokens: otherAnchors.tokens },
    ] as const, chatBudget);
    const summaryTokens = chatParts.get('story-echo-summary') ?? 0;
    const recentContextTokens = Math.max(0, chatBudget - allocationTotal(chatParts));
    const unclassified = Math.max(
      0,
      total - allocationTotal(outer) + storyBudget - allocationTotal(storyParts),
    );
    const categories = categoryList({
      system: storyParts.get('system') ?? 0,
      character: storyParts.get('character') ?? 0,
      'world-info': storyParts.get('world-info') ?? 0,
      examples: examplesBudget,
      'recent-context': recentContextTokens,
      'story-echo-summary': summaryTokens,
      'other-prompts': chatParts.get('other-prompts') ?? 0,
      unclassified,
    }, total);
    return {
      messageId,
      totalTokens: total,
      categories,
      storyEcho: {
        contextTokens: recentContextTokens,
        summaryTokens,
      },
      ...metadata,
      detailed: true,
      estimated: true,
      origin: 'sillytavern-itemization',
      totalMeasured: false,
      agentContextTrimmed: false,
    };
  }

  const fallbackParts = proportionalAllocation([
    { id: 'system', tokens: instruction.tokens },
    { id: 'character', tokens: character.tokens },
    { id: 'world-info', tokens: worldInfo.tokens },
    { id: 'examples', tokens: examples.tokens },
    { id: 'story-echo-summary', tokens: summary.tokens },
    { id: 'other-prompts', tokens: otherAnchors.tokens },
  ] as const, total);
  const summaryTokens = fallbackParts.get('story-echo-summary') ?? 0;
  const unclassified = Math.max(0, total - allocationTotal(fallbackParts));
  return {
    messageId,
    totalTokens: total,
    categories: categoryList({
      system: fallbackParts.get('system') ?? 0,
      character: fallbackParts.get('character') ?? 0,
      'world-info': fallbackParts.get('world-info') ?? 0,
      examples: fallbackParts.get('examples') ?? 0,
      'story-echo-summary': summaryTokens,
      'other-prompts': fallbackParts.get('other-prompts') ?? 0,
      unclassified,
    }, total),
    storyEcho: {
      contextTokens: null,
      summaryTokens,
    },
    ...metadata,
    detailed: false,
    estimated: true,
    origin: 'sillytavern-itemization',
    totalMeasured: false,
    agentContextTrimmed: false,
  };
}

async function buildAgentBreakdown(
  snapshot: TauriAgentPromptSnapshot,
  context: SillyTavernContext,
): Promise<LatestPromptTokenBreakdown | null> {
  const texts: Record<
    'system' | 'recent-context' | 'story-echo-summary' | 'other-prompts',
    string[]
  > = {
    system: [],
    'recent-context': [],
    'story-echo-summary': [],
    'other-prompts': [],
  };
  for (const message of snapshot.messages) {
    const text = promptText(message);
    if (!text.trim()) {
      continue;
    }
    const skeleton = taggedBlocks(text, 'story_echo_skeleton');
    const summary = taggedBlocks(text, 'story_echo_summary');
    const storyEcho = [skeleton, summary].filter(Boolean).join('\n');
    if (storyEcho) {
      texts['story-echo-summary'].push(storyEcho);
    }
    const remainder = removeExactBlocks(text, [skeleton, summary]).trim();
    if (!remainder) {
      continue;
    }
    const role = (
      message &&
      typeof message === 'object' &&
      !Array.isArray(message) &&
      typeof (message as Record<string, unknown>)['role'] === 'string'
    )
      ? ((message as Record<string, unknown>)['role'] as string).toLowerCase()
      : '';
    if (role === 'system' || role === 'developer') {
      texts.system.push(remainder);
    } else if (role === 'user' || role === 'assistant') {
      texts['recent-context'].push(remainder);
    } else {
      texts['other-prompts'].push(remainder);
    }
  }
  if (snapshot.toolDefinitions.length > 0) {
    try {
      texts['other-prompts'].push(JSON.stringify(snapshot.toolDefinitions));
    } catch {
      // The bridge already cloned this value, but keep diagnostics fail-open.
    }
  }

  const count = async (text: string): Promise<number> => {
    const normalized = text.trim();
    if (!normalized) {
      return 0;
    }
    if (context.getTokenCountAsync) {
      try {
        const tokens = await context.getTokenCountAsync(normalized, 0);
        if (Number.isFinite(tokens) && tokens >= 0) {
          return Math.round(tokens);
        }
      } catch {
        // Fall through to the bounded local estimate.
      }
    }
    return estimateTokens(normalized);
  };
  const ids = [
    'system',
    'recent-context',
    'story-echo-summary',
    'other-prompts',
  ] as const;
  const counts = await Promise.all(ids.map((id) => count(texts[id].join('\n'))));
  const seeds = ids.map((id, index) => ({ id, tokens: counts[index] ?? 0 }));
  const measuredTotal = snapshot.actualInputTokens;
  const identifiedTotal = seeds.reduce((total, seed) => total + seed.tokens, 0);
  const total = measuredTotal ?? identifiedTotal;
  if (total <= 0) {
    return null;
  }
  const allocation = proportionalAllocation(seeds, total);
  const unclassified = Math.max(0, total - allocationTotal(allocation));
  const values: Partial<Record<PromptTokenCategoryId, number>> = {
    system: allocation.get('system') ?? 0,
    'recent-context': allocation.get('recent-context') ?? 0,
    'story-echo-summary': allocation.get('story-echo-summary') ?? 0,
    'other-prompts': allocation.get('other-prompts') ?? 0,
    unclassified,
  };
  return {
    messageId: context.chat.length - 1,
    totalTokens: total,
    categories: categoryList(values, total),
    storyEcho: {
      contextTokens: values['recent-context'] ?? 0,
      summaryTokens: values['story-echo-summary'] ?? 0,
    },
    api: snapshot.api,
    model: snapshot.model,
    tokenizer: '',
    preset: '',
    agentProfile: snapshot.profile,
    detailed: false,
    estimated: true,
    origin: 'tauritavern-agent',
    totalMeasured: measuredTotal !== null,
    agentContextTrimmed: snapshot.storyEchoTrimmedByAgentAssembly,
  };
}

function agentSnapshotSignature(snapshot: TauriAgentPromptSnapshot): string {
  return JSON.stringify([
    snapshot.actualInputTokens,
    snapshot.api,
    snapshot.model,
    snapshot.profile,
    snapshot.storyEchoTrimmedByAgentAssembly,
  ]);
}

export class PromptItemizationService {
  private cachedAgentSnapshot: TauriAgentPromptSnapshot | null = null;
  private cachedAgentSignature = '';
  private cachedAgentChatLength = -1;
  private cachedAgentBreakdown: LatestPromptTokenBreakdown | null = null;
  private pendingAgentSnapshot: TauriAgentPromptSnapshot | null = null;
  private pendingAgentSignature = '';
  private pendingAgentChatLength = -1;
  private pendingAgentBreakdown: Promise<LatestPromptTokenBreakdown | null> | null = null;
  private cachedChatId = '';
  private cachedChatLength = -1;
  private cachedItemCount = -1;
  private cachedRecord: ItemizedPromptRecord | null = null;
  private cachedRawPrompt: unknown;
  private cachedBreakdown: LatestPromptTokenBreakdown | null = null;
  private pendingChatId = '';
  private pendingChatLength = -1;
  private pendingItemCount = -1;
  private pendingRecord: ItemizedPromptRecord | null = null;
  private pendingRawPrompt: unknown;
  private pendingBreakdown: Promise<LatestPromptTokenBreakdown | null> | null = null;

  constructor(
    private readonly loader: ItemizedPromptsLoader = loadItemizedPromptsModule,
    private readonly agentPrompts: AgentPromptLookup = tauriTavernAgentBridge,
  ) {}

  async latest(context = getContext()): Promise<LatestPromptTokenBreakdown | null> {
    const chatId = getCurrentChatId(context) ?? '';
    if (!chatId || context.chat.length === 0) {
      this.clearCache();
      return null;
    }
    const agentSnapshot = this.agentPrompts.promptForLatestMessage(context);
    if (agentSnapshot) {
      return this.latestAgent(agentSnapshot, context);
    }
    this.clearAgentCache();
    if (this.agentPrompts.latestMessageBelongsToAgent?.(context)) {
      // TauriTavern Agent bypasses SillyTavern's itemized-prompt store. After
      // a reload the in-memory Agent snapshot is gone; showing the preceding
      // non-Agent request here would be materially misleading.
      this.clearCache();
      return null;
    }
    const module = await this.loader();
    const records = Array.isArray(module.itemizedPrompts) ? module.itemizedPrompts : [];
    const record = latestRecord(records, context.chat.length - 1);
    if (!record) {
      this.cachedChatId = chatId;
      this.cachedChatLength = context.chat.length;
      this.cachedItemCount = records.length;
      this.cachedRecord = null;
      this.cachedRawPrompt = undefined;
      this.cachedBreakdown = null;
      return null;
    }
    const rawPrompt = record.rawPrompt ?? record['finalPrompt'];
    if (
      chatId === this.cachedChatId &&
      context.chat.length === this.cachedChatLength &&
      records.length === this.cachedItemCount &&
      record === this.cachedRecord &&
      rawPrompt === this.cachedRawPrompt
    ) {
      return this.cachedBreakdown;
    }
    if (
      chatId === this.pendingChatId &&
      context.chat.length === this.pendingChatLength &&
      records.length === this.pendingItemCount &&
      record === this.pendingRecord &&
      rawPrompt === this.pendingRawPrompt &&
      this.pendingBreakdown
    ) {
      return this.pendingBreakdown;
    }
    const pending = buildBreakdown(record, context);
    this.pendingChatId = chatId;
    this.pendingChatLength = context.chat.length;
    this.pendingItemCount = records.length;
    this.pendingRecord = record;
    this.pendingRawPrompt = rawPrompt;
    this.pendingBreakdown = pending;
    let breakdown: LatestPromptTokenBreakdown | null;
    try {
      breakdown = await pending;
    } catch (error) {
      if (this.pendingBreakdown === pending) {
        this.clearPending();
      }
      throw error;
    }
    if (this.pendingBreakdown !== pending) {
      return breakdown;
    }
    this.clearPending();
    // Discard a result if the user switched chats while tokenization was in flight.
    if ((getCurrentChatId(context) ?? '') !== chatId) {
      return null;
    }
    this.cachedChatId = chatId;
    this.cachedChatLength = context.chat.length;
    this.cachedItemCount = records.length;
    this.cachedRecord = record;
    this.cachedRawPrompt = rawPrompt;
    this.cachedBreakdown = breakdown;
    return breakdown;
  }

  clearCache(): void {
    this.clearAgentCache();
    this.cachedChatId = '';
    this.cachedChatLength = -1;
    this.cachedItemCount = -1;
    this.cachedRecord = null;
    this.cachedRawPrompt = undefined;
    this.cachedBreakdown = null;
    this.clearPending();
  }

  private async latestAgent(
    snapshot: TauriAgentPromptSnapshot,
    context: SillyTavernContext,
  ): Promise<LatestPromptTokenBreakdown | null> {
    const signature = agentSnapshotSignature(snapshot);
    const chatLength = context.chat.length;
    if (
      snapshot === this.cachedAgentSnapshot &&
      signature === this.cachedAgentSignature &&
      chatLength === this.cachedAgentChatLength
    ) {
      return this.cachedAgentBreakdown;
    }
    if (
      snapshot === this.pendingAgentSnapshot &&
      signature === this.pendingAgentSignature &&
      chatLength === this.pendingAgentChatLength &&
      this.pendingAgentBreakdown
    ) {
      return this.pendingAgentBreakdown;
    }
    const pending = buildAgentBreakdown(snapshot, context);
    this.pendingAgentSnapshot = snapshot;
    this.pendingAgentSignature = signature;
    this.pendingAgentChatLength = chatLength;
    this.pendingAgentBreakdown = pending;
    let breakdown: LatestPromptTokenBreakdown | null;
    try {
      breakdown = await pending;
    } catch (error) {
      if (this.pendingAgentBreakdown === pending) {
        this.clearPendingAgent();
      }
      throw error;
    }
    if (this.pendingAgentBreakdown !== pending) {
      return breakdown;
    }
    this.clearPendingAgent();
    if (this.agentPrompts.promptForLatestMessage(context) !== snapshot) {
      return null;
    }
    this.cachedAgentSnapshot = snapshot;
    this.cachedAgentSignature = signature;
    this.cachedAgentChatLength = chatLength;
    this.cachedAgentBreakdown = breakdown;
    return breakdown;
  }

  private clearAgentCache(): void {
    this.cachedAgentSnapshot = null;
    this.cachedAgentSignature = '';
    this.cachedAgentChatLength = -1;
    this.cachedAgentBreakdown = null;
    this.clearPendingAgent();
  }

  private clearPendingAgent(): void {
    this.pendingAgentSnapshot = null;
    this.pendingAgentSignature = '';
    this.pendingAgentChatLength = -1;
    this.pendingAgentBreakdown = null;
  }

  private clearPending(): void {
    this.pendingChatId = '';
    this.pendingChatLength = -1;
    this.pendingItemCount = -1;
    this.pendingRecord = null;
    this.pendingRawPrompt = undefined;
    this.pendingBreakdown = null;
  }
}

export const promptItemizationService = new PromptItemizationService();
