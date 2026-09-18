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
import { moduleGrant } from './permissions';
import { loadConfig } from './config';
import { moduleWriteCap } from './tabAccess';

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

/**
 * Replaces the full membership set. Passing `[]` is the Archive action.
 *
 * ── THE GUARD, AND WHY IT IS HERE ────────────────────────────────────────
 * This took an `AuthContext` and never read it. `set_record_memberships`
 * checks `record_visible()` and nothing else, so anyone who could SEE a record
 * could move it between modules — including into a module hidden to them, and
 * including into none at all, which is Archive. A member holding Tickets =
 * View could archive a record out of every colleague's dashboard.
 *
 * Membership is a write to the record, so it needs Edit on the record, and
 * each module added or removed needs Edit on THAT module: adding a record to
 * Deals is a change to Deals, and it should not be reachable by someone who
 * cannot open Deals.
 *
 * Unchanged modules are deliberately not checked. Archiving a record out of
 * Leads should not be blocked because it also sits in a module the viewer
 * cannot see — that membership is not being touched.
 */
export async function setMemberships(
  ctx: AuthContext,
  recordId: string,
  moduleIds: string[],
): Promise<void> {
  if (!ctx.isAdmin) {
    const cap = (await moduleWriteCap(ctx, [recordId])).get(recordId) ?? 'hidden';
    if (cap !== 'edit') throw new Error('You do not have edit access to this record.');

    const config = await loadConfig();
    const before = new Set(await membershipsFor(ctx, recordId));
    const after = new Set(moduleIds);
    const touched = [...new Set([...before, ...after])].filter(
      (id) => before.has(id) !== after.has(id),
    );

    for (const id of touched) {
      const mod = config.modules.find((m) => m.id === id);
      if (!mod) throw new Error('That module no longer exists.');
      if ((await moduleGrant(ctx, mod.id, mod.adminOnly)) !== 'edit') {
        throw new Error(`You do not have edit access to ${mod.label}.`);
      }
    }
  }

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
