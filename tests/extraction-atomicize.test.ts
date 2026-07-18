import { describe, expect, it } from 'vitest';
import { atomicizeMemoryCandidate } from '../src/extraction/atomicize';
import { candidate } from './fixtures';

describe('extraction candidate atomicization', () => {
  it('splits independent same-name entity facts into separate memories', () => {
    const result = atomicizeMemoryCandidate(candidate({
      type: 'revelation',
      scene: { location: '', time: '', participants: [] },
      event: '琥珀戒指和银铃的位置都已确认。',
      entities: ['琥珀戒指', '白塔药铺', '银铃', '北境白塔'],
      aliases: [],
      stateChanges: [],
      knownBy: ['刘爽'],
      retrievalText: '琥珀戒指位于白塔药铺前厅掌柜抽屉；银铃位于北境白塔顶层悬挂。',
      injectionText: '白塔药铺的琥珀戒指在抽屉，北境白塔的银铃在顶层。',
    }));

    expect(result).toHaveLength(2);
    expect(result.map((item) => item.entities)).toEqual([
      ['琥珀戒指', '白塔药铺'],
      ['银铃', '北境白塔'],
    ]);
    expect(result[0]?.retrievalText).not.toContain('银铃');
    expect(result[1]?.retrievalText).not.toContain('琥珀戒指');
    expect(result[0]?.injectionText).not.toContain('北境白塔');
    expect(result[1]?.injectionText).not.toContain('白塔药铺');
  });

  it('does not split clauses that share a core entity', () => {
    const original = candidate({
      entities: ['银色钥匙', '暮钟旅店', '红色铁盒'],
      retrievalText: '银色钥匙已从暮钟旅店取出；银色钥匙现在位于红色铁盒。',
    });

    expect(atomicizeMemoryCandidate(original)).toEqual([original]);
  });
});
