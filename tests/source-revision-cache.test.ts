import { describe, expect, it } from 'vitest';
import type { TavernChatMessage } from '../src/core/types';
import { SourceRevisionCache } from '../src/history/source-revision-cache';

describe('SourceRevisionCache', () => {
  it('accepts appended messages without revalidating an unchanged covered prefix', () => {
    const chat: TavernChatMessage[] = [
      { is_user: true, name: '用户', mes: '第一条' },
      { is_user: false, name: '角色', mes: '第二条' },
    ];
    const cache = new SourceRevisionCache();
    cache.remember('chat-id', '0:1:hash', chat, 1);

    chat.push({ is_user: true, mes: '新追加、尚未被总结的消息' });

    expect(cache.matches('chat-id', '0:1:hash', chat, 1)).toBe(true);
  });

  it('invalidates on every field included by the persisted source hash', () => {
    const chat: TavernChatMessage[] = [
      { is_user: true, name: '用户', mes: '原文' },
    ];
    const cache = new SourceRevisionCache();
    cache.remember('chat-id', 'signature', chat, 0);

    chat[0]!.mes = '已编辑原文';

    expect(cache.matches('chat-id', 'signature', chat, 0)).toBe(false);
    expect(cache.matches('chat-id', 'other-signature', chat, 0)).toBe(false);
  });
});
