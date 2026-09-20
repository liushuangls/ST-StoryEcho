import { describe, expect, it } from 'vitest';
import { PROMPT_EVAL_CHAIN_CASES } from '../evals/chain-cases';
import { buildHistoryStructureProbe, historyStructureSchedule, scoreHistoryStructureProbe } from '../evals/history-structure';

const fixture = PROMPT_EVAL_CHAIN_CASES[0]!;
const archive = '## 借用与归还\n\n完整历史证据。\n\n### 合作暂停\n尚未恢复。';
const answers = () => fixture.probes.map((probe) => ({ id: probe.id, choice: probe.correctChoice as number | 'unknown', evidence: ['完整历史证据。'] }));

describe('history structure downstream evaluation', () => {
  it('preserves raw layout without exposing expected choices or unrelated source text', () => {
    const request = buildHistoryStructureProbe(fixture, archive);
    expect(request.prompt).toContain(`<history_archive>\n${archive}\n</history_archive>`);
    expect(request.prompt).not.toContain('correctChoice');
    expect(request.prompt).not.toContain(fixture.batches[0]![0]!.mes);
    expect(request.prompt).not.toContain('context_segments');
  });

  it('freezes two balanced rounds for each scene, within 18 requests', () => {
    const schedule = historyStructureSchedule(PROMPT_EVAL_CHAIN_CASES);
    expect(schedule).toHaveLength(8);
    expect(PROMPT_EVAL_CHAIN_CASES.length + schedule.length * 2).toBe(18);
    for (const scene of PROMPT_EVAL_CHAIN_CASES) {
      for (const arm of ['control', 'candidate']) expect(schedule.filter((trial) => trial.fixtureId === scene.id && trial.arm === arm)).toHaveLength(2);
      expect(schedule.filter((trial) => trial.fixtureId === scene.id && trial.round === 1).map((trial) => trial.arm))
        .toEqual(schedule.filter((trial) => trial.fixtureId === scene.id && trial.round === 2).map((trial) => trial.arm).reverse());
    }
  });

  it('scores answers while preserving quotes for subsequent semantic review', () => {
    expect(scoreHistoryStructureProbe(fixture, archive, JSON.stringify({ answers: answers() }))).toMatchObject({ correct: 8, total: 8 });
    const unknown = answers(); unknown[0]!.choice = 'unknown'; unknown[0]!.evidence = [];
    expect(scoreHistoryStructureProbe(fixture, archive, JSON.stringify({ answers: unknown }))).toMatchObject({ correct: 7, total: 8 });
  });

  it('rejects invented/absent quotes, duplicate IDs, invalid choices and missing answers', () => {
    for (const mutate of [
      (copy: ReturnType<typeof answers>) => { copy[0]!.evidence = ['不存在的引文']; },
      (copy: ReturnType<typeof answers>) => { copy[0]!.evidence = []; },
      (copy: ReturnType<typeof answers>) => { copy[0]!.choice = 'unknown'; },
      (copy: ReturnType<typeof answers>) => { copy[0]!.choice = 10; },
      (copy: ReturnType<typeof answers>) => { copy[1]!.id = copy[0]!.id; },
      (copy: ReturnType<typeof answers>) => { copy.pop(); },
    ]) {
      const copy = answers(); mutate(copy);
      expect(() => scoreHistoryStructureProbe(fixture, archive, JSON.stringify({ answers: copy }))).toThrow();
    }
  });
});
