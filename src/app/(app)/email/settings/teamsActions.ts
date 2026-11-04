'use server';

/**
 * The two "hide mine" switches for Calendar and Chat. Admins and Super admins only
 * (spec, Permissions), so the role is checked here and the row is written by the
 * server: nothing a browser can call writes it directly.
 */
import { z } from 'zod';
import { authorize } from '@/lib/records/permissions';
import { currentImpersonation } from '@/lib/auth/impersonation';
import { canHideOwn } from '@/lib/msteams/access';
import { supabaseAdmin } from '@/lib/supabase/admin';

export async function setTeamsPrivacyAction(raw: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
  const p = z.object({ calendar: z.boolean(), chat: z.boolean() }).safeParse(raw);
  if (!p.success) return { ok: false, message: 'That could not be saved.' };
  const ctx = await authorize();
  if (await currentImpersonation()) return { ok: false, message: 'This is not available while signed in as someone else.' };
  if (!(await canHideOwn(ctx))) return { ok: false, message: 'This setting is for Admins and Super admins.' };
  const { error } = await supabaseAdmin()
    .from('mail_user_settings')
    .upsert({ user_id: ctx.userId, hide_my_calendar: p.data.calendar, hide_my_chat: p.data.chat, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  return error ? { ok: false, message: 'That could not be saved.' } : { ok: true };
}
