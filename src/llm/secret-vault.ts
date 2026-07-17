export class SessionSecretVault {
  #apiKey: string | undefined;

  setSessionKey(value: string): void {
    const normalized = value.trim();
    this.#apiKey = normalized.length > 0 ? normalized : undefined;
  }

  hasSessionKey(): boolean {
    return this.#apiKey !== undefined;
  }

  getSessionKey(): string | undefined {
    return this.#apiKey;
  }

  clear(): void {
    this.#apiKey = undefined;
  }
}

export const sessionSecretVault = new SessionSecretVault();
