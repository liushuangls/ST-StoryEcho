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

  it('spells out the fixed candidate field names for providers that ignore JSON Schema', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('type、scene、event');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('truthStatus只能是');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('不要改名为secret、content、confidence');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('importance低于0.6的普通事件不要输出');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('一闪而过的猜测');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('该封闭名单优先');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('必须输出两条');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('多个独立entity或attribute必须拆成多条记忆');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('完成状态');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('同一个完整标识');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('sourceMessageIds');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('reference_context没有messageId');
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
});
