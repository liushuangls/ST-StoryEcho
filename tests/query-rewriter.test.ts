import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import {
  buildQueryRewriteInput,
  parseQueryRewriteResponse,
  QueryRewriteService,
} from '../src/retrieval/query-rewriter';

describe('query rewrite input', () => {
  it('uses the current user message and only the three most recent non-system context messages', () => {
    const input = buildQueryRewriteInput([
      { is_user: false, mes: '会被窗口丢弃的较早回复' },
      { is_user: true, mes: '较早用户消息' },
      { is_user: false, is_system: true, mes: '系统注入不应发送' },
      { is_user: false, mes: '林雨带着钥匙进入钟楼。' },
      { is_user: true, mes: '你确定要进去吗？' },
      { is_user: false, mes: '林雨点了点头。' },
      { is_user: true, mes: '我跟上去' },
    ], 6);

    expect(input.currentUser).toBe('我跟上去');
    expect(input.recentContext).toHaveLength(3);
    expect(input.recentContext.map((item) => item.content)).toEqual([
      '林雨带着钥匙进入钟楼。',
      '你确定要进去吗？',
      '林雨点了点头。',
    ]);
    expect(JSON.stringify(input)).not.toContain('系统注入');
  });
});

describe('parseQueryRewriteResponse', () => {
  it('accepts fenced JSON and normalizes whitespace', () => {
    expect(parseQueryRewriteResponse('```json\n{"query":" 林雨  进入钟楼后的线索 "}\n```'))
      .toBe('林雨 进入钟楼后的线索');
  });

  it('rejects an empty query', () => {
    expect(() => parseQueryRewriteResponse('{"query":""}')).toThrow('缺少query');
  });
});

describe('QueryRewriteService', () => {
  it('caches the rewritten query for the same chat context', async () => {
    const completion = vi.fn(async () => '{"query":"林雨进入钟楼后的去向、银色钥匙和守卫线索"}');
    const service = new QueryRewriteService(completion);
    const settings = structuredClone(DEFAULT_SETTINGS);
    const messages = [
      { is_user: false, mes: '林雨握着银色钥匙逃进钟楼。' },
      { is_user: true, mes: '我跟上去' },
    ];

    const first = await service.rewrite(settings, messages, 1, 'chat-a');
    const second = await service.rewrite(settings, messages, 1, 'chat-a');

    expect(first).toMatchObject({ cacheHit: false, query: '林雨进入钟楼后的去向、银色钥匙和守卫线索' });
    expect(second).toMatchObject({ cacheHit: true, query: first.query, durationMs: 0 });
    expect(completion).toHaveBeenCalledOnce();
  });
});
