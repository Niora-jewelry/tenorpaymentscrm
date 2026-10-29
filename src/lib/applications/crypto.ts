/**
 * Encryption for the Prepopulated Application: the link token's sealed copy,
 * the merchant's typed SSNs while they save-and-finish-later, and returned
 * PDFs (spec: "Returned PDFs contain SSNs. Store them encrypted").
 *
 * AES-256-GCM, binary in and out, with a key derived (HKDF-SHA256) from
 * LOGIN_ENC_KEY under its own label — the same secret that already protects
 * Logins passwords, so there is no new key to lose, and a derived key keeps
 * the two uses apart. ⚠️ Changing LOGIN_ENC_KEY makes every sealed value here
 * unreadable, exactly as it does for saved passwords.
 *
 * The AAD binds each ciphertext to what it belongs to (an application id, a
 * file id), so a sealed blob copied onto another row does not decrypt.
 */
import 'server-only';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { serverEnv } from '@/lib/env.server';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey: Buffer | null = null;
function key(): Buffer {
  if (!cachedKey) {
    cachedKey = Buffer.from(
      hkdfSync('sha256', Buffer.from(serverEnv.LOGIN_ENC_KEY, 'utf8'), Buffer.alloc(0), 'tapdash/applications/v1', 32),
    );
  }
  return cachedKey;
}

export type SealedBytes = { data: Buffer; iv: Buffer };

/** Encrypts; the GCM tag is appended to the data. */
export function sealBytes(plain: Buffer, aad: string): SealedBytes {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { data: Buffer.concat([body, cipher.getAuthTag()]), iv };
}

/** Decrypts, or throws when the key, the AAD or the bytes do not match. */
export function openBytes(sealed: SealedBytes, aad: string): Buffer {
  if (sealed.iv.length !== IV_BYTES || sealed.data.length < TAG_BYTES) throw new Error('Sealed data is malformed.');
  const body = sealed.data.subarray(0, sealed.data.length - TAG_BYTES);
  const tag = sealed.data.subarray(sealed.data.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key(), sealed.iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

export const sealText = (plain: string, aad: string): SealedBytes => sealBytes(Buffer.from(plain, 'utf8'), aad);
export const openText = (sealed: SealedBytes, aad: string): string => openBytes(sealed, aad).toString('utf8');
