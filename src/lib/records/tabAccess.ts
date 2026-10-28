/**
 * The grant chain, resolved against a RECORD — module → tab → (field).
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 * `effective_grant()` resolves one scope id at a time and knows nothing about
 * containment: a field does not inherit from its tab, a tab does not inherit
 * from its module. That is correct for storage — three independent scopes are
 * exactly what the client specified — but it means the *enforcement* side has
 * to compose them, and until it did, two of the three levels were decoration:
 *
 *   - a module set to View still handed the drawer a page of Edit fields,
 *     because an unset field resolves to Edit (`GRANT_DEFAULT`);
 *   - a tab set to Hidden did nothing whatsoever, because nothing read tab
 *     grants at all (`permissions.ts`'s own ⚠️ note, Phase 6b).
 *
 * Cases, Files, Logins, Statements, Updates and Communication are the sharp
 * end of the second one: none of them are made of fields, so a tab grant was
 * the ONLY permission that could ever have restricted them. There was none.
 *
 * ── WHY THE MODULE IS RESOLVED FROM THE RECORD, NOT THE REQUEST ───────────
 * Every write action carries a `moduleSlug` from the browser. Trusting it lets
 * a member holding Leads = View and Deals = Edit edit a Leads-only record by
 * saying "deals". So the module half is resolved from the record's ACTUAL
 * `record_modules` rows, and the caller's claim never enters the decision.
 *
 * A record in no module at all (archived) resolves to Hidden and is therefore
 * unwritable. Correct by construction rather than by accident: an archived
 * record lives only in the Records List, which is admin-only, and admins never
 * reach any of this because they short-circuit to Edit on the first line.
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { loadConfig } from './config';
import {
  capGrant,
  fieldGrant,
  moduleGrant,
  subtabGrant,
  tabGrant,
  type AuthContext,
  type Grant,
} from './permissions';
import type { Field } from './config';

type RecordModule = { id: string; adminOnly: boolean };

/**
 * ── THE ONE RULE EVERY RECORD-SCOPED ANSWER FOLLOWS ───────────────────────
 * For each module the record is actually displayed in, cap the whole chain
 * WITHIN that module — module grant, then tab, then subtab, then field — and
 * keep the best result across modules.
 *
 * ⚠ CAP FIRST, THEN TAKE THE BEST. Doing it the other way round — resolving
 * each level's best across modules and capping the results together — reads as
 * equivalent and is not. Take a record in Leads and Deals with:
 *
 *            module    tab       subtab      capped within the module
 *   Leads     edit      edit      hidden   →  hidden
 *   Deals     edit      hidden    edit     →  hidden
 *
 * The correct answer is Hidden: there is no module in which the viewer can
 * reach that subtab. Best-per-level gives tab = Edit and subtab = Edit, and
 * caps them to EDIT — access granted through a combination that exists in
 * neither module. That is why this takes the whole chain as one list rather
 * than exposing a per-level helper callers compose themselves.
 *
 * Best-across-modules is not new: it is what the module ceiling already did —
 * "a record shown in both Leads and Deals is one record: holding Edit on
 * either module is holding Edit on it." Taking the worst instead would mean
 * adding a record to a second module could only ever REMOVE access.
 */
async function chainCapFor(
  ctx: AuthContext,
  recordIds: string[],
  /** Each level below the module, resolved IN a given module. Evaluated once
   *  per distinct module, never once per record. */
  levels: ((moduleId: string) => Promise<Grant>)[],
): Promise<Map<string, Grant>> {
  const out = new Map<string, Grant>();
  if (!recordIds.length) return out;
  if (ctx.isAdmin) {
    for (const id of recordIds) out.set(id, 'edit');
    return out;
  }

  const modulesByRecord = await recordModulesFor(recordIds);

  // Resolved once per DISTINCT module rather than once per record — a
  // 500-record bulk edit spans at most six modules.
  const byModule = new Map<string, RecordModule>();
  for (const mods of modulesByRecord.values()) for (const m of mods) byModule.set(m.id, m);

  const capByModule = new Map<string, Grant>();
  await Promise.all(
    [...byModule.values()].map(async (mod) => {
      capByModule.set(mod.id, await capInModule(ctx, mod, levels));
    }),
  );

  for (const id of recordIds) out.set(id, bestOf(modulesByRecord.get(id) ?? [], capByModule));
  return out;
}

/** The chain capped inside ONE module. */
async function capInModule(
  ctx: AuthContext,
  mod: RecordModule,
  levels: ((moduleId: string) => Promise<Grant>)[],
): Promise<Grant> {
  let g = await moduleGrant(ctx, mod.id, mod.adminOnly);
  for (const level of levels) {
    if (g === 'hidden') break; // nothing below can re-open it
    g = capGrant(g, await level(mod.id));
  }
  return g;
}

function bestOf(mods: RecordModule[], capByModule: Map<string, Grant>): Grant {
  let best: Grant = 'hidden';
  for (const mod of mods) {
    const g = capByModule.get(mod.id) ?? 'hidden';
    if (g === 'edit') return 'edit';
    if (g === 'view') best = 'view';
  }
  return best;
}

/**
 * The highest module-level grant this viewer holds over any module the record
 * is displayed in.
 */
export async function moduleWriteCap(
  ctx: AuthContext,
  recordIds: string[],
): Promise<Map<string, Grant>> {
  return chainCapFor(ctx, recordIds, []);
}

/** The record's `record_modules` rows, batched. */
async function recordModulesFor(recordIds: string[]): Promise<Map<string, RecordModule[]>> {
  const out = new Map<string, RecordModule[]>();
  if (!recordIds.length) return out;

  const supabase = await createSupabaseServerClient();

  /*
   * Chunked, because this is reached from `bulkSetValue` with up to 500 record
   * ids (`records.ts`, BULK_CHUNK). PostgREST sends `.in()` as a GET query
   * string, so 500 UUIDs is roughly 19 KB of URL — past the default limit of
   * several proxies and load balancers, which reject it with a 414 rather than
   * anything that names the real cause. `bulkSetValue` already chunks the RPC
   * it feeds; the permission read in front of it did not, so the guard could
   * fail on exactly the batches it exists to guard.
   *
   * 200 keeps the longest URL near 8 KB, comfortably under every limit worth
   * caring about. The chunks run together — this is a widening of one query,
   * not a new sequential wave.
   */
  const IN_CHUNK = 200;
  const chunks: string[][] = [];
  for (let i = 0; i < recordIds.length; i += IN_CHUNK) chunks.push(recordIds.slice(i, i + IN_CHUNK));

  const pages = await Promise.all(
    chunks.map(async (chunk) => {
      const { data, error } = await supabase
        .from('record_modules')
        .select('record_id, module_id')
        .in('record_id', chunk);
      if (error) throw error;
      return data ?? [];
    }),
  );
  const data = pages.flat();

  const config = await loadConfig();
  const moduleById = new Map(config.modules.map((m) => [m.id, m]));
  /* The Records List holds every record, so it is one of every record's
     modules for access — the same rule `user_record_field_grant` follows
     (migration 9811). Whether it OPENS anything is the user's Records List
     setting, decided in `moduleGrant`. */
  const storage = config.modules.filter((m) => m.kind === 'storage').map((m) => ({ id: m.id, adminOnly: m.adminOnly }));

  for (const id of recordIds) out.set(id, [...storage]);
  for (const r of data) {
    const mod = moduleById.get(r.module_id as string);
    if (!mod) continue;
    out.get(r.record_id as string)?.push({ id: mod.id, adminOnly: mod.adminOnly });
  }
  return out;
}

/**
 * The chain for one tab on one record: the record's module ceiling, then the
 * tab's own grant under it.
 *
 * `tabKey` rather than a tab id because the callers are feature modules —
 * `cases.ts` knows it is the Cases tab, and looking the id up here keeps
 * "which row in `tabs` is this" out of seven different files. An unknown key
 * is a programming error, not a permission answer, so it throws.
 */
export async function tabAccess(ctx: AuthContext, recordId: string, tabKey: string): Promise<Grant> {
  if (ctx.isAdmin) return 'edit';
  const config = await loadConfig();
  const tab = config.tabs.find((t) => t.key === tabKey);
  if (!tab) throw new Error(`Unknown tab: ${tabKey}`);
  return tabAccessById(ctx, recordId, tab.id);
}

/** The same chain, for a caller that already holds the tab's id — a field
 * knows its `tabId`, and so does a note's scope. */
export async function tabAccessById(ctx: AuthContext, recordId: string, tabId: string): Promise<Grant> {
  return (await tabCapsFor(ctx, [recordId], tabId)).get(recordId) ?? 'hidden';
}

/** Batched `tabAccessById` — module ceiling, then the tab under it. */
export async function tabCapsFor(
  ctx: AuthContext,
  recordIds: string[],
  tabId: string,
): Promise<Map<string, Grant>> {
  return chainCapFor(ctx, recordIds, [(moduleId) => tabGrant(ctx, tabId, moduleId)]);
}

/**
 * The full write chain for one field on a set of records:
 * module -> tab -> subtab -> the field itself, capped inside each of the
 * record's modules before the best is taken.
 *
 * This returns the FINAL answer, not a ceiling to be capped again by the
 * caller. Handing back a ceiling was the shape that let a caller cap two
 * independently-best-of levels together and land on a grant that held in no
 * single module — see the note on `chainCapFor`.
 */
export async function fieldCapsFor(
  ctx: AuthContext,
  recordIds: string[],
  field: Field | undefined,
): Promise<Map<string, Grant>> {
  const levels: ((moduleId: string) => Promise<Grant>)[] = [];
  // A field always has a tab. The empty chain only covers a field deleted from
  // config between render and submit, where the module ceiling alone decides.
  if (field) {
    levels.push((moduleId) => tabGrant(ctx, field.tabId, moduleId));
    if (field.subtabId) {
      const subtabId = field.subtabId;
      levels.push((moduleId) => subtabGrant(ctx, subtabId, moduleId));
    }
    levels.push((moduleId) => fieldGrant(ctx, field, moduleId));
  }
  return chainCapFor(ctx, recordIds, levels);
}

/**
 * Which of `fields` this viewer may not see ON THIS RECORD, by field key.
 *
 * Per record rather than global because a field's grant can differ by module
 * and a record's modules differ by record. The activity log is the caller that
 * makes this matter: its rows carry `from_value` and `to_value` verbatim, so a
 * field hidden only in the module a record lives in still leaked its values
 * through the history when this was resolved globally.
 */
export async function hiddenFieldKeysFor(
  ctx: AuthContext,
  recordId: string,
  fields: Field[],
): Promise<Set<string>> {
  const hidden = new Set<string>();
  if (ctx.isAdmin || !fields.length) return hidden;

  // ONE module lookup for the whole field list. Calling `fieldCapsFor` per
  // field would be ~200 round trips on a drawer open; every level below the
  // module reads the per-request grant map in memory, so the rest is free.
  const mods = (await recordModulesFor([recordId])).get(recordId) ?? [];
  if (!mods.length) {
    // In no module at all — archived. Nothing is readable through a display
    // module, which is what this set is used to decide.
    for (const f of fields) hidden.add(f.key);
    return hidden;
  }

  const moduleCap = new Map<string, Grant>();
  await Promise.all(
    mods.map(async (m) => moduleCap.set(m.id, await moduleGrant(ctx, m.id, m.adminOnly))),
  );

  await Promise.all(
    fields.map(async (f) => {
      const capByModule = new Map<string, Grant>();
      await Promise.all(
        mods.map(async (m) => {
          let g = moduleCap.get(m.id) ?? 'hidden';
          if (g !== 'hidden') g = capGrant(g, await tabGrant(ctx, f.tabId, m.id));
          if (g !== 'hidden' && f.subtabId) g = capGrant(g, await subtabGrant(ctx, f.subtabId, m.id));
          if (g !== 'hidden') g = capGrant(g, await fieldGrant(ctx, f, m.id));
          capByModule.set(m.id, g);
        }),
      );
      if (bestOf(mods, capByModule) === 'hidden') hidden.add(f.key);
    }),
  );
  return hidden;
}

/**
 * The write guard every tab-backed feature calls first.
 *
 * Deliberately in the service layer, not the Server Action: the action is one
 * caller, and CLAUDE.md rule 2 puts the gate below the app layer precisely so
 * a second caller cannot forget it.
 */
export async function requireTabEdit(ctx: AuthContext, recordId: string, tabKey: string): Promise<void> {
  const grant = await tabAccess(ctx, recordId, tabKey);
  if (grant !== 'edit') throw new Error(`No edit access to this record's ${tabKey} tab.`);
}

/** The read guard, for content that is fetched on demand rather than rendered
 * with the page — a revealed password, a signed download URL. */
export async function requireTabView(ctx: AuthContext, recordId: string, tabKey: string): Promise<void> {
  const grant = await tabAccess(ctx, recordId, tabKey);
  if (grant === 'hidden') throw new Error(`No access to this record's ${tabKey} tab.`);
}

/**
 * The record a child row belongs to.
 *
 * Half the write functions in the tab features take the entity's own id — a
 * note id, a case id, a login id — not the record's, so the guard has one
 * lookup to do before it can resolve anything. Goes through the request's own
 * RLS-bound client on purpose: a row the viewer cannot see returns nothing
 * here and the guard refuses, which is the same answer for "does not exist"
 * and "not yours" and so leaks neither.
 */
export async function recordIdOf(table: string, id: string, column = 'record_id'): Promise<string> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from(table).select(column).eq('id', id).maybeSingle();
  if (error) throw error;
  const recordId = (data as Record<string, string> | null)?.[column];
  if (!recordId) throw new Error('Not found');
  return recordId;
}

/** `requireTabEdit`, for a function that only has the child row's id. */
export async function requireTabEditVia(
  ctx: AuthContext,
  table: string,
  id: string,
  tabKey: string,
  column = 'record_id',
): Promise<void> {
  await requireTabEdit(ctx, await recordIdOf(table, id, column), tabKey);
}
