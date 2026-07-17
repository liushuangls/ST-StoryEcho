import { describe, expect, it } from 'vitest';
import { normalizeChatCompletionsUrl } from '../src/llm/url';

describe('normalizeChatCompletionsUrl', () => {
  it.each([
    ['https://example.com', 'https://example.com/v1/chat/completions'],
    ['https://example.com/v1', 'https://example.com/v1/chat/completions'],
    ['https://example.com/v1/chat/completions', 'https://example.com/v1/chat/completions'],
    ['https://example.com/api', 'https://example.com/api/v1/chat/completions'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeChatCompletionsUrl(input, { allowInsecureHttp: false })).toBe(expected);
  });

  it('rejects insecure HTTP by default', () => {
    expect(() => normalizeChatCompletionsUrl('http://localhost:1234/v1', {
      allowInsecureHttp: false,
    })).toThrow(/HTTP/);
  });

  it('allows explicitly enabled HTTP', () => {
    expect(normalizeChatCompletionsUrl('http://localhost:1234/v1', {
      allowInsecureHttp: true,
    })).toBe('http://localhost:1234/v1/chat/completions');
  });

  it('rejects credentials embedded in the URL', () => {
    expect(() => normalizeChatCompletionsUrl('https://user:secret@example.com/v1', {
      allowInsecureHttp: false,
    })).toThrow('不能包含用户名或密码');
  });

  it('rejects query parameters that could persist credentials', () => {
    expect(() => normalizeChatCompletionsUrl('https://example.com/v1?api_key=secret', {
      allowInsecureHttp: false,
    })).toThrow('不能包含查询参数');
  });
});
