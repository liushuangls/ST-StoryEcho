import { describe, expect, it } from 'vitest';
import {
  buildRetrievalQueryPlan,
  isWeakRetrievalIntent,
  withRewrittenRetrievalQuery,
} from '../src/retrieval/query-builder';

describe('buildRetrievalQueryPlan', () => {
  it('does not contaminate a self-contained user query with assistant prose', () => {
    const ignoredBeginning = '很久以前的无关描述。'.repeat(80);
    const relevantEnding = '林雨站在钟楼前，把银色钥匙递了过来。'.repeat(40);
    const plan = buildRetrievalQueryPlan([
      { is_user: false, mes: `${ignoredBeginning}${relevantEnding}` },
      { is_user: true, mes: '我要问林雨钥匙从哪里来。' },
    ], 1);

    expect(plan.intentQuery).toBe('我要问林雨钥匙从哪里来。');
    expect(plan.sceneQuery).toBe('');
    expect(plan.keywordSceneQuery).toBe('');
    expect(plan.intentWeight).toBe(1);
    expect(plan.sceneWeight).toBe(0);
  });

  it('uses the latest non-system assistant message as scene context', () => {
    const plan = buildRetrievalQueryPlan([
      { is_user: false, mes: '较早的AI回复' },
      { is_user: true, mes: '上一轮用户输入' },
      { is_user: false, mes: '最新的AI回复' },
      { is_user: false, is_system: true, mes: '系统注入' },
      { is_user: true, mes: '继续' },
    ], 4);

    expect(plan.sceneQuery).toBe('最新的AI回复');
    expect(plan.weakIntent).toBe(true);
    expect(plan.intentWeight).toBe(0.25);
    expect(plan.sceneWeight).toBe(1);
  });

  it('keeps the assistant tail only when a concrete query contains an unresolved reference', () => {
    const plan = buildRetrievalQueryPlan([
      { is_user: false, mes: '林雨把星纹钥匙锁进北塔的铁柜。' },
      { is_user: true, mes: '那把钥匙现在在哪里？' },
    ], 1);

    expect(plan.intentQuery).toBe('那把钥匙现在在哪里？');
    expect(plan.sceneQuery).toContain('星纹钥匙');
    expect(plan.intentWeight).toBe(1);
    expect(plan.sceneWeight).toBe(0.55);
  });

  it('treats a user identity question as self-contained', () => {
    const plan = buildRetrievalQueryPlan([
      { is_user: false, mes: '上一条AI回复猜测了年龄、性别和时间。' },
      { is_user: true, mes: '你还记得我的名字吗' },
    ], 1);

    expect(plan.sceneQuery).toBe('');
    expect(plan.sceneWeight).toBe(0);
  });

  it('uses an LLM rewrite for vectors while preserving raw text for exact entity matching', () => {
    const local = buildRetrievalQueryPlan([
      { is_user: false, mes: '林雨带着钥匙进入钟楼。' },
      { is_user: true, mes: '我跟上去' },
    ], 1);
    const rewritten = withRewrittenRetrievalQuery(local, '林雨进入钟楼后的去向和钥匙线索');

    expect(rewritten).toMatchObject({
      strategy: 'llm',
      intentQuery: '林雨进入钟楼后的去向和钥匙线索',
      sceneQuery: '',
      keywordIntentQuery: '我跟上去',
      keywordSceneQuery: '林雨带着钥匙进入钟楼。',
      intentWeight: 1,
      sceneWeight: 0,
    });
  });
});

describe('isWeakRetrievalIntent', () => {
  it.each(['继续！', '然后呢？', '我跟上去。', 'go on', 'OK'])('recognizes %s as context-dependent', (input) => {
    expect(isWeakRetrievalIntent(input)).toBe(true);
  });

  it('keeps a short but concrete intent at full weight', () => {
    expect(isWeakRetrievalIntent('去港口找林雨')).toBe(false);
  });
});
