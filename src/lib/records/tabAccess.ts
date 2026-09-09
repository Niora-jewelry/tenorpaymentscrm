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
import { capGrant, moduleGrant, tabGrant, type AuthContext, type Grant } from './permissions';

/**
 * The highest module-level grant this viewer holds over any module the record
 * is displayed in. Highest, because a record shown in both Leads and Deals is
 * one record: holding Edit on either module is holding Edit on it.
 */
export async function moduleWriteCap(
  ctx: AuthContext,
  recordIds: string[],
): Promise<Map<string, Grant>> {
  const out = new Map<string, Grant>();
  if (!recordIds.length) return out;
  if (ctx.isAdmin) {
    for (const id of recordIds) out.set(id, 'edit');
    return out;
  }

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
  // One `moduleGrant` round trip per DISTINCT module, not per record — a
  // 500-record bulk edit spans at most six modules.
  const grantByModule = new Map<string, Grant>();
  for (const id of new Set(data.map((r) => r.module_id as string))) {
    const mod = moduleById.get(id);
    if (mod) grantByModule.set(id, await moduleGrant(ctx, mod.id, mod.adminOnly));
  }

  for (const id of recordIds) out.set(id, 'hidden');
  for (const r of data) {
    const g = grantByModule.get(r.module_id as string) ?? 'hidden';
    const best = out.get(r.record_id as string) ?? 'hidden';
    if (g === 'edit' || (g === 'view' && best === 'hidden')) out.set(r.record_id as string, g);
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
  if (ctx.isAdmin) return 'edit';
  const [caps, tg] = await Promise.all([
    moduleWriteCap(ctx, [recordId]),
    tabGrant(ctx, tabId),
  ]);
  return capGrant(caps.get(recordId) ?? 'hidden', tg);
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
