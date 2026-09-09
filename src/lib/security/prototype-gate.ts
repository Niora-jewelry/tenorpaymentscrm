/**
 * Access control for the deployed prototype.
 *
 * The prototype holds no real data — every merchant, message and credential in
 * it is invented — but it does show the client's field names, their pricing
 * structure and their whole product shape. That is commercially theirs, so it
 * does not go on the open internet.
 *
 * The rule is DEFAULT-CLOSED, and deliberately so:
 *
 *   development             always reachable, no code needed
 *   production, nothing set 404. Not a login page, not "access denied" — 404,
 *                           because an error page advertises that something is
 *                           there to find
 *   production, code set    reachable with ?key=<code> once; a cookie carries
 *                           it from then on
 *   production, PUBLIC set  reachable by anyone with the URL
 *
 * Deleting these variables from the deployment closes it again with no code
 * change and no redeploy of anything else. That matters: this surface should be
 * easy to switch off by someone who is not a developer.
 *
 * This is a shared door code, not authentication. It says nothing about WHO is
 * looking, and it is not the mechanism protecting anything real — the actual
 * CRM behind /login is protected by Supabase Auth and row-level security, which
 * this file has nothing to do with.
 */

export const PROTOTYPE_COOKIE = 'tapdash_proto_access';
export const PROTOTYPE_KEY_PARAM = 'key';

/** 90 days. Long enough that a client is not locked out mid-review. */
export const PROTOTYPE_COOKIE_MAX_AGE = 90 * 24 * 60 * 60;

/**
 * Short codes are the failure mode here, so the floor is enforced rather than
 * documented. A code below this length is treated as absent, which fails
 * closed — the prototype 404s instead of quietly being guessable.
 */
const MIN_CODE_LENGTH = 16;

export function prototypeAccessCode(): string | null {
  const raw = process.env.PROTOTYPE_ACCESS_CODE?.trim();
  if (!raw || raw.length < MIN_CODE_LENGTH) return null;
  return raw;
}

/**
 * Compares in constant time with respect to CONTENT. Length is compared first
 * and leaks, which is fine for a fixed-length shared code and is the standard
 * trade-off; the alternative is hashing both sides, and Web Crypto's digest is
 * async, which this needs to not be.
 */
function matches(candidate: string, code: string): boolean {
  if (candidate.length !== code.length) return false;
  let diff = 0;
  for (let i = 0; i < code.length; i++) {
    diff |= candidate.charCodeAt(i) ^ code.charCodeAt(i);
  }
  return diff === 0;
}

export function isPrototypeUnlocked(candidate: string | null | undefined): boolean {
  const code = prototypeAccessCode();
  if (!code || !candidate) return false;
  return matches(candidate, code);
}
