import { describe, expect, it } from 'vitest';
import { isFactVerificationQuery } from '../src/retrieval/intent';

describe('fact-verification intent', () => {
  it('recognizes strict and current-state fact questions', () => {
    expect(isFactVerificationQuery('不要续写，只回答当前事实：银钥匙在哪里？')).toBe(true);
    expect(isFactVerificationQuery('银色钥匙现在由谁保管？')).toBe(true);
    expect(isFactVerificationQuery('若没有已确认记录，就回答“没有已确认记录”。')).toBe(true);
  });

  it('keeps ordinary continuation and speculative investigation in narrative mode', () => {
    expect(isFactVerificationQuery('继续调查那名失踪男子。')).toBe(false);
    expect(isFactVerificationQuery('你觉得他可能为什么离开？')).toBe(false);
  });
});
