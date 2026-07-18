export function normalizeChatCompletionsUrl(
  rawUrl: string,
  options: { allowInsecureHttp: boolean },
): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error('Base URL不能为空。');
  }
  if (trimmed.length > 2_048) {
    throw new Error('Base URL过长。');
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('Base URL格式无效。');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Base URL只允许HTTP或HTTPS协议。');
  }
  if (url.username || url.password) {
    throw new Error('Base URL不能包含用户名或密码。请通过API Key字段提供凭据。');
  }
  if (url.search) {
    throw new Error('Base URL不能包含查询参数。请通过API Key字段提供凭据。');
  }
  if (url.protocol === 'http:' && !options.allowInsecureHttp) {
    throw new Error('当前禁止不安全的HTTP端点。仅局域网服务应启用该选项。');
  }

  const path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/chat/completions')) {
    url.pathname = path;
  } else if (path.endsWith('/v1')) {
    url.pathname = `${path}/chat/completions`;
  } else if (path === '') {
    url.pathname = '/v1/chat/completions';
  } else {
    url.pathname = `${path}/v1/chat/completions`;
  }

  url.hash = '';
  return url.toString();
}

export function normalizeChatCompletionsBaseUrl(
  rawUrl: string,
  options: { allowInsecureHttp: boolean },
): string {
  const endpoint = new URL(normalizeChatCompletionsUrl(rawUrl, options));
  endpoint.pathname = endpoint.pathname.replace(/\/chat\/completions\/?$/, '');
  return endpoint.toString().replace(/\/+$/, '');
}
