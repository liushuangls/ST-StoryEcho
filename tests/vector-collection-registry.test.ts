import { afterEach, describe, expect, it, vi } from 'vitest';
import { VectorCollectionRegistry } from '../src/vector/collection-registry';

afterEach(() => {
  vi.unstubAllGlobals();
});

function installContext() {
  const context = {
    chat: [],
    extensionSettings: {} as Record<string, unknown>,
    chatMetadata: {},
    saveSettingsDebounced: vi.fn(),
    saveMetadata: vi.fn(async () => undefined),
    generateRaw: vi.fn(async () => ''),
  };
  vi.stubGlobal('SillyTavern', { getContext: () => context });
  return context;
}

describe('VectorCollectionRegistry', () => {
  it('remembers a collection and purges it after its chat is deleted', async () => {
    const context = installContext();
    const registry = new VectorCollectionRegistry();
    const purge = vi.fn(async () => undefined);

    registry.remember('chat-one', 'story_echo_collection-one_v1');
    expect(registry.queuePurge('chat-one')).toBe('story_echo_collection-one_v1');
    expect(registry.pendingCount()).toBe(1);

    await expect(registry.drainPending(purge)).resolves.toEqual([]);

    expect(purge).toHaveBeenCalledWith('story_echo_collection-one_v1');
    expect(registry.pendingCount()).toBe(0);
    expect(context.saveSettingsDebounced).toHaveBeenCalled();
  });

  it('persists failed purges for a later background retry', async () => {
    installContext();
    const registry = new VectorCollectionRegistry();
    const failure = new Error('vector server unavailable');
    registry.remember('chat-one', 'story_echo_collection-one_v1');
    registry.queuePurge('chat-one');

    const failures = await registry.drainPending(async () => {
      throw failure;
    });

    expect(failures).toEqual([{
      collectionId: 'story_echo_collection-one_v1',
      error: failure,
    }]);
    expect(registry.pendingCount()).toBe(1);

    await registry.drainPending(async () => undefined);
    expect(registry.pendingCount()).toBe(0);
  });

  it('does not let a stale in-flight save cancel deletion cleanup', async () => {
    installContext();
    const registry = new VectorCollectionRegistry();
    let finishPurge: (() => void) | undefined;
    registry.remember('chat-one', 'story_echo_collection-one_v1');
    registry.queuePurge('chat-one');

    const draining = registry.drainPending(() => new Promise<void>((resolve) => {
      finishPurge = resolve;
    }));
    await vi.waitFor(() => expect(finishPurge).toBeTypeOf('function'));

    registry.remember('chat-one', 'story_echo_collection-one_v1');
    expect(registry.pendingCount()).toBe(1);
    finishPurge?.();
    await draining;

    expect(registry.pendingCount()).toBe(0);
    expect(registry.queuePurge('chat-one')).toBeNull();
  });

  it('moves the collection registration when a chat is renamed', async () => {
    installContext();
    const registry = new VectorCollectionRegistry();
    const purge = vi.fn(async () => undefined);
    registry.remember('old-chat', 'story_echo_collection-one_v1');

    registry.rename('old-chat', 'new-chat');

    expect(registry.queuePurge('old-chat')).toBeNull();
    expect(registry.queuePurge('new-chat')).toBe('story_echo_collection-one_v1');
    await registry.drainPending(purge);
    expect(purge).toHaveBeenCalledOnce();
  });
});
