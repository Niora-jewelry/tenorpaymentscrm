/**
 * May this person use the Email module at all?
 *
 * The same answer `src/lib/phone/access.ts` gives for the phone, for the
 * same reasons: the `communication/email` subtab is already a real, seeded
 * permission scope, settable per person or per template on the Permissions
 * screen, so "who gets email" is configuration, not code (CLAUDE.md rule 1
 * applied to a feature). Capped by the Communication tab, so hiding that tab
 * hides email too.
 *
 *   View  → may open the module and read mail in mailboxes they can see.
 *   Edit  → may also send, move, delete, and manage folders and rules.
 *
 * This is the APPLICATION half. The boundary on mail itself is RLS on every
 * `mail_*` table (`mail_visible_mailbox_ids()`), which this can only narrow.
 */
import 'server-only';
import type { AuthContext } from '@/lib/records/permissions';
import { mailConfigured } from '@/lib/env.server';

/** Looked up by key, never by id. */

export type EmailAccess = 'hidden' | 'view' | 'edit';

/**
 * Every user has the Email module for their own connected inbox, "whatever
 * their other permissions" (Permissions spec: Moving Email settings into the
 * Email module). Whose OTHER inboxes they also see is the Email setting —
 * Own only / All users — enforced by `mail_visible_mailbox_ids()`
 * (migration 9813), not here. There is no Hidden and no view-only Email.
 */
export async function emailAccess(ctx: AuthContext): Promise<EmailAccess> {
  void ctx;
  if (!mailConfigured) return 'hidden';
  return 'edit';
}

export async function canSeeEmail(ctx: AuthContext): Promise<boolean> {
  return (await emailAccess(ctx)) !== 'hidden';
}

export async function canUseEmail(ctx: AuthContext): Promise<boolean> {
  return (await emailAccess(ctx)) === 'edit';
}

export class EmailAccessError extends Error {
  constructor(public readonly needed: 'view' | 'edit') {
    super(needed === 'edit' ? 'You can read email here but not change it.' : 'Email is not available to you.');
    this.name = 'EmailAccessError';
  }
}

/** Throws unless the person holds at least `level`. Every Email action calls this. */
export async function requireEmailAccess(ctx: AuthContext, level: 'view' | 'edit'): Promise<void> {
  const access = await emailAccess(ctx);
  if (access === 'hidden' || (level === 'edit' && access !== 'edit')) throw new EmailAccessError(level);
}
