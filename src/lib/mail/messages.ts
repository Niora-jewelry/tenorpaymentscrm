/**
 * Every sentence the Email module shows a person about something going
 * wrong, in one file — the same discipline as `auth/messages.ts`.
 *
 * House style: short, says what happened and what to do, never a raw code.
 * Graph's own code stays available behind a details toggle (`detail`).
 */
import type { MailErrorCode } from './errors';

export const MAIL_MESSAGES = {
  reconnect: (address: string) => `Outlook disconnected ${address}. Reconnect to resume syncing.`,
  reconnectMfa: 'Microsoft asked for a fresh sign-in.',
  consent: 'The TapDash app is not approved for this Microsoft account yet. Ask your Microsoft admin to approve it, then reconnect.',
  appSecretAdmin: 'Outlook sync is paused: the Microsoft app secret has expired. Rotate it in Azure and update MAIL_CLIENT_SECRET.',
  scopeMissing: (feature: string) => `Outlook needs one more permission for ${feature}. Reconnect to grant it.`,
  accessRemoved: (shared: string) => `You no longer have access to ${shared} in Outlook. Ask your Microsoft admin, then reconnect.`,
  goneMessage: 'That message was already moved or deleted in Outlook.',
  goneAttachment: 'That attachment is no longer in Outlook.',
  conflictMessage: "Outlook changed this message first. Showing Outlook's version.",
  folderExists: 'A folder with that name already exists in Outlook.',
  busy: (seconds: number) => `Outlook is busy. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`,
  offline: "You're offline. Showing cached mail; actions are paused until you're back online.",
  providerDown: "Can't reach Outlook right now. You're seeing cached mail; sending and other actions are paused until it's back.",
  paused: 'Paused until Outlook is reachable.',
  tooLarge: "Outlook rejected this message: it's over the size limit. Remove an attachment and try again.",
  wouldBeTooLarge: (limitMb: number) => `This would push the message over Outlook's ${limitMb} MB limit.`,
  sendAsDenied: (shared: string) => `Outlook won't let you send as ${shared}. Ask your Microsoft admin for Send As permission.`,
  sendQuota: "Outlook's sending limit for this mailbox was reached. Try again later.",
  badRecipient: (address: string) => `One of the addresses isn't valid: ${address}.`,
  sendFailed: (to: string) => `Your message to ${to} didn't send.`,
  ruleRejected: (graph: string) => `Outlook rejected this rule: ${graph}`,
  folderCap: 'This mailbox already has 500 folders.',
  connectionCap: "You've connected 30 mailboxes, the maximum. Disconnect one to add another.",
  oauthCancelled: 'Microsoft sign-in was cancelled. Nothing was connected.',
  oauthExpired: 'That sign-in link expired. Start the connection again.',
  wrongTenant: "That account isn't in a TapDash Microsoft tenant, so it can't be connected.",
  personalAccount: 'Only work or school Microsoft 365 accounts can be connected, not personal Outlook.com accounts.',
  impersonating: "Hidden while you're signed in as another user.",
  notConfigured: 'Email is not set up on this deployment yet.',
  generic: 'Something went wrong talking to Outlook. Try again in a moment.',
} as const;

/** The sentence for an action failure, from the classified code. */
export function messageFor(code: MailErrorCode, ctx: { address?: string; shared?: string; retryAfter?: number; to?: string } = {}): string {
  switch (code) {
    case 'reconnect_required': return MAIL_MESSAGES.reconnect(ctx.address ?? 'this mailbox');
    case 'consent_required': return MAIL_MESSAGES.consent;
    case 'app_secret_invalid': return MAIL_MESSAGES.providerDown;
    case 'scope_missing': return MAIL_MESSAGES.scopeMissing('this action');
    case 'mailbox_access_removed': return MAIL_MESSAGES.accessRemoved(ctx.shared ?? ctx.address ?? 'this mailbox');
    case 'mailbox_not_found': return MAIL_MESSAGES.reconnect(ctx.address ?? 'this mailbox');
    case 'not_found': return MAIL_MESSAGES.goneMessage;
    case 'conflict': return MAIL_MESSAGES.conflictMessage;
    case 'throttled': return MAIL_MESSAGES.busy(ctx.retryAfter ?? 10);
    case 'provider_down': return MAIL_MESSAGES.providerDown;
    case 'too_large': return MAIL_MESSAGES.tooLarge;
    case 'send_as_denied': return MAIL_MESSAGES.sendAsDenied(ctx.shared ?? 'this mailbox');
    case 'send_quota': return MAIL_MESSAGES.sendQuota;
    case 'bad_recipient': return MAIL_MESSAGES.badRecipient(ctx.to ?? 'one recipient');
    case 'rule_rejected': return MAIL_MESSAGES.ruleRejected('check the conditions and actions.');
    case 'token_expired':
    case 'unknown':
    default: return MAIL_MESSAGES.generic;
  }
}
