'use server';

/**
 * Server actions for the residuals admin screens.
 *
 * Thin shells: parse, authorise, call the RPC, revalidate. The RPCs carry
 * their own `auth_is_admin()` check as well — belt and braces on purpose,
 * because those functions are reachable by any signed-in user through
 * PostgREST and must not depend on this layer having been honest.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { authorize } from '@/lib/records/permissions';
import { supabaseAdmin } from '@/lib/supabase/admin';

export type ResidualActionState = { ok: boolean; message?: string };

const linkSchema = z.object({
  mid: z.string().trim().min(1).max(32),
  recordId: z.string().uuid(),
});

/** Attach a statement MID to a merchant record, by hand. */
export async function linkMidAction(
  mid: string,
  recordId: string,
): Promise<ResidualActionState> {
  const ctx = await authorize();
  if (!ctx.isAdmin) return { ok: false, message: 'Admin only.' };

  const parsed = linkSchema.safeParse({ mid, recordId });
  if (!parsed.success) return { ok: false, message: 'That is not a valid link.' };

  const { data, error } = await supabaseAdmin().rpc('residual_link_mid_to_record', {
    p_mid: parsed.data.mid,
    p_record_id: parsed.data.recordId,
    p_period_id: null,
  });

  if (error) {
    console.error('[residuals] link failed', error);
    return { ok: false, message: error.message };
  }

  const r = data as { lines_linked: number; volumes_linked: number; plans_linked: number } | null;
  const total = (r?.lines_linked ?? 0) + (r?.volumes_linked ?? 0) + (r?.plans_linked ?? 0);

  revalidatePath('/admin/residuals');
  return { ok: true, message: `${total} row${total === 1 ? '' : 's'} attached.` };
}

/**
 * Re-adjudicate every machine link.
 *
 * Manual links are untouched by the kernel, so this cannot overturn a human
 * decision — which is why it is safe to offer as a single button with no
 * confirmation.
 */
export async function sweepLinksAction(): Promise<ResidualActionState> {
  const ctx = await authorize();
  if (!ctx.isAdmin) return { ok: false, message: 'Admin only.' };

  const { data, error } = await supabaseAdmin().rpc('residual_sweep_mid_links');
  if (error) {
    console.error('[residuals] sweep failed', error);
    return { ok: false, message: error.message };
  }

  const n = (data as number | null) ?? 0;
  revalidatePath('/admin/residuals');
  return {
    ok: true,
    message: n === 0 ? 'Nothing changed — every link is current.' : `${n} row${n === 1 ? '' : 's'} re-checked.`,
  };
}
