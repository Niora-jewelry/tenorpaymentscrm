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

/** The `scope` value for an account approved for mail only. */
export const MAIL_SCOPE_PARAM = MAIL_SCOPES.join(' ');

/**
 * What Calendar and Chat need on top of mail. Asked for together with mail on every
 * connect, so one Microsoft sign-in feeds all three modules.
 *
 * Separate from GRAPH_SCOPES on purpose: `missingScopes` decides whether a MAILBOX
 * is degraded, and a mailbox approved before Chat existed is not degraded.
 */
export const TEAMS_SCOPES = [
  'Chat.ReadWrite',
  'ChatMessage.Send',
  'ChannelMessage.Send',
  'ChannelMessage.ReadWrite',
  'ChannelMessage.Read.All',
  'Channel.ReadBasic.All',
  'Channel.Create',
  'ChannelMember.Read.All',
  'Team.ReadBasic.All',
  'Team.Create',
  'TeamMember.ReadWrite.All',
  'Files.ReadWrite.All',
  'User.ReadBasic.All',
  'People.Read',
  'OnlineMeetings.ReadWrite',
] as const;

/** The `scope` value for connecting: mail, calendar and chat together. */
export const FULL_SCOPE_PARAM = [...MAIL_SCOPES, ...TEAMS_SCOPES].join(' ');

/** Has this sign-in approved calendar and chat access? */
export function teamsGranted(granted: readonly string[]): boolean {
  const have = new Set(granted.map((s) => s.toLowerCase()));
  return TEAMS_SCOPES.every((s) => have.has(s.toLowerCase()));
}

/**
 * The `scope` to refresh with. It has to match what this sign-in approved: asking
 * for one permission more makes Microsoft refuse the refresh, and a refused refresh
 * marks the whole connection broken, Email included.
 */
export function scopeParamFor(granted: readonly string[]): string {
  return teamsGranted(granted) ? FULL_SCOPE_PARAM : MAIL_SCOPE_PARAM;
}

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
