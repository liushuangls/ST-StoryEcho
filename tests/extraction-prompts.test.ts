import { describe, expect, it } from 'vitest';
import { buildExtractionPrompt } from '../src/extraction/prompts';

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
});
