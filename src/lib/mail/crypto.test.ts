import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { open, parseKey, seal } from './crypto';

const key = randomBytes(32);

describe('mail token encryption', () => {
  it('round-trips a token', () => {
    const sealed = seal('M.R3_refresh_token_value', key, 'identity-1');
    expect(open(sealed, key, 'identity-1')).toBe('M.R3_refresh_token_value');
  });

  it('never stores the plaintext in the ciphertext', () => {
    const sealed = seal('a-very-recognisable-secret', key, 'identity-1');
    expect(sealed.ciphertext.toString('utf8')).not.toContain('recognisable');
  });

  it('uses a fresh IV every time, so equal tokens do not look equal', () => {
    const a = seal('same', key, 'id');
    const b = seal('same', key, 'id');
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('refuses a ciphertext moved to another row (AAD mismatch)', () => {
    const sealed = seal('token', key, 'identity-1');
    expect(() => open(sealed, key, 'identity-2')).toThrow();
  });

  it('refuses the wrong key', () => {
    const sealed = seal('token', key, 'identity-1');
    expect(() => open(sealed, randomBytes(32), 'identity-1')).toThrow();
  });

  it('refuses a tampered ciphertext', () => {
    const sealed = seal('token', key, 'identity-1');
    sealed.ciphertext[0] ^= 0xff;
    expect(() => open(sealed, key, 'identity-1')).toThrow();
  });

  it('accepts only a 32-byte key', () => {
    expect(parseKey(randomBytes(32).toString('base64')).length).toBe(32);
    expect(() => parseKey(randomBytes(16).toString('base64'))).toThrow(/32 random bytes/);
  });
});
