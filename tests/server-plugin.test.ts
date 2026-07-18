import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const plugin = require('../server/index.cjs') as {
  __test: {
    createStoryEchoService(options: {
      createSecretManager: () => FakeSecretManager;
      fetchImpl: typeof fetch;
    }): StoryEchoService;
    endpointFingerprint(endpoint: string): string;
  };
};

interface StoryEchoService {
  status(directories: { root: string }): {
    profiles: Record<'llm' | 'embedding', { configured: boolean; endpointFingerprint?: string }>;
  };
  saveProfile(
    directories: { root: string },
    kind: 'llm' | 'embedding',
    payload: Record<string, unknown>,
  ): { configured: boolean; endpointFingerprint: string };
  deleteProfile(directories: { root: string }, kind: 'llm' | 'embedding'): void;
  complete(directories: { root: string }, payload: Record<string, unknown>): Promise<{ content: string }>;
  embed(directories: { root: string }, payload: Record<string, unknown>): Promise<{ vectors: number[][] }>;
}

class FakeSecretManager {
  readonly values = new Map<string, string>();

  readSecret(key: string): string {
    return this.values.get(key) ?? '';
  }

  writeSecret(key: string, value: string): void {
    this.values.set(key, value);
  }

  deleteSecret(key: string): void {
    this.values.delete(key);
  }
}

const directories = { root: '/fake/user' };

function createService(fetchImpl: typeof fetch): { service: StoryEchoService; secrets: FakeSecretManager } {
  const secrets = new FakeSecretManager();
  const service = plugin.__test.createStoryEchoService({
    createSecretManager: () => secrets,
    fetchImpl,
  });
  return { service, secrets };
}

describe('StoryEcho server plugin', () => {
  it('stores the key server-side and uses it only for the bound LLM endpoint', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'LLM result' } }],
    }), { status: 200 }));
    const { service, secrets } = createService(fetchMock);
    const endpoint = 'https://example.com/v1/chat/completions';

    const saved = service.saveProfile(directories, 'llm', {
      endpoint,
      apiKey: 'server-secret',
      allowInsecureHttp: false,
    });
    expect(saved.endpointFingerprint).toBe(plugin.__test.endpointFingerprint(endpoint));
    expect(JSON.stringify(service.status(directories))).not.toContain('server-secret');

    await expect(service.complete(directories, {
      endpointFingerprint: saved.endpointFingerprint,
      model: 'model-name',
      system: 'system',
      prompt: 'prompt',
      timeoutMs: 1_000,
    })).resolves.toEqual({ content: 'LLM result' });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(endpoint);
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer server-secret' });
    expect(String(init?.body)).not.toContain('server-secret');
    expect([...secrets.values.values()].join('')).toContain('server-secret');
  });

  it('refuses to send a stored key when the requested endpoint fingerprint changes', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const { service } = createService(fetchMock);
    service.saveProfile(directories, 'llm', {
      endpoint: 'https://trusted.example/v1/chat/completions',
      apiKey: 'server-secret',
      allowInsecureHttp: false,
    });

    await expect(service.complete(directories, {
      endpointFingerprint: plugin.__test.endpointFingerprint('https://attacker.example/v1/chat/completions'),
      model: 'model-name',
      system: 'system',
      prompt: 'prompt',
    })).rejects.toThrow('Base URL已变化');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('generates and validates embeddings on the server', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: [
        { index: 1, embedding: [0.3, 0.4] },
        { index: 0, embedding: [0.1, 0.2] },
      ],
    }), { status: 200 }));
    const { service } = createService(fetchMock);
    const endpoint = 'https://example.com/v1/embeddings';
    const saved = service.saveProfile(directories, 'embedding', {
      endpoint,
      apiKey: 'embedding-secret',
      allowInsecureHttp: false,
    });

    await expect(service.embed(directories, {
      endpointFingerprint: saved.endpointFingerprint,
      model: 'embedding-model',
      texts: ['一', '二'],
      timeoutMs: 1_000,
    })).resolves.toEqual({ vectors: [[0.1, 0.2], [0.3, 0.4]] });
  });

  it('redacts a stored key from upstream error messages', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'credential server-secret was rejected' },
    }), { status: 401 }));
    const { service } = createService(fetchMock);
    const endpoint = 'https://example.com/v1/chat/completions';
    const saved = service.saveProfile(directories, 'llm', {
      endpoint,
      apiKey: 'server-secret',
      allowInsecureHttp: false,
    });

    const error = await service.complete(directories, {
      endpointFingerprint: saved.endpointFingerprint,
      model: 'model-name',
      system: 'system',
      prompt: 'prompt',
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('[REDACTED]');
    expect((error as Error).message).not.toContain('server-secret');
  });

  it('deletes the persisted profile completely', () => {
    const { service } = createService(vi.fn<typeof fetch>());
    service.saveProfile(directories, 'llm', {
      endpoint: 'https://example.com/v1/chat/completions',
      apiKey: 'server-secret',
      allowInsecureHttp: false,
    });
    service.deleteProfile(directories, 'llm');
    expect(service.status(directories).profiles.llm.configured).toBe(false);
  });
});
