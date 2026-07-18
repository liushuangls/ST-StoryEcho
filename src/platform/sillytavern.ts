import type { TavernChatMessage } from '../core/types';

export interface SillyTavernContext {
  chat: TavernChatMessage[];
  chatId?: string;
  characterId?: number;
  groupId?: string;
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
