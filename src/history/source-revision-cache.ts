import type { TavernChatMessage } from '../core/types';

interface SourceMessageSnapshot {
  isUser: boolean;
  isSystem: boolean;
  name: string;
  content: string;
}

/**
 * Persisted cryptographic hashes remain authoritative. This cache only proves
 * that the exact source fields have not changed since a successful check, so
 * ordinary appended replies do not serialize and hash the old prefix again.
 */
export class SourceRevisionCache {
  private ownerChatId = '';
  private sourceSignature = '';
  private endMessageId = -1;
  private messages: SourceMessageSnapshot[] = [];

  matches(
    ownerChatId: string,
    sourceSignature: string,
    chat: readonly TavernChatMessage[],
    endMessageId: number,
  ): boolean {
    if (
      !sourceSignature ||
      ownerChatId !== this.ownerChatId ||
      sourceSignature !== this.sourceSignature ||
      endMessageId !== this.endMessageId ||
      endMessageId >= chat.length ||
      this.messages.length !== endMessageId + 1
    ) {
      return false;
    }
    for (let index = 0; index <= endMessageId; index += 1) {
      const message = chat[index];
      const snapshot = this.messages[index];
      if (
        !message ||
        !snapshot ||
        message.is_user !== snapshot.isUser ||
        Boolean(message.is_system) !== snapshot.isSystem ||
        (message.name || '') !== snapshot.name ||
        message.mes !== snapshot.content
      ) {
        return false;
      }
    }
    return true;
  }

  remember(
    ownerChatId: string,
    sourceSignature: string,
    chat: readonly TavernChatMessage[],
    endMessageId: number,
  ): void {
    if (!sourceSignature || endMessageId < 0 || endMessageId >= chat.length) {
      this.clear();
      return;
    }
    this.ownerChatId = ownerChatId;
    this.sourceSignature = sourceSignature;
    this.endMessageId = endMessageId;
    this.messages = chat.slice(0, endMessageId + 1).map((message) => ({
      isUser: message.is_user,
      isSystem: Boolean(message.is_system),
      name: message.name || '',
      content: message.mes,
    }));
  }

  clear(): void {
    this.ownerChatId = '';
    this.sourceSignature = '';
    this.endMessageId = -1;
    this.messages = [];
  }
}
