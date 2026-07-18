import { describe, expect, it } from 'vitest';
import { corsProxyUrl, normalizeEmbeddingsUrl } from '../src/vector/url';

describe('normalizeEmbeddingsUrl', () => {
  it.each([
    ['https://example.com', 'https://example.com/v1/embeddings'],
    ['https://example.com/v1', 'https://example.com/v1/embeddings'],
    ['https://example.com/v1/embeddings', 'https://example.com/v1/embeddings'],
    [
      'https://ark.cn-beijing.volces.com/api/v3',
      'https://ark.cn-beijing.volces.com/api/v3/embeddings',
    ],
    [
      'https://ark.cn-beijing.volces.com/api/coding/v3/',
      'https://ark.cn-beijing.volces.com/api/coding/v3/embeddings',
    ],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeEmbeddingsUrl(input, { allowInsecureHttp: false })).toBe(expected);
  });

  it('rejects unsafe or credential-bearing URLs', () => {
    expect(() => normalizeEmbeddingsUrl('http://example.com/v1', {
      allowInsecureHttp: false,
    })).toThrow(/HTTP/);
    expect(() => normalizeEmbeddingsUrl('https://user:secret@example.com/v1', {
      allowInsecureHttp: false,
    })).toThrow('不能包含用户名或密码');
    expect(() => normalizeEmbeddingsUrl('https://example.com/v1?key=secret', {
      allowInsecureHttp: false,
    })).toThrow('不能包含查询参数');
  });

  it('encodes the target URL into the SillyTavern CORS proxy path', () => {
    expect(corsProxyUrl('https://example.com/v1/embeddings')).toBe(
      '/proxy/https%3A%2F%2Fexample.com%2Fv1%2Fembeddings',
    );
  });
});
