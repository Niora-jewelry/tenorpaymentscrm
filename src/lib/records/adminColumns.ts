/**
 * Admin → Presets, sub-step 3: dashboard columns and header-strip membership.
 *
 * Properties (a), (b) and (e) of the client's own six-things-vary-per-module
 * table (`CLIENT-SPEC-BY-MODULE.md` §1) — which fields are a module's table
 * columns, in what order, and which appear in the drawer's top summary strip.
 * This is what makes the spec's scoping real ("Last merchant response — header
 * strip: Leads and Tickets only", "Risk Level — Yes, contacts/residuals only"):
 * rows in `module_header_fields`, never a condition in code.
 *
 * FULL REPLACE, IN ONE TRANSACTION. Both writers hand the whole ordered list
 * to a `SECURITY DEFINER` function (migration 35) rather than diffing rows.
 * The transaction is the point: a delete-then-insert that fails halfway leaves
 * a module with zero columns, and a config screen that can empty a dashboard
 * by failing partway through is worse than one that can't save at all.
 *
 * ── DEAL NAME IS NOT A COLUMN HERE, AND THAT IS THE SPEC BEING HONOURED ──
 * `CLIENT-SPEC-BY-MODULE.md` §1 makes Deal Name "always column 1, frozen,
 * cannot be de-selected". This build delivers that by drawing it OUTSIDE the
 * configurable set — a hardcoded first `<th>` fed from `records.deal_name`
 * (`proto/ui/DataTable.tsx:639`) and the drawer's title line
 * (`proto/ui/Drawer.tsx:123`) — so nothing can be ordered before it and there
 * is no checkbox to un-tick. It is absent from the seed's `module_columns`
 * and `module_header_fields` for exactly that reason.
 *
 * Adding a row for it therefore does NOT pin it to the front; it renders Deal
 * Name a second time, at the end, reading a `values` key nothing writes.
 * `remaining-plan.md` § Phase 2 asks for it to be forced to index 0 — that
 * instruction was written from the spec rather than from this renderer, and
 * following it would produce the duplicate it was meant to prevent. So the
 * rule is enforced as its inverse, in both halves CLAUDE.md asks for: stripped
 * from every request below, and rejected outright by a trigger on both tables
 * (migration 35) so direct SQL cannot introduce it either.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { type AuthContext, FROZEN_COLUMN_FIELD_KEY } from './permissions';
import { loadConfig, type FieldType } from './config';
import { assertAdmin, type Result } from './adminConfig';
import type { SetModuleFieldListInput } from './adminSchemas';

/**
 * Types that have no sensible one-cell rendering, and so are never offered.
 *
 * `repeat_group` stores a JSONB ARRAY OF OBJECTS — one entry per owner or
 * contact. `CellValue` has no branch for it (`proto/ui/value.tsx:194`), so it
 * falls through to `String(value)` and renders `[object Object]` in a table
 * cell and in the header strip. Every other type either has its own branch
 * there (a grid shows "3 rows", an address is formatted, a percent split is
 * summarised) or is genuinely a string.
 *
 * Same posture as Phase 1's `GRID_COLUMN_TYPES`: don't offer a choice whose
 * result is broken, and don't leave the admin to discover it on a dashboard.
 */
const NON_LIST_FIELD_TYPES: readonly FieldType[] = ['repeat_group'];

/** A field an admin may put in a module's column list or header strip. */
export type AssignableField = {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  /** Where it lives in the drawer — the only way to tell two "POS Provider"s
   * apart in a flat picker of 129 fields. */
  tabLabel: string;
  subtabLabel: string | null;
};

/** One module's two ordered selections, as field ids. */
export type ModuleFieldSelection = {
  moduleId: string;
  columnIds: string[];
  headerIds: string[];
  /** Field id → shown by default in the list (UI/UX spec §6). */
  columnDefaults: Record<string, boolean>;
};

/**
 * The picker's catalogue: every live field that can be listed, in drawer
 * order.
 *
 * Reads `loadConfig()` rather than querying `fields` directly — unlike Phase
 * 1's `listFieldsForAdmin`, this screen must NOT see archived fields. An
 * archived field is absent from every dashboard and drawer already
 * (`columnsForModule` drops it), so offering it here would let an admin
 * "select" a column that cannot appear.
 */
export async function listAssignableFields(ctx: AuthContext): Promise<AssignableField[]> {
  assertAdmin(ctx);
  const config = await loadConfig();

  const tabById = new Map(config.tabs.map((t) => [t.id, t]));
  const subtabById = new Map(config.subtabs.map((s) => [s.id, s]));

  return config.fields
    .filter((f) => f.key !== FROZEN_COLUMN_FIELD_KEY && !NON_LIST_FIELD_TYPES.includes(f.type))
    .map((f) => ({
      id: f.id,
      key: f.key,
      label: f.label,
      type: f.type,
      tabLabel: tabById.get(f.tabId)?.label ?? '(unknown tab)',
      subtabLabel: f.subtabId ? (subtabById.get(f.subtabId)?.label ?? null) : null,
    }))
    .sort((a, b) => a.tabLabel.localeCompare(b.tabLabel) || a.label.localeCompare(b.label));
}

/**
 * Every module's current selections in one read, so the section can switch
 * modules client-side with no server round trip. It is all one cached
 * `loadConfig()` call either way — asking per module would be strictly more
 * work for strictly less responsiveness.
 *
 * Archived fields are filtered out here too: their rows survive on purpose
 * (see `setModuleColumns`), but showing them as selected would mean the admin
 * saving that list right back, which is the one thing that WOULD delete them.
 */
export async function listModuleFieldSelections(ctx: AuthContext): Promise<ModuleFieldSelection[]> {
  assertAdmin(ctx);
  const config = await loadConfig();

  const live = new Set(config.fields.map((f) => f.id));
  const pick = (rows: { moduleId: string; fieldId: string; position: number }[], moduleId: string) =>
    rows
      .filter((r) => r.moduleId === moduleId && live.has(r.fieldId))
      .sort((a, b) => a.position - b.position)
      .map((r) => r.fieldId);

  return config.modules.map((m) => ({
    moduleId: m.id,
    columnIds: pick(config.moduleColumns, m.id),
    headerIds: pick(config.moduleHeaderFields, m.id),
    columnDefaults: Object.fromEntries(
      config.moduleColumns.filter((c) => c.moduleId === m.id).map((c) => [c.fieldId, c.defaultVisible]),
    ),
  }));
}

/** "Visible by default" for one module's column. Users can still show or
 *  hide it for themselves. */
export async function setColumnDefaultVisible(
  ctx: AuthContext,
  input: { moduleId: string; fieldId: string; visible: boolean },
): Promise<Result> {
  assertAdmin(ctx);
  const supabase = supabaseAdmin();
  const { error } = await supabase.rpc('set_module_column_default_visible', {
    p_module_id: input.moduleId,
    p_field_id: input.fieldId,
    p_visible: input.visible,
  });
  if (error) return { ok: false, message: error.message };
  return { ok: true, id: input.fieldId };
}

/**
 * Normalises what the form sent into what the database should hold.
 *
 * Two things happen here rather than in the Zod schema, because both are
 * normalisation rather than a shape the admin can correct: a repeated id
 * would violate the tables' `(module_id, field_id)` primary key, and the
 * frozen field is silently dropped instead of failing a save the admin has no
 * way to fix from the UI (it is never offered there in the first place — this
 * is the server-side half, for a request that didn't come from the form).
 */
async function normalise(fieldIds: string[]): Promise<string[]> {
  const config = await loadConfig();
  const frozenId = config.fields.find((f) => f.key === FROZEN_COLUMN_FIELD_KEY)?.id;

  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of fieldIds) {
    if (id === frozenId || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

async function replaceList(fn: 'set_module_columns' | 'set_module_header_fields', input: SetModuleFieldListInput): Promise<Result> {
  const supabase = supabaseAdmin();
  const { error } = await supabase.rpc(fn, {
    p_module_id: input.moduleId,
    p_field_ids: await normalise(input.fieldIds),
  });
  if (error) return { ok: false, message: error.message };
  return { ok: true, id: input.moduleId };
}

/**
 * Replaces a module's dashboard column list, in the given order.
 *
 * ARCHIVED FIELDS' ROWS ARE PRESERVED. Phase 1 made archiving a field leave
 * its `module_columns` row alone deliberately — that is what makes restoring
 * the field put it back exactly where it was. An archived field is absent
 * from this screen's picker, so a naive full replace would read "not
 * selected" and delete the row, quietly breaking restore. The function's
 * DELETE is scoped to live fields only (migration 35).
 *
 * An empty list is allowed. A module with no configured columns still renders
 * its frozen Deal Name column, so this is a recoverable state, not a broken
 * one — and refusing it would be a rule the client never asked for.
 */
export async function setModuleColumns(ctx: AuthContext, input: SetModuleFieldListInput): Promise<Result> {
  assertAdmin(ctx);
  return replaceList('set_module_columns', input);
}

/** Header-strip membership — same mechanics, same preservation rule. */
export async function setModuleHeaderFields(ctx: AuthContext, input: SetModuleFieldListInput): Promise<Result> {
  assertAdmin(ctx);
  return replaceList('set_module_header_fields', input);
}
