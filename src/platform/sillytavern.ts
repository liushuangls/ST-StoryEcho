import type { TavernChatMessage } from '../core/types';

export interface SillyTavernCharacterCardFields {
  description?: string;
  personality?: string;
  persona?: string;
  scenario?: string;
  system?: string;
  jailbreak?: string;
  charDepthPrompt?: string;
  creatorNotes?: string;
  mesExamples?: string;
  firstMessage?: string;
  alternateGreetings?: string[];
}

export interface SillyTavernCharacter {
  name?: string;
  avatar?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  data?: Record<string, unknown>;
}

export interface SillyTavernWorldInfoEntry {
  uid?: number | string;
  world?: string;
  comment?: string;
  content?: string;
  key?: string[];
  keysecondary?: string[];
  selective?: boolean;
  selectiveLogic?: number;
  disable?: boolean;
  constant?: boolean;
  caseSensitive?: boolean;
  matchWholeWords?: boolean;
  triggers?: string[];
  decorators?: string[];
  order?: number;
  characterFilter?: {
    names?: string[];
    tags?: string[];
    isExclude?: boolean;
  };
}

export interface SillyTavernPopupOptions {
  leftAlign?: boolean;
}

export interface SillyTavernPopupApi {
  show: {
    confirm(
      header: string | null,
      text?: string | null,
      options?: SillyTavernPopupOptions,
    ): Promise<number | null>;
  };
}

export interface SillyTavernPopupResults {
  AFFIRMATIVE: number;
  NEGATIVE: number;
  CANCELLED: null;
}

export interface SillyTavernContext {
  chat: TavernChatMessage[];
  chatId?: string;
  characterId?: number;
  groupId?: string;
  /** SillyTavern's top-level API id. Chat completions use `openai`. */
  mainApi?: string;
  name1?: string;
  name2?: string;
  characters?: SillyTavernCharacter[];
  groups?: Array<Record<string, unknown>>;
  tagMap?: Record<string, string[]>;
  maxContext?: number;
  chatCompletionSettings?: Record<string, unknown>;
  textCompletionSettings?: Record<string, unknown>;
  extensionSettings: Record<string, unknown>;
  chatMetadata: Record<string, unknown>;
  eventSource?: {
    on(event: string, handler: (...args: unknown[]) => void | Promise<void>): void;
    off?(event: string, handler: (...args: unknown[]) => void | Promise<void>): void;
    removeListener?(event: string, handler: (...args: unknown[]) => void | Promise<void>): void;
  };
  event_types?: Record<string, string>;
  eventTypes?: Record<string, string>;
  saveSettingsDebounced(): void;
  saveMetadata(): Promise<void>;
  generateRaw(options: {
    systemPrompt: string;
    prompt: string;
    jsonSchema?: Record<string, unknown>;
    responseLength?: number;
  }): Promise<string>;
  getRequestHeaders?(): Record<string, string>;
  getCurrentChatId?(): string | null;
  getChatCompletionModel?(settings?: Record<string, unknown>): string | null;
  getCharacterCardFields?(options?: { chid?: number }): SillyTavernCharacterCardFields;
  getTokenCountAsync?(text: string, padding?: number): Promise<number>;
  substituteParams?(text: string): string;
  /** Test/future API seam; current SillyTavern builds expose this from world-info.js. */
  getSortedWorldInfoEntries?(): Promise<SillyTavernWorldInfoEntry[]>;
  Popup?: SillyTavernPopupApi;
  POPUP_RESULT?: SillyTavernPopupResults;
}

export interface MainConnectionIdentity {
  mainApi: string;
  source: string;
  model: string;
}

interface SillyTavernGlobal {
  getContext(): SillyTavernContext;
  libs?: {
    DOMPurify?: {
      sanitize(value: string): string;
    };
  };
}

declare global {
  var SillyTavern: SillyTavernGlobal | undefined;
}

export function getContext(): SillyTavernContext {
  if (!globalThis.SillyTavern?.getContext) {
    throw new Error('SillyTavern context is not available.');
  }

  return globalThis.SillyTavern.getContext();
}

export function getCurrentChatId(context = getContext()): string | null {
  const fromFunction = context.getCurrentChatId?.();
  if (fromFunction) {
    return fromFunction;
  }
  if (context.chatId) {
    return context.chatId;
  }

  const metadataId = context.chatMetadata['chat_id'];
  if (typeof metadataId === 'string' && metadataId.length > 0) {
    return metadataId;
  }

  return null;
}

function popupPlainText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replace(/\r?\n/gu, '<br>');
}

export async function showConfirmation(
  title: string,
  message: string,
  context = getContext(),
): Promise<boolean> {
  if (context.Popup?.show.confirm && context.POPUP_RESULT) {
    const result = await context.Popup.show.confirm(
      popupPlainText(title),
      popupPlainText(message),
      { leftAlign: true },
    );
    return result === context.POPUP_RESULT.AFFIRMATIVE;
  }

  return globalThis.confirm(`${title}\n\n${message}`);
}

const CHAT_MODEL_KEYS: Record<string, string> = {
  ai21: 'ai21_model',
  aimlapi: 'aimlapi_model',
  azure_openai: 'azure_openai_model',
  chutes: 'chutes_model',
  claude: 'claude_model',
  cohere: 'cohere_model',
  cometapi: 'cometapi_model',
  custom: 'custom_model',
  deepseek: 'deepseek_model',
  electronhub: 'electronhub_model',
  fireworks: 'fireworks_model',
  groq: 'groq_model',
  makersuite: 'google_model',
  minimax: 'minimax_model',
  mistralai: 'mistralai_model',
  moonshot: 'moonshot_model',
  nanogpt: 'nanogpt_model',
  openai: 'openai_model',
  openrouter: 'openrouter_model',
  perplexity: 'perplexity_model',
  pollinations: 'pollinations_model',
  siliconflow: 'siliconflow_model',
  vertexai: 'vertexai_model',
  workers_ai: 'workers_ai_model',
  xai: 'xai_model',
  zai: 'zai_model',
};

/**
 * Resolve the model selected by SillyTavern without reading credentials.
 *
 * SillyTavern 1.18 exposes getChatCompletionModel() directly. The field map is
 * retained for older compatible builds and test doubles where that helper is
 * absent.
 */
export function getMainConnectionIdentity(context = getContext()): MainConnectionIdentity {
  const mainApi = typeof context.mainApi === 'string' ? context.mainApi.trim() : '';
  if (mainApi !== 'openai') {
    return { mainApi, source: '', model: '' };
  }

  const settings = context.chatCompletionSettings ?? {};
  const source = typeof settings['chat_completion_source'] === 'string'
    ? settings['chat_completion_source'].trim()
    : '';
  let model = '';
  try {
    const resolved = context.getChatCompletionModel?.(settings);
    model = typeof resolved === 'string' ? resolved.trim() : '';
  } catch {
    // Fall through to the stable source-to-setting mapping below.
  }
  if (!model) {
    const modelKey = CHAT_MODEL_KEYS[source];
    const fallback = modelKey ? settings[modelKey] : undefined;
    model = typeof fallback === 'string' ? fallback.trim() : '';
  }

  return { mainApi, source, model };
}

export async function getRequestHeaders(context = getContext()): Promise<Record<string, string>> {
  if (context.getRequestHeaders) {
    return context.getRequestHeaders();
  }

  const scriptModuleUrl = '/script.js';
  const scriptModule = (await import(/* @vite-ignore */ scriptModuleUrl)) as {
    getRequestHeaders?: () => Record<string, string>;
  };

  if (!scriptModule.getRequestHeaders) {
    throw new Error('SillyTavern getRequestHeaders() is not available.');
  }

  return scriptModule.getRequestHeaders();
}
