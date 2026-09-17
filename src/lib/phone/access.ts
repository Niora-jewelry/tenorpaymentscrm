/**
 * May this person use the phone at all?
 *
 * ── WHY THIS IS A GRANT AND NOT A ROLE ───────────────────────────────────
 * Donny's module answers this with `auth_role() in ('admin','super_admin')`,
 * because the old CRM had roles and nothing finer. TapDash has the grant
 * system, and the `communication/phone` subtab is already a real permission
 * scope — seeded, listed on the Permissions screen, settable per person or per
 * template. So "who may dial" is configuration here, not code, which is
 * CLAUDE.md rule 1 applied to a feature rather than to a module.
 *
 * The practical difference: an admin can give a new rep a phone by setting one
 * grant and assigning a number, without a deploy and without anyone editing a
 * list of user ids.
 *
 * ── TWO GATES, DELIBERATELY ──────────────────────────────────────────────
 * This is not the only check. `/api/twilio/token` also requires an ACTIVE
 * ASSIGNED NUMBER, and that stays Donny's design because it answers a different
 * question: the grant says "you are allowed to", the number says "someone is
 * paying for it". The admin Numbers screen remains the single control over
 * telephony spend.
 *
 * ── SUBTAB, NOT TAB ──────────────────────────────────────────────────────
 * `communication` (the tab) governs email, text and the rest together, so
 * gating on it would switch off the whole Communication tab for anyone denied
 * the phone. The grant chain caps a subtab by its tab anyway, so a hidden
 * Communication tab still hides Phone — which is the correct direction.
 */
import 'server-only';
import { loadConfig } from '@/lib/records/config';
import { subtabGrant, capGrant, tabGrant, type AuthContext } from '@/lib/records/permissions';

/** The subtab keys this module lives in. Looked up by key, never by id. */
const PHONE_SUBTAB_KEY = 'phone';
const RECORDINGS_SUBTAB_KEY = 'recordings';

async function subtabAccess(ctx: AuthContext, subtabKey: string) {
  if (ctx.isAdmin) return 'edit' as const;

  const config = await loadConfig();
  const subtab = config.subtabs.find((s) => s.key === subtabKey);
  if (!subtab) return 'hidden' as const;

  // Capped by its own tab, so hiding Communication hides everything under it.
  const [tg, sg] = await Promise.all([
    tabGrant(ctx, subtab.tabId),
    subtabGrant(ctx, subtab.id),
  ]);
  return capGrant(tg, sg);
}

/** Dialling and texting need Edit — both place billable traffic. */
export async function canUsePhone(ctx: AuthContext): Promise<boolean> {
  return (await subtabAccess(ctx, PHONE_SUBTAB_KEY)) === 'edit';
}

/** Seeing the call log needs only View. */
export async function canSeePhone(ctx: AuthContext): Promise<boolean> {
  return (await subtabAccess(ctx, PHONE_SUBTAB_KEY)) !== 'hidden';
}

/**
 * Hearing a recording needs View on Call recordings.
 *
 * ⚠ This is the APPLICATION half only. The real boundary is the
 * `phone_recordings` RLS policy and the `phone-recordings` bucket policy, both
 * of which restrict audio to the call's owner and admins regardless of what
 * this returns — see migration 68. This gate can only ever narrow that further,
 * never widen it.
 */
export async function canHearRecordings(ctx: AuthContext): Promise<boolean> {
  return (await subtabAccess(ctx, RECORDINGS_SUBTAB_KEY)) !== 'hidden';
}
