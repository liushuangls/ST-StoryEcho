export function stableNumericHash(value: string): number {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}

export async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function allocateVectorHash(seed: string, occupied: ReadonlySet<number>): number {
  let salt = 0;

  while (true) {
    const candidate = stableNumericHash(salt === 0 ? seed : `${seed}:${salt}`);
    if (!occupied.has(candidate)) {
      return candidate;
    }
    salt += 1;
  }
}
