/**
 * The Microsoft Graph permissions the Email module asks for — one set, for
 * every mailbox, so Izzy's tenant admin consents once.
 *
 * Delegated only. `.Shared` variants are what let a person act in a shared
 * mailbox they have Full Access / Send As on; without them Graph answers 403
 * on `/users/{shared}/…` even when Exchange delegation is in place.
 */

/** OpenID scopes: not echoed back reliably, so never part of the "missing" diff. */
const OIDC = ['openid', 'profile', 'email', 'offline_access'] as const;

/** The resource scopes each feature needs. Order is the order Microsoft shows. */
export const GRAPH_SCOPES = [
  'User.Read',
  'Mail.ReadWrite',
  'Mail.ReadWrite.Shared',
  'Mail.Send',
  'Mail.Send.Shared',
  'MailboxSettings.ReadWrite',
  'Calendars.ReadWrite',
  'Calendars.ReadWrite.Shared',
  'Contacts.Read',
] as const;

export const MAIL_SCOPES: readonly string[] = [...OIDC, ...GRAPH_SCOPES];

/** The `scope` value for the authorize and token requests. */
export const MAIL_SCOPE_PARAM = MAIL_SCOPES.join(' ');

const GRAPH_PREFIX = 'https://graph.microsoft.com/';

/**
 * Normalises the `scope` string a token response carries. Microsoft returns
 * either short names or `https://graph.microsoft.com/Mail.Read` forms
 * depending on the request; both become the short name.
 */
export function grantedScopes(scope: string | null | undefined): string[] {
  if (!scope) return [];
  const out = new Set<string>();
  for (const raw of scope.split(/\s+/)) {
    if (!raw) continue;
    const name = raw.toLowerCase().startsWith(GRAPH_PREFIX) ? raw.slice(GRAPH_PREFIX.length) : raw;
    out.add(name);
  }
  return [...out];
}

/** Resource scopes we asked for and did not get (case-insensitive). */
export function missingScopes(granted: readonly string[]): string[] {
  const have = new Set(granted.map((s) => s.toLowerCase()));
  return GRAPH_SCOPES.filter((s) => !have.has(s.toLowerCase()));
}
