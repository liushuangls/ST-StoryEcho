import type { TavernChatMessage } from '../core/types';
import { createUuid } from '../core/uuid';

interface ActiveInternalRequest {
  marker: string;
  systemPrompt: string;
  prompt: string;
}

const activeInternalRequests = new Map<string, ActiveInternalRequest>();

export interface MarkedInternalRequest {
  marker: string;
  systemPrompt: string;
  prompt: string;
}

export function markInternalGenerationRequest(
  systemPrompt: string,
  prompt: string,
): MarkedInternalRequest {
  const marker = `story_echo_internal_${createUuid()}`;
  // Keep a plain-text sentinel with an uncommon nonce. Prompt helpers may
  // repackage or normalize messages before generate interceptors run; the
  // nonce keeps the internal call distinguishable from a real user generation
  // so it cannot deadlock behind its own background queue task.
  const markerText = `[${marker}]`;
  return {
    marker,
    systemPrompt: `${markerText}\n${systemPrompt}`,
    prompt: `${prompt}\n${markerText}`,
  };
}

export function isInternalGeneration(): boolean {
  return activeInternalRequests.size > 0;
}

/**
 * Identifies only the raw request created by StoryEcho. A global "an internal
 * request exists" flag is deliberately insufficient: a real user generation
 * can arrive concurrently and must be queued instead of skipped.
 */
export function isInternalGenerationRequest(chat: TavernChatMessage[]): boolean {
  if (activeInternalRequests.size === 0) {
    return false;
  }
  const contents = chat.map((message) => message.mes);
  for (const request of activeInternalRequests.values()) {
    if (contents.some((content) => content.includes(request.marker))) {
      return true;
    }
    // Compatibility fallback for helpers that repackage prompts before
    // invoking generate interceptors.
    if (
      contents.includes(request.systemPrompt)
      || contents.includes(request.prompt)
    ) {
      return true;
    }
  }
  return false;
}

export async function withInternalGeneration<T>(
  request: MarkedInternalRequest,
  operation: () => Promise<T>,
): Promise<T> {
  activeInternalRequests.set(request.marker, {
    marker: request.marker,
    systemPrompt: request.systemPrompt,
    prompt: request.prompt,
  });
  try {
    return await operation();
  } finally {
    activeInternalRequests.delete(request.marker);
  }
}
