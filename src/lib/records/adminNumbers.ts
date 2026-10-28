/**
 * Admin → Phone numbers. Assigning a Twilio number to a person.
 *
 * ── WHY THIS SCREEN IS THE SPEND CONTROL ─────────────────────────────────
 * Holding an active number is half the permission to use telephony (the other
 * half is the `communication/phone` subtab grant). Every call and text is
 * billed to the client's Twilio account, so this is the screen that decides who
 * can spend their money — which is why every function here re-checks
 * `ctx.isAdmin` itself rather than trusting the page that rendered it.
 *
 * ── WHAT THIS SCREEN CANNOT DO, AND MUST NOT PRETEND TO ──────────────────
 * ⚠ Assigning a number here grants APPLICATION authorization and says nothing
 * about CARRIER authorization. A US number cannot text US numbers until A2P
 * 10DLC (local) or toll-free verification completes in the Twilio console, and
 * that registration is per number, not once per account — provisioning a new
 * number does not inherit an existing clearance. There is no API that reports
 * this in advance; the only signal is the send failing with Twilio error 30034.
 *
 * Both of the client's current numbers are pending that registration, so the
 * UI says so per row rather than letting someone assign a number, watch texts
 * fail, and go looking for the bug in this code. Inbound is unaffected —
 * 10DLC governs outbound only — so a working inbound thread proves nothing
 * about whether sending will work.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { type AuthContext } from '@/lib/records/permissions';
import { normalizePhone } from '@/lib/phone/normalize';
import { assertAdminPage } from './adminConfig';

export type AdminPhoneNumber = {
  id: string;
  e164: string;
  kind: 'user' | 'campaign';
  userId: string | null;
  fallbackUserId: string | null;
  label: string | null;
  isActive: boolean;
};


export async function listNumbers(ctx: AuthContext): Promise<AdminPhoneNumber[]> {
  await assertAdminPage(ctx, 'numbers');

  const { data, error } = await supabaseAdmin()
    .from('phone_numbers')
    .select('id, e164, kind, user_id, fallback_user_id, label, is_active')
    .is('deleted_at', null)
    .order('e164');

  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id as string,
    e164: r.e164 as string,
    kind: r.kind as 'user' | 'campaign',
    userId: r.user_id as string | null,
    fallbackUserId: r.fallback_user_id as string | null,
    label: r.label as string | null,
    isActive: r.is_active as boolean,
  }));
}

export async function addNumber(
  ctx: AuthContext,
  input: { e164: string; label: string | null },
): Promise<{ ok: true } | { ok: false; message: string }> {
  await assertAdminPage(ctx, 'numbers');

  const normalized = normalizePhone(input.e164);
  if (!normalized.ok) return { ok: false, message: 'That does not look like a phone number.' };

  const { error } = await supabaseAdmin()
    .from('phone_numbers')
    .insert({ e164: normalized.e164, kind: 'user', label: input.label, is_active: true });

  if (error) {
    // 23505 = the partial unique index on live rows. A number already here is
    // a normal mistake, not an exception worth a stack trace.
    if (error.code === '23505') return { ok: false, message: 'That number is already listed.' };
    throw error;
  }
  return { ok: true };
}

/**
 * Point a number at a person, or at nobody.
 *
 * ⚠ ONE ACTIVE NUMBER PER USER is enforced by a partial unique index, not by
 * this function — so a race between two admins assigning the same person two
 * numbers fails in the database rather than producing a state the resolver
 * cannot answer (`resolveUserActiveNumber` uses `maybeSingle`, which would
 * throw on a second row). The 23505 is translated here into the sentence an
 * admin needs.
 */
export async function assignNumber(
  ctx: AuthContext,
  input: { numberId: string; userId: string | null },
): Promise<{ ok: true } | { ok: false; message: string }> {
  await assertAdminPage(ctx, 'numbers');

  const { error } = await supabaseAdmin()
    .from('phone_numbers')
    .update({ user_id: input.userId })
    .eq('id', input.numberId)
    .is('deleted_at', null);

  if (error) {
    if (error.code === '23505') {
      return { ok: false, message: 'That person already has an active number. Unassign it first.' };
    }
    throw error;
  }
  return { ok: true };
}

/**
 * Switch a number off without deleting it.
 *
 * Deactivating is the reversible move and is what should normally be used: the
 * number stops being resolvable for outbound caller id and for inbound routing,
 * while every call and message already logged against it keeps its history.
 */
export async function setNumberActive(
  ctx: AuthContext,
  input: { numberId: string; isActive: boolean },
): Promise<void> {
  await assertAdminPage(ctx, 'numbers');

  const { error } = await supabaseAdmin()
    .from('phone_numbers')
    .update({ is_active: input.isActive })
    .eq('id', input.numberId)
    .is('deleted_at', null);

  if (error) throw error;
}
