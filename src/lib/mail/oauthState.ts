/**
 * The OAuth round trip to Microsoft: signed state cookie + PKCE.
 *
 * Ported from the old CRM's `lib/outlook/oauth-state.ts`, with three changes
 * that close gaps it had:
 *
 *   1. PKCE. A `code_verifier` is generated here and travels ONLY inside the
 *      signed httpOnly cookie; the authorize URL carries its S256 challenge.
 *      An intercepted authorization code is useless without it.
 *   2. The state is bound to the CRM user who started the flow. The callback
 *      refuses unless the signed-in user is that same person, which stops
 *      "login CSRF" — an attacker finishing a flow so THEIR mailbox lands on
 *      someone else's CRM account.
 *   3. The `state` query parameter is only the nonce; the payload never
 *      leaves the cookie.
 *
 * Token format: base64url(JSON) + "." + base64url(HMAC-SHA256(JSON-b64, secret)).
 * Pure apart from the secret, which callers pass in, so it is unit-tested.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type ConnectKind = 'personal' | 'shared';

export type OAuthStatePayload = {
  v: 1;
  nonce: string;
  verifier: string;
  userId: string;
  kind: ConnectKind;
  /** The shared mailbox address, signed so it cannot be swapped between legs. */
  target?: string;
  returnPath: string;
  iat: number;
};

export const MAIL_OAUTH_COOKIE = 'mail_oauth';
export const MAIL_OAUTH_COOKIE_PATH = '/api/mail/oauth';
export const STATE_MAX_AGE_MS = 10 * 60 * 1000;

const b64url = (buf: Buffer) => buf.toString('base64url');

function hmac(payloadB64: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(payloadB64).digest());
}

/** Constant-time string equality; false on any length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** RFC 7636: 43–128 chars from the unreserved set. 32 random bytes → 43. */
export function newVerifier(): string {
  return b64url(randomBytes(32));
}

export function challengeFor(verifier: string): string {
  return b64url(createHash('sha256').update(verifier).digest());
}

/** Builds and signs a fresh state. Returns the cookie value and the nonce for `state=`. */
export function signState(
  args: { userId: string; kind: ConnectKind; target?: string; returnPath: string },
  secret: string,
  now = Date.now(),
): { cookie: string; nonce: string; verifier: string } {
  const payload: OAuthStatePayload = {
    v: 1,
    nonce: b64url(randomBytes(16)),
    verifier: newVerifier(),
    userId: args.userId,
    kind: args.kind,
    ...(args.target ? { target: args.target } : {}),
    returnPath: args.returnPath,
    iat: now,
  };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return { cookie: `${payloadB64}.${hmac(payloadB64, secret)}`, nonce: payload.nonce, verifier: payload.verifier };
}

export type StateCheck =
  | { ok: true; payload: OAuthStatePayload }
  | { ok: false; reason: 'missing' | 'bad_signature' | 'malformed' | 'expired' | 'nonce_mismatch' | 'wrong_user' };

/**
 * Every check the callback needs, in order, so no route can do half of them.
 * `stateParam` is the `state` query value; `userId` the signed-in user.
 */
export function verifyState(
  cookie: string | undefined,
  stateParam: string | null,
  userId: string,
  secret: string,
  now = Date.now(),
): StateCheck {
  if (!cookie || !stateParam) return { ok: false, reason: 'missing' };

  const dot = cookie.indexOf('.');
  if (dot <= 0 || dot === cookie.length - 1) return { ok: false, reason: 'malformed' };
  const payloadB64 = cookie.slice(0, dot);
  if (!safeEqual(cookie.slice(dot + 1), hmac(payloadB64, secret))) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    payload?.v !== 1 ||
    (payload.kind !== 'personal' && payload.kind !== 'shared') ||
    typeof payload.nonce !== 'string' ||
    typeof payload.verifier !== 'string' ||
    typeof payload.userId !== 'string' ||
    typeof payload.returnPath !== 'string' ||
    typeof payload.iat !== 'number' ||
    (payload.kind === 'shared' && (typeof payload.target !== 'string' || payload.target.length === 0))
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (now - payload.iat > STATE_MAX_AGE_MS || payload.iat > now + 60_000) {
    return { ok: false, reason: 'expired' };
  }
  if (!safeEqual(stateParam, payload.nonce)) return { ok: false, reason: 'nonce_mismatch' };
  if (!safeEqual(payload.userId, userId)) return { ok: false, reason: 'wrong_user' };

  return { ok: true, payload };
}

/**
 * Where to land after connecting. Only a path under /email, never anything
 * a caller could point off-site — the general open-redirect guard in
 * `security/redirect.ts` is stricter than needed here and this is narrower.
 */
export function safeEmailReturnPath(raw: string | null | undefined): string {
  if (!raw) return '/email';
  if (!/^\/email(?:[/?#]|$)/.test(raw)) return '/email';
  if (raw.includes('//') || raw.includes('\\') || /[\u0000-\u001f\u007f]/.test(raw)) return '/email';
  return raw.slice(0, 512);
}
