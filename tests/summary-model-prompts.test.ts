import { describe, expect, it } from 'vitest';
import type { LlmRequest } from '../src/core/types';
import { isGemini3Model, isGeminiModel } from '../src/llm/model-family';
import { SUMMARY_ARCHIVAL_GUIDANCE } from '../src/summary/archival-guidance';
import { GEMINI_L1_DELIVERY_GUIDANCE, summaryRequestForModel } from '../src/summary/model-prompts';
import { buildStageSummaryPrompt, STAGE_SUMMARY_SYSTEM_PROMPT } from '../src/summary/prompts';

describe('model-specific L1 delivery', () => {
  it.each([
    ['gemini-3.8-flash', true, true],
    ['google/gemini-3-flash-preview', true, true],
    ['models/gemini-3.1-pro', true, true],
    ['google:gemini-3-pro', true, true],
    [' GEMINI-3.8-FLASH ', true, true],
    ['gemini-2.5-pro', true, false],
    ['gemini-30-test', true, false],
    ['deepseek-v4-flash', false, false],
    ['not-gemini-3-flash', false, false],
    ['', false, false],
  ])('recognizes the actual model ID %s', (model, gemini, gemini3) => {
    expect(isGeminiModel(model)).toBe(gemini);
    expect(isGemini3Model(model)).toBe(gemini3);
  });

  it('makes L1 coverage explicit after the complete source while preserving evidence and budgets', () => {
    const prompt = buildStageSummaryPrompt([
      { is_user: true, mes: '甲请求借用钥匙，答应次日归还。' },
      { is_user: false, mes: '乙同意，但只允许进入档案室。' },
    ], 12);
    const signal = new AbortController().signal;
    const request: LlmRequest = {
      system: STAGE_SUMMARY_SYSTEM_PROMPT, prompt,
      summaryLevel: 1, maxTokens: 3_000, timeoutMs: 300_000, signal,
    };
    const adapted = summaryRequestForModel(request, 'gemini-3.8-flash');

    expect(adapted.system).not.toContain('主动追求高压缩率');
    expect(adapted.system).toContain('优先完整覆盖独有重要事实');
    expect(adapted.system).toContain('不把要求或答应写成执行结果');
    expect(adapted.system).toContain(SUMMARY_ARCHIVAL_GUIDANCE);
    expect(adapted.prompt).toBe(`${prompt}\n\n${GEMINI_L1_DELIVERY_GUIDANCE}`);
    expect(adapted.prompt).not.toMatch(/至少\d+|不少于\d+|\d+字|Token/u);
    expect(adapted.maxTokens).toBe(3_000);
    expect(adapted.timeoutMs).toBe(300_000);
    expect(adapted.signal).toBe(signal);
    expect(request.system).toBe(STAGE_SUMMARY_SYSTEM_PROMPT);
    expect(request.prompt).toBe(prompt);
    expect(summaryRequestForModel(adapted, 'gemini-3.8-flash')).toEqual(adapted);
  });

  it.each([undefined, 2, 3])('leaves non-L1 requests untouched: level %s', (summaryLevel) => {
    const request: LlmRequest = {
      system: 'system', prompt: 'prompt',
      ...(summaryLevel === undefined ? {} : { summaryLevel }),
    };
    expect(summaryRequestForModel(request, 'gemini-3.8-flash')).toBe(request);
  });

  it('leaves other models on the existing L1 prompt', () => {
    const request: LlmRequest = { system: STAGE_SUMMARY_SYSTEM_PROMPT, prompt: 'prompt', summaryLevel: 1 };
    expect(summaryRequestForModel(request, 'deepseek-v4-flash')).toBe(request);
  });
});
