import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildPromptEvalCase, PROMPT_EVAL_CASES } from '../evals/cases';
import { L1_AUDIT_DEVELOPMENT_CASES } from '../evals/l1-audit-cases';
import { caseEvaluationHash } from '../evals/protocol';
import {
  applyPromptEvalVariant,
  L1_ADJACENT_ORDER_EDGES_PRINCIPLE,
  L1_EVENT_TRANSITION_CANDIDATE,
  L1_LEAN_EVIDENCE_CONTRACT_CANDIDATE,
  L1_LEAN_EVIDENCE_CONTRACT_V2_CANDIDATE,
  L1_LOW_IMPACT_OMISSION_PRINCIPLE,
  L1_LOW_IMPACT_OMISSION_V2_CANDIDATE,
  L1_SOURCE_ORDER_CANDIDATE,
  promptEvalVariant,
} from '../evals/variants';
import { STAGE_SUMMARY_BASE_SYSTEM_PROMPT, STAGE_SUMMARY_SYSTEM_PROMPT } from '../src/summary/prompts';
import { SUMMARY_ARCHIVAL_GUIDANCE } from '../src/summary/archival-guidance';

const FROZEN_V2_SHA256 = '80fbaf870f951a055f8eddb83875a92e9ac79b0623c8939d4e88f7a2995808ff';

describe('promoted L1 lean evidence contract', () => {
  it('preserves the evaluated v2 contract and identifies the separate archival addition', () => {
    expect(L1_LEAN_EVIDENCE_CONTRACT_CANDIDATE.split(L1_LOW_IMPACT_OMISSION_PRINCIPLE))
      .toHaveLength(2);
    expect(L1_LEAN_EVIDENCE_CONTRACT_V2_CANDIDATE).toBe(
      L1_LEAN_EVIDENCE_CONTRACT_CANDIDATE.replace(
        L1_LOW_IMPACT_OMISSION_PRINCIPLE,
        L1_LOW_IMPACT_OMISSION_V2_CANDIDATE,
      ),
    );
    expect(STAGE_SUMMARY_BASE_SYSTEM_PROMPT).toBe(L1_LEAN_EVIDENCE_CONTRACT_V2_CANDIDATE);
    expect(Array.from(STAGE_SUMMARY_BASE_SYSTEM_PROMPT)).toHaveLength(1_577);
    expect(createHash('sha256').update(STAGE_SUMMARY_BASE_SYSTEM_PROMPT).digest('hex'))
      .toBe(FROZEN_V2_SHA256);
    expect(STAGE_SUMMARY_SYSTEM_PROMPT)
      .toBe(`${STAGE_SUMMARY_BASE_SYSTEM_PROMPT}\n\n${SUMMARY_ARCHIVAL_GUIDANCE}`);
  });

  it('keeps the validated evidence, ordering and density behavior generic', () => {
    expect(STAGE_SUMMARY_SYSTEM_PROMPT).toContain('事实契约');
    expect(STAGE_SUMMARY_SYSTEM_PROMPT).toContain('是否归还尚未交代');
    expect(STAGE_SUMMARY_SYSTEM_PROMPT).toContain('把它作为省略信号');
    expect(STAGE_SUMMARY_SYSTEM_PROMPT).toContain('篇幅由有效信息量决定');
    expect(STAGE_SUMMARY_SYSTEM_PROMPT).toContain('所有关键变化、当前结果和待续事项已覆盖且没有重复时立即收束');
    expect(STAGE_SUMMARY_SYSTEM_PROMPT)
      .not.toMatch(/林晚|周宁|乔音|奖学金|住院|评论区|潮镜|北库|服务器所有权|Token|字数/);
  });

  it('keeps chat history above prior summaries and world-book context', () => {
    expect(STAGE_SUMMARY_SYSTEM_PROMPT).toContain('与本批冲突时以history_messages中较新的有效信息为准');
    expect(STAGE_SUMMARY_SYSTEM_PROMPT).toContain('不能证明某个剧情事件已经发生，也不能覆盖聊天原文');
  });

  it('separates requests, decisions, execution and completion', () => {
    expect(STAGE_SUMMARY_SYSTEM_PROMPT)
      .toContain('不把意图写成决定，不把要求或答应写成执行结果');
  });

  it('preserves meaning-bearing chronology and newer revisions', () => {
    expect(STAGE_SUMMARY_SYSTEM_PROMPT).toContain('不得倒置“触发或要求—回应或决定—执行或结果”');
    expect(STAGE_SUMMARY_SYSTEM_PROMPT).toContain('较新的明确状态替换较旧状态');
  });

  it('preserves epistemic boundaries and unknown outcomes', () => {
    expect(STAGE_SUMMARY_SYSTEM_PROMPT).toContain('注明持有者及确定程度');
    expect(STAGE_SUMMARY_SYSTEM_PROMPT).toContain('未交代的结果不推定为已发生或已失败');
  });

  it('grounds relationship changes in observable evidence', () => {
    expect(STAGE_SUMMARY_SYSTEM_PROMPT)
      .toContain('关系与立场变化只依据可见行动、明确话语、具体回应、共同决定和实际承诺');
    expect(STAGE_SUMMARY_SYSTEM_PROMPT).toContain('不擅自补全更深动机、关系标签或唯一解释');
  });

  it('bridges confirmed aliases without merging uncertain identities', () => {
    expect(STAGE_SUMMARY_SYSTEM_PROMPT).toContain('新旧身份对应时建立桥接');
    expect(STAGE_SUMMARY_SYSTEM_PROMPT).toContain('尚未确认对应关系时保留不同称呼和不确定性');
  });

  it('uses explicit no-change evidence as an omission signal', () => {
    expect(STAGE_SUMMARY_SYSTEM_PROMPT).toContain('把它作为省略信号');
    expect(STAGE_SUMMARY_SYSTEM_PROMPT).toContain('只有省略会让当前状态产生歧义时，才用最短否定说明');
  });

  it('keeps output length adaptive rather than imposing a numeric target', () => {
    expect(STAGE_SUMMARY_SYSTEM_PROMPT).toContain('篇幅由有效信息量决定');
    expect(STAGE_SUMMARY_SYSTEM_PROMPT).not.toMatch(/\d+[～~-]\d+个中文字符/u);
    expect(STAGE_SUMMARY_SYSTEM_PROMPT).not.toMatch(/(?:最大|至少|不超过).*?(?:Token|字|字符)/u);
  });

  it('keeps v1 and v2 reproducible without silently adding new production guidance', () => {
    expect(promptEvalVariant(' l1-lean-evidence-contract-v2 ')).toBe('l1-lean-evidence-contract-v2');
    expect(promptEvalVariant(' l1-lean-evidence-contract ')).toBe('l1-lean-evidence-contract');
    expect(Array.from(L1_LEAN_EVIDENCE_CONTRACT_CANDIDATE).length)
      .toBeLessThan(Array.from(STAGE_SUMMARY_SYSTEM_PROMPT).length);

    for (const definition of [...L1_AUDIT_DEVELOPMENT_CASES, ...PROMPT_EVAL_CASES]) {
      const base = buildPromptEvalCase(definition);
      const v2 = applyPromptEvalVariant(base, 'l1-lean-evidence-contract-v2');
      const v1 = applyPromptEvalVariant(base, 'l1-lean-evidence-contract');
      expect(caseEvaluationHash(v2)).toBe(caseEvaluationHash(base));
      expect(caseEvaluationHash(v1)).toBe(caseEvaluationHash(base));
      if (base.kind !== 'l1') {
        expect(v2).toBe(base);
        expect(v1).toBe(base);
        continue;
      }
      expect(v2).toEqual({ ...base, system: L1_LEAN_EVIDENCE_CONTRACT_V2_CANDIDATE });
      expect(v2.system).not.toContain(SUMMARY_ARCHIVAL_GUIDANCE);
      expect(v1).toEqual({ ...base, system: L1_LEAN_EVIDENCE_CONTRACT_CANDIDATE });
      expect(v1.prompt).toBe(base.prompt);
      expect(v1.maxTokens).toBe(base.maxTokens);
    }
  });

  it('fails closed if an L1 prompt is modified or an ablation is stacked', () => {
    const base = buildPromptEvalCase(L1_AUDIT_DEVELOPMENT_CASES[0]!);
    const stale = { ...base, system: `${base.system}\n外部修改` };
    expect(() => applyPromptEvalVariant(stale, 'l1-lean-evidence-contract-v2'))
      .toThrow('不能重复或叠加');
    expect(() => applyPromptEvalVariant(stale, 'l1-lean-evidence-contract'))
      .toThrow('不能重复或叠加');
    const v1 = applyPromptEvalVariant(base, 'l1-lean-evidence-contract');
    expect(() => applyPromptEvalVariant(v1, 'l1-lean-evidence-contract'))
      .toThrow('不能重复或叠加');
  });
});

describe('archived L1 clause experiments', () => {
  const archived = [
    ['l1-event-transition', L1_EVENT_TRANSITION_CANDIDATE],
    ['l1-source-order', L1_SOURCE_ORDER_CANDIDATE],
    ['l1-adjacent-order-edges', L1_ADJACENT_ORDER_EDGES_PRINCIPLE],
  ] as const;

  it('keeps their names and generic frozen text for interpreting saved results', () => {
    for (const [variant, candidate] of archived) {
      expect(promptEvalVariant(` ${variant} `)).toBe(variant);
      expect(candidate).not.toMatch(/林晚|周宁|乔音|奖学金|住院|评论区|Token|字数/);
      expect(STAGE_SUMMARY_SYSTEM_PROMPT).not.toContain(candidate);
    }
  });

  it('rejects applying old-baseline variants to the promoted L1 prompt', () => {
    const l1 = buildPromptEvalCase(L1_AUDIT_DEVELOPMENT_CASES[0]!);
    const l2Definition = PROMPT_EVAL_CASES.find((definition) => definition.kind === 'l2');
    expect(l2Definition).toBeDefined();
    const l2 = buildPromptEvalCase(l2Definition!);

    for (const [variant] of archived) {
      expect(() => applyPromptEvalVariant(l1, variant)).toThrow('已归档');
      expect(applyPromptEvalVariant(l2, variant)).toBe(l2);
    }
  });
});
