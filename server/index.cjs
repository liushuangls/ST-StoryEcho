'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PLUGIN_VERSION = '0.5.0';
const PROFILE_KEYS = Object.freeze({
  llm: 'storyecho_llm_profile',
  embedding: 'storyecho_embedding_profile',
});
const MAX_KEY_LENGTH = 16 * 1024;
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_MODEL_LENGTH = 200;
const MAX_LLM_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_EMBEDDING_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_PROMPT_LENGTH = 1024 * 1024;
const MAX_SYSTEM_LENGTH = 128 * 1024;
const MAX_EMBEDDING_ITEMS = 64;
const MAX_EMBEDDING_TEXT_LENGTH = 128 * 1024;
const MAX_EMBEDDING_TOTAL_LENGTH = 2 * 1024 * 1024;

class PublicError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'PublicError';
    this.status = status;
    this.code = code;
  }
}

function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

function requiredString(value, name, maxLength) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PublicError(400, 'INVALID_REQUEST', `${name}不能为空。`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new PublicError(400, 'INVALID_REQUEST', `${name}过长。`);
  }
  return normalized;
}

function optionalApiKey(value) {
  if (typeof value !== 'string') {
    throw new PublicError(400, 'INVALID_REQUEST', 'API Key必须是字符串。');
  }
  const normalized = value.trim();
  if (normalized.length > MAX_KEY_LENGTH) {
    throw new PublicError(400, 'INVALID_REQUEST', 'API Key过长。');
  }
  return normalized;
}

function validateEndpoint(value, kind, allowInsecureHttp) {
  const endpoint = requiredString(value, 'Base URL', MAX_ENDPOINT_LENGTH);
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new PublicError(400, 'INVALID_ENDPOINT', 'Base URL不是有效网址。');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new PublicError(400, 'INVALID_ENDPOINT', 'Base URL只允许HTTP或HTTPS协议。');
  }
  if (url.protocol === 'http:' && allowInsecureHttp !== true) {
    throw new PublicError(400, 'INVALID_ENDPOINT', 'HTTP端点需要显式开启“允许不安全HTTP”。');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new PublicError(400, 'INVALID_ENDPOINT', 'Base URL不能包含凭据、查询参数或片段。');
  }
  const requiredSuffix = kind === 'llm' ? '/chat/completions' : '/embeddings';
  if (!url.pathname.replace(/\/+$/, '').endsWith(requiredSuffix)) {
    throw new PublicError(400, 'INVALID_ENDPOINT', `服务端需要规范化后的${requiredSuffix}端点。`);
  }
  return url.toString().replace(/\/$/, '');
}

function endpointFingerprint(endpoint) {
  return crypto.createHash('sha256').update(endpoint, 'utf8').digest('hex');
}

function clampTimeout(value) {
  const number = Number(value);
  return Math.min(300_000, Math.max(1_000, Number.isFinite(number) ? Math.floor(number) : 60_000));
}

function parseProfile(raw, kind) {
  if (!raw) {
    return null;
  }
  try {
    const profile = JSON.parse(raw);
    if (
      profile?.version !== 1
      || profile?.kind !== kind
      || typeof profile?.endpoint !== 'string'
      || typeof profile?.apiKey !== 'string'
    ) {
      return null;
    }
    return profile;
  } catch {
    return null;
  }
}

function clearStoredProfile(manager, key) {
  for (let index = 0; index < 1_000 && manager.readSecret(key); index += 1) {
    manager.deleteSecret(key, null);
  }
  if (manager.readSecret(key)) {
    throw new Error(`Could not clear StoryEcho secret profile: ${key}`);
  }
}

async function readLimitedText(response, maxBytes, label) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new PublicError(502, 'UPSTREAM_RESPONSE_TOO_LARGE', `${label}响应过大。`);
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new PublicError(502, 'UPSTREAM_RESPONSE_TOO_LARGE', `${label}响应过大。`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    byteLength += value.byteLength;
    if (byteLength > maxBytes) {
      await reader.cancel();
      throw new PublicError(502, 'UPSTREAM_RESPONSE_TOO_LARGE', `${label}响应过大。`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function upstreamErrorMessage(value, fallback, apiKey) {
  let message = '';
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed?.error === 'string') {
      message = parsed.error;
    } else if (typeof parsed?.error?.message === 'string') {
      message = parsed.error.message;
    } else if (typeof parsed?.message === 'string') {
      message = parsed.message;
    }
  } catch {
    message = value.replace(/\s+/g, ' ').trim();
  }
  const sanitized = (message || fallback).slice(0, 500);
  return apiKey ? sanitized.split(apiKey).join('[REDACTED]') : sanitized;
}

function parseLlmContent(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part) => typeof part?.text === 'string' ? part.text : '').join('');
  }
  throw new PublicError(502, 'INVALID_UPSTREAM_RESPONSE', '自定义LLM没有返回可读取的内容。');
}

function parseVectors(data, expectedCount) {
  if (!Array.isArray(data?.data)) {
    throw new PublicError(502, 'INVALID_UPSTREAM_RESPONSE', 'Embedding接口响应缺少data数组。');
  }
  const items = [...data.data].sort((left, right) => Number(left?.index ?? 0) - Number(right?.index ?? 0));
  if (items.length !== expectedCount) {
    throw new PublicError(
      502,
      'INVALID_UPSTREAM_RESPONSE',
      `Embedding接口返回${items.length}条向量，预期${expectedCount}条。`,
    );
  }
  let dimension;
  return items.map((item) => {
    if (!Array.isArray(item?.embedding) || item.embedding.length === 0) {
      throw new PublicError(502, 'INVALID_UPSTREAM_RESPONSE', 'Embedding接口返回了空向量。');
    }
    const vector = item.embedding.map(Number);
    if (vector.some((number) => !Number.isFinite(number))) {
      throw new PublicError(502, 'INVALID_UPSTREAM_RESPONSE', 'Embedding接口返回了无效向量数值。');
    }
    dimension ??= vector.length;
    if (vector.length !== dimension) {
      throw new PublicError(502, 'INVALID_UPSTREAM_RESPONSE', 'Embedding接口返回的向量维度不一致。');
    }
    return vector;
  });
}

function createStoryEchoService({ createSecretManager, fetchImpl }) {
  function managerFor(directories) {
    if (!directories?.root) {
      throw new PublicError(401, 'USER_CONTEXT_REQUIRED', 'SillyTavern用户上下文不可用。');
    }
    return createSecretManager(directories);
  }

  function readProfile(directories, kind) {
    const manager = managerFor(directories);
    return parseProfile(manager.readSecret(PROFILE_KEYS[kind]), kind);
  }

  function requireProfile(directories, kind, expectedFingerprint) {
    const profile = readProfile(directories, kind);
    if (!profile) {
      throw new PublicError(409, 'PROFILE_NOT_CONFIGURED', `尚未在服务端保存${kind === 'llm' ? 'LLM' : 'Embedding'}配置。`);
    }
    const actualFingerprint = endpointFingerprint(profile.endpoint);
    if (typeof expectedFingerprint !== 'string' || expectedFingerprint !== actualFingerprint) {
      throw new PublicError(409, 'PROFILE_MISMATCH', 'Base URL已变化，请重新保存API Key以确认新端点。');
    }
    return profile;
  }

  async function callUpstream(profile, body, timeoutMs, maxBytes, label) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const headers = { 'Content-Type': 'application/json' };
    if (profile.apiKey) {
      headers.Authorization = `Bearer ${profile.apiKey}`;
    }
    try {
      const response = await fetchImpl(profile.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      });
      const text = await readLimitedText(response, maxBytes, label);
      if (!response.ok) {
        const fallback = `${label}请求失败（HTTP ${response.status}）。`;
        const detail = upstreamErrorMessage(text, fallback, profile.apiKey);
        throw new PublicError(502, 'UPSTREAM_ERROR', `${fallback}${detail === fallback ? '' : `：${detail}`}`);
      }
      return text;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new PublicError(504, 'UPSTREAM_TIMEOUT', `${label}请求超时（${timeoutMs}ms）。`);
      }
      if (error instanceof PublicError) {
        throw error;
      }
      throw new PublicError(502, 'UPSTREAM_NETWORK_ERROR', `${label}网络请求失败。`);
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    status(directories) {
      const profiles = {};
      for (const kind of Object.keys(PROFILE_KEYS)) {
        const profile = readProfile(directories, kind);
        profiles[kind] = profile
          ? {
              configured: true,
              endpointFingerprint: endpointFingerprint(profile.endpoint),
              updatedAt: profile.updatedAt,
              hasApiKey: Boolean(profile.apiKey),
            }
          : { configured: false };
      }
      return { available: true, version: PLUGIN_VERSION, profiles };
    },

    saveProfile(directories, kind, payload) {
      if (!Object.hasOwn(PROFILE_KEYS, kind)) {
        throw new PublicError(404, 'UNKNOWN_PROFILE', '未知的服务端配置类型。');
      }
      const body = asRecord(payload);
      const endpoint = validateEndpoint(body.endpoint, kind, body.allowInsecureHttp);
      const apiKey = optionalApiKey(body.apiKey);
      const profile = {
        version: 1,
        kind,
        endpoint,
        apiKey,
        updatedAt: new Date().toISOString(),
      };
      const manager = managerFor(directories);
      clearStoredProfile(manager, PROFILE_KEYS[kind]);
      manager.writeSecret(PROFILE_KEYS[kind], JSON.stringify(profile), `StoryEcho ${kind}`);
      return {
        configured: true,
        endpointFingerprint: endpointFingerprint(endpoint),
        updatedAt: profile.updatedAt,
        hasApiKey: Boolean(apiKey),
      };
    },

    deleteProfile(directories, kind) {
      if (!Object.hasOwn(PROFILE_KEYS, kind)) {
        throw new PublicError(404, 'UNKNOWN_PROFILE', '未知的服务端配置类型。');
      }
      const manager = managerFor(directories);
      clearStoredProfile(manager, PROFILE_KEYS[kind]);
    },

    async complete(directories, payload) {
      const body = asRecord(payload);
      const profile = requireProfile(directories, 'llm', body.endpointFingerprint);
      const model = requiredString(body.model, '模型名', MAX_MODEL_LENGTH);
      const system = requiredString(body.system, 'System Prompt', MAX_SYSTEM_LENGTH);
      const prompt = requiredString(body.prompt, 'Prompt', MAX_PROMPT_LENGTH);
      const timeoutMs = clampTimeout(body.timeoutMs);
      const requestBody = {
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      };
      if (
        body.strictJsonSchema === true
        && body.jsonSchema !== undefined
        && asRecord(body.jsonSchema) !== body.jsonSchema
      ) {
        throw new PublicError(400, 'INVALID_REQUEST', 'JSON Schema格式无效。');
      }
      if (body.strictJsonSchema === true && body.jsonSchema) {
        requestBody.response_format = {
          type: 'json_schema',
          json_schema: {
            name: 'story_echo_response',
            strict: true,
            schema: body.jsonSchema,
          },
        };
      }
      const text = await callUpstream(profile, requestBody, timeoutMs, MAX_LLM_RESPONSE_BYTES, '自定义LLM');
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new PublicError(502, 'INVALID_UPSTREAM_RESPONSE', '自定义LLM返回了非JSON响应。');
      }
      return { content: parseLlmContent(data) };
    },

    async embed(directories, payload) {
      const body = asRecord(payload);
      const profile = requireProfile(directories, 'embedding', body.endpointFingerprint);
      const model = requiredString(body.model, 'Embedding模型', MAX_MODEL_LENGTH);
      if (!Array.isArray(body.texts) || body.texts.length === 0 || body.texts.length > MAX_EMBEDDING_ITEMS) {
        throw new PublicError(400, 'INVALID_REQUEST', `Embedding文本数量必须为1～${MAX_EMBEDDING_ITEMS}。`);
      }
      let totalLength = 0;
      const texts = body.texts.map((text) => {
        if (typeof text !== 'string' || text.length > MAX_EMBEDDING_TEXT_LENGTH) {
          throw new PublicError(400, 'INVALID_REQUEST', 'Embedding文本格式无效或过长。');
        }
        totalLength += text.length;
        return text;
      });
      if (totalLength > MAX_EMBEDDING_TOTAL_LENGTH) {
        throw new PublicError(400, 'INVALID_REQUEST', 'Embedding文本总长度过大。');
      }
      const timeoutMs = clampTimeout(body.timeoutMs);
      const text = await callUpstream(profile, {
        input: texts,
        model,
        encoding_format: 'float',
      }, timeoutMs, MAX_EMBEDDING_RESPONSE_BYTES, 'Embedding');
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new PublicError(502, 'INVALID_UPSTREAM_RESPONSE', 'Embedding接口返回的不是有效JSON。');
      }
      return { vectors: parseVectors(data, texts.length) };
    },
  };
}

function sendError(response, error) {
  if (error instanceof PublicError) {
    return response.status(error.status).send({ error: { code: error.code, message: error.message } });
  }
  console.error('[StoryEcho] Server plugin request failed.', error);
  return response.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'StoryEcho服务端内部错误。' } });
}

function registerRoutes(router, service) {
  router.get('/status', (request, response) => {
    try {
      return response.send(service.status(request.user?.directories));
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.put('/profiles/:kind', (request, response) => {
    try {
      return response.send(service.saveProfile(request.user?.directories, request.params.kind, request.body));
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.delete('/profiles/:kind', (request, response) => {
    try {
      service.deleteProfile(request.user?.directories, request.params.kind);
      return response.sendStatus(204);
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.post('/llm/chat-completions', async (request, response) => {
    try {
      return response.send(await service.complete(request.user?.directories, request.body));
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.post('/embedding/embeddings', async (request, response) => {
    try {
      return response.send(await service.embed(request.user?.directories, request.body));
    } catch (error) {
      return sendError(response, error);
    }
  });
}

async function loadHostSecretManager() {
  const candidates = [
    path.resolve(process.cwd(), 'src/endpoints/secrets.js'),
    path.resolve(__dirname, '../../../src/endpoints/secrets.js'),
  ];
  const modulePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!modulePath) {
    throw new Error('SillyTavern SecretManager not found. Install StoryEcho under the SillyTavern plugins directory.');
  }
  const module = await import(pathToFileURL(modulePath).href);
  if (typeof module.SecretManager !== 'function') {
    throw new Error('This SillyTavern version does not expose SecretManager.');
  }
  return module.SecretManager;
}

async function init(router) {
  const SecretManager = await loadHostSecretManager();
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('StoryEcho server plugin requires Node.js 20 or newer.');
  }
  const service = createStoryEchoService({
    createSecretManager: (directories) => new SecretManager(directories),
    fetchImpl: globalThis.fetch,
  });
  registerRoutes(router, service);
  console.log(`[StoryEcho] Server plugin ${PLUGIN_VERSION} loaded.`);
}

async function exit() {
  return Promise.resolve();
}

const info = {
  id: 'story-echo',
  name: 'StoryEcho Server',
  description: 'Secure server-side credential storage and OpenAI-compatible request proxy for StoryEcho.',
};

module.exports = {
  init,
  exit,
  info,
  __test: {
    PROFILE_KEYS,
    PublicError,
    createStoryEchoService,
    endpointFingerprint,
    registerRoutes,
  },
};
