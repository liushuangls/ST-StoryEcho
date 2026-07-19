import type { EvidenceRole, TavernChatMessage } from '../core/types';

export function classifyEvidenceRole(
  sourceMessageIds: readonly number[],
  messages: readonly TavernChatMessage[],
  sourceStartMessageId = 0,
): EvidenceRole {
  let hasUser = false;
  let hasAssistant = false;
  for (const messageId of sourceMessageIds) {
    const message = messages[messageId - sourceStartMessageId];
    if (!message || message.is_system) {
      continue;
    }
    if (message.is_user) {
      hasUser = true;
    } else {
      hasAssistant = true;
    }
  }
  if (hasUser && hasAssistant) {
    return 'mixed';
  }
  if (hasUser) {
    return 'user';
  }
  if (hasAssistant) {
    return 'assistant';
  }
  return 'unknown';
}

export function combineEvidenceRoles(
  left: EvidenceRole | undefined,
  right: EvidenceRole | undefined,
): EvidenceRole {
  const roles = new Set([left ?? 'unknown', right ?? 'unknown']);
  if (roles.has('mixed') || (roles.has('user') && roles.has('assistant'))) {
    return 'mixed';
  }
  if (roles.has('user')) {
    return 'user';
  }
  if (roles.has('assistant')) {
    return 'assistant';
  }
  return 'unknown';
}

export function evidenceRoleRank(role: EvidenceRole | undefined): number {
  switch (role) {
    case 'user':
    case 'mixed':
      return 3;
    case 'unknown':
    case 'assistant':
      return 1;
    default:
      return 1;
  }
}
