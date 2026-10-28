/**
 * Admin → Presets, sub-step 2: field CRUD.
 *
 * The client's stated blocker — until this exists he cannot add a single field
 * himself. Same shape as `adminPresets.ts` (assert admin, normalise the key,
 * append at the end of the placement, return a `Result` the form renders), so
 * read that file first if this is your entry point.
 *
 * ARCHIVE, NEVER DELETE. `fields` rows are never removed: `records.values` is
 * keyed by `fields.key`, so a deleted row orphans a value on every record with
 * no way back. `archived_at` retires a field while its stored values stay
 * intact and restorable, which is also why `key` can never be reused — an
 * archived field still holds it (see `createField`'s duplicate-key message).
 *
 * THREE THINGS ARE IMMUTABLE AFTER CREATION, and none of them are merely
 * greyed out in the form — they are absent from `updateFieldSchema` entirely,
 * so there is no request shape that can change them:
 *
 *   - `key`, because `records.values` is keyed by it. Renaming it makes every
 *     existing value unreachable, silently, with no migration path.
 *   - `type`, because it reinterprets every stored value. `text` → `percent_split`
 *     turns a string into something that renders as a broken split on 4,000
 *     records at once. Archive and recreate instead.
 *   - `grid_columns` / `repeat_schema`, because a grid row is a JSONB object
 *     keyed by the COLUMN LABEL (`GridControl`, `proto/ui/value.tsx:717`).
 *     Renaming a column orphans that column's cell in every existing row.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { type AuthContext, FROZEN_COLUMN_FIELD_KEY } from './permissions';
import { loadConfig, type FieldType } from './config';
import { assertAdmin, slugifyKey, UNIQUE_VIOLATION, CHECK_VIOLATION, type Result } from './adminConfig';
import type { ChangeFieldTypeInput, CreateFieldInput, FieldSetupInput, UpdateFieldInput } from './adminSchemas';
import { normaliseChoices } from './adminChoices';

export type GridColumn = { label: string; type: FieldType };
export type RepeatMember = { key: string; label: string; type: FieldType; sensitive?: boolean };

export type AdminFieldRow = {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  tabId: string;
  subtabId: string | null;
  position: number;
  hint: string | null;
  section: string | null;
  required: boolean;
  sensitive: boolean;
  wide: boolean;
  notesEnabled: boolean;
  isSystem: boolean;
  readOnly: boolean;
  repeatMax: number | null;
  repeatSchema: RepeatMember[] | null;
  repeatGroupKey: string | null;
  gridColumns: GridColumn[] | null;
  digits: number[] | null;
  autoSource: string | null;
  autoSourceField: string | null;
  /** In Vital Info (any module). */
  inVital: boolean;
  /** Modules whose record list shows it as a column. */
  columnModuleIds: string[];
  archivedAt: string | null;
};

/**
 * Every field, ARCHIVED ONES INCLUDED — which is why this cannot reuse
 * `loadConfig()`. That query filters `.is('archived_at', null)` (`config.ts:142`)
 * because every rendering surface wants live fields only; the admin screen is
 * the one place that must see retired fields, or they can never be restored.
 */
export async function listFieldsForAdmin(ctx: AuthContext): Promise<AdminFieldRow[]> {
  assertAdmin(ctx);
  const supabase = supabaseAdmin();
  const [{ data, error }, header, columns] = await Promise.all([
    supabase.from('fields').select('*').order('position'),
    supabase.from('module_header_fields').select('field_id'),
    supabase.from('module_columns').select('field_id, module_id'),
  ]);
  if (error) throw error;
  if (header.error) throw header.error;
  if (columns.error) throw columns.error;
  const inVital = new Set((header.data ?? []).map((h) => h.field_id as string));
  const columnsOf = new Map<string, string[]>();
  for (const c of columns.data ?? []) {
    const list = columnsOf.get(c.field_id as string);
    if (list) list.push(c.module_id as string);
    else columnsOf.set(c.field_id as string, [c.module_id as string]);
  }

  return (data ?? []).map((f) => ({
    id: f.id,
    key: f.key,
    label: f.label,
    type: f.type,
    tabId: f.tab_id,
    subtabId: f.subtab_id,
    position: f.position,
    hint: f.hint,
    section: f.section ?? null,
    required: f.required,
    sensitive: f.sensitive,
    wide: f.wide,
    notesEnabled: f.notes_enabled,
    isSystem: f.is_system,
    readOnly: f.read_only,
    repeatMax: f.repeat_max,
    repeatSchema: f.repeat_schema,
    repeatGroupKey: f.repeat_group_key,
    gridColumns: f.grid_columns,
    digits: f.digits ?? null,
    autoSource: f.auto_source ?? null,
    autoSourceField: f.auto_source_field ?? null,
    inVital: inVital.has(f.id),
    columnModuleIds: columnsOf.get(f.id) ?? [],
    archivedAt: f.archived_at,
  }));
}

/** A key not yet taken — "gateway_provider", then "gateway_provider_2"… —
 *  counting archived fields, which keep theirs. */
async function freeKey(base: string): Promise<string> {
  const supabase = supabaseAdmin();
  const { data, error } = await supabase.from('fields').select('key').ilike('key', `${base}%`);
  if (error) throw error;
  const taken = new Set((data ?? []).map((r) => String(r.key).toLowerCase()));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

/**
 * The New field form (UI/UX spec §6), saved in ONE transaction by
 * `create_field_with_setup` (migration 9805): the field, its options, its
 * place in the tab, Vital Info and list-column membership. A failure anywhere
 * leaves nothing behind.
 */
export async function createFieldWithSetup(ctx: AuthContext, input: FieldSetupInput): Promise<Result> {
  assertAdmin(ctx);
  const label = input.label.trim();
  const base = slugifyKey(input.key || label);
  if (!base || !label) return { ok: false, message: 'Give the field a label.' };

  const config = await loadConfig();
  const tab = config.tabs.find((t) => t.id === input.tabId);
  if (!tab) return { ok: false, message: 'That tab no longer exists.' };
  if (!tab.acceptsFields) return { ok: false, message: `The ${tab.label} tab does not hold fields.` };
  if (input.subtabId && !config.subtabs.some((s) => s.id === input.subtabId && s.tabId === input.tabId)) {
    return { ok: false, message: 'That sub-tab is not part of the chosen tab.' };
  }
  if (input.autoSource === 'mcc_lookup' && !config.fields.some((f) => f.key === input.autoSourceField)) {
    return { ok: false, message: 'The MCC code field no longer exists.' };
  }

  // Digits-only Text is stored as `identifier` (leading zeros kept, length rule).
  const type = input.type === 'text' && input.digitsOnly ? 'identifier' : input.type;
  const digits = type === 'identifier' && input.digits
    ? input.digits.split(',').map((d) => Number(d.trim())).filter((n) => n > 0)
    : null;
  const key = input.key ? slugifyKey(input.key) : await freeKey(base);
  const choices = normaliseChoices(input.choices.map((c) => ({ key: '', value: c.value, swatch: c.swatch })));

  const supabase = supabaseAdmin();
  const { data, error } = await supabase.rpc('create_field_with_setup', {
    p_field: {
      key, label, type,
      tab_id: input.tabId,
      subtab_id: input.subtabId ?? '',
      hint: input.hint,
      section: input.section,
      required: input.required,
      sensitive: input.sensitive,
      notes_enabled: input.notesEnabled,
      digits,
      auto_source: type === 'auto' ? input.autoSource : null,
      auto_source_field: type === 'auto' && input.autoSource === 'mcc_lookup' ? input.autoSourceField : null,
    },
    p_choices: choices,
    p_after: input.afterFieldId,
    p_vital: input.showInVital,
    p_column_modules: input.columnModuleIds,
  });
  if (error) return await writeFailure(error, key);
  return { ok: true, id: data as string };
}

/**
 * Type change (spec §6): free while no record holds a value; with values,
 * only between types that store the same shape, and only once confirmed.
 * `needsConfirm` carries how many records hold one.
 */
export async function changeFieldType(
  ctx: AuthContext,
  input: ChangeFieldTypeInput,
): Promise<Result | { ok: false; message: string; needsConfirm: number }> {
  assertAdmin(ctx);
  const supabase = supabaseAdmin();
  const { data, error } = await supabase.rpc('change_field_type', {
    p_field_id: input.fieldId,
    p_type: input.type,
    p_confirm: input.confirm,
  });
  if (error) return { ok: false, message: error.message };
  const held = Number(data ?? 0);
  if (held > 0) {
    return {
      ok: false,
      needsConfirm: held,
      message: `${held} record${held === 1 ? ' holds' : 's hold'} a value. They keep it, read as the new type. Change anyway?`,
    };
  }
  return { ok: true, id: input.fieldId };
}

/**
 * Where a new field lands: the end of its own (tab, subtab) placement.
 *
 * Counts archived fields deliberately. An archived field keeps its position
 * and reclaims it on restore, so skipping them here would hand a new field a
 * position a restore is about to collide with.
 */
async function nextPositionIn(tabId: string, subtabId: string | null): Promise<number> {
  const supabase = supabaseAdmin();
  const query = supabase
    .from('fields')
    .select('position')
    .eq('tab_id', tabId)
    .order('position', { ascending: false })
    .limit(1);

  const { data } = await (subtabId === null ? query.is('subtab_id', null) : query.eq('subtab_id', subtabId)).maybeSingle();
  return (data?.position ?? -1) + 1;
}

/** The three database-level rejections an admin can actually cause, turned
 * into something a dialog can show. `CHECK_VIOLATION` covers both the shape
 * constraints and the `fields_placement_guard` trigger, whose own messages are
 * already written for a human. */
async function writeFailure(error: { code?: string; message: string }, key: string): Promise<Result> {
  if (error.code === UNIQUE_VIOLATION) {
    // Which field holds the key decides what the admin should DO about it, and
    // the archived case is the one that looks like a bug from the outside: the
    // colliding field is invisible on every screen except the Archived toggle,
    // so "already exists" alone reads as the app being wrong.
    const supabase = supabaseAdmin();
    const { data: existing } = await supabase
      .from('fields')
      .select('label, archived_at')
      .eq('key', key)
      .maybeSingle();

    if (existing?.archived_at) {
      return {
        ok: false,
        message: `"${existing.label}" already uses the key "${key}" and is archived. Restore it from the Archived list, or pick a different key — an archived field keeps its key because every record's values are still stored under it.`,
      };
    }
    return { ok: false, message: `A field with key "${key}" already exists.` };
  }
  if (error.code === CHECK_VIOLATION) return { ok: false, message: `Rejected by the database: ${error.message}` };
  return { ok: false, message: error.message };
}

export async function createField(ctx: AuthContext, input: CreateFieldInput): Promise<Result> {
  assertAdmin(ctx);
  const supabase = supabaseAdmin();

  const key = slugifyKey(input.key);
  const label = input.label.trim();
  if (!key || !label) return { ok: false, message: 'Key and label are both required.' };

  const config = await loadConfig();
  const tab = config.tabs.find((t) => t.id === input.tabId);
  if (!tab) return { ok: false, message: 'That tab no longer exists.' };
  // The trigger enforces this too (and must, against direct SQL) — checking
  // here turns "Updates/Communication/Cases hold no fields" into a sentence
  // rather than a raised 23514 the admin has to interpret.
  if (!tab.acceptsFields) return { ok: false, message: `The ${tab.label} tab does not hold fields.` };

  const position = await nextPositionIn(input.tabId, input.subtabId);

  // Every shape column is all-or-nothing per type: the `grid_shape`,
  // `repeat_group_shape` and `repeat_group_key_shape` checks each require the
  // columns to be NULL — not empty, not '' — for every other type.
  const isGrid = input.type === 'grid';
  const isRepeatGroup = input.type === 'repeat_group';

  const { data: field, error } = await supabase
    .from('fields')
    .insert({
      key,
      label,
      type: input.type,
      tab_id: input.tabId,
      subtab_id: input.subtabId,
      position,
      hint: input.hint.trim() || null,
      section: input.section.trim() || null,
      required: input.required,
      sensitive: input.sensitive,
      wide: input.wide,
      notes_enabled: input.notesEnabled,
      // Not admin-settable, any of them. `is_system`/`read_only` are structural
      // claims about fields the build seeded (Record creator is the read-only
      // one); `sync_enabled` is Email/Phone only and needs a provider wired up;
      // `placeholder` means "the client has not specified this yet", which is
      // never true of a field he just asked for by name.
      is_system: false,
      read_only: false,
      sync_enabled: false,
      placeholder: false,
      grid_columns: isGrid ? input.gridColumns : null,
      repeat_max: isRepeatGroup ? input.repeatMax : null,
      repeat_schema: isRepeatGroup ? input.repeatSchema : null,
      // Migration 27's `repeat_group_key_shape` makes this NOT NULL for a
      // repeat_group — a null here fails the insert outright. Defaulting to the
      // field's own key matches how the seed treats a single-location group
      // ('contact', 'affiliate'); an explicit value is how the admin links two
      // separately-placed rows into ONE set of instances, the way 'owner'
      // spans Application → Private and Application → Ownership.
      repeat_group_key: isRepeatGroup ? slugifyKey(input.repeatGroupKey) || key : null,
    })
    .select('id')
    .single();

  if (error) return await writeFailure(error, key);
  return { ok: true, id: field.id };
}

/**
 * Edits the metadata that is safe to change: label, hint, placement, and the
 * four display flags. See this file's header for the three things that are
 * absent from the input type entirely and why.
 *
 * Moving a field to a different tab/subtab re-appends it at the end of the
 * destination. Keeping the old position would drop it into an arbitrary slot
 * in a list it has never been part of, and positions are only unique-ish
 * within a placement.
 */
export async function updateField(ctx: AuthContext, input: UpdateFieldInput): Promise<Result> {
  assertAdmin(ctx);
  const supabase = supabaseAdmin();

  const label = input.label.trim();
  if (!label) return { ok: false, message: 'Label is required.' };

  const { data: current, error: readErr } = await supabase
    .from('fields')
    .select('key, tab_id, subtab_id')
    .eq('id', input.fieldId)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!current) return { ok: false, message: 'That field no longer exists.' };

  const config = await loadConfig();
  const tab = config.tabs.find((t) => t.id === input.tabId);
  if (!tab) return { ok: false, message: 'That tab no longer exists.' };
  if (!tab.acceptsFields) return { ok: false, message: `The ${tab.label} tab does not hold fields.` };

  const moved = current.tab_id !== input.tabId || current.subtab_id !== input.subtabId;

  const { error } = await supabase
    .from('fields')
    .update({
      label,
      tab_id: input.tabId,
      subtab_id: input.subtabId,
      hint: input.hint.trim() || null,
      section: input.section.trim() || null,
      required: input.required,
      sensitive: input.sensitive,
      wide: input.wide,
      notes_enabled: input.notesEnabled,
      ...(moved ? { position: await nextPositionIn(input.tabId, input.subtabId) } : {}),
    })
    .eq('id', input.fieldId);

  if (error) return await writeFailure(error, current.key);

  // Where it sits (dragged on the preview) and where it shows (Vital Info,
  // list columns) — the same functions the New field form uses.
  if (input.placeIt) {
    const placed = await supabase.rpc('place_field', { p_field_id: input.fieldId, p_after: input.afterFieldId });
    if (placed.error) return { ok: false, message: placed.error.message };
  }
  const surfaces = await supabase.rpc('set_field_surfaces', {
    p_field_id: input.fieldId,
    p_vital: input.showInVital,
    p_column_modules: input.columnModuleIds,
  });
  if (surfaces.error) return { ok: false, message: surfaces.error.message };
  return { ok: true, id: input.fieldId };
}

/**
 * Retires a field. Its stored values stay on every record, its
 * `module_columns` / `module_header_fields` rows stay too — both of those are
 * what makes `restoreField` put it back exactly where it was, and neither
 * leaks: `columnsForModule` and `headerFieldsForModule` resolve id → field
 * against the archived-filtered set and drop the misses (`config.ts:232-246`).
 */
export async function archiveField(ctx: AuthContext, fieldId: string): Promise<Result> {
  assertAdmin(ctx);
  const supabase = supabaseAdmin();

  const { data: field, error: readErr } = await supabase
    .from('fields')
    .select('key, label, is_system')
    .eq('id', fieldId)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!field) return { ok: false, message: 'That field no longer exists.' };

  if (field.key === FROZEN_COLUMN_FIELD_KEY) {
    return { ok: false, message: `${field.label} is the frozen first column of every dashboard and cannot be archived.` };
  }
  if (field.is_system) {
    return { ok: false, message: `${field.label} is a system field — the build depends on it existing.` };
  }

  const { error } = await supabase.from('fields').update({ archived_at: new Date().toISOString() }).eq('id', fieldId);
  if (error) throw error;
  return { ok: true, id: fieldId };
}

export async function restoreField(ctx: AuthContext, fieldId: string): Promise<Result> {
  assertAdmin(ctx);
  const supabase = supabaseAdmin();

  const { error } = await supabase.from('fields').update({ archived_at: null }).eq('id', fieldId);
  if (error) throw error;
  return { ok: true, id: fieldId };
}
