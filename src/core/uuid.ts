function fillRandomBytes(bytes: Uint8Array): void {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes);
    return;
  }

  // StoryEcho UUIDs are collision-resistant internal identifiers, not secrets.
  // This last-resort path keeps older/non-standard WebViews usable when the
  // Web Crypto API is missing entirely.
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
}

function byteToHex(byte: number): string {
  return byte.toString(16).padStart(2, '0');
}

/**
 * Generate a UUID v4 without requiring a secure browser context.
 *
 * `crypto.randomUUID()` is only exposed in secure contexts by browsers, while
 * SillyTavern is commonly served over plain HTTP on a LAN. `getRandomValues()`
 * remains available in those deployments and is used as the compatible path.
 */
export function createUuid(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }

  const bytes = new Uint8Array(16);
  fillRandomBytes(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = Array.from(bytes, byteToHex);
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}
