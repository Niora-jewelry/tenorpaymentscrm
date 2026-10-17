/**
 * Encryption for stored Microsoft tokens — AES-256-GCM in Node.
 *
 * ── WHY HERE AND NOT IN THE DATABASE ─────────────────────────────────────
 * A refresh token is a standing key to someone's mailbox. Supabase Vault and
 * `pgp_sym_encrypt` both decrypt INSIDE Postgres, which means anyone holding
 * the database URL can read every token — and that URL is in every
 * integration test and every `scripts/*.mjs`. With the key in the app's
 * environment (`MAIL_TOKEN_ENC_KEY`) a leaked database URL yields ciphertext
 * and nothing else, and the key never travels through PostgREST or a query
 * log.
 *
 * ── AAD BINDS A CIPHERTEXT TO ITS ROW ────────────────────────────────────
 * The additional authenticated data is `<crm user id>:<microsoft user id>`
 * (`config.ts` `tokenAad`) — the pair that identifies a sign-in, and known
 * before the identity row exists, so the token can be sealed before the
 * connect RPC stores it. Copy one person's encrypted token onto another
 * person's row and decryption fails outright instead of quietly handing over
 * the wrong mailbox.
 *
 * Pure (no env, no `server-only`) so it can be tested in isolation; the
 * key is passed in by `tokens.ts`.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type Sealed = { ciphertext: Buffer; iv: Buffer };

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Decodes and checks a base64 key. 32 bytes or it is refused. */
export function parseKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) {
    throw new Error('MAIL_TOKEN_ENC_KEY must be 32 random bytes, base64-encoded.');
  }
  return key;
}

/** Encrypts `plaintext`; the GCM tag is appended to the ciphertext. */
export function seal(plaintext: string, key: Buffer, aad: string): Sealed {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), iv };
}

/** Decrypts, or throws if the key, the AAD or the bytes do not match. */
export function open(sealed: Sealed, key: Buffer, aad: string): string {
  if (sealed.iv.length !== IV_BYTES || sealed.ciphertext.length <= TAG_BYTES) {
    throw new Error('Sealed token is malformed.');
  }
  const body = sealed.ciphertext.subarray(0, sealed.ciphertext.length - TAG_BYTES);
  const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, sealed.iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/**
 * Postgres `bytea` over PostgREST travels as the hex text form `\x…`.
 * These are the only two conversions; never hand-roll either.
 */
export function toBytea(buf: Buffer): string {
  return `\\x${buf.toString('hex')}`;
}

export function fromBytea(value: unknown): Buffer {
  if (typeof value !== 'string' || !value.startsWith('\\x')) throw new Error('Not a bytea hex value.');
  return Buffer.from(value.slice(2), 'hex');
}
