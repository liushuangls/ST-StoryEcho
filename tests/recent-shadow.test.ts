import { describe, expect, it } from 'vitest';
import { isShadowedByRecentUserFact } from '../src/retrieval/recent-shadow';
import { memory } from './fixtures';

describe('recent User fact shadowing', () => {
  const oldLocation = memory({
    logicalKey: 'location:玄纹玉简',
    entities: ['玄纹玉简', '赤铜盒'],
    aliases: [],
    stateChanges: [{ entity: '玄纹玉简', attribute: '位置', after: '月井地下室赤铜盒' }],
    retrievalText: '玄纹玉简位于月井地下室赤铜盒。',
  });

  it('shadows an older state after a recent explicit User move', () => {
    expect(isShadowedByRecentUserFact(oldLocation, [
      { is_user: true, mes: '我把玄纹玉简藏进听雪楼密室第二层鹿皮匣。' },
      { is_user: false, mes: '虞颜收好了玉简。' },
    ], 0, 1)).toBe(true);
  });

  it('does not shadow the memory when the User is only asking for its location', () => {
    expect(isShadowedByRecentUserFact(oldLocation, [
      { is_user: true, mes: '玄纹玉简现在具体藏在哪里？' },
    ], 0, 0)).toBe(false);
  });

  it('does not mistake a question containing update words for a new fact', () => {
    expect(isShadowedByRecentUserFact(oldLocation, [
      { is_user: true, mes: '玄纹玉简已经转移到哪里了？' },
    ], 0, 0)).toBe(false);
    expect(isShadowedByRecentUserFact(oldLocation, [
      { is_user: true, mes: '玄纹玉简已经转移了？' },
    ], 0, 0)).toBe(false);
  });

  it('still recognizes a declarative update followed by a separate question', () => {
    expect(isShadowedByRecentUserFact(oldLocation, [
      { is_user: true, mes: '剧情更新：玄纹玉简已经移到听雪楼密室。你记住了吗？' },
    ], 0, 0)).toBe(true);
  });

  it('keeps commas inside an ordinary declarative update', () => {
    expect(isShadowedByRecentUserFact(oldLocation, [
      { is_user: true, mes: '剧情更新：玄纹玉简，已经转移到听雪楼密室。' },
    ], 0, 0)).toBe(true);
  });

  it('does not let an Assistant-only hallucination hide confirmed memory', () => {
    expect(isShadowedByRecentUserFact(oldLocation, [
      { is_user: false, mes: '玄纹玉简已经被陌生人偷走了。' },
    ], 0, 0)).toBe(false);
  });
});
