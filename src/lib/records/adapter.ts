/**
 * Adapts real DB config/records into the exact shapes the prototype's
 * polished UI components (`src/proto/ui/*`) already expect.
 *
 * This is the concrete mechanism for "evolve `src/proto/ui/*`, don't restart
 * it" (Stage 4's own framing): the prototype's `Field`/`RecordRow` types in
 * `src/proto/schema.ts` are treated as a stable UI CONTRACT. `DataTable`,
 * `CellValue`, `FieldRenderer` and friends were built against that contract
 * for a backend-less demo; this file produces objects satisfying the same
 * contract from real Supabase data, so those components can be reused
 * verbatim rather than rewritten.
 *
 * One deliberate identity choice: the adapted `Field.id` is the DB field's
 * `key` (citext), not its `uuid` id. The prototype's whole rendering stack —
 * `r.values[field.id]`, `CellValue`, `FieldRenderer` — assumes `Field.id` IS
 * the storage key on `RecordRow.values`, and real records really do store
 * their JSONB under `key`, not under the row's uuid. Matching that identity
 * is what makes the reuse verbatim rather than "verbatim except one field."
 */
import 'server-only';
import type { Config, Field as DbField } from './config';
import { choicesFor as dbChoicesFor } from './config';
import type { Field as ProtoField, Choice, Swatch, RecordRow as ProtoRecordRow } from '@/proto/schema';
import type { RecordRow as DbRecordRow } from './records';

function tabPlacement(config: Config, f: DbField): string {
  const tab = config.tabs.find((t) => t.id === f.tabId);
  const tabKey = tab?.key ?? f.tabId;
  if (!f.subtabId) return tabKey;
  const subtab = config.subtabs.find((s) => s.id === f.subtabId);
  return subtab ? `${tabKey}/${subtab.key}` : tabKey;
}

/**
 * Adapts one field for the DASHBOARD surface: `DataTable`'s column header and
 * `CellValue`'s per-type rendering. Carries choices (global + per-module, in
 * the exact shape `choicesFor()` in `src/proto/fields.ts` already reads) so
 * status/dropdown columns render identically to the prototype without that
 * function needing to change at all.
 */
export function adaptFieldForDashboard(config: Config, f: DbField): ProtoField {
  const allChoices = config.choices.filter((c) => c.fieldId === f.id);
  // `key` is not decoration here — it is the value `records.values` actually
  // holds. Dropping it (as this did until Phase 3) leaves the label as the
  // option's only identity, which makes every choice-backed cell render its
  // raw stored key with no swatch AND makes picking an option write the label
  // back into a key-shaped column. `Choice`'s own comment has the full account.
  const toChoice = (c: (typeof allChoices)[number]): Choice => ({
    key: c.key,
    value: c.value,
    swatch: (c.swatch as Swatch | null) ?? undefined,
  });

  const global: Choice[] = allChoices
    .filter((c) => c.moduleId === null)
    .sort((a, b) => a.position - b.position)
    .map(toChoice);

  const byModule: Partial<Record<string, Choice[]>> = {};
  for (const c of [...allChoices].sort((a, b) => a.position - b.position)) {
    if (!c.moduleId) continue;
    const mod = config.modules.find((m) => m.id === c.moduleId);
    if (!mod) continue;
    (byModule[mod.slug] ??= []).push(toChoice(c));
  }

  const columnRow = config.moduleColumns.find((mc) => mc.fieldId === f.id);
  const columnModuleSlugs = config.moduleColumns
    .filter((mc) => mc.fieldId === f.id)
    .map((mc) => config.modules.find((m) => m.id === mc.moduleId)?.slug)
    .filter((s): s is string => Boolean(s));
  const headerModuleSlugs = config.moduleHeaderFields
    .filter((mh) => mh.fieldId === f.id)
    .map((mh) => config.modules.find((m) => m.id === mh.moduleId)?.slug)
    .filter((s): s is string => Boolean(s));

  return {
    id: f.key,
    label: f.label,
    type: f.type as ProtoField['type'],
    choices: global.length ? global : undefined,
    choicesByModule: Object.keys(byModule).length ? (byModule as ProtoField['choicesByModule']) : undefined,
    tab: tabPlacement(config, f),
    columnIn: columnModuleSlugs as ProtoField['columnIn'],
    columnOrder: columnRow?.position,
    headerIn: headerModuleSlugs.length ? (headerModuleSlugs as ProtoField['headerIn']) : undefined,
    notes: f.notesEnabled,
    sync: f.syncEnabled,
    system: f.isSystem,
    readOnly: f.readOnly,
    required: f.required,
    sensitive: f.sensitive,
    width: f.width ?? undefined,
    wide: f.wide,
    digits: f.digits ?? undefined,
    hint: f.hint ?? undefined,
    placeholder: f.placeholder,
  };
}

/** `values` re-keyed from field UUID... no adaptation needed — real records
 * already store `values` keyed by the field's `key`, same as the prototype
 * stores `values` keyed by `Field.id` (which IS the key here). `memberships`
 * is not on the DB row (it is a separate join table) — pass it in once
 * fetched, so this stays a pure, cheap mapping. */
export function adaptRecordRow(row: DbRecordRow, memberships: string[]): ProtoRecordRow {
  return {
    id: row.id,
    dealName: row.dealName,
    // Real JSONB is genuinely open-ended; the prototype's FieldValue union
    // describes what a well-formed value looks like once a field's own
    // renderer interprets it, not a runtime guarantee this boundary can
    // check. Same trust boundary as every other read from Postgres here.
    values: row.values as ProtoRecordRow['values'],
    memberships: memberships as ProtoRecordRow['memberships'],
    creator:
      row.creatorKind === 'campaign'
        ? { kind: 'campaign', id: row.creatorCampaignId! }
        : { kind: 'user', id: row.creatorUserId! },
    pipeline: {},
    createdAt: row.createdAt,
    // Carried so a dashboard cell can write with a compare-and-swap. Dropping
    // it was harmless while the table was read-only; an editable table without
    // it would overwrite whatever someone else had just saved.
    updatedAt: row.updatedAt,
  };
}

/**
 * Adapts one field for the DRAWER surface: everything `adaptFieldForDashboard`
 * does, plus typed grid columns (`grid_columns` is already `[{label,type}]`
 * in the database — the exact shape `Field.columns` expects, no conversion
 * needed) so `GridControl`/`FieldRenderer` render a real "One Time Charges"
 * grid exactly as the prototype does.
 *
 * Deliberately NOT wired for `repeat_group` fields: the real database stores
 * a repeatable set as one JSONB array (SCHEMA-DECISIONS §1), while the
 * prototype's `RepeatGroup` component expects flat numbered keys
 * (`owner_1_first`…`owner_3_first`) — a different storage shape, not just a
 * different rendering. Reusing the prototype's repeat-group UI here would be
 * silently wrong, not just incomplete, so the drawer renders a plain
 * placeholder for these fields instead of pretending to support them.
 */
export function adaptFieldForDrawer(config: Config, f: DbField): ProtoField {
  const base = adaptFieldForDashboard(config, f);
  return {
    ...base,
    columns: (f.gridColumns as ProtoField['columns']) ?? undefined,
    section: f.section ?? undefined,
  };
}

export { dbChoicesFor };
