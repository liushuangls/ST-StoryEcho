import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SillyTavernContext } from '../src/platform/sillytavern';
import { getConnectionProfiles } from '../src/platform/connection-profiles';
import { ConnectionProfileLlmProvider } from '../src/llm/connection-profile-provider';
import { createLlmProvider } from '../src/llm/provider-factory';
import { completeWithConfiguredProviderDetailed } from '../src/llm/complete';
import { normalizeLlmCompletionMetadata } from '../src/llm/completion-metadata';
import { LlmRequestTimeoutError } from '../src/llm/errors';
import { StoryEchoTaskCancelledError } from '../src/runtime/task-cancellation';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import {
  applyConnectionSelectValue, connectionSelectOptions, connectionSelectValue, syncConnectionSelect,
} from '../src/ui/connection-select';

function installContext() {
  const profiles: unknown[] = [
    { id: 'saved-cc', name: '云端', mode: 'cc', api: 'openrouter', model: 'google/gemini-3.8-flash', 'secret-id': 'host-secret', 'api-url': 'private-url' },
    { id: 'saved-tc', name: '本地', mode: 'tc', api: 'koboldcpp', model: '' },
    { id: 'embed', name: '向量', mode: 'embedding', source: 'openai', model: 'embedding-model' },
    { id: 'rerank', name: '重排', mode: 'rerank', api: 'openrouter', model: 'reranker' },
    { id: 'unknown', name: '未知接口', mode: 'cc', api: 'new-unsupported-api' },
  ];
  const sendRequest = vi.fn().mockResolvedValue({
    choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  });
  const extract = vi.fn((payload) => payload.choices?.[0]?.message?.content ?? payload.choices?.[0]?.text ?? '');
  const context: SillyTavernContext = {
    chat: [{ mes: 'private chat must not be sent', is_user: true }],
    mainApi: 'openai', chatCompletionSettings: { model: 'active-other-model' },
    extensionSettings: { connectionManager: { profiles, selectedProfile: 'unrelated' }, disabledExtensions: [] },
    chatMetadata: { unchanged: true },
    saveMetadata: vi.fn(), saveSettingsDebounced: vi.fn(), generateRaw: vi.fn(),
    CONNECT_API_MAP: {
      openrouter: { selected: 'openai', source: 'openrouter' },
      koboldcpp: { selected: 'textgenerationwebui', type: 'koboldcpp' },
    },
    ConnectionManagerRequestService: { sendRequest },
    extractMessageFromData: extract,
  };
  vi.stubGlobal('SillyTavern', { getContext: () => context });
  return { context, profiles, sendRequest, extract };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('saved connection discovery and selector', () => {
  it('lists every valid saved ID but disables non-generative/unknown profiles and strips secrets', () => {
    const { profiles } = installContext();
    profiles.push(null, { name: 'no id' }, { id: 'saved-cc', name: 'duplicate' });
    const found = getConnectionProfiles();
    expect(found).toHaveLength(5);
    expect(found.filter((p) => !p.unavailableReason).map((p) => p.id).sort()).toEqual(['saved-cc', 'saved-tc']);
    expect(JSON.stringify(found)).not.toMatch(/host-secret|private-url|secret-id|api-url/);
  });

  it('accepts legacy profiles without a mode and uses IDs when names are missing', () => {
    const { profiles } = installContext();
    profiles.push({ id: 'legacy', api: 'openrouter' });
    expect(getConnectionProfiles().find((p) => p.id === 'legacy')).toMatchObject({ name: 'legacy', unavailableReason: '' });
  });

  it('handles unconfigured hosts and disabled/missing host APIs safely', () => {
    const { context } = installContext();
    context.extensionSettings['disabledExtensions'] = ['connection-manager'];
    expect(getConnectionProfiles().find((p) => p.id === 'saved-cc')?.unavailableReason).toContain('已禁用');
    context.extensionSettings['disabledExtensions'] = [];
    delete context.ConnectionManagerRequestService;
    expect(getConnectionProfiles().find((p) => p.id === 'saved-cc')?.unavailableReason).toContain('不支持独立');
    delete context.extensionSettings['connectionManager'];
    expect(getConnectionProfiles()).toEqual([]);
  });

  it('round-trips IDs including colons and preserves a deleted selection', () => {
    installContext();
    const settings = structuredClone(DEFAULT_SETTINGS);
    applyConnectionSelectValue(settings, 'profile:custom:id');
    expect(connectionSelectValue(settings)).toBe('profile:custom:id');
    expect(connectionSelectOptions(settings, getConnectionProfiles()).at(-1)).toMatchObject({ value: 'profile:custom:id', disabled: true });
    applyConnectionSelectValue(settings, 'openai-compatible');
    expect(settings.llm.provider).toBe('openai-compatible');
    applyConnectionSelectValue(settings, 'not-an-option');
    expect(settings.llm.provider).toBe('openai-compatible');
    applyConnectionSelectValue(settings, 'main');
    expect(connectionSelectValue(settings)).toBe('main');
  });

  it('refreshes labels safely without rebuilding unchanged options or losing the selected ID', () => {
    const { profiles } = installContext();
    const settings = structuredClone(DEFAULT_SETTINGS);
    applyConnectionSelectValue(settings, 'profile:saved-cc');
    const children: Array<{ value: string; textContent: string; disabled: boolean }> = [];
    vi.stubGlobal('document', { createElement: () => ({}) });
    const select = { dataset: {}, value: '', replaceChildren: vi.fn((...items) => children.splice(0, children.length, ...items)) };
    syncConnectionSelect(select as unknown as HTMLSelectElement, settings);
    syncConnectionSelect(select as unknown as HTMLSelectElement, settings);
    expect(select.replaceChildren).toHaveBeenCalledOnce();
    (profiles[0] as Record<string, unknown>)['name'] = '<img onerror=bad> renamed';
    syncConnectionSelect(select as unknown as HTMLSelectElement, settings);
    expect(select.value).toBe('profile:saved-cc');
    expect(children.find((p) => p.value === select.value)?.textContent).toContain('<img onerror=bad> renamed');
    vi.unstubAllGlobals();
    vi.stubGlobal('document', { createElement: () => ({}) });
    syncConnectionSelect(select as unknown as HTMLSelectElement, settings);
    expect(children.find((p) => p.value === select.value)?.disabled).toBe(true);
  });
});

describe('saved connection provider', () => {
  it('uses the selected profile independently, with metadata, no preset or main-connection mutation', async () => {
    const { context, sendRequest, extract } = installContext();
    const before = JSON.stringify([context.chat, context.chatMetadata, context.extensionSettings, context.chatCompletionSettings]);
    const settings = structuredClone(DEFAULT_SETTINGS);
    applyConnectionSelectValue(settings, 'profile:saved-cc');
    const provider = createLlmProvider(settings);
    const result = await provider.completeDetailed!({ system: 'summarize', prompt: 'source', maxTokens: 500 });
    expect(provider).toBeInstanceOf(ConnectionProfileLlmProvider);
    expect(result.text).toBe('OK');
    expect(result.metadata).toMatchObject({ provider: 'connection-profile', model: 'google/gemini-3.8-flash', source: 'openrouter', requestedMaxTokens: 500, promptTokens: 10, finishReason: 'stop' });
    expect(normalizeLlmCompletionMetadata(result.metadata)).toEqual(result.metadata);
    expect(sendRequest).toHaveBeenCalledWith('saved-cc', [
      { role: 'system', content: expect.stringContaining('summarize') },
      { role: 'user', content: expect.stringContaining('source') },
    ], 500, {
      stream: false, extractData: false, includePreset: false, includeInstruct: true,
      signal: expect.any(AbortSignal),
    }, expect.objectContaining({ type: 'quiet', tools: [], tool_choice: 'none' }));
    expect(sendRequest.mock.calls[0]?.[4]).not.toHaveProperty('temperature');
    expect(JSON.stringify(sendRequest.mock.calls)).not.toContain('private chat');
    expect(extract).toHaveBeenCalledWith(expect.any(Object), 'openai');
    expect(JSON.stringify([context.chat, context.chatMetadata, context.extensionSettings, context.chatCompletionSettings])).toBe(before);
    expect(context.generateRaw).not.toHaveBeenCalled();
    expect(context.saveMetadata).not.toHaveBeenCalled();
  });

  it('supports text completion profiles without a model and uses the correct extractor API', async () => {
    const { sendRequest, extract } = installContext();
    sendRequest.mockResolvedValue({ choices: [{ text: 'local result' }] });
    expect(await new ConnectionProfileLlmProvider('saved-tc').complete({ system: 's', prompt: 'p' })).toBe('local result');
    expect(extract).toHaveBeenCalledWith(expect.any(Object), 'textgenerationwebui');
    expect(sendRequest.mock.calls[0]?.[4]).toMatchObject({ temperature: 0, top_p: 1 });
  });

  it('tests only the selected connection with a small request', async () => {
    const { sendRequest } = installContext();
    await new ConnectionProfileLlmProvider('saved-cc').testConnection();
    expect(sendRequest.mock.calls[0]?.[0]).toBe('saved-cc');
    expect(sendRequest.mock.calls[0]?.[2]).toBe(128);
    expect(sendRequest.mock.calls[0]?.[1][1].content).toContain('Reply with exactly: OK');
  });

  it.each(['', 'deleted', 'embed', 'rerank', 'unknown'])('rejects unavailable %s without falling back', async (id) => {
    const { sendRequest, context } = installContext();
    await expect(new ConnectionProfileLlmProvider(id).testConnection()).rejects.toThrow(/不存在|不可用/);
    expect(sendRequest).not.toHaveBeenCalled();
    expect(context.generateRaw).not.toHaveBeenCalled();
  });

  it('uses the saved target model for Gemini L1 guidance and clamps budgets', async () => {
    const { sendRequest } = installContext();
    await new ConnectionProfileLlmProvider('saved-cc').complete({ system: '总结', prompt: 'source', summaryLevel: 1, maxTokens: 99_999 });
    expect(sendRequest.mock.calls[0]?.[1][1].content).toContain('起因');
    expect(sendRequest.mock.calls[0]?.[2]).toBe(16_000);
    expect(sendRequest.mock.calls[0]?.[4]).not.toHaveProperty('summaryLevel');
  });

  it('rejects empty/refused responses and hides host error details', async () => {
    const { sendRequest } = installContext();
    const provider = new ConnectionProfileLlmProvider('saved-cc');
    sendRequest.mockResolvedValue({ choices: [] });
    await expect(provider.testConnection()).rejects.toThrow('空响应');
    sendRequest.mockResolvedValue({ choices: [{ finish_reason: 'content_filter' }] });
    await expect(provider.testConnection()).rejects.toThrow();
    sendRequest.mockRejectedValue(new Error('secret-key-private-url'));
    await expect(provider.testConnection()).rejects.toThrow('已配置连接请求失败，请检查该插头的 API、模型与凭据。');
  });

  it('cancels an in-flight host call and does not start pre-aborted requests', async () => {
    const { sendRequest } = installContext();
    sendRequest.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const provider = new ConnectionProfileLlmProvider('saved-cc');
    const pending = provider.complete({ system: 's', prompt: 'p', signal: controller.signal });
    const reason = new StoryEchoTaskCancelledError('test');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(sendRequest.mock.calls[0]?.[3].signal.aborted).toBe(true);
    sendRequest.mockClear();
    await expect(provider.complete({ system: 's', prompt: 'p', signal: controller.signal })).rejects.toBe(reason);
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it('preserves empty-response and upstream timeout retries on the selected profile only', async () => {
    const { sendRequest, context } = installContext();
    const settings = structuredClone(DEFAULT_SETTINGS);
    applyConnectionSelectValue(settings, 'profile:saved-cc');
    sendRequest.mockResolvedValueOnce({ choices: [{ message: { content: '' } }] });
    const request = { system: 's', prompt: 'p', maxTokens: 500 };
    await expect(completeWithConfiguredProviderDetailed(settings, request)).resolves.toMatchObject({ text: 'OK' });
    expect(sendRequest.mock.calls[1]?.[2]).toBe(1_000);
    sendRequest.mockClear();
    sendRequest.mockRejectedValueOnce(new Error('API request failed', { cause: new Error('HTTP 504 private-url') }));
    await expect(completeWithConfiguredProviderDetailed(settings, request)).resolves.toMatchObject({ text: 'OK' });
    expect(sendRequest).toHaveBeenCalledTimes(2);
    expect(context.generateRaw).not.toHaveBeenCalled();
  });

  it('rejects non-text extracted data', async () => {
    const { extract } = installContext();
    extract.mockReturnValue({ unexpected: true });
    await expect(new ConnectionProfileLlmProvider('saved-cc').testConnection()).rejects.toThrow('无效的文本');
  });

  it('times out and aborts the underlying request', async () => {
    vi.useFakeTimers();
    const { sendRequest } = installContext();
    sendRequest.mockImplementation(() => new Promise(() => {}));
    const pending = new ConnectionProfileLlmProvider('saved-cc').complete({ system: 's', prompt: 'p', timeoutMs: 1 });
    const rejection = expect(pending).rejects.toBeInstanceOf(LlmRequestTimeoutError);
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(sendRequest.mock.calls[0]?.[3].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
