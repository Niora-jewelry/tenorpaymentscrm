/**
 * Admin → Presets, sub-step 1: tabs/subtabs CRUD.
 *
 * Additive-only, deliberately — no delete/archive of a tab or subtab in this
 * pass. A tab/subtab already in use by real fields is the highest-risk
 * removal case (exactly the class of bug this build has hit before —
 * `subtabsForModule`'s cross-tab leak, `user_field_order`'s NOT-NULL PK —
 * both from a config change that wasn't checked against the real rendered
 * tree). Create-and-assign is the safe 80% of this feature; removal is a
 * deliberate follow-up once this is shipped and proven.
 *
 * New tabs are always `kind = 'custom'` — the other `tab_kind` values
 * (cases/files/logins/statements/communication/updates/freeform) each have a
 * dedicated panel component in `DrawerTabs.tsx` that a freshly-created tab
 * has no way to be wired to; `custom` (a plain field grid) is the only kind
 * that means something for an admin-created tab with no code changes.
 *
 * `assertAdmin`/`slugifyKey`/`appendToModuleOrder`/`Result` now live in
 * `adminConfig.ts` — sub-steps 2-5 (fields, columns, choices, pipelines) all
 * need the same four, and one shared copy beats four that drift.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { AuthContext } from './permissions';
import { loadConfig } from './config';
import { assertAdmin, slugifyKey, appendToModuleOrder, UNIQUE_VIOLATION, type Result } from './adminConfig';
import type { CreateTabInput, CreateSubtabInput } from './adminSchemas';

/** `frozen` is the client's "do not work on it yet, someone else is designing
 * it" flag (Residuals). It gates nothing here — column and header-strip
 * assignment is not field design — but the admin screens surface it so nobody
 * reconfigures that module without knowing. */
export type ModuleOption = { id: string; slug: string; label: string; frozen: boolean };

export type AdminTabRow = {
  id: string;
  key: string;
  label: string;
  kind: string;
  isSystem: boolean;
  /** Updates/Communication/Cases are false — `fields_placement_guard` rejects
   * a field pointed at one, so the field form must not offer them. */
  acceptsFields: boolean;
  moduleIds: string[];
};

export type AdminSubtabRow = {
  id: string;
  tabId: string;
  key: string;
  label: string;
  description: string | null;
  moduleIds: string[];
};

export async function listModulesForAdmin(ctx: AuthContext): Promise<ModuleOption[]> {
  assertAdmin(ctx);
  const config = await loadConfig();
  return config.modules.map((m) => ({ id: m.id, slug: m.slug, label: m.label, frozen: m.frozen }));
}

export async function listTabsForAdmin(ctx: AuthContext): Promise<AdminTabRow[]> {
  assertAdmin(ctx);
  const config = await loadConfig();
  const modulesByTab = new Map<string, string[]>();
  for (const r of config.moduleTabOrder) {
    const list = modulesByTab.get(r.tabId);
    if (list) list.push(r.moduleId);
    else modulesByTab.set(r.tabId, [r.moduleId]);
  }
  return config.tabs
    .map((t) => ({
      id: t.id,
      key: t.key,
      label: t.label,
      kind: t.kind,
      isSystem: t.isSystem,
      acceptsFields: t.acceptsFields,
      moduleIds: modulesByTab.get(t.id) ?? [],
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Each module's tab order, as an ordered list of tab ids.
 *
 * `listTabsForAdmin` above is keyed the other way — tab → which modules — which
 * is right for the "Modules" column but says nothing about ORDER. Tab order is
 * one of the six things the client's §1 says varies per module, and it was the
 * one an admin could not see, let alone change.
 *
 * `config.moduleTabOrder` is already sorted by position by `loadConfig`, so
 * this only has to group it.
 */
export async function listModuleTabOrder(ctx: AuthContext): Promise<Record<string, string[]>> {
  assertAdmin(ctx);
  const config = await loadConfig();
  const out: Record<string, string[]> = {};
  for (const r of config.moduleTabOrder) (out[r.moduleId] ??= []).push(r.tabId);
  return out;
}

/**
 * Per-module SUBTAB order — the fourth of the client's six per-module settings,
 * and the sibling of `listModuleTabOrder` above.
 *
 * Keyed `moduleId:tabId`, not `moduleId`. `module_subtab_order` rows carry only
 * (moduleId, subtabId), and a module has many tabs each with their own subtabs —
 * so grouping by module alone returns every subtab across every tab in that
 * module as one list, which is the exact bug `subtabsForModule` in `config.ts`
 * carries a comment about having had. The subtab's own `tabId` is what scopes
 * it, and the composite key is that scoping made explicit.
 *
 * `config.moduleSubtabOrder` is already sorted by position, so the arrays come
 * out in order.
 */
export async function listModuleSubtabOrder(ctx: AuthContext): Promise<Record<string, string[]>> {
  assertAdmin(ctx);
  const config = await loadConfig();
  const tabBySubtab = new Map(config.subtabs.map((s) => [s.id, s.tabId]));
  const out: Record<string, string[]> = {};
  for (const r of config.moduleSubtabOrder) {
    const tabId = tabBySubtab.get(r.subtabId);
    if (!tabId) continue;   // a subtab deleted out from under an order row
    (out[`${r.moduleId}:${tabId}`] ??= []).push(r.subtabId);
  }
  return out;
}

export async function listSubtabsForAdmin(ctx: AuthContext): Promise<AdminSubtabRow[]> {
  assertAdmin(ctx);
  const config = await loadConfig();
  const modulesBySubtab = new Map<string, string[]>();
  for (const r of config.moduleSubtabOrder) {
    const list = modulesBySubtab.get(r.subtabId);
    if (list) list.push(r.moduleId);
    else modulesBySubtab.set(r.subtabId, [r.moduleId]);
  }
  return config.subtabs
    .map((s) => ({ id: s.id, tabId: s.tabId, key: s.key, label: s.label, description: s.description, moduleIds: modulesBySubtab.get(s.id) ?? [] }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export async function createTab(ctx: AuthContext, input: CreateTabInput): Promise<Result> {
  assertAdmin(ctx);
  const supabase = supabaseAdmin();
  const key = slugifyKey(input.key);
  const label = input.label.trim();
  if (!key || !label) return { ok: false, message: 'Key and label are both required.' };

  const { data: maxRow } = await supabase.from('tabs').select('position').order('position', { ascending: false }).limit(1).maybeSingle();
  const position = (maxRow?.position ?? -1) + 1;

  const { data: tab, error } = await supabase
    .from('tabs')
    .insert({ key, label, kind: 'custom', is_system: false, accepts_fields: true, position })
    .select('id')
    .single();
  if (error) {
    if (error.code === UNIQUE_VIOLATION) return { ok: false, message: `A tab with key "${key}" already exists.` };
    return { ok: false, message: error.message };
  }

  await appendToModuleOrder('module_tab_order', 'tab_id', tab.id, input.moduleIds);
  return { ok: true, id: tab.id };
}

export async function createSubtab(ctx: AuthContext, input: CreateSubtabInput): Promise<Result> {
  assertAdmin(ctx);
  const supabase = supabaseAdmin();
  const key = slugifyKey(input.key);
  const label = input.label.trim();
  if (!key || !label) return { ok: false, message: 'Key and label are both required.' };

  const { data: maxRow } = await supabase
    .from('subtabs')
    .select('position')
    .eq('tab_id', input.tabId)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle();
  const position = (maxRow?.position ?? -1) + 1;

  const { data: subtab, error } = await supabase
    .from('subtabs')
    .insert({ tab_id: input.tabId, key, label, description: input.description.trim() || null, position, coming_soon: false })
    .select('id')
    .single();
  if (error) {
    if (error.code === UNIQUE_VIOLATION) return { ok: false, message: `This tab already has a subtab with key "${key}".` };
    return { ok: false, message: error.message };
  }

  await appendToModuleOrder('module_subtab_order', 'subtab_id', subtab.id, input.moduleIds);
  return { ok: true, id: subtab.id };
}

/** Adds (never removes) a tab to one more module's own tab order — the
 * "assign an existing tab to another module" half of this feature, separate
 * from creating a brand new tab. */
/**
 * Rename a tab, and rename or re-describe a subtab.
 *
 * ── WHY THIS WAS MISSING, AND WHY IT MATTERS ─────────────────────────────
 * This module was additive-only: create and assign, nothing else. That was a
 * deliberate scope line while the tables every module depends on were new, but
 * it left a real hole — a typo in a tab label was permanent, and the label is
 * what every user reads on every record, in every module, forever. There is no
 * second place a tab's name appears, so there was no workaround either.
 *
 * ── WHAT IS STILL NOT POSSIBLE, DELIBERATELY ─────────────────────────────
 * The KEY is not editable, for the same reason a field's key is not: it is the
 * identity that `module_tab_order`, `fields.tab_id`, every grant row and every
 * saved per-user field order point at, and renaming it would orphan all of
 * them silently. Deleting a tab or subtab in use is still out of scope, and
 * still for the reason the plan gives: nobody has decided what happens to the
 * field values underneath one.
 */
export async function renameTab(ctx: AuthContext, tabId: string, label: string): Promise<Result> {
  assertAdmin(ctx);
  const trimmed = label.trim();
  if (!trimmed) return { ok: false, message: 'A tab needs a label.' };

  /*
   * System tabs are non-renamable. The client's Admin Module Plan §3.1 says
   * hardcoded tabs appear in this surface "flagged as locked system tabs:
   * non-deletable and non-renamable, but orderable", and §3.5 repeats it for
   * every system item. Renaming Cases to something else would also break the
   * vocabulary rule CLAUDE.md binds — "Cases" is the tab, "Tickets" is the
   * module, and the two must never be confused.
   *
   * Checked HERE and not only in the UI, because the spec says the API must
   * reject what the interface forbids.
   */
  const { data: tab, error: readError } = await supabaseAdmin()
    .from('tabs').select('is_system, label').eq('id', tabId).maybeSingle();
  if (readError) return { ok: false, message: readError.message };
  if (!tab) return { ok: false, message: 'That tab no longer exists.' };
  if (tab.is_system) {
    return { ok: false, message: `${tab.label} is a system tab — it can be reordered, but not renamed.` };
  }

  const { error } = await supabaseAdmin().from('tabs').update({ label: trimmed }).eq('id', tabId);
  if (error) return { ok: false, message: error.message };
  return { ok: true, id: tabId };
}

export async function renameSubtab(
  ctx: AuthContext,
  subtabId: string,
  label: string,
  description: string | null,
): Promise<Result> {
  assertAdmin(ctx);
  const trimmed = label.trim();
  if (!trimmed) return { ok: false, message: 'A subtab needs a label.' };

  // The description is the client's own explanatory text rendered at the top of
  // a Pricing subtab, so it is editable alongside the label rather than frozen
  // at creation — getting that sentence wrong was previously permanent too.
  const desc = description?.trim() ? description.trim() : null;
  const { error } = await supabaseAdmin()
    .from('subtabs')
    .update({ label: trimmed, description: desc })
    .eq('id', subtabId);
  if (error) return { ok: false, message: error.message };
  return { ok: true, id: subtabId };
}

/**
 * Set one module's tab order, or one module's subtab order within a tab.
 *
 * ── WHY THIS WAS THE BIGGEST "NEEDS A DEVELOPER" GAP ─────────────────────
 * Tab order and subtab order are two of the SIX things the client's §1 says
 * vary per module — and they were the only two of the six an admin could not
 * change. `appendToModuleOrder` appends, and nothing else ever wrote these
 * tables, so the seeded order was the permanent order. Reordering Leads' tabs
 * required a developer and a migration.
 *
 * Replaced wholesale rather than patched position by position: a partial
 * update can leave two rows sharing a position, and the read side
 * (`tabsForModule`) sorts by it. Ids not named are dropped, which is how a tab
 * is removed from ONE module without touching the tab itself.
 *
 * Positions are spaced by 10, matching the seed, so a later `appendToModuleOrder`
 * still lands cleanly at the end.
 */
export async function setModuleTabOrder(
  ctx: AuthContext,
  moduleId: string,
  tabIds: string[],
): Promise<Result> {
  assertAdmin(ctx);
  const supabase = supabaseAdmin();

  const { error: delError } = await supabase.from('module_tab_order').delete().eq('module_id', moduleId);
  if (delError) return { ok: false, message: delError.message };

  if (tabIds.length) {
    const { error } = await supabase.from('module_tab_order').insert(
      tabIds.map((tabId, i) => ({ module_id: moduleId, tab_id: tabId, position: i * 10 })),
    );
    if (error) return { ok: false, message: error.message };
  }
  return { ok: true, id: moduleId };
}

export async function setModuleSubtabOrder(
  ctx: AuthContext,
  moduleId: string,
  subtabIds: string[],
): Promise<Result> {
  assertAdmin(ctx);
  const supabase = supabaseAdmin();

  // Scoped to the subtabs actually named, so reordering one tab's subtabs
  // cannot wipe another tab's order for the same module.
  if (!subtabIds.length) return { ok: true, id: moduleId };

  const { error: delError } = await supabase
    .from('module_subtab_order')
    .delete()
    .eq('module_id', moduleId)
    .in('subtab_id', subtabIds);
  if (delError) return { ok: false, message: delError.message };

  const { error } = await supabase.from('module_subtab_order').insert(
    subtabIds.map((subtabId, i) => ({ module_id: moduleId, subtab_id: subtabId, position: i * 10 })),
  );
  if (error) return { ok: false, message: error.message };
  return { ok: true, id: moduleId };
}

export async function assignTabToModules(ctx: AuthContext, tabId: string, moduleIds: string[]): Promise<void> {
  assertAdmin(ctx);
  await appendToModuleOrder('module_tab_order', 'tab_id', tabId, moduleIds);
}

export async function assignSubtabToModules(ctx: AuthContext, subtabId: string, moduleIds: string[]): Promise<void> {
  assertAdmin(ctx);
  await appendToModuleOrder('module_subtab_order', 'subtab_id', subtabId, moduleIds);
}
