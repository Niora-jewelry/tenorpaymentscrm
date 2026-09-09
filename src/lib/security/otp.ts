/**
 * One-time codes.
 *
 * Spec rules, all enforced server-side:
 *   - ~10 minute expiry
 *   - single-use
 *   - max 5 attempts, then a new code is required
 *   - resend allowed on a 60-second cooldown
 *
 * Added on top:
 *   - codes generated with a CSPRNG, never Math.random
 *   - only HMAC-SHA256(code, OTP_PEPPER) is stored; the plaintext exists only in
 *     the outbound email, so a database dump yields nothing replayable
 *   - a signed, hashed, single-use "ticket" carries the fact that an OTP was
 *     verified, so the client never holds that as trusted state
 */
import 'server-only';
import { randomInt, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { serverEnv } from '@/lib/env.server';

export const OTP_LENGTH = 6;
export const OTP_TTL_SECONDS = 600; // ~10 minutes (spec)
export const OTP_MAX_ATTEMPTS = 5; // spec
export const OTP_RESEND_COOLDOWN_SECONDS = 60; // spec

/**
 * How long a verified user has to choose a password.
 *
 * 30 minutes, not 15. The spec fixes the OTP lifetime at ~10 minutes but says
 * nothing about this window, and 15 proved too tight in practice: someone
 * picking a password manager entry, being interrupted, or bouncing off the
 * breached-password check a couple of times can easily spend longer than that.
 *
 * The security cost is small — the ticket is single-use, HTTP-only, stored only
 * as a hash, and useless without also knowing the email it was issued for.
 */
export const TICKET_TTL_SECONDS = 1800;

/** Cryptographically random numeric code. */
export function generateOtpCode(): string {
  const max = 10 ** OTP_LENGTH;
  return String(randomInt(0, max)).padStart(OTP_LENGTH, '0');
}

/** HMAC of the code under the server pepper. Only this is ever persisted. */
export function hashOtpCode(code: string): Buffer {
  return createHmac('sha256', Buffer.from(serverEnv.OTP_PEPPER, 'base64'))
    .update(code.trim())
    .digest();
}

/** Opaque ticket returned once on OTP success and held in an HTTP-only cookie. */
export function generateTicket(): string {
  return randomBytes(32).toString('base64url');
}

export function hashTicket(ticket: string): Buffer {
  return createHmac('sha256', Buffer.from(serverEnv.OTP_PEPPER, 'base64'))
    .update(ticket)
    .digest();
}

/**
 * Postgres `bytea` arrives over PostgREST as a hex string prefixed with `\x`.
 * Buffers are sent the same way.
 */
export function toPostgresBytea(buf: Buffer): string {
  return `\\x${buf.toString('hex')}`;
}

/** Constant-time comparison, for any in-process hash check. */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Codes are entered by humans; tolerate spaces and stray separators. */
export function normaliseOtpInput(raw: string): string {
  return raw.replace(/[^0-9]/g, '').slice(0, OTP_LENGTH);
}
