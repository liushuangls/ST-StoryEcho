import type { TavernChatMessage } from '../core/types';

const HIDDEN_REASONING_TAGS = [
  'think',
  'thinking',
  'analysis',
  'reasoning',
  'scratchpad',
  'internal_thought',
];
const NARRATIVE_WRAPPERS = ['正文', 'now_plot', 'content'];

function pairedTag(tag: string): RegExp {
  return new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}\\s*>`, 'giu');
}

function stripHiddenReasoning(value: string): string {
  let result = value.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const tag of HIDDEN_REASONING_TAGS) {
    result = result.replace(pairedTag(tag), ' ');
  }
  return result.replace(
    /<details(?:\s[^>]*)?>\s*<summary(?:\s[^>]*)?>[^<]*(?:思考|推理|analysis|reasoning)[\s\S]*?<\/details\s*>/giu,
    ' ',
  );
}

function wrappedNarrative(value: string): string {
  for (const tag of NARRATIVE_WRAPPERS) {
    const matches = [...value.matchAll(pairedTag(tag))]
      .map((match) => match[1]?.trim() ?? '')
      .filter(Boolean);
    if (matches.length > 0) {
      return matches.join('\n\n');
    }
  }
  return value;
}

/**
 * Produce evidence text for background models without changing the stored chat.
 * User text remains verbatim because it is the highest-authority evidence.
 * Assistant-only hidden reasoning and common presentation wrappers are removed
 * so extraction, summaries, world-info matching, and query rewrite see the
 * displayed story rather than preset scaffolding.
 */
export function storyContent(message: Pick<TavernChatMessage, 'is_user' | 'mes'>): string {
  if (message.is_user) {
    return message.mes.trim();
  }
  return wrappedNarrative(stripHiddenReasoning(message.mes))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function storyMessages(messages: TavernChatMessage[]): TavernChatMessage[] {
  return messages.map((message) => ({
    ...message,
    mes: storyContent(message),
  }));
}
