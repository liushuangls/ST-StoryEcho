import { describe, expect, it, vi } from 'vitest';
import { PromptItemizationService } from '../src/prompt/itemization';
import type { SillyTavernContext } from '../src/platform/sillytavern';
import type {
  TauriAgentPromptSnapshot,
  TauriStandardPromptSnapshot,
} from '../src/platform/tauritavern-agent';

function context(overrides: Partial<SillyTavernContext> = {}): SillyTavernContext {
  return {
    chat: Array.from({ length: 5 }, (_, index) => ({
      is_user: index % 2 === 1,
      mes: `message-${index}`,
      ...(index === 4 ? { extra: { model: 'deepseek-v4-flash', api: 'custom' } } : {}),
    })),
    chatId: 'chat-id',
    extensionSettings: {},
    chatMetadata: {},
    saveSettingsDebounced: vi.fn(),
    saveMetadata: vi.fn(async () => undefined),
    generateRaw: vi.fn(async () => ''),
    getTokenCountAsync: vi.fn(async (text: string) => text.trim().length),
    ...overrides,
  };
}

function tokenSum(value: Awaited<ReturnType<PromptItemizationService['latest']>>): number {
  return value?.categories.reduce((total, category) => total + category.tokens, 0) ?? 0;
}

describe('latest SillyTavern prompt itemization', () => {
  it('uses the latest completed chat message and separates StoryEcho payloads', async () => {
    const skeleton = '<story_echo_skeleton>SKELETON</story_echo_skeleton>';
    const summary = '<story_echo_summary>SUM</story_echo_summary>';
    const historyNotice = 'StoryEcho historical data precedence notice';
    const record = {
      mesId: 4,
      main_api: 'openai',
      tokenizer: 'DeepSeek tokenizer',
      presetName: 'default',
      rawPrompt: [
        { role: 'system', content: `${historyNotice}\n${skeleton}\n${summary}` },
        { role: 'user', content: 'continue' },
      ],
      charDescription: 'character description',
      charPersonality: 'character personality',
      scenarioText: 'scenario',
      userPersona: 'persona',
      worldInfoString: 'world information',
      examplesString: 'example dialogue',
      allAnchors: '',
      oaiStartTokens: 80,
      oaiMainTokens: 70,
      oaiPromptTokens: 300,
      oaiExamplesTokens: 50,
      oaiConversationTokens: 500,
      oaiTotalTokens: 1_000,
    };
    const pendingStoppedRequest = { ...record, mesId: 5, rawPrompt: 'must not be selected' };
    const service = new PromptItemizationService(async () => ({
      itemizedPrompts: [record, pendingStoppedRequest],
    }));

    const result = await service.latest(context());

    expect(result).not.toBeNull();
    expect(result?.messageId).toBe(4);
    expect(result?.totalTokens).toBe(1_000);
    expect(tokenSum(result)).toBe(1_000);
    expect(result?.storyEcho.summaryTokens).toBe(`${skeleton}\n${summary}`.length);
    expect(result?.storyEcho.contextTokens).toBe(
      500 - `${skeleton}\n${summary}`.length,
    );
    expect(result?.model).toBe('deepseek-v4-flash');
    expect(result?.tokenizer).toBe('DeepSeek tokenizer');
    expect(result?.preset).toBe('default');
    expect(result?.detailed).toBe(true);
  });

  it('reuses in-flight and completed tokenization while the latest prompt is unchanged', async () => {
    const prompt = [{ role: 'user', content: 'hello' }];
    const itemizedPrompts = [{
      mesId: 4,
      main_api: 'openai',
      rawPrompt: prompt,
      oaiConversationTokens: 10,
      oaiTotalTokens: 10,
    }];
    const tokenCounter = vi.fn(async (text: string) => text.trim().length);
    const service = new PromptItemizationService(async () => ({ itemizedPrompts }));
    const tavernContext = context({ getTokenCountAsync: tokenCounter });

    await Promise.all([
      service.latest(tavernContext),
      service.latest(tavernContext),
    ]);
    const callsAfterFirstRead = tokenCounter.mock.calls.length;
    await service.latest(tavernContext);

    expect(callsAfterFirstRead).toBeGreaterThan(0);
    expect(tokenCounter).toHaveBeenCalledTimes(callsAfterFirstRead);
  });

  it('falls back to visible tagged text without pretending it can split recent chat', async () => {
    const summary = '<story_echo_summary>older plot</story_echo_summary>';
    const rawPrompt = [{ role: 'system', content: summary }, { role: 'user', content: 'go on' }];
    const service = new PromptItemizationService(async () => ({
      itemizedPrompts: [{ mesId: 4, main_api: 'openai', rawPrompt }],
    }));

    const result = await service.latest(context());

    expect(result?.detailed).toBe(false);
    expect(result?.estimated).toBe(true);
    expect(result?.storyEcho.contextTokens).toBeNull();
    expect(result?.storyEcho.summaryTokens).toBe(summary.length);
    expect(tokenSum(result)).toBe(result?.totalTokens);
  });

  it('derives a separable recent-context bucket for text completion prompts', async () => {
    const summary = '<story_echo_summary>older</story_echo_summary>';
    const storyString = 'character and world';
    const examplesString = 'example';
    const mesSendString = `${summary}\nrecent dialogue`;
    const service = new PromptItemizationService(async () => ({
      itemizedPrompts: [{
        mesId: 4,
        main_api: 'textgenerationwebui',
        rawPrompt: `${storyString}${examplesString}${mesSendString}`,
        storyString,
        examplesString,
        mesSendString,
        charDescription: 'character',
        worldInfoString: 'world',
      }],
    }));

    const result = await service.latest(context());

    expect(result?.detailed).toBe(true);
    expect(result?.storyEcho.contextTokens).not.toBeNull();
    expect(result?.storyEcho.contextTokens).toBeGreaterThan(0);
    expect(result?.storyEcho.summaryTokens).toBeGreaterThan(0);
    expect(tokenSum(result)).toBe(result?.totalTokens);
  });

  it('returns no card data before a completed request exists', async () => {
    const service = new PromptItemizationService(async () => ({ itemizedPrompts: [] }));
    await expect(service.latest(context())).resolves.toBeNull();
  });

  it('does not reuse an older SillyTavern request for a reloaded Agent reply', async () => {
    const service = new PromptItemizationService(async () => ({
      itemizedPrompts: [{
        mesId: 3,
        main_api: 'openai',
        rawPrompt: [{ role: 'user', content: 'older request' }],
        oaiConversationTokens: 20,
        oaiTotalTokens: 20,
      }],
    }));
    const tavernContext = context();
    tavernContext.chat[4]!.extra = {
      tauritavern: { agent: { runId: 'reloaded-run' } },
    };

    await expect(service.latest(tavernContext)).resolves.toBeNull();
  });

  it('recovers when prompt details are saved after an earlier empty read', async () => {
    const itemizedPrompts: Array<Record<string, unknown>> = [];
    const service = new PromptItemizationService(async () => ({ itemizedPrompts }));
    const tavernContext = context();

    await expect(service.latest(tavernContext)).resolves.toBeNull();

    itemizedPrompts.push({
      mesId: 4,
      main_api: 'openai',
      rawPrompt: [{ role: 'user', content: 'continue' }],
      oaiConversationTokens: 20,
      oaiTotalTokens: 20,
    });
    service.clearCache();

    const result = await service.latest(tavernContext);
    expect(result?.messageId).toBe(4);
    expect(result?.totalTokens).toBe(20);
  });

  it('loads a TauriTavern full prompt record from a lightweight index entry', async () => {
    const recordLoader = vi.fn(async () => ({
      mesId: 4,
      main_api: 'openai',
      rawPrompt: [{ role: 'user', content: 'lazy Tauri prompt' }],
      oaiConversationTokens: 30,
      oaiTotalTokens: 30,
    }));
    const service = new PromptItemizationService(
      async () => ({
        itemizedPrompts: [{ mesId: 4, recordId: 'record-4' }],
      }),
      { promptForLatestMessage: () => null },
      recordLoader,
    );

    const result = await service.latest(context());

    expect(recordLoader).toHaveBeenCalledWith('chat-id', 'record-4');
    expect(result).toMatchObject({
      messageId: 4,
      totalTokens: 30,
      origin: 'sillytavern-itemization',
    });
  });

  it('retries a TauriTavern lazy prompt record that has not finished writing yet', async () => {
    const savedRecord = {
      mesId: 4,
      main_api: 'openai',
      rawPrompt: [{ role: 'user', content: 'now persisted' }],
      oaiConversationTokens: 24,
      oaiTotalTokens: 24,
    };
    const recordLoader = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(savedRecord);
    const service = new PromptItemizationService(
      async () => ({
        itemizedPrompts: [{ mesId: 4, recordId: 'delayed-record' }],
      }),
      { promptForLatestMessage: () => null },
      recordLoader,
    );

    await expect(service.latest(context())).resolves.toBeNull();
    await expect(service.latest(context())).resolves.toMatchObject({
      messageId: 4,
      totalTokens: 24,
    });
    expect(recordLoader).toHaveBeenCalledTimes(2);
  });
});

describe('TauriTavern Agent prompt itemization', () => {
  it('uses provider usage for the first-call total and estimates the final Agent snapshot categories', async () => {
    const summary = '<story_echo_summary>older plot</story_echo_summary>';
    const snapshot: TauriAgentPromptSnapshot = {
      runId: 'run-1',
      chatId: 'chat-id',
      generationType: 'normal',
      expectedMessageId: 4,
      messages: [
        { role: 'system', content: `system rules\n${summary}` },
        { role: 'user', content: 'continue' },
      ],
      toolDefinitions: [{ type: 'function', function: { name: 'search' } }],
      api: 'openrouter',
      model: 'agent-model',
      profile: 'profile-1',
      capturedAt: Date.now(),
      actualInputTokens: 500,
      storyEchoTrimmedByAgentAssembly: true,
    };
    const loader = vi.fn(async () => ({ itemizedPrompts: [] }));
    const lookup = {
      promptForLatestMessage: vi.fn(() => snapshot),
    };
    const service = new PromptItemizationService(loader, lookup);

    const result = await service.latest(context());

    expect(loader).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      messageId: 4,
      totalTokens: 500,
      api: 'openrouter',
      model: 'agent-model',
      agentProfile: 'profile-1',
      origin: 'tauritavern-agent',
      totalMeasured: true,
      agentContextTrimmed: true,
    });
    expect(result?.storyEcho.summaryTokens).toBe(summary.length);
    expect(result?.storyEcho.contextTokens).toBe('continue'.length);
    expect(tokenSum(result)).toBe(500);
    expect(result?.categories.find((entry) => entry.id === 'unclassified')?.tokens)
      .toBeGreaterThan(0);
  });

  it('refreshes a cached Agent total when provider usage arrives asynchronously', async () => {
    const snapshot: TauriAgentPromptSnapshot = {
      runId: 'run-2',
      chatId: 'chat-id',
      generationType: 'normal',
      expectedMessageId: 4,
      messages: [{ role: 'user', content: 'continue' }],
      toolDefinitions: [],
      api: '',
      model: '',
      profile: '',
      capturedAt: Date.now(),
      actualInputTokens: null,
      storyEchoTrimmedByAgentAssembly: false,
    };
    const service = new PromptItemizationService(
      async () => ({ itemizedPrompts: [] }),
      { promptForLatestMessage: () => snapshot },
    );
    const tavernContext = context();

    expect((await service.latest(tavernContext))?.totalTokens).toBe('continue'.length);
    snapshot.actualInputTokens = 250;
    const measured = await service.latest(tavernContext);
    expect(measured?.totalTokens).toBe(250);
    expect(measured?.totalMeasured).toBe(true);
    expect(tokenSum(measured)).toBe(250);
    snapshot.profile = 'writer';
    snapshot.api = 'custom';
    const enriched = await service.latest(tavernContext);
    expect(enriched?.agentProfile).toBe('writer');
    expect(enriched?.api).toBe('custom');
  });

  it('uses a completed ordinary TauriTavern prompt snapshot when Agent is off', async () => {
    const summary = '<story_echo_summary>older plot</story_echo_summary>';
    const snapshot: TauriStandardPromptSnapshot = {
      chatId: 'chat-id',
      messageId: 4,
      messages: [
        { role: 'system', content: summary },
        { role: 'user', content: 'ordinary request' },
      ],
      toolDefinitions: [],
      api: 'custom',
      model: 'ordinary-model',
      profile: '',
      capturedAt: Date.now(),
      actualInputTokens: null,
      storyEchoTrimmedByAgentAssembly: false,
    };
    const loader = vi.fn(async () => ({ itemizedPrompts: [] }));
    const recordLoader = vi.fn(async () => null);
    const lookup = {
      promptForLatestMessage: vi.fn(() => null),
      standardPromptForLatestMessage: vi.fn(() => snapshot),
      latestMessageBelongsToAgent: vi.fn(() => false),
    };
    const service = new PromptItemizationService(loader, lookup, recordLoader);

    const result = await service.latest(context());

    expect(loader).toHaveBeenCalledOnce();
    expect(recordLoader).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      messageId: 4,
      api: 'custom',
      model: 'ordinary-model',
      origin: 'tauritavern-standard',
      totalMeasured: false,
      agentContextTrimmed: false,
    });
    expect(result?.storyEcho.summaryTokens).toBe(summary.length);
    expect(result?.storyEcho.contextTokens).toBe('ordinary request'.length);
    expect(tokenSum(result)).toBe(result?.totalTokens);
  });

  it('upgrades an ordinary Tauri snapshot to the exact stored itemization', async () => {
    const snapshot: TauriStandardPromptSnapshot = {
      chatId: 'chat-id',
      messageId: 4,
      messages: [{ role: 'user', content: 'snapshot fallback' }],
      toolDefinitions: [],
      api: 'custom',
      model: 'ordinary-model',
      profile: '',
      capturedAt: Date.now(),
      actualInputTokens: null,
      storyEchoTrimmedByAgentAssembly: false,
    };
    const recordLoader = vi.fn(async () => ({
      mesId: 4,
      main_api: 'openai',
      rawPrompt: [{ role: 'user', content: 'stored exact prompt' }],
      oaiConversationTokens: 72,
      oaiTotalTokens: 72,
    }));
    const service = new PromptItemizationService(
      async () => ({
        itemizedPrompts: [{ mesId: 4, recordId: 'stored-record' }],
      }),
      {
        promptForLatestMessage: () => null,
        standardPromptForLatestMessage: () => snapshot,
        latestMessageBelongsToAgent: () => false,
      },
      recordLoader,
    );

    const result = await service.latest(context());

    expect(recordLoader).toHaveBeenCalledWith('chat-id', 'stored-record');
    expect(result).toMatchObject({
      messageId: 4,
      totalTokens: 72,
      origin: 'sillytavern-itemization',
      totalMeasured: true,
    });
  });
});
