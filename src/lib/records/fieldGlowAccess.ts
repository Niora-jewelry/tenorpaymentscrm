/**
 * Who sees field glows, and which set a record shows (Field Highlight Glows spec).
 *
 * The stage is read with the service role once the record is proven visible, and
 * only the stage word leaves here: glows must match in every module, including
 * for a viewer with no Applications tab, who still learns no status or detail.
 */
import 'server-only';
import { currentImpersonation } from '@/lib/auth/impersonation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { glowStageFrom, type GlowStage } from './fieldNeeds';
import { permissionsFor, type AuthContext } from './permissions';

export { glowStageFrom };

/** `permitted` is the permission; `hidden` is the user's own switch. Glows show when permitted and not hidden. */
export async function fieldGlowAccess(ctx: AuthContext): Promise<{ permitted: boolean; hidden: boolean }> {
  const [permissions, setting] = await Promise.all([
    permissionsFor(ctx),
    supabaseAdmin().from('user_field_glow_settings').select('hidden').eq('user_id', ctx.userId).maybeSingle(),
  ]);
  if (setting.error) throw setting.error;
  return { permitted: permissions.settings['fields.highlights'] === 'yes', hidden: Boolean(setting.data?.hidden) };
}

/**
 * The personal switch. It only ever hides: `fieldGlowAccess` still answers
 * `permitted: false` for a user whose permission is No, whatever is stored here.
 * Someone viewing as another user cannot change that user's screen.
 */
export async function setFieldGlowHidden(ctx: AuthContext, hidden: boolean): Promise<void> {
  if (await currentImpersonation()) throw new Error('Not while viewing as another user.');
  const { error } = await supabaseAdmin()
    .from('user_field_glow_settings')
    .upsert({ user_id: ctx.userId, hidden, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) throw error;
}

/** The stage of one record, or 'none' for a record the viewer may not open. */
export async function recordGlowStage(ctx: AuthContext, recordId: string): Promise<GlowStage> {
  void ctx; // The pass: only the gate can make one, so an unauthorised caller cannot compile.
  const supabase = await createSupabaseServerClient();
  const visible = await supabase.rpc('record_visible', { rec: recordId });
  if (visible.error) throw visible.error;
  if (!visible.data) return 'none';

  const admin = supabaseAdmin();
  const kinds = await admin.from('agreement_kinds').select('key').eq('sets_glow_stage', true);
  if (kinds.error) throw kinds.error;
  const [application, agreement] = await Promise.all([
    admin.from('applications').select('status').eq('record_id', recordId).order('number', { ascending: false }).limit(1).maybeSingle(),
    admin
      .from('agreements')
      .select('status')
      .eq('record_id', recordId)
      .in('kind', (kinds.data ?? []).map((k) => k.key as string))
      .order('number', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (application.error) throw application.error;
  if (agreement.error) throw agreement.error;
  return glowStageFrom((application.data?.status as string | undefined) ?? null, (agreement.data?.status as string | undefined) ?? null);
}
