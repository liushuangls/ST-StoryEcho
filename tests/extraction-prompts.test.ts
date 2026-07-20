import { describe, expect, it } from 'vitest';
import { buildExtractionPrompt, EXTRACTION_SYSTEM_PROMPT } from '../src/extraction/prompts';

describe('buildExtractionPrompt', () => {
  it('keeps source ids while excluding system messages from story extraction', () => {
    const prompt = buildExtractionPrompt([
      { is_user: true, mes: 'user message' },
      { is_user: false, is_system: true, mes: 'hidden system note' },
      { is_user: false, mes: 'assistant message' },
    ], 0, 2, 20);

    expect(prompt).toContain('消息 20 到 22');
    expect(prompt).toContain('"messageId":20');
    expect(prompt).toContain('"messageId":22');
    expect(prompt).not.toContain('hidden system note');
  });

  it('spells out classified roots and critical rules for providers that ignore JSON Schema', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain(
      'episodes、stateFacts、relationships、commitments、revelations、clues六个数组',
    );
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('truthStatus只能是');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('只填写各分类要求的事实字段');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('importance低于0.6的普通事件不要输出');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('一闪而过的猜测');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('该封闭名单优先');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('同一原文可以同时产生一条完整episode和多条stateFacts');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('每个独立entity+attribute必须单独一项');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('同一承诺或任务从提出到完成放入commitments');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('sourceMessageIds');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('reference_context没有messageId');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('我叫刘爽');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('稳定状态');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('统一使用稳定主体entity="用户"');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('AI对用户身份的猜测不是稳定事实');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('位置和持有/保管人永远是两个不同槽');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('name只是SillyTavern界面说话者标签');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('不要套用预设题材');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('修炼、突破、历练与日常成长主要进入episodes/stateFacts');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('普通未知信息不得自动变成clue');
  });

  it('places controlled reference context before the evidence messages', () => {
    const prompt = buildExtractionPrompt(
      [{ is_user: true, mes: '聊天正文' }],
      0,
      0,
      8,
      '<story_echo_reference_context>只用于消歧</story_echo_reference_context>',
    );

    expect(prompt.indexOf('<story_echo_reference_context>')).toBeLessThan(
      prompt.indexOf('<history_messages>'),
    );
  });

  it('sends displayed assistant narrative instead of hidden preset reasoning', () => {
    const prompt = buildExtractionPrompt([{
      is_user: false,
      mes: '<thinking>规划下一幕</thinking><正文>银钥匙被交给顾青。</正文><status>变量面板</status>',
    }], 0, 0, 3);

    expect(prompt).toContain('银钥匙被交给顾青');
    expect(prompt).not.toContain('规划下一幕');
    expect(prompt).not.toContain('变量面板');
  });
});
