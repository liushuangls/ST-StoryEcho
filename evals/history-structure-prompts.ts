import { createHash } from 'node:crypto';
import { STAGE_SUMMARY_BASE_SYSTEM_PROMPT } from '../src/summary/prompts';
import { SUMMARY_ARCHIVAL_GUIDANCE } from '../src/summary/archival-guidance';

/** Rejected experiment, archived for reproducibility. Never imported by src/. */
export const STAGE_SUMMARY_PRE_STRUCTURE_SYSTEM_PROMPT = `${STAGE_SUMMARY_BASE_SYSTEM_PROMPT}\n\n${SUMMARY_ARCHIVAL_GUIDANCE}`;

export const STAGE_SUMMARY_BASE_WRITING_RULE = '- 使用中立第三人称和清晰实体名称。按内容复杂度选择紧凑段落、概括性标题或少量动态小节，不逐消息复述，也不为每个场景设置标题。';

export const STAGE_SUMMARY_HISTORY_WRITING_RULE = `- 使用中立第三人称和清晰实体名称，以历史事件链组织正文。短总结使用紧凑段落；较长且包含多个实际剧情阶段时，用少量简短、事实性小标题标识阶段，不设固定分类，也不逐消息或逐场景设标题。标题只概括来源支持的事件，不新增动机、关系定性或完成结论。
- 同一事件的起因、行动或回应、结果、条件和未兑现承诺留在同一事件链中，保持来源支持的先后与因果，不为分类拆散或重复事实。状态和未决事项以本批历史结束时为界，不将当时状态表述为聊天至今仍然有效；保留必要的已有时间锚点，不补写日期。`;

export const HISTORY_STRUCTURE_CANDIDATE_SYSTEM_PROMPT = STAGE_SUMMARY_PRE_STRUCTURE_SYSTEM_PROMPT.replace(
  STAGE_SUMMARY_BASE_WRITING_RULE,
  STAGE_SUMMARY_HISTORY_WRITING_RULE,
);

// Fail before paid requests if either historical arm has drifted.
for (const [prompt, expected] of [
  [STAGE_SUMMARY_PRE_STRUCTURE_SYSTEM_PROMPT, 'bcec115f1da338458d043f351eb7b91a4d914b829bf1a70946f7e918f9f9df4c'],
  [HISTORY_STRUCTURE_CANDIDATE_SYSTEM_PROMPT, 'dac1f993b66208e7dfbc8bbc759e60d7884e2d51b3941af33ecdc38f70d73f5a'],
] as const) {
  if (createHash('sha256').update(prompt).digest('hex') !== expected) {
    throw new Error('历史组织实验的冻结提示词已变化，禁止静默重放。');
  }
}
