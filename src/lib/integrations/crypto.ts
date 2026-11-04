/**
 * Seals provider keys for the `integration_settings` table: AES-256-GCM under a
 * key derived (HKDF-SHA256) from LOGIN_ENC_KEY with this module's own label, and
 * the setting's name as additional data. A database dump alone reveals nothing,
 * and a sealed value copied onto another setting's row refuses to open.
 *
 * LOGIN_ENC_KEY stays in the environment. Changing it makes these unreadable; the
 * CRM then falls back to the environment values and the screen asks for re-entry.
 */
import 'server-only';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { serverEnv } from '@/lib/env.server';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey: Buffer | null = null;

function key(): Buffer {
  cachedKey ??= Buffer.from(hkdfSync('sha256', Buffer.from(serverEnv.LOGIN_ENC_KEY, 'utf8'), Buffer.alloc(0), 'tenor/integrations/v1', 32));
  return cachedKey;
}

export type SealedSetting = { sealed: string; iv: string };

export function sealSetting(settingKey: string, value: string): SealedSetting {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  cipher.setAAD(Buffer.from(settingKey, 'utf8'));
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { sealed: Buffer.concat([body, cipher.getAuthTag()]).toString('base64'), iv: iv.toString('base64') };
}

export function openSetting(settingKey: string, stored: SealedSetting): string {
  const iv = Buffer.from(stored.iv, 'base64');
  const data = Buffer.from(stored.sealed, 'base64');
  if (iv.length !== IV_BYTES || data.length < TAG_BYTES) throw new Error('Sealed setting is malformed.');
  const decipher = createDecipheriv(ALGORITHM, key(), iv);
  decipher.setAAD(Buffer.from(settingKey, 'utf8'));
  decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
  return Buffer.concat([decipher.update(data.subarray(0, data.length - TAG_BYTES)), decipher.final()]).toString('utf8');
}
