'use server';

/**
 * The four things a human can do to a month.
 *
 * Acknowledge a mismatch, take that back, sign the month off, reopen it. All
 * four are `security definer` RPCs gated on `auth_is_admin()`, which resolves
 * `auth.uid()` — NULL under the service-role key — so every one goes through
 * the request-scoped client. `residual_acknowledge_verdict` says so in its own
 * hint: *"This function cannot be called on a service-role connection."*
 *
 * ── EVERY ONE OF THEM TAKES A REASON, AND THAT IS NOT CEREMONY ───────────
 * The database enforces it (`length(btrim(coalesce(p_reason,''))) < 3` raises
 * 22004), so the client-side minimum below is the same rule said earlier and
 * in a sentence. The reason is the entire value of the record: an
 * acknowledgment without one says a number was forgiven and nothing about why,
 * which is indistinguishable from the mismatch having been missed.
 *
 * ── THE DELTA IS NEVER SENT ──────────────────────────────────────────────
 * `residual_acknowledge_verdict` derives it. Daniel: *"The delta is DERIVED
 * here and never accepted from the caller: an ack's whole value is that it
 * records what was actually on the screen."* So these actions pass the row, the
 * step and the reason, and nothing numeric.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { authorize } from '@/lib/records/permissions';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export type ActionResult = { ok: boolean; message: string };

const SCOPE = z.enum(['line', 'group']);
const STEP = z.union([z.literal(1), z.literal(2), z.literal(3)]);
/** The database refuses under 3 characters. Said here as a sentence instead. */
const REASON = z
  .string()
  .trim()
  .min(3, 'Say why, in a few words at least — the reason is the whole point of the record.')
  .max(1000);

/**
 * Turns a PostgREST error into something an operator can act on.
 *
 * The RPCs raise with deliberate SQLSTATEs and useful messages, so the message
 * is passed through rather than replaced. The codes are mapped because
 * "22004" on a screen is not an explanation.
 */
function explain(error: { code?: string; message: string }): string {
  if (error.code === '42501') {
    return 'You are not authorised to do that. If you are an admin, try signing in again.';
  }
  if (error.code === 'P0002') return 'That row is no longer there — reload the month.';
  return error.message;
}

/** Forgive one step's mismatch on one row, with a reason that is recorded. */
export async function acknowledgeVerdictAction(
  periodId: string,
  scope: string,
  scopeId: string,
  step: number,
  reason: string,
): Promise<ActionResult> {
  const ctx = await authorize();
  if (!ctx.isAdmin) return { ok: false, message: 'Admin only.' };

  const parsed = z
    .object({
      periodId: z.string().uuid(),
      scope: SCOPE,
      scopeId: z.string().uuid(),
      step: STEP,
      reason: REASON,
    })
    .safeParse({ periodId, scope, scopeId, step, reason });

  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0].message };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('residual_acknowledge_verdict', {
    p_scope: parsed.data.scope,
    p_scope_id: parsed.data.scopeId,
    p_step: parsed.data.step,
    p_reason: parsed.data.reason,
    p_processor: null,
  });

  if (error) {
    console.error('[residuals] acknowledge failed', error);
    return { ok: false, message: explain(error) };
  }

  revalidatePath(`/admin/residuals/${parsed.data.periodId}`);
  return { ok: true, message: 'Acknowledged. The mismatch stays visible, and no longer blocks.' };
}

/**
 * Take an acknowledgment back.
 *
 * The brief had retirement as a system act only; this is the deliberate
 * exception, because somebody who acknowledged the wrong row needs a way out
 * that is not editing the table. It also takes a reason, for the same reason
 * the acknowledgment did.
 */
export async function withdrawAcknowledgmentAction(
  periodId: string,
  ackId: string,
  reason: string,
): Promise<ActionResult> {
  const ctx = await authorize();
  if (!ctx.isAdmin) return { ok: false, message: 'Admin only.' };

  const parsed = z
    .object({ periodId: z.string().uuid(), ackId: z.string().uuid(), reason: REASON })
    .safeParse({ periodId, ackId, reason });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0].message };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('residual_withdraw_acknowledgment', {
    p_ack_id: parsed.data.ackId,
    p_reason: parsed.data.reason,
  });

  if (error) {
    console.error('[residuals] withdraw failed', error);
    return { ok: false, message: explain(error) };
  }

  revalidatePath(`/admin/residuals/${parsed.data.periodId}`);
  return { ok: true, message: 'Withdrawn. That mismatch counts again.' };
}

/**
 * Sign the month off.
 *
 * ── THE GATE IS IN THE DATABASE, NOT IN THE BUTTON ───────────────────────
 * `residual_sign_off_period` refuses a month that is not signable, and
 * "signable" means at least one merchant and every one of them clean. The
 * "at least one" half is not pedantry: without it an empty period is
 * vacuously signable, and signing an empty month freezes it against the import
 * that was about to arrive.
 *
 * The UI disables the button for the same reason, which is a courtesy rather
 * than the enforcement.
 */
export async function signOffPeriodAction(
  periodId: string,
  note: string,
): Promise<ActionResult> {
  const ctx = await authorize();
  if (!ctx.isAdmin) return { ok: false, message: 'Admin only.' };

  const parsed = z
    .object({
      periodId: z.string().uuid(),
      /* Optional here: the function accepts a null note, and a sign-off on a
         month with nothing outstanding has nothing to explain. */
      note: z.string().trim().max(1000).optional(),
    })
    .safeParse({ periodId, note });
  if (!parsed.success) return { ok: false, message: 'That is not a period.' };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('residual_sign_off_period', {
    p_period_id: parsed.data.periodId,
    p_note: parsed.data.note === '' ? null : (parsed.data.note ?? null),
    p_processor: null,
  });

  if (error) {
    console.error('[residuals] sign-off failed', error);
    return { ok: false, message: explain(error) };
  }

  revalidatePath(`/admin/residuals/${parsed.data.periodId}`);
  revalidatePath('/admin/residuals');
  return { ok: true, message: 'Signed off. The month is reconciled.' };
}

/** Reopen a signed-off month. Takes a reason, and the reason is required. */
export async function reopenPeriodAction(
  periodId: string,
  reason: string,
): Promise<ActionResult> {
  const ctx = await authorize();
  if (!ctx.isAdmin) return { ok: false, message: 'Admin only.' };

  const parsed = z
    .object({ periodId: z.string().uuid(), reason: REASON })
    .safeParse({ periodId, reason });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0].message };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('residual_reopen_period', {
    p_period_id: parsed.data.periodId,
    p_reason: parsed.data.reason,
  });

  if (error) {
    console.error('[residuals] reopen failed', error);
    return { ok: false, message: explain(error) };
  }

  revalidatePath(`/admin/residuals/${parsed.data.periodId}`);
  revalidatePath('/admin/residuals');
  return { ok: true, message: 'Reopened. The month can be recalculated and signed again.' };
}
