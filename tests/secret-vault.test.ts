import { describe, expect, it } from 'vitest';
import { SessionSecretVault } from '../src/llm/secret-vault';

describe('SessionSecretVault', () => {
  it('keeps a key only in the vault instance', () => {
    const vault = new SessionSecretVault();
    vault.setSessionKey('  secret  ');
    expect(vault.hasSessionKey()).toBe(true);
    expect(vault.getSessionKey()).toBe('secret');
    vault.clear();
    expect(vault.getSessionKey()).toBeUndefined();
  });

  it('treats an empty key as absent', () => {
    const vault = new SessionSecretVault();
    vault.setSessionKey('   ');
    expect(vault.hasSessionKey()).toBe(false);
  });
});
