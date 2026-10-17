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
import { loadConfig } from '@/lib/records/config';
import { subtabGrant, capGrant, tabGrant, type AuthContext } from '@/lib/records/permissions';
import { mailConfigured } from '@/lib/env.server';

/** Looked up by key, never by id. */
const EMAIL_SUBTAB_KEY = 'email';

export type EmailAccess = 'hidden' | 'view' | 'edit';

export async function emailAccess(ctx: AuthContext): Promise<EmailAccess> {
  if (!mailConfigured) return 'hidden';
  if (ctx.isAdmin) return 'edit';

  const config = await loadConfig();
  const subtab = config.subtabs.find((s) => s.key === EMAIL_SUBTAB_KEY);
  if (!subtab) return 'hidden';

  const [tg, sg] = await Promise.all([tabGrant(ctx, subtab.tabId), subtabGrant(ctx, subtab.id)]);
  return capGrant(tg, sg);
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
