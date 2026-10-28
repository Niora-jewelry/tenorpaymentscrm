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
import type { AuthContext } from '@/lib/records/permissions';

/*
 * ── EVERY USER HAS THEIR OWN PHONE LINE ──────────────────────────────────
 * Permissions spec: the Phone module is Own only / All users, with no Hidden
 * — "every user sees at least their own". Whose calls and texts they see
 * beyond their own is the Phone setting, enforced by the phone_* policies
 * (migration 9813); dialling needs a number assigned on the admin Numbers
 * screen, which stays the one control over telephony spend.
 */

export async function canUsePhone(ctx: AuthContext): Promise<boolean> {
  return Boolean(ctx.userId);
}

export async function canSeePhone(ctx: AuthContext): Promise<boolean> {
  return Boolean(ctx.userId);
}

/**
 * Hearing a recording: the `phone_recordings` policy and the bucket policy
 * decide (your own calls; the record's calls with Communication = Whole org;
 * everyone's with Phone = All users). This gate cannot widen them.
 */
export async function canHearRecordings(ctx: AuthContext): Promise<boolean> {
  return Boolean(ctx.userId);
}
