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

export interface SillyTavernContext {
  chat: TavernChatMessage[];
  chatId?: string;
  characterId?: number;
  groupId?: string;
  name1?: string;
  name2?: string;
  characters?: SillyTavernCharacter[];
  groups?: Array<Record<string, unknown>>;
  tagMap?: Record<string, string[]>;
  maxContext?: number;
  extensionSettings: Record<string, unknown>;
  chatMetadata: Record<string, unknown>;
  eventSource?: {
    on(event: string, handler: (...args: unknown[]) => void | Promise<void>): void;
    off?(event: string, handler: (...args: unknown[]) => void | Promise<void>): void;
    removeListener?(event: string, handler: (...args: unknown[]) => void | Promise<void>): void;
  };
  event_types?: Record<string, string>;
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
  getCharacterCardFields?(options?: { chid?: number }): SillyTavernCharacterCardFields;
  getTokenCountAsync?(text: string, padding?: number): Promise<number>;
  substituteParams?(text: string): string;
  /** Test/future API seam; current SillyTavern builds expose this from world-info.js. */
  getSortedWorldInfoEntries?(): Promise<SillyTavernWorldInfoEntry[]>;
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
