/**
 * DEMO LOGIN — temporary, development only.
 *
 * WHY THIS EXISTS
 * Real signup needs a Supabase project and a verified email domain, neither of
 * which is connected yet. This lets the client click through the product today.
 *
 * WHAT IT IS NOT
 * It is NOT an auth bypass. It does not accept "any password". It checks one
 * fixed credential pair from the environment. There is no code path in which an
 * unknown password succeeds.
 *
 * PRODUCTION GUARD
 * If DEMO_AUTH_ENABLED is truthy while NODE_ENV is production, the app THROWS on
 * startup rather than quietly ignoring the flag. Silently disabling would let a
 * misconfigured deploy look fine while the operator believed demo login worked;
 * refusing to boot is the honest failure. Deleting this file is the last step of
 * wiring real Supabase auth.
 *
 * Edge-safe: Web Crypto and process.env only, so the proxy can verify sessions.
 */

const COOKIE_NAME = 'td_demo_session';
const SESSION_TTL_SECONDS = 24 * 60 * 60; // matches the real 24h session rule

export const DEMO_COOKIE_NAME = COOKIE_NAME;

function readFlag(): boolean {
  const raw = process.env.DEMO_AUTH_ENABLED;
  return raw === 'true' || raw === '1';
}

/**
 * The single gate. Everything demo-related asks this first.
 * Throws rather than returning false in production — see PRODUCTION GUARD above.
 */
export function isDemoAuthEnabled(): boolean {
  const enabled = readFlag();
  if (!enabled) return false;

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'DEMO_AUTH_ENABLED is set in a production build. Demo login is a ' +
        'development-only stand-in and must never run in production. Unset it, ' +
        'or connect real Supabase auth.',
    );
  }
  return true;
}

export function demoCredentials(): { email: string; password: string } | null {
  if (!isDemoAuthEnabled()) return null;

  const email = process.env.DEMO_AUTH_EMAIL?.trim().toLowerCase();
  const password = process.env.DEMO_AUTH_PASSWORD;

  if (!email || !password) return null;
  return { email, password };
}

function secret(): string {
  // Falls back to a fixed development string only because this whole module is
  // unreachable outside development.
  return process.env.DEMO_AUTH_SECRET || 'tapdash-demo-session-secret-dev-only';
}

// --- Session token: base64url(payload).base64url(hmac) -----------------------

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmac(message: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return new Uint8Array(signature);
}

export type DemoSession = {
  email: string;
  name: string;
  /** Unix seconds. */
  exp: number;
};

export async function createDemoSessionToken(email: string, name: string): Promise<string> {
  const payload: DemoSession = {
    email,
    name,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const encoded = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = toBase64Url(await hmac(encoded));
  return `${encoded}.${signature}`;
}

/** Returns the session only if the signature verifies AND it has not expired. */
export async function verifyDemoSessionToken(
  token: string | undefined,
): Promise<DemoSession | null> {
  if (!token) return null;

  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;

  const expected = await hmac(encoded);
  const provided = fromBase64Url(signature);

  if (expected.length !== provided.length) return null;

  // Constant-time comparison — a byte-by-byte early return would leak the
  // signature one byte at a time.
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected[i]! ^ provided[i]!;
  if (diff !== 0) return null;

  try {
    const session = JSON.parse(new TextDecoder().decode(fromBase64Url(encoded))) as DemoSession;
    if (typeof session.exp !== 'number' || session.exp * 1000 < Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

/** Fixed-credential check. Constant-time, so it cannot be probed character by character. */
export function demoCredentialsMatch(email: string, password: string): boolean {
  const expected = demoCredentials();
  if (!expected) return false;

  const emailOk = constantTimeEquals(email.trim().toLowerCase(), expected.email);
  const passwordOk = constantTimeEquals(password, expected.password);

  // Both are always evaluated; no early return on the email check.
  return emailOk && passwordOk;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
