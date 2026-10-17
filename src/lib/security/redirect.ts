/**
 * Open-redirect defence.
 *
 * The spec requires that an unauthenticated visitor to any route is sent to
 * /login and then "the originally requested URL is preserved and restored after
 * successful login". That feature is the classic open-redirect vector: an
 * attacker sends a link that logs you in and then quietly forwards you to their
 * site, where a convincing fake page collects whatever it likes.
 *
 * A target is accepted ONLY if it is a same-origin relative path. Everything
 * else falls back to DEFAULT_REDIRECT.
 *
 * Edge-runtime safe: no Node built-ins, used from middleware.
 */

export const DEFAULT_REDIRECT = '/dashboard';

/** Paths a signed-in user must never be "restored" to. */
const NEVER_RESTORE = new Set([
  '/login',
  '/signup',
  '/reset-password',
  // A session that lapses mid-way through connecting a mailbox must not be
  // "restored" into the OAuth callback: that would replay a used code.
  '/api/mail/oauth/callback',
]);

/**
 * Control characters (including tab, newline, carriage return) and spaces are
 * stripped by browsers when resolving URLs, which is how "/\tjavascript:" and
 * "/\n//evil.com" slip past naive checks.
 */
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f-\u009f]/g;

function decodeFully(value: string): string {
  let current = value;
  // Bounded loop: defeats double- and triple-encoding (%252f%252f) without
  // risking an unbounded spin on malformed input.
  for (let i = 0; i < 3; i += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return current;
    }
    if (next === current) return current;
    current = next;
  }
  return current;
}

/**
 * @param target    Untrusted candidate, typically from a `?next=` parameter.
 * @param appOrigin Canonical origin of this app.
 * @returns A safe relative path. Never an absolute URL, never off-origin.
 */
export function safeRedirectPath(
  target: string | null | undefined,
  appOrigin: string,
): string {
  if (!target) return DEFAULT_REDIRECT;

  const cleaned = target.replace(CONTROL_OR_SPACE, '');
  if (cleaned.length === 0 || cleaned.length > 2048) return DEFAULT_REDIRECT;

  // Must be a rooted relative path.
  if (!cleaned.startsWith('/')) return DEFAULT_REDIRECT;

  // Protocol-relative ("//evil.com") and backslash variants ("/\evil.com",
  // which several browsers normalise to "//evil.com").
  if (cleaned.startsWith('//') || cleaned.startsWith('/\\')) return DEFAULT_REDIRECT;

  // Reject anything that still looks off-origin once fully decoded.
  const decoded = decodeFully(cleaned).replace(CONTROL_OR_SPACE, '');
  if (
    !decoded.startsWith('/') ||
    decoded.startsWith('//') ||
    decoded.startsWith('/\\') ||
    decoded.includes('\\')
  ) {
    return DEFAULT_REDIRECT;
  }

  // A scheme anywhere in the decoded value is disqualifying.
  if (/^[a-z][a-z0-9+.-]*:/i.test(decoded.slice(1))) return DEFAULT_REDIRECT;

  // Final authority: resolve it and confirm the origin did not move.
  let resolved: URL;
  try {
    resolved = new URL(cleaned, appOrigin);
  } catch {
    return DEFAULT_REDIRECT;
  }

  if (resolved.origin !== new URL(appOrigin).origin) return DEFAULT_REDIRECT;
  if (NEVER_RESTORE.has(resolved.pathname)) return DEFAULT_REDIRECT;

  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

/**
 * Builds the /login URL that preserves where the user was trying to go.
 */
export function loginUrlPreserving(pathWithQuery: string, appOrigin: string): URL {
  const url = new URL('/login', appOrigin);
  const safe = safeRedirectPath(pathWithQuery, appOrigin);
  if (safe !== DEFAULT_REDIRECT) url.searchParams.set('next', safe);
  return url;
}
