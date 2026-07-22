import { describe, expect, it } from 'vitest';
import { storySkeletonQualityIssues } from '../src/summary/skeleton-quality';

describe('story skeleton quality gate', () => {
  it('finds relationship absence claims, narrator stage labels, and state snapshots', () => {
    const issues = storySkeletonQualityIssues([
      '## 当前事件链与待续触发点',
      '',
      '姜梦听懂刘爽的未尽心意，却没有给予未来承诺；两人已进入信任期。',
      '',
      '苏清雪仍是克制的剑道同行者，没有恋爱确认。',
      '',
      '刘爽与南宫婉只是有限信任的联络者，并非亲密伙伴或恋爱关系。',
      '',
      '截至12月28日未时，刘爽已是金丹圆满，灵力稳定，银纹长剑仍在修复。',
    ].join('\n'));

    expect(issues.some((issue) => issue.kind === 'relationship-stage')).toBe(true);
    expect(issues.some((issue) => issue.kind === 'relationship-absence')).toBe(true);
    expect(issues.filter((issue) => issue.kind === 'state-snapshot')).toHaveLength(2);
  });

  it('keeps explicit spoken boundaries and unresolved plot evidence outside the gate', () => {
    const issues = storySkeletonQualityIssues([
      '姜梦明确说：“你仍是我的弟子。”这句话让刘爽停止追问，先去完成训练。',
      '异界法则母体尚未确认，黑金阁与祭坛的关系也仍待核实。',
      '海伊没有强闯护阵，而是交出傀儡并接受执剑堂问询。',
    ].join('\n\n'));

    expect(issues).toEqual([]);
  });
});
