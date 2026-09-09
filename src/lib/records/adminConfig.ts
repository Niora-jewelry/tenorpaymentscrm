/**
 * Shared primitives for every Admin → Presets data module.
 *
 * Presets is being built as five independently-shipped sub-steps over the
 * same handful of tables (tabs/subtabs, fields, module columns, choices,
 * pipelines). Sub-step 1 (`adminPresets.ts`) established the shape every
 * later one copies: assert admin, normalise a key, append at the end of an
 * existing per-module order, return a `Result` the form can render. Those
 * live here so sub-steps 2-5 inherit them rather than re-implementing four
 * slightly-different versions — the `appendToModuleOrder` positioning rule in
 * particular is easy to get subtly wrong (see its own comment).
 *
 * What does NOT live here: cache invalidation. That is `adminConfigCache.ts`,
 * because it is a Next-cache concern that only the Server Action layer is
 * allowed to trigger, not something a data function should do as a side
 * effect of writing a row.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { AuthContext } from './permissions';

/** Every Presets data function's first line. `AuthContext` can only be built
 * by `authorize()`, so this is the admin half of the check, not the
 * authentication half. */
export function assertAdmin(ctx: AuthContext): void {
  if (!ctx.isAdmin) throw new Error('Admin only');
}

/** A human-typed key ("Merchant Equipment") to a storable one
 * ("merchant_equipment"). Normalisation, not validation — the Zod schema at
 * the action boundary has already rejected an empty or over-long value, and
 * the database's own unique constraint is what actually enforces uniqueness. */
export function slugifyKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** What a Presets mutation hands back to a form: an id to select, or a
 * message to render. Deliberately not a thrown error for the expected
 * failures (duplicate key, bad placement) — those are user-correctable and
 * belong in the form, not in an error boundary. */
export type Result = { ok: true; id: string } | { ok: false; message: string };

/** Postgres unique-violation. Every config table has at least one unique
 * constraint an admin can hit by typing a key that already exists. */
export const UNIQUE_VIOLATION = '23505';

/** Postgres check-constraint violation, raised by `fields_placement_guard`
 * among others — see migration 4. */
export const CHECK_VIOLATION = '23514';

/**
 * Assigns a tab/subtab/field to each of `moduleIds`, at the END of that
 * module's own existing order.
 *
 * The rule that matters: never insert before an admin-configured position,
 * and never disturb a module that isn't in the list. Each module gets its own
 * `max(position) + 1` — a single shared counter would collide, because these
 * tables are ordered per module, not globally.
 */
export async function appendToModuleOrder(
  table: 'module_tab_order' | 'module_subtab_order',
  idColumn: 'tab_id' | 'subtab_id',
  targetId: string,
  moduleIds: string[],
): Promise<void> {
  if (!moduleIds.length) return;
  const supabase = supabaseAdmin();
  const { data: existing, error: existingErr } = await supabase
    .from(table)
    .select('module_id, position')
    .in('module_id', moduleIds);
  if (existingErr) throw existingErr;

  const maxByModule = new Map<string, number>();
  for (const r of existing ?? []) {
    const cur = maxByModule.get(r.module_id) ?? -1;
    if (r.position > cur) maxByModule.set(r.module_id, r.position);
  }

  const rows = moduleIds.map((moduleId) => ({
    module_id: moduleId,
    [idColumn]: targetId,
    position: (maxByModule.get(moduleId) ?? -1) + 1,
  }));
  const { error } = await supabase.from(table).insert(rows);
  if (error) throw error;
}
