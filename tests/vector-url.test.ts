import { describe, expect, it } from 'vitest';
import { normalizeEmbeddingsUrl, resolveEmbeddingRequestUrl } from '../src/vector/url';

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
});

describe('resolveEmbeddingRequestUrl', () => {
  it('automatically adds the SillyTavern proxy for external endpoints', () => {
    expect(resolveEmbeddingRequestUrl(
      'https://ark.cn-beijing.volces.com/api/v3/embeddings',
      'http://192.168.31.10:8888',
    )).toBe('/proxy/https://ark.cn-beijing.volces.com/api/v3/embeddings');
  });

  it('keeps same-origin endpoints direct to avoid a circular proxy request', () => {
    expect(resolveEmbeddingRequestUrl(
      'http://192.168.31.10:8888/api/embeddings',
      'http://192.168.31.10:8888',
    )).toBe('http://192.168.31.10:8888/api/embeddings');
  });

  it('does not add the proxy twice', () => {
    expect(resolveEmbeddingRequestUrl(
      '/proxy/https://example.com/v1/embeddings',
      'http://192.168.31.10:8888',
    )).toBe('/proxy/https://example.com/v1/embeddings');
  });
});
