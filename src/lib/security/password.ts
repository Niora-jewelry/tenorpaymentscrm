/**
 * Password policy.
 *
 * Spec §4: "Minimum 8 characters, enforced via Supabase password policy plus
 * client-side validation; reject common-password-list entries at minimum."
 *
 * The local list satisfies "at minimum". On top of it we run a Have I Been
 * Pwned k-anonymity check: only the first 5 characters of the SHA-1 leave this
 * server, never the password and never the full hash. That is strictly stronger
 * than any static list, and leaks nothing.
 *
 * If HIBP is unreachable, we fall back to the local list rather than blocking
 * signup — availability of a third party must not stop a user creating an
 * account, and the local floor still applies.
 */
import 'server-only';
import { createHash } from 'node:crypto';

export const MIN_PASSWORD_LENGTH = 8; // spec floor
export const MAX_PASSWORD_LENGTH = 200;

/**
 * Local deny-list. Deliberately small and high-signal: HIBP does the heavy
 * lifting, this is the offline floor that always applies.
 */
const COMMON_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', 'password', 'password1', 'password123',
  'qwerty123', 'qwertyui', 'abc12345', 'iloveyou', 'welcome1', 'welcome123',
  'admin123', 'letmein1', 'monkey12', 'sunshine', 'princess', 'football',
  'baseball', 'trustno1', 'superman', 'starwars', 'passw0rd', 'p@ssw0rd',
  'zaq12wsx', '1q2w3e4r', 'qazwsxedc', 'asdfghjkl', 'changeme', 'secret12',
  'tapdash1', 'tapdash123',
]);

export type PasswordCheck =
  | { ok: true }
  | { ok: false; message: string };

/** Synchronous checks. Safe to mirror in the browser for instant feedback. */
export function checkPasswordBasics(password: string, email?: string): PasswordCheck {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, message: `Use at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, message: `Use at most ${MAX_PASSWORD_LENGTH} characters.` };
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return { ok: false, message: 'That password is too common. Choose something less predictable.' };
  }
  if (email) {
    const localPart = email.split('@')[0]?.toLowerCase();
    if (localPart && localPart.length >= 4 && password.toLowerCase().includes(localPart)) {
      return { ok: false, message: 'Your password cannot contain your email address.' };
    }
  }
  return { ok: true };
}

/**
 * Have I Been Pwned range API, k-anonymity mode.
 *
 * We send the first 5 hex characters of the SHA-1 and receive every suffix
 * sharing that prefix, then match locally. The service never learns the
 * password or its full hash.
 */
async function isBreached(password: string): Promise<boolean | null> {
  try {
    const sha1 = createHash('sha1').update(password).digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    const response = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'TapDash-CRM' },
      signal: AbortSignal.timeout(2500),
      cache: 'no-store',
    });

    if (!response.ok) return null;

    const body = await response.text();
    for (const line of body.split('\n')) {
      const [hashSuffix, countRaw] = line.trim().split(':');
      if (hashSuffix === suffix && Number(countRaw ?? 0) > 0) return true;
    }
    return false;
  } catch {
    // Unreachable or slow — fall back to the local list.
    return null;
  }
}

/** Full server-side policy: basics, then the breach check. */
export async function validatePassword(
  password: string,
  email?: string,
): Promise<PasswordCheck> {
  const basics = checkPasswordBasics(password, email);
  if (!basics.ok) return basics;

  const breached = await isBreached(password);
  if (breached === true) {
    return {
      ok: false,
      message:
        'That password has appeared in a known data breach. Choose a different one.',
    };
  }

  return { ok: true };
}
