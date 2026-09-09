/**
 * Audit metadata redaction.
 *
 * Deliberately dependency-free: no Supabase client, no environment, no
 * `server-only`. The guarantee "secrets never reach the audit log" should be
 * testable in isolation, and reusable by any future logger.
 */

/**
 * Keys whose values are never written, whatever a caller passes.
 * Matched case-insensitively as SUBSTRINGS, so `otpCode`, `new_password` and
 * `serviceRoleKey` are all caught without maintaining an exhaustive list.
 */
const FORBIDDEN_KEY_FRAGMENTS = [
  'password', 'passwd', 'secret', 'token', 'ticket', 'code', 'otp',
  'key', 'authorization', 'cookie', 'session', 'hash', 'pepper',
];

export const REDACTED = '[redacted]';

const MAX_DEPTH = 4;
const MAX_STRING_LENGTH = 500;
const MAX_ARRAY_ITEMS = 25;

export function redactMetadata(input: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (input === null || input === undefined) return input;

  if (Array.isArray(input)) {
    return input.slice(0, MAX_ARRAY_ITEMS).map((item) => redactMetadata(item, depth + 1));
  }

  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      const lowered = key.toLowerCase();
      out[key] = FORBIDDEN_KEY_FRAGMENTS.some((fragment) => lowered.includes(fragment))
        ? REDACTED
        : redactMetadata(value, depth + 1);
    }
    return out;
  }

  if (typeof input === 'string') return input.slice(0, MAX_STRING_LENGTH);
  return input;
}
