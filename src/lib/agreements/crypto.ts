/**
 * Encryption for agreements: the snapshot of every value printed on one
 * (SSNs, bank and licence numbers among them) and the PDFs — the sent copy
 * and the signed one that comes back.
 *
 * The same scheme as the Prepopulated Application's: AES-256-GCM with a key
 * derived (HKDF-SHA256) from LOGIN_ENC_KEY under this module's own label, so
 * the two uses stay apart and there is no new secret to lose. ⚠️ Changing
 * LOGIN_ENC_KEY makes every sealed value here unreadable.
 *
 * The AAD ties each ciphertext to its row (an agreement id, a file id).
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
    cachedKey = Buffer.from(hkdfSync('sha256', Buffer.from(serverEnv.LOGIN_ENC_KEY, 'utf8'), Buffer.alloc(0), 'tapdash/agreements/v1', 32));
  }
  return cachedKey;
}

export type SealedBytes = { data: Buffer; iv: Buffer };

export function sealBytes(plain: Buffer, aad: string): SealedBytes {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { data: Buffer.concat([body, cipher.getAuthTag()]), iv };
}

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
