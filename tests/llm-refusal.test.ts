import { describe, expect, it } from 'vitest';
import type { LlmCompletionResult } from '../src/core/types';
import { LlmRefusalError, LlmTruncatedResponseError } from '../src/llm/errors';
import { assertNoLlmRefusal, assertSummaryCompletionAccepted } from '../src/llm/refusal';

function result(text: string, finishReason = 'stop'): LlmCompletionResult {
  return {
    text,
    metadata: {
      provider: 'main',
      requestedMaxTokens: 3_000,
      responseCharacters: Array.from(text).length,
      finishReason,
    },
  };
}

describe('summary refusal detection', () => {
  it.each([
    { promptFeedback: { blockReason: 'SAFETY' } },
    { candidates: [{ finishReason: 'SAFETY' }] },
    { candidates: [{ finishReason: 'PROHIBITED_CONTENT' }] },
    { choices: [{ finish_reason: 'content_filter', message: { content: 'partial' } }] },
    { choices: [{ message: { refusal: 'private refusal body', content: '' } }] },
    { choices: [{ delta: { refusal: 'private stream fragment' } }] },
    { choices: [{ message: { content: [{ type: 'refusal', refusal: 'private' }] } }] },
    { delta: { stop_reason: 'refusal' } },
    { stopReason: 'REFUSAL' },
    { message: { refusal: 'private' } },
    { type: 'response.refusal.delta', delta: 'private' },
    { type: 'response.refusal.done', refusal: 'private' },
  ])('rejects a provider-declared block without retaining its text: %j', (payload) => {
    let error: unknown;
    try {
      assertNoLlmRefusal(payload);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(LlmRefusalError);
    expect(String(error)).toContain('内容过滤');
    expect(JSON.stringify(error)).not.toContain('private');
  });

  it.each([
    null,
    [],
    { promptFeedback: { blockReason: 'BLOCK_REASON_UNSPECIFIED' } },
    { promptFeedback: { blockReason: '' } },
    { candidates: [{ finishReason: 'STOP' }] },
    { choices: [{ finish_reason: 'length', message: { refusal: null, content: '剧情摘要' } }] },
    { choices: [{ message: { refusal: '', content: [{ type: 'text', text: '甲拒绝交易。' }] } }] },
  ])('does not mistake ordinary completions or missing metadata for a refusal: %j', (payload) => {
    expect(() => assertNoLlmRefusal(payload)).not.toThrow();
  });

  it.each([
    '抱歉，我无法为包含露骨性描写的文本生成摘要。',
    '我不能总结这段内容。',
    '很抱歉，这段文本含有敏感内容，我无法提供摘要。',
    '作为一个AI语言模型，我不能帮助处理这个请求。',
    '```md\n<story_echo_summary>抱歉，我无法提供这个总结。</story_echo_summary>\n```',
    "I'm sorry, I can't summarize this content.",
    'I am unable to process this request.',
    'Sorry, I cannot provide a summary of this material.',
  ])('rejects explicit model refusal prose: %s', (text) => {
    expect(() => assertSummaryCompletionAccepted(result(text))).toThrow(LlmRefusalError);
  });

  it.each([
    '甲拒绝交易，但答应次日归还钥匙。',
    '两名成年角色自愿发生亲密互动，随后约定次日共同出发。',
    '乙说“抱歉，我不能帮助你”，甲接受了这一边界。',
    '“我无法提供帮助”是门卫对甲请求的回应。',
    '无法确认两人是否已经建立恋爱关系。',
    '甲向乙道歉，表示不能继续原定计划。',
    '这里的“NSFW”是来源标签，摘要只记录了双方约定。',
    'Alice refused the proposal; Bob agreed to wait.',
  ])('preserves story facts about refusal, uncertainty and intimacy: %s', (text) => {
    expect(() => assertSummaryCompletionAccepted(result(text))).not.toThrow();
  });

  it('distinguishes content filtering from output-limit truncation', () => {
    expect(() => assertSummaryCompletionAccepted(result('部分剧情', 'SAFETY')))
      .toThrow(LlmRefusalError);
    expect(() => assertSummaryCompletionAccepted(result('部分剧情', 'length')))
      .toThrow(LlmTruncatedResponseError);
  });

  it.each(['length', 'MAX_TOKENS', ' max-token ', 'max output tokens', 'token_limit', 'OUTPUT_TOKEN_LIMIT'])(
    'rejects declared incomplete output without keeping private prose: %s', (reason) => {
      let error: unknown;
      try { assertSummaryCompletionAccepted(result('private unfinished summary', reason)); }
      catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(LlmTruncatedResponseError);
      expect(error).toMatchObject({ completion: { finishReason: reason } });
      expect(String(error)).toContain('保留原文或原有总结');
      expect(JSON.stringify(error)).not.toContain('private unfinished summary');
    },
  );

  it.each([undefined, '', 'stop', 'STOP', 'end_turn', 'unknown'])(
    'does not infer truncation from prose or absent metadata: %s', (reason) => {
      const completion = result('旅队到达边界，守卫提到“length”和 Token 上限。');
      if (reason === undefined) delete completion.metadata.finishReason;
      else completion.metadata.finishReason = reason;
      expect(() => assertSummaryCompletionAccepted(completion)).not.toThrow();
    },
  );
});
