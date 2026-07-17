export const DIAGNOSTICS_UPDATED_EVENT = 'storyecho:diagnostics-updated';

export function emitDiagnosticsUpdated(): void {
  if (typeof globalThis.dispatchEvent === 'function' && typeof Event === 'function') {
    globalThis.dispatchEvent(new Event(DIAGNOSTICS_UPDATED_EVENT));
  }
}
