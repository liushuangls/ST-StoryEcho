export type StoryEchoPublicChangeReason =
  | 'chat'
  | 'injection'
  | 'lifecycle'
  | 'settings'
  | 'state';

type StoryEchoPublicChangeListener = (reason: StoryEchoPublicChangeReason) => void;

const listeners = new Set<StoryEchoPublicChangeListener>();

/**
 * Notify public-API subscribers after a user-visible StoryEcho snapshot may
 * have changed. Listener failures are isolated so one consumer cannot affect
 * StoryEcho or other extensions.
 */
export function emitStoryEchoPublicApiChanged(reason: StoryEchoPublicChangeReason): void {
  for (const listener of listeners) {
    try {
      listener(reason);
    } catch {
      // Do not print a consumer-provided Error: it may contain summary text.
      console.warn('[StoryEcho] Public API change listener failed.');
    }
  }
}

export function subscribeStoryEchoPublicApiChanged(
  listener: StoryEchoPublicChangeListener,
): () => void {
  listeners.add(listener);
  let subscribed = true;
  return () => {
    if (!subscribed) {
      return;
    }
    subscribed = false;
    listeners.delete(listener);
  };
}
