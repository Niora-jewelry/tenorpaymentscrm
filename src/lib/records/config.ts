/**
 * The config loader — modules, tabs, subtabs, fields, and every per-module
 * property (columns, header fields, choices, pipelines) in one shot.
 *
 * Everything here is `select`-able by any signed-in user (RLS: config tables
 * are readable-by-authenticated, writable-by-admin — migration 9) and, more
 * importantly for caching, is NOT filtered per user at all — every
 * authenticated caller gets back the exact same rows (permission FILTERING
 * happens separately, in `fieldGrants()`/`effective_grant()`, never inside
 * these queries). That's what makes this safe to cache ACROSS requests and
 * users via `unstable_cache` (unlike `listRecords`/`getRecord`, which are
 * genuinely per-user via RLS and must never be cached this way — caching
 * THOSE by accident is exactly the kind of cross-user data leak this
 * comment exists to warn the next person away from). Every caller of
 * `loadConfig()` already went through `authorize()` first regardless, so
 * `supabaseAdmin()` here isn't widening access — the request-scoped client
 * can't be used inside `unstable_cache` at all (Next disallows reading
 * request-scoped `cookies()` inside a cached function), and RLS wouldn't
 * have filtered these rows differently anyway.
 *
 * React `cache()` still wraps the outside for free per-request dedup on top
 * of the cross-request cache; a dashboard page, its drawer, and every field
 * cell asking "what does this field look like" still shares one lookup.
 */
import 'server-only';
import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase/admin';

export type FieldType =
  | 'text' | 'long_text' | 'number' | 'currency' | 'date' | 'datetime'
  | 'dropdown' | 'status' | 'multi_select' | 'team_member' | 'email' | 'phone'
  | 'url' | 'checkbox' | 'file' | 'percentage' | 'address' | 'percent_split'
  | 'months' | 'grid' | 'identifier' | 'repeat_group';

export type Module = {
  id: string;
  slug: string;
  label: string;
  kind: 'storage' | 'display';
  position: number;
  adminOnly: boolean;
  frozen: boolean;
  /**
   * A record is a member of this module exactly while it has an open case
   * (migration 9764). Membership is written by the cases trigger and nothing
   * else: the drawer shows the chip as an indicator, the module offers no
   * "New record", and the bulk restore picker leaves it out.
   */
  showsOpenCases: boolean;
};

export type Tab = {
  id: string;
  key: string;
  label: string;
  kind: string;
  isSystem: boolean;
  acceptsFields: boolean;
  position: number;
};

export type Subtab = {
  id: string;
  tabId: string;
  key: string;
  label: string;
  description: string | null;
  position: number;
  comingSoon: boolean;
};

export type Field = {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  tabId: string;
  subtabId: string | null;
  position: number;
  hint: string | null;
  notesEnabled: boolean;
  syncEnabled: boolean;
  isSystem: boolean;
  readOnly: boolean;
  required: boolean;
  sensitive: boolean;
  wide: boolean;
  placeholder: boolean;
  width: number | null;
  digits: number[] | null;
  repeatMax: number | null;
  repeatSchema: { key: string; label: string; type: FieldType; sensitive?: boolean }[] | null;
  /** The semantic group key ('owner'), distinct from `key` when a group spans
   * more than one tab/subtab location ('owner_private', 'owner_ownership') —
   * migration 27. Every `repeat_group` row that shares this value represents
   * the SAME set of repeatable instances, just split across locations, and
   * must stay the same length as its siblings. */
  repeatGroupKey: string | null;
  gridColumns: { label: string; type: FieldType }[] | null;
  /** Fields sharing a section label are drawn in their own card under the sub-tab's main grid. */
  section: string | null;
  archivedAt: string | null;
};

export type Choice = { fieldId: string; moduleId: string | null; key: string; value: string; swatch: string | null; position: number };
export type Pipeline = {
  id: string;
  moduleId: string;
  label: string;
  position: number;
  /** The synced Status field this pipeline owns — Admin §3.6, migration 57.
   * Its options ARE the pipeline's steps and its stored value IS the step id,
   * which is what lets the standard column filter do "filter by step" with no
   * special case. NULL only for a pipeline created before that migration and
   * never touched since, which the backfill left none of. */
  statusFieldId: string | null;
};
export type PipelineStep = { id: string; pipelineId: string; label: string; swatch: string; position: number };

export type Config = {
  modules: Module[];
  tabs: Tab[];
  subtabs: Subtab[];
  fields: Field[];
  moduleTabOrder: { moduleId: string; tabId: string; position: number }[];
  moduleSubtabOrder: { moduleId: string; subtabId: string; position: number }[];
  moduleColumns: { moduleId: string; fieldId: string; position: number }[];
  moduleHeaderFields: { moduleId: string; fieldId: string; position: number }[];
  choices: Choice[];
  pipelines: Pipeline[];
  pipelineSteps: PipelineStep[];
};

/**
 * The cache tag every config write must invalidate. Exported (rather than
 * repeated as a bare string) so the tag and its one invalidator —
 * `revalidateConfig()` in `adminConfigCache.ts` — can never drift apart: a
 * typo'd tag string would make a write succeed, leave the database correct,
 * and never show up anywhere in the app. That is the single highest-risk
 * silent failure in the whole Presets area.
 */
export const CONFIG_CACHE_TAG = 'config';

/** One query round trip per table, cached across requests (see the file
 * header for why that's safe here specifically) via `unstable_cache`, and
 * deduped again per request by the outer React `cache()`. Invalidated by
 * `revalidateConfig()`, which every admin config write calls — the Presets
 * screen (tabs/subtabs today, fields/columns/choices/pipelines as later
 * sub-steps land) is the only thing in the app that changes this data. */
const loadConfigCached = unstable_cache(
  async (): Promise<Config> => {
    const supabase = supabaseAdmin();

    const [
      modules, tabs, subtabs, fields, moduleTabOrder, moduleSubtabOrder,
      moduleColumns, moduleHeaderFields, choices, pipelines, pipelineSteps,
    ] = await Promise.all([
      supabase.from('modules').select('*').order('position'),
      supabase.from('tabs').select('*').order('position'),
      supabase.from('subtabs').select('*').order('position'),
      supabase.from('fields').select('*').is('archived_at', null).order('position'),
      supabase.from('module_tab_order').select('*').order('position'),
      supabase.from('module_subtab_order').select('*').order('position'),
      supabase.from('module_columns').select('*').order('position'),
      supabase.from('module_header_fields').select('*').order('position'),
      supabase.from('field_choices').select('*').order('position'),
      supabase.from('pipelines').select('*').order('position'),
      supabase.from('pipeline_steps').select('*').order('position'),
    ]);

    for (const r of [
      modules, tabs, subtabs, fields, moduleTabOrder, moduleSubtabOrder,
      moduleColumns, moduleHeaderFields, choices, pipelines, pipelineSteps,
    ]) {
      if (r.error) throw r.error;
    }

    return {
      modules: modules.data!.map((m) => ({
        id: m.id, slug: m.slug, label: m.label, kind: m.kind,
        position: m.position, adminOnly: m.admin_only, frozen: m.frozen,
        showsOpenCases: m.shows_open_cases,
      })),
      tabs: tabs.data!.map((t) => ({
        id: t.id, key: t.key, label: t.label, kind: t.kind,
        isSystem: t.is_system, acceptsFields: t.accepts_fields, position: t.position,
      })),
      subtabs: subtabs.data!.map((s) => ({
        id: s.id, tabId: s.tab_id, key: s.key, label: s.label,
        description: s.description, position: s.position, comingSoon: s.coming_soon,
      })),
      fields: fields.data!.map((f) => ({
        id: f.id, key: f.key, label: f.label, type: f.type,
        tabId: f.tab_id, subtabId: f.subtab_id, position: f.position, hint: f.hint,
        notesEnabled: f.notes_enabled, syncEnabled: f.sync_enabled, isSystem: f.is_system,
        readOnly: f.read_only, required: f.required, sensitive: f.sensitive,
        wide: f.wide, placeholder: f.placeholder, width: f.width, digits: f.digits,
        repeatMax: f.repeat_max, repeatSchema: f.repeat_schema, repeatGroupKey: f.repeat_group_key,
        gridColumns: f.grid_columns,
        section: f.section ?? null,
        archivedAt: f.archived_at,
      })),
      moduleTabOrder: moduleTabOrder.data!.map((r) => ({ moduleId: r.module_id, tabId: r.tab_id, position: r.position })),
      moduleSubtabOrder: moduleSubtabOrder.data!.map((r) => ({ moduleId: r.module_id, subtabId: r.subtab_id, position: r.position })),
      moduleColumns: moduleColumns.data!.map((r) => ({ moduleId: r.module_id, fieldId: r.field_id, position: r.position })),
      moduleHeaderFields: moduleHeaderFields.data!.map((r) => ({ moduleId: r.module_id, fieldId: r.field_id, position: r.position })),
      choices: choices.data!.map((c) => ({
        fieldId: c.field_id, moduleId: c.module_id, key: c.key, value: c.value,
        swatch: c.swatch, position: c.position,
      })),
      pipelines: pipelines.data!.map((p) => ({
        id: p.id, moduleId: p.module_id, label: p.label, position: p.position,
        statusFieldId: p.status_field_id,
      })),
      pipelineSteps: pipelineSteps.data!.map((s) => ({
        id: s.id, pipelineId: s.pipeline_id, label: s.label, swatch: s.swatch, position: s.position,
      })),
    };
  },
  ['records-config'],
  { tags: [CONFIG_CACHE_TAG] },
);

export const loadConfig = cache(loadConfigCached);

/* -------------------------------------------------------------------------- */
/* Derived lookups — the shapes the rest of lib/records/* actually wants      */
/* -------------------------------------------------------------------------- */

export function moduleBySlug(config: Config, slug: string): Module | undefined {
  return config.modules.find((m) => m.slug === slug);
}

export function fieldByKey(config: Config, key: string): Field | undefined {
  return config.fields.find((f) => f.key === key);
}

/** Every `repeat_group` field row sharing one semantic group — 'owner' is two
 * rows (`owner_private`, `owner_ownership`, migration 27); every other group
 * is one. Adding/removing an instance must apply to every row this returns,
 * so the arrays stay the same length across locations. */
export function fieldsInRepeatGroup(config: Config, repeatGroupKey: string): Field[] {
  return config.fields
    .filter((f) => f.type === 'repeat_group' && f.repeatGroupKey === repeatGroupKey && f.archivedAt === null)
    .sort((a, b) => a.position - b.position);
}

/** Fields in a tab, or one subtab of it, in the admin-configured global order. */
export function fieldsInTab(config: Config, tabId: string, subtabId?: string | null): Field[] {
  return config.fields
    .filter((f) => f.tabId === tabId && (subtabId === undefined ? true : f.subtabId === (subtabId ?? null)))
    .sort((a, b) => a.position - b.position);
}

/** Dashboard columns for a module, admin order, admin selection only (layer 1). */
export function columnsForModule(config: Config, moduleId: string): Field[] {
  const rows = config.moduleColumns
    .filter((c) => c.moduleId === moduleId)
    .sort((a, b) => a.position - b.position);
  const byId = new Map(config.fields.map((f) => [f.id, f]));
  return rows.map((r) => byId.get(r.fieldId)).filter((f): f is Field => Boolean(f));
}

export function headerFieldsForModule(config: Config, moduleId: string): Field[] {
  const rows = config.moduleHeaderFields
    .filter((h) => h.moduleId === moduleId)
    .sort((a, b) => a.position - b.position);
  const byId = new Map(config.fields.map((f) => [f.id, f]));
  return rows.map((r) => byId.get(r.fieldId)).filter((f): f is Field => Boolean(f));
}

/** A field's choices for a module: the module-specific override if one
 * exists, else the global (module_id IS NULL) set — SCHEMA.md's
 * `module_id IS NULL means "applies everywhere"`. */
export function choicesFor(config: Config, fieldId: string, moduleId: string): Choice[] {
  const scoped = config.choices.filter((c) => c.fieldId === fieldId && c.moduleId === moduleId);
  if (scoped.length) return scoped.sort((a, b) => a.position - b.position);
  return config.choices
    .filter((c) => c.fieldId === fieldId && c.moduleId === null)
    .sort((a, b) => a.position - b.position);
}

export function tabsForModule(config: Config, moduleId: string): Tab[] {
  const rows = config.moduleTabOrder
    .filter((r) => r.moduleId === moduleId)
    .sort((a, b) => a.position - b.position);
  const byId = new Map(config.tabs.map((t) => [t.id, t]));
  return rows.map((r) => byId.get(r.tabId)).filter((t): t is Tab => Boolean(t));
}

export function subtabsForModule(config: Config, moduleId: string, tabId: string): Subtab[] {
  const byId = new Map(config.subtabs.map((s) => [s.id, s]));
  // `module_subtab_order` rows are keyed by (moduleId, subtabId) only — a
  // module has many tabs, each with its own subtabs, so filtering by
  // moduleId alone (as this used to) returns every subtab across every tab
  // in the module, not just this one. The subtab's own `tabId` is what
  // actually scopes it correctly.
  const rows = config.moduleSubtabOrder
    .filter((r) => r.moduleId === moduleId && byId.get(r.subtabId)?.tabId === tabId)
    .sort((a, b) => a.position - b.position);
  const ordered = rows.map((r) => byId.get(r.subtabId)).filter((s): s is Subtab => Boolean(s));
  return ordered.length ? ordered : config.subtabs.filter((s) => s.tabId === tabId).sort((a, b) => a.position - b.position);
}

export function pipelinesForModule(config: Config, moduleId: string): Pipeline[] {
  return config.pipelines.filter((p) => p.moduleId === moduleId).sort((a, b) => a.position - b.position);
}

export function stepsForPipeline(config: Config, pipelineId: string): PipelineStep[] {
  return config.pipelineSteps.filter((s) => s.pipelineId === pipelineId).sort((a, b) => a.position - b.position);
}

/**
 * Which fields are pipeline-synced Status fields, and which pipeline each one
 * belongs to — `fieldId -> pipelineId`.
 *
 * Admin §3.6: "That Status field is visible only on records assigned to that
 * pipeline." A generated Status field lives on a tab like any other field, so
 * without this it would render on every record in the module including the ones
 * with no pipeline at all, showing an empty Status whose options describe a
 * process that record is not in.
 */
export function pipelineStatusFields(config: Config): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of config.pipelines) {
    if (p.statusFieldId) out.set(p.statusFieldId, p.id);
  }
  return out;
}
