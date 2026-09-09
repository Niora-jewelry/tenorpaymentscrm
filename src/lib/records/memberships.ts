/**
 * Module membership — "In modules" in the drawer.
 *
 * Zero rows means Archived (SCHEMA.md: an absence, not a flag, so the two
 * can never disagree). `set_record_memberships` (migration 13) replaces the
 * whole set and logs the delta — including detecting the Archive transition
 * as its own event — in one transaction.
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { AuthContext } from './permissions';

/** Batched — one query for a whole page of the dashboard, not one per row. */
export async function membershipsForMany(_ctx: AuthContext, recordIds: string[]): Promise<Record<string, string[]>> {
  if (!recordIds.length) return {};
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('record_modules')
    .select('record_id, module_id')
    .in('record_id', recordIds);
  if (error) throw error;

  const out: Record<string, string[]> = {};
  for (const r of data ?? []) {
    (out[r.record_id as string] ??= []).push(r.module_id as string);
  }
  return out;
}

export async function membershipsFor(_ctx: AuthContext, recordId: string): Promise<string[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('record_modules')
    .select('module_id')
    .eq('record_id', recordId);
  if (error) throw error;
  return (data ?? []).map((r) => r.module_id as string);
}

/** Replaces the full membership set. Passing `[]` is the Archive action. */
export async function setMemberships(
  _ctx: AuthContext,
  recordId: string,
  moduleIds: string[],
): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('set_record_memberships', {
    p_record_id: recordId,
    p_module_ids: moduleIds,
  });
  if (error) throw error;
}

export async function toggleMembership(
  ctx: AuthContext,
  recordId: string,
  moduleId: string,
  on: boolean,
): Promise<void> {
  const current = await membershipsFor(ctx, recordId);
  const next = on ? [...new Set([...current, moduleId])] : current.filter((m) => m !== moduleId);
  await setMemberships(ctx, recordId, next);
}
