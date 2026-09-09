/**
 * Per-user personalization — 19 Aug amendment. "Admin default → user
 * override → permission filter." This file is layer 2: the read/write
 * surface for what one signed-in user has dragged into their own order, on
 * top of whatever the admin configured (layer 1, `config.ts`) and before the
 * permission gate strips anything hidden (layer 3, `permissions.ts`).
 *
 * `resolveOrder` is the exact algorithm `src/proto/schema.ts` already proved
 * out in the prototype — ported verbatim rather than reinvented, since the
 * whole point of the prototype pass was to get this logic right before it
 * touched a database. RLS (migration 8) scopes every row here to
 * `user_id = auth.uid()` — the request-scoped client is all that is needed,
 * no service-role escalation, and no combined write+log function: the client
 * himself said personalization changes are "pure UI preference, would be
 * noise" in the activity log, so there is nothing to keep transactional with
 * these writes.
 */
import 'server-only';
import { cache } from 'react';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { AuthContext } from './permissions';
import type { ListFilter } from './records';

/**
 * Resolves an admin's base order against a user's saved override. The SET of
 * slots occupied by user-reordered ids stays exactly where the admin put it;
 * only the VALUES filling those slots get reordered — so a field the admin
 * adds later keeps its admin-defined position (it was never in the user's
 * saved order to begin with), and a field the admin removes just disappears
 * (dropped by the `known` filter below), with no migration step either way.
 */
export function resolveOrder(adminOrder: string[], userOrder: string[] | undefined): string[] {
  if (!userOrder || userOrder.length === 0) return adminOrder;

  const known = new Set(adminOrder);
  const kept = userOrder.filter((id) => known.has(id));
  const keptSet = new Set(kept);

  let next = 0;
  return adminOrder.map((id) => (keptSet.has(id) ? kept[next++]! : id));
}

/* -------------------------------------------------------------------------- */
/* Dashboard column order — keyed by module                                   */
/* -------------------------------------------------------------------------- */

export async function columnOrderFor(ctx: AuthContext, moduleId: string): Promise<string[] | undefined> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('user_column_order')
    .select('field_id, position')
    .eq('user_id', ctx.userId)
    .eq('module_id', moduleId)
    .order('position');
  if (error) throw error;
  if (!data?.length) return undefined;
  return data.map((r) => r.field_id as string);
}

export async function setColumnOrder(ctx: AuthContext, moduleId: string, orderedFieldIds: string[]): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error: delError } = await supabase
    .from('user_column_order')
    .delete()
    .eq('user_id', ctx.userId)
    .eq('module_id', moduleId);
  if (delError) throw delError;

  if (!orderedFieldIds.length) return;
  const { error } = await supabase.from('user_column_order').insert(
    orderedFieldIds.map((fieldId, i) => ({
      user_id: ctx.userId, module_id: moduleId, field_id: fieldId, position: i,
    })),
  );
  if (error) throw error;
}

/** Deletes the shadow — the admin order was never overwritten, so there is
 * nothing to restore, and a live future admin reorder applies on next read. */
export async function resetColumnOrder(ctx: AuthContext, moduleId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from('user_column_order')
    .delete()
    .eq('user_id', ctx.userId)
    .eq('module_id', moduleId);
  if (error) throw error;
}

/* -------------------------------------------------------------------------- */
/* Drawer field order — keyed by tab (+ subtab), NOT by module: the drawer is
 * one global definition, so one saved order per tab covers every module.    */
/* -------------------------------------------------------------------------- */

/** The key one saved order is filed under. `null` subtab is spelled `_`
 * rather than the empty string so a tab with no subtabs can never collide
 * with a (hypothetical) subtab whose id is blank. */
function orderSlot(tabId: string, subtabId: string | null): string {
  return `${tabId}/${subtabId ?? '_'}`;
}

/** The one query. Wrapped by `allFieldOrdersFor` below, which is what
 * callers use — this is separated only so the box can hold its promise. */
async function fetchFieldOrders(userId: string): Promise<Map<string, string[]>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('user_field_order')
    .select('tab_id, subtab_id, field_id, position')
    .eq('user_id', userId)
    .order('position');
  if (error) throw error;

  const out = new Map<string, string[]>();
  for (const r of data ?? []) {
    const key = orderSlot(r.tab_id as string, (r.subtab_id as string | null) ?? null);
    const list = out.get(key);
    if (list) list.push(r.field_id as string);
    else out.set(key, [r.field_id as string]);
  }
  return out;
}

/**
 * A per-request BOX, not a per-request memoised value.
 *
 * `cache()` around the fetch itself would be simpler, but it cannot be
 * invalidated, and this data is written in the same request that reads it: a
 * reorder Server Action calls `setFieldOrder` and then `revalidatePath`, which
 * re-renders the route inside that same action response. A memo with no reset
 * would serve that re-render the order from BEFORE the write, so the drag
 * would appear to snap back until a full reload — the exact silent-staleness
 * class this file's own header warns about. `cache()` on a factory returns the
 * same mutable object for the whole request, which gives a cache that can be
 * cleared. `userId` is stored alongside so a box built for one user can never
 * answer for another.
 */
const fieldOrderBox = cache((): { userId: string | null; orders: Promise<Map<string, string[]>> | null } => ({
  userId: null,
  orders: null,
}));

/** Called by every writer below. Cheap, and the only thing standing between a
 * write and a stale read in the same request. */
function invalidateFieldOrders(): void {
  const box = fieldOrderBox();
  box.userId = null;
  box.orders = null;
}

/**
 * Every saved drawer field order for this user, in ONE round trip.
 *
 * ⚠️ `fieldOrderFor` below used to issue its own query per (tab, subtab), and
 * the drawer calls it once per slot — 15 queries for the seeded config
 * (4 plain tabs + 7 Application subtabs + 4 Pricing subtabs), every one of
 * them a filtered read of the same small `user_field_order` table for the same
 * user. This fetches the whole slice once and slices it in memory.
 *
 * Rows come back ordered by `position`, so each slot's array is already in the
 * right order without a second sort per slot.
 */
async function allFieldOrdersFor(userId: string): Promise<Map<string, string[]>> {
  const box = fieldOrderBox();
  if (box.userId !== userId || !box.orders) {
    box.userId = userId;
    box.orders = fetchFieldOrders(userId);
  }
  return box.orders;
}

export async function fieldOrderFor(
  ctx: AuthContext,
  tabId: string,
  subtabId: string | null,
): Promise<string[] | undefined> {
  const orders = await allFieldOrdersFor(ctx.userId);
  // `undefined` (not an empty array) for "no saved order" — `resolveOrder`
  // and the `hasCustomFieldOrder` flag both distinguish the two.
  return orders.get(orderSlot(tabId, subtabId));
}

export async function setFieldOrder(
  ctx: AuthContext,
  tabId: string,
  subtabId: string | null,
  orderedFieldIds: string[],
): Promise<void> {
  const supabase = await createSupabaseServerClient();
  let del = supabase.from('user_field_order').delete().eq('user_id', ctx.userId).eq('tab_id', tabId);
  del = subtabId ? del.eq('subtab_id', subtabId) : del.is('subtab_id', null);
  const { error: delError } = await del;
  if (delError) throw delError;
  // Before the early return below, not after it: the delete alone already
  // changed what a read should see.
  invalidateFieldOrders();

  if (!orderedFieldIds.length) return;
  const { error } = await supabase.from('user_field_order').insert(
    orderedFieldIds.map((fieldId, i) => ({
      user_id: ctx.userId, tab_id: tabId, subtab_id: subtabId, field_id: fieldId, position: i,
    })),
  );
  if (error) throw error;
  invalidateFieldOrders();
}

export async function resetFieldOrder(ctx: AuthContext, tabId: string, subtabId: string | null): Promise<void> {
  const supabase = await createSupabaseServerClient();
  let del = supabase.from('user_field_order').delete().eq('user_id', ctx.userId).eq('tab_id', tabId);
  del = subtabId ? del.eq('subtab_id', subtabId) : del.is('subtab_id', null);
  const { error } = await del;
  if (error) throw error;
  invalidateFieldOrders();
}

/* -------------------------------------------------------------------------- */
/* Filters — durable per user per module. No admin default layer here: a     */
/* filter is entirely the user's own, so there is nothing to reset TO.       */
/* -------------------------------------------------------------------------- */

export async function filtersFor(ctx: AuthContext, moduleId: string): Promise<Record<string, ListFilter>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('user_filters')
    .select('filters')
    .eq('user_id', ctx.userId)
    .eq('module_id', moduleId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return {};
  const list = (data.filters as ListFilter[]) ?? [];
  return Object.fromEntries(list.map((f) => [f.fieldId, f]));
}

export async function setFilters(
  ctx: AuthContext,
  moduleId: string,
  filters: Record<string, ListFilter>,
): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from('user_filters').upsert(
    {
      user_id: ctx.userId,
      module_id: moduleId,
      filters: Object.values(filters),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,module_id' },
  );
  if (error) throw error;
}

export async function clearFilters(ctx: AuthContext, moduleId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from('user_filters')
    .delete()
    .eq('user_id', ctx.userId)
    .eq('module_id', moduleId);
  if (error) throw error;
}
