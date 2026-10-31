/**
 * The record store: list, read, create, set a value, bulk-edit, archive/
 * delete/restore.
 *
 * "Hidden fields are never fetched" (MODULE-2-PLAN §5.1) is implemented as
 * strip-after-fetch, not a dynamic per-viewer SQL projection: Postgres has no
 * cheap way to compose "select this JSONB document minus these keys" per
 * request from supabase-js's query builder, so this file fetches the whole
 * `values` document server-side (still inside trusted server code, still
 * behind RLS's `can_see_record`) and strips hidden keys before the object
 * ever becomes a return value — which is the leak that actually matters: a
 * hidden field's value never reaches the browser, dev tools, or a future
 * export, regardless of how the server-side fetch itself was shaped.
 */
import 'server-only';
import { likePattern } from './search';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { AuthContext } from './permissions';
import { canDo, fieldGrant, fieldGrants, moduleGrant, capGrant, VISIBILITY_FIELD_KEY, type Grant } from './permissions';
import { fieldCapsFor, hiddenFieldKeysFor } from './tabAccess';
import { loadConfig, columnsForModule, type Field, type FieldType } from './config';
import { parseTeamMembers } from './teamMembers';

/**
 * The ceiling a field value sits under, per record: the record's module grant
 * capped by the grant on the tab that field lives in. The field's own grant is
 * applied on top of this by the caller — `capGrant` composes in any order.
 *
 * Batched over records because one bulk edit touches one field across up to
 * 500 of them: the tab lookup happens once, the module ceiling in one query.
 */
async function fieldCaps(
  ctx: AuthContext,
  recordIds: string[],
  fieldId: string,
): Promise<Map<string, Grant>> {
  if (ctx.isAdmin) return new Map(recordIds.map((id) => [id, 'edit' as Grant]));

  const config = await loadConfig();
  const field = config.fields.find((f) => f.id === fieldId);

  /*
   * ⚠ THE WHOLE CHAIN IN ONE CALL, and that is the point.
   *
   * This used to resolve the module ceiling, the tab and the subtab as three
   * independent lookups and cap the results together. Each of those three took
   * the BEST answer across the record's modules, so capping them afterwards
   * could grant a level that held in no single module — see the worked example
   * on `chainCapFor`. `fieldCapsFor` caps within each module first.
   *
   * It also returns the FINAL grant rather than a ceiling above the field: the
   * field's own grant is per-module too, so resolving it separately reopened
   * the same hole one level down.
   */
  return fieldCapsFor(ctx, recordIds, field);
}

async function fieldCap(ctx: AuthContext, recordId: string, fieldId: string): Promise<Grant> {
  return (await fieldCaps(ctx, [recordId], fieldId)).get(recordId) ?? 'hidden';
}

/**
 * The write-time check for the one field type whose value is a permission.
 * Returns the value to store, or a message. Everything else passes through
 * untouched — this is not a general validation hook, and should not become one:
 * every other field type's shape is the database's business
 * (`decodeFieldValue`'s JSON round trip, the check constraints), and only this
 * one decides who can read the row.
 */
async function checkedValue(
  ctx: AuthContext,
  type: FieldType,
  value: unknown,
): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  if (type !== 'team_member') return { ok: true, value };
  const parsed = await parseTeamMembers(ctx, value);
  return parsed.ok ? { ok: true, value: parsed.ids } : parsed;
}

export type RecordRow = {
  id: string;
  dealName: string;
  values: Record<string, unknown>;
  creatorKind: 'user' | 'campaign';
  creatorUserId: string | null;
  creatorCampaignId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

function mapRow(r: Record<string, unknown>): RecordRow {
  return {
    id: r.id as string,
    dealName: r.deal_name as string,
    values: (r.values as Record<string, unknown>) ?? {},
    creatorKind: r.creator_kind as 'user' | 'campaign',
    creatorUserId: (r.creator_user_id as string | null) ?? null,
    creatorCampaignId: (r.creator_campaign_id as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    deletedAt: (r.deleted_at as string | null) ?? null,
  };
}

/** Strips any key in `values` whose field the viewer may not see at all. */
/**
 * Every column of `records` EXCEPT `values`.
 *
 * `values` is no longer selectable by `authenticated` (migration 75): field
 * permissions could not be enforced while the whole jsonb blob came back in one
 * column, so the column was revoked and handed back through
 * `record_values_for()`, which strips the viewer's hidden keys in the database.
 *
 * Spelled out rather than `*` because `*` now FAILS for a signed-in user, and
 * failing loudly at the query is better than a column quietly going missing.
 */
const RECORD_COLUMNS =
  'id, deal_name, creator_kind, creator_user_id, creator_campaign_id, created_at, updated_at, deleted_at';

/**
 * Stripped values for a page of records, in one round trip.
 *
 * Batched deliberately: the dashboard renders 50 rows, and one call per row is
 * the N+1 that turns a page into 50 queries.
 */
async function valuesByRecordId(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  ids: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (!ids.length) return out;

  const { data, error } = await supabase.rpc('record_values_for', { p_ids: ids });
  if (error) throw error;

  for (const row of (data ?? []) as { id: string; values: Record<string, unknown> | null }[]) {
    out.set(row.id, row.values ?? {});
  }
  return out;
}

function stripHidden(values: Record<string, unknown>, hiddenKeys: Set<string>): Record<string, unknown> {
  if (!hiddenKeys.size) return values;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (!hiddenKeys.has(k)) out[k] = v;
  }
  return out;
}

/**
 * Hidden keys for a LIST of records shown inside one module.
 *
 * `moduleId` is not optional in practice and must not be dropped: a field's
 * grant can differ by module, so resolving this globally both missed
 * per-module hides and over-stripped fields a module re-opens.
 */
async function hiddenKeysFor(
  ctx: AuthContext,
  fields: Field[],
  moduleId: string | null,
): Promise<Set<string>> {
  if (ctx.isAdmin) return new Set();
  const grants = await fieldGrants(ctx, fields, moduleId);
  const hidden = new Set<string>();
  for (const f of fields) {
    if (grants.get(f.id) === 'hidden') hidden.add(f.key);
  }
  return hidden;
}

/** Field types whose stored value is a JSON ARRAY rather than a scalar. They
 *  need a containment filter; `->>` would stringify the whole array. `grid` and
 *  `repeat_group` are arrays too but are never filterable, so they are
 *  deliberately absent. */
const ARRAY_VALUED_TYPES = new Set<FieldType>(['team_member', 'multi_select', 'months']);

import { SORTABLE_TYPES, type ListSort } from './listSort';
export type { ListSort };

export type ListFilter =
  | { fieldId: string; kind: 'contains'; text: string }
  | { fieldId: string; kind: 'values'; values: string[] }
  | { fieldId: string; kind: 'range'; min?: number; max?: number }
  | { fieldId: string; kind: 'dates'; from?: string; to?: string }
  | { fieldId: string; kind: 'bool'; checked: boolean }
  /** "Has any value at all" — the dashboard's filter-by-pipeline. See the
   * matching note on `Filter` in `proto/schema.ts`. */
  | { fieldId: string; kind: 'present' };

const PAGE_SIZE = 50;

/**
 * The dashboard query: one page of a module's live records, plus a total
 * count from the same scan (SCHEMA.md: `count(*) over ()`, not a second
 * `SELECT count(*)` that can disagree with the page under concurrent writes).
 */
export async function listRecords(
  ctx: AuthContext,
  moduleId: string,
  opts: { page?: number; filters?: ListFilter[]; q?: string; sort?: ListSort | null } = {},
): Promise<{ rows: RecordRow[]; total: number; page: number; pageCount: number }> {
  const supabase = await createSupabaseServerClient();
  const config = await loadConfig();
  const page = Math.max(0, opts.page ?? 0);

  const targetModule = config.modules.find((m) => m.id === moduleId);
  const isRecordsList = targetModule?.slug === 'records';

  /*
   * ⚠️ `records_filterable`, NOT `records`, and the difference is the filters.
   *
   * `records.values` is not selectable by a signed-in user (migration 75, and
   * see RECORD_COLUMNS above). A filter is applied as `values->>key`, and
   * PostgreSQL requires SELECT privilege on every column named in a WHERE
   * clause — not merely on the ones returned. So filtering this table by any
   * field value was refused outright with
   *
   *     42501 permission denied for table records
   *
   * and the page fell to its error boundary. That was true of essentially
   * every filter in the app; it surfaced when the pipeline step became a
   * dashboard column, because the funnel on it saves a filter in one click.
   *
   * The view (migration …9752) returns the same rows the SELECT policy on
   * `records` allows, with `values` stripped of this viewer's hidden keys by
   * the same expression `record_values_for()` uses — so it discloses nothing
   * new, and a filter on a field the viewer may not see matches nothing
   * rather than reporting whether a value is present.
   *
   * `values` is still absent from the select list below. The view makes the
   * column FILTERABLE; it does not put it back on the wire.
   */

  /*
   * Records List shows every non-deleted record regardless of membership —
   * including fully archived ones (zero display memberships), since it is
   * their only remaining home. So the module test is applied only when
   * actually filtering to one display module, exactly as the `!inner` join it
   * replaces was conditional.
   *
   * `module_ids` is the view's array of the record's display modules, and
   * `contains` is a plain `cs` containment test — no embedded resource, so
   * nothing depends on PostgREST inferring a relationship through a view.
   *
   * The cast stays: the view is not in the generated database types, and
   * `mapRow` below reads the shape explicitly in any case.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query = supabase.from('records_filterable').select(RECORD_COLUMNS, { count: 'exact' }) as any;
  query = query.is('deleted_at', null);

  if (!isRecordsList) {
    query = query.contains('module_ids', [moduleId]);
  }

  /*
   * The list search (every module): a case-insensitive substring of
   * `search_text` — the name plus every string value the viewer may see,
   * computed by the view from the same stripped `values`, so a hidden
   * field's content can never match (migration 9797).
   */
  const q = opts.q?.trim();
  if (q) query = query.ilike('search_text', likePattern(q));

  // Layer 3 of "admin default → user override → permission filter" happens
  // above this call (columnsForModule already excludes fields the caller
  // cannot see at all, elsewhere); the filters below operate on values the
  // caller is allowed to filter by in the first place.
  /*
   * ⚠️ Keyed by BOTH the field's `key` and its uuid, and `key` is the one that
   * actually matches.
   *
   * This map was `f.id → f` (the database uuid) and every lookup missed, so
   * `continue` fired for every filter and this whole block was dead code.
   * Filters are created in the browser from the ADAPTED field, whose `id` is
   * deliberately the field's `key` rather than its uuid (`adapter.ts`: "the
   * prototype's own identity"), and they are saved and read back in that
   * shape. Nothing errored — the query simply came back unfiltered, and
   * `DataTable` then filtered the 50 rows it had been given, so a filter
   * looked like it worked while quietly only searching the first page.
   *
   * Both keys are accepted rather than swapping one for the other: a filter
   * saved by any other caller, now or later, resolves either way, and a field
   * `key` cannot collide with a uuid.
   */
  const byId = new Map<string, (typeof config.fields)[number]>();
  for (const f of config.fields) {
    byId.set(f.key, f);
    byId.set(f.id, f);
  }
  for (const filter of opts.filters ?? []) {
    const field = byId.get(filter.fieldId);
    if (!field) continue;
    const path = `values->>${field.key}`;
    switch (filter.kind) {
      case 'contains':
        query = query.ilike(path, `%${filter.text}%`);
        break;
      case 'values':
        if (filter.values.length) {
          /*
           * ⚠️ An ARRAY-valued field cannot be filtered with `->> … in(…)`.
           *
           * `team_member`, `multi_select` and `months` each store a JSON array,
           * and `values->>key` renders that array as its JSON TEXT — so `in()`
           * was comparing the literal string `["id-a","id-b"]` against a single
           * id and matching nothing, ever. Verified against the live API: the
           * old form returned `[]` for a team member who is genuinely on three
           * records.
           *
           * Containment is the right operator: `values->key cs ["id"]` asks
           * "does this array hold that element". Several selected values mean
           * "any of", which is one `cs` term per value OR-ed together —
           * PostgREST splits an `or=(…)` on commas, and each term's JSON array
           * holds exactly one element, so no term can contain one.
           */
          if (ARRAY_VALUED_TYPES.has(field.type)) {
            const terms = filter.values
              .map((v) => `values->${field.key}.cs.${JSON.stringify([v])}`)
              .join(',');
            query = query.or(terms);
          } else {
            query = query.in(path, filter.values);
          }
        }
        break;
      case 'range':
        /* `sort_values` (migration 9808), never `values->>key`: that is TEXT,
           so "9" > "100", and stored numbers are a mix of JSON numbers and
           numeric strings. sort_values holds a real JSON number. */
        if (filter.min != null) query = query.gte(`sort_values->${field.key}`, filter.min);
        if (filter.max != null) query = query.lte(`sort_values->${field.key}`, filter.max);
        break;
      case 'dates':
        if (filter.from) query = query.gte(path, filter.from);
        if (filter.to) query = query.lte(path, filter.to);
        break;
      case 'bool':
        query = query.eq(path, String(filter.checked));
        break;
      case 'present':
        // A pipeline's synced Status field holds a step id on exactly the
        // records assigned to that pipeline and is absent everywhere else
        // (migration 57 removes the key rather than nulling it), so "is not
        // null" IS "is on this pipeline".
        query = query.not(path, 'is', null);
        break;
    }
  }

  /* UI/UX spec §6: sortable by value where the type allows. A field's typed
     value (number, date, option position) sorts; records without one go last;
     the name breaks ties so a page boundary is stable. */
  const sortField = opts.sort ? byId.get(opts.sort.fieldId) : undefined;
  if (opts.sort?.fieldId === 'deal_name') {
    query = query.order('deal_name', { ascending: opts.sort.dir === 'asc' });
  } else if (sortField && SORTABLE_TYPES.has(sortField.type)) {
    query = query
      .order(`sort_values->${sortField.key}`, { ascending: opts.sort!.dir === 'asc', nullsFirst: false })
      .order('deal_name');
  } else {
    query = query.order('deal_name');
  }

  const from = page * PAGE_SIZE;
  const { data, error, count } = await query.range(from, from + PAGE_SIZE - 1);
  if (error) throw error;

  const total = count ?? 0;
  const columns = moduleId ? columnsForModule(config, moduleId) : [];
  const hidden = await hiddenKeysFor(ctx, columns, moduleId ?? null);

  /*
   * Values arrive separately and already stripped — `values` is no longer a
   * selectable column for a signed-in user (migration 75). One batched call for
   * the whole page, not one per row.
   */
  const raw = (data ?? []) as Record<string, unknown>[];
  const valuesById = await valuesByRecordId(supabase, raw.map((r) => r.id as string));

  const rows = raw.map((r) => {
    const row = mapRow({ ...r, values: valuesById.get(r.id as string) ?? {} });
    // `stripHidden` is now belt-and-braces: the database already removed these
    // keys. Kept because the boundary being elsewhere is no reason for this
    // layer to start trusting its input.
    return { ...row, values: stripHidden(row.values, hidden) };
  });

  return { rows, total, page, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
}

/**
 * Sidebar nav badge counts, for every module in TWO queries rather than one
 * per module.
 *
 * This used to issue a `head: true` count per module — six to eight round
 * trips, in the LAYOUT, so every page load and every drawer-URL navigation in
 * the whole app paid them. They were concurrent, which hid the cost as one
 * slow wave rather than several, but it was still the last real per-element
 * query loop on the request path.
 *
 * Two queries now, run together:
 *   1. every visible `record_modules` row for live records — one row per
 *      (record, module) pair, tallied per module in memory;
 *   2. one count of live records for the Records List, which deliberately
 *      counts ARCHIVED (zero-membership) records too and therefore cannot come
 *      from the join in (1).
 *
 * RLS on the request-scoped client scopes both to what this viewer may see, so
 * the counts still match what each module's own dashboard reports as `total` —
 * which is the property that matters, and the reason (2) keeps the same shape
 * `listRecords` uses.
 *
 * The pair-row fetch is bounded by how many records the viewer can see; at the
 * scale this table is designed for (a CRM's record list, paged at 50) that is
 * far cheaper than the round trips it replaces. If it ever stops being so, the
 * right answer is a grouped-count RPC, not a return to one query per module.
 */
export async function moduleRecordCounts(modules: { id: string; slug: string }[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const m of modules) out[m.slug] = 0;
  if (!modules.length) return out;

  const supabase = await createSupabaseServerClient();
  const needsRecordsList = modules.some((m) => m.slug === 'records');

  const [pairs, recordsListCount] = await Promise.all([
    (async () => {
      const { data, error } = await supabase
        .from('record_modules')
        .select('module_id, records!inner(id)')
        .is('records.deleted_at', null);
      if (error) throw error;
      return (data ?? []) as { module_id: string }[];
    })(),
    (async () => {
      if (!needsRecordsList) return 0;
      // Same `!inner`-only-when-filtering reasoning as `listRecords` above —
      // the Records List badge must count archived (zero-membership) records,
      // so it must NOT go through the membership join.
      const { count, error } = await supabase
        .from('records')
        .select('id', { count: 'exact', head: true })
        .is('deleted_at', null);
      if (error) throw error;
      return count ?? 0;
    })(),
  ]);

  const bySlug = new Map(modules.map((m) => [m.id, m.slug]));
  for (const p of pairs) {
    const slug = bySlug.get(p.module_id);
    if (slug && slug !== 'records') out[slug] = (out[slug] ?? 0) + 1;
  }
  if (needsRecordsList) out.records = recordsListCount;
  return out;
}

/** One record, with hidden-field values stripped for this viewer. */
export async function getRecord(ctx: AuthContext, recordId: string): Promise<RecordRow | null> {
  const supabase = await createSupabaseServerClient();
  const config = await loadConfig();

  const { data, error } = await supabase
    .from('records')
    .select(RECORD_COLUMNS)
    .eq('id', recordId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  // A record can be a row in this viewer's list without being one they may
  // open: an open assignment, before they take it (migration 9843). `records`
  // answers the list's question, `record_visible` this one.
  const [{ data: opens, error: opensError }, valuesById] = await Promise.all([
    supabase.rpc('record_visible', { rec: recordId }),
    // Values come separately now, already stripped by the database.
    valuesByRecordId(supabase, [recordId]),
  ]);
  if (opensError) throw opensError;
  if (!opens) return null;
  (data as Record<string, unknown>).values = valuesById.get(recordId) ?? {};

  // Per RECORD, not global: this record's modules decide which per-module
  // field grants apply, and `record_values_for` already stripped by the same
  // rule in the database.
  const hidden = await hiddenFieldKeysFor(ctx, recordId, config.fields);
  const row = mapRow(data as Record<string, unknown>);
  return { ...row, values: stripHidden(row.values, hidden) };
}

/**
 * Create a record. Duplicate-blocked on Deal Name at the database (the
 * partial unique index on `lower(btrim(deal_name))`) — this just turns that
 * constraint violation into a message worth showing, rather than a raw
 * Postgres error code.
 */
/**
 * Who already holds this Deal Name, and how much the caller may be told.
 *
 * ── MODULES AMENDMENT 2, WHICH THE HANDOVER DOCUMENT DID NOT CARRY ───────
 * The client is precise about the asymmetry here, and it is a real disclosure
 * rule rather than wording:
 *
 *   "The duplicate check always runs against every non-deleted record in the
 *    system regardless of the acting user's visibility. The error message,
 *    however, is visibility-aware: if the user can see the blocking record …
 *    the message identifies and links to it. If the blocking record is not
 *    visible to the user, the message states only: 'This name is already in
 *    use on another record. Contact an administrator to resolve.' … The block
 *    itself is never weakened; only the disclosure is gated."
 *
 * Without the gate the error is an oracle: type a name, learn whether a record
 * you have no access to exists and what it is called. `deal_name_conflict()`
 * (migration 52) is `security definer` so the CHECK sees everything;
 * `record_visible()` then decides what the message may say.
 */
export type DuplicateBlock = {
  /** Present only when this caller is allowed to know which record it is. */
  record: { id: string; dealName: string } | null;
  message: string;
};

const OPAQUE_DUPLICATE =
  'This name is already in use on another record. Contact an administrator to resolve.';

export async function describeDuplicate(
  ctx: AuthContext,
  dealName: string,
  excludeRecordId?: string,
): Promise<DuplicateBlock> {
  void ctx; // the gate below is the database's own, per-request
  const supabase = await createSupabaseServerClient();

  const { data: conflictId, error } = await supabase.rpc('deal_name_conflict', {
    p_name: dealName,
    p_exclude: excludeRecordId ?? null,
  });
  if (error) throw error;
  if (!conflictId) {
    // The unique index refused but this found nothing — a race, or a name that
    // normalises differently. Say the honest minimum rather than inventing a
    // blocker that cannot be shown.
    return { record: null, message: OPAQUE_DUPLICATE };
  }

  // One row, and only if this caller may see it. `records_select` already
  // encodes `can_see_record()`, so an ordinary read IS the visibility check —
  // no second copy of the rule.
  const { data: visible } = await supabase
    .from('records')
    .select('id, deal_name')
    .eq('id', conflictId as string)
    .maybeSingle();

  if (!visible) return { record: null, message: OPAQUE_DUPLICATE };

  return {
    record: { id: visible.id as string, dealName: visible.deal_name as string },
    message: `“${visible.deal_name}” already uses this Deal Name.`,
  };
}

export async function createRecord(
  ctx: AuthContext,
  dealName: string,
  moduleIds: string[],
  /**
   * Who else lands on the new record's team, besides its creator.
   *
   * Until now this took no such argument and the creator was the only possible
   * member, which meant a record could not be shared with anyone at the moment
   * it was made — the person who owns the deal had to create it themselves, or
   * an admin had to go and edit the field afterwards. Empty is the old
   * behaviour exactly.
   */
  memberIds: string[] = [],
  /** Whole teams to assign, each left Open. */
  teamIds: string[] = [],
): Promise<{ id: string } | { error: 'duplicate' } | { error: 'members'; message: string }> {
  // Creating INTO a module is an edit of that module. The "+ New record"
  // button is already hidden below Edit, but the action behind it is callable
  // regardless of what rendered — hiding a button is not the boundary.
  const config = await loadConfig();
  // "Create new records" is one company-wide yes/no (Permissions spec); the
  // records_insert policy refuses without it too.
  if (!(await canDo(ctx, 'create'))) throw new Error('You do not have permission to create records.');
  for (const id of moduleIds) {
    const mod = config.modules.find((m) => m.id === id);
    if (!mod) throw new Error('Unknown module.');
    if ((await moduleGrant(ctx, mod.id, mod.adminOnly)) !== 'edit') {
      throw new Error(`No edit access to ${mod.label}.`);
    }
  }

  const supabase = await createSupabaseServerClient();

  // The creator must land on their own record's team at creation — visibility
  // (`can_see_record()`) is entirely driven by `record_team_members`, which
  // `sync_record_team_members()` derives ONLY from this field, never from
  // `creator_user_id`. Without this, a non-admin's own freshly-created
  // record would be invisible to them the instant they created it, and the
  // `set_record_memberships` call right below would fail too — admin testing
  // never caught it because `auth_is_admin()` bypasses `can_see_record()`
  // entirely.
  //
  // ── AND THE ID IS GENERATED HERE, NOT READ BACK ─────────────────────────
  // The obvious shape for this is `.insert(...).select('id').single()`. It
  // cannot work for a non-admin, and the reason is a Postgres ordering rule
  // that no amount of getting the `values` document right can move:
  //
  //   1. RLS checks the new row against records_select — because RETURNING
  //      is present, the SELECT policy is evaluated as a WITH CHECK option;
  //   2. the row is inserted;
  //   3. AFTER INSERT triggers fire — `sync_record_team_members()`, the only
  //      thing that ever writes `record_team_members`.
  //
  // `can_see_record()` reads `record_team_members`, which step 3 populates
  // and step 1 needs. The creator is therefore not yet on the team at the
  // moment the read-back is judged, and the insert dies with 42501
  // "new row violates row-level security policy for table records" — on a
  // row it was perfectly entitled to write. Verified directly against the
  // database as a Member: identical INSERT without RETURNING succeeds, and
  // the row is visible to that same member on the very next statement.
  //
  // A SELECT-policy widening (`or creator_user_id = auth.uid()`) would fix
  // the symptom by permanently granting the creator sight of a record they
  // may later have been removed from the team of — a change to who can see
  // what, to work around a timing rule. Generating the uuid here costs one
  // `crypto.randomUUID()` and changes nothing about the permission model.
  //
  // ── AND THE CREATOR IS ALWAYS FIRST ON THE LIST ─────────────────────────
  // `memberIds` is additive, never a replacement. Everything above is the
  // reason: the creator has to be on the team for the read-back and the
  // `set_record_memberships` call below to be legal at all, so "create a record
  // and hand it straight to someone else" is a create followed by an edit, not
  // a create that leaves the creator out. The picker in the dialog says so.
  const team = await parseTeamMembers(ctx, memberIds);
  if (!team.ok) return { error: 'members', message: team.message };
  const others = team.ids.filter((id) => id !== ctx.userId);

  const id = crypto.randomUUID();
  const { error } = await supabase
    .from('records')
    .insert({
      id,
      deal_name: dealName, creator_kind: 'user', creator_user_id: ctx.userId,
      // `VISIBILITY_FIELD_KEY` and not the field's type: this runs before any
      // field has been looked up, and of the three `team_member` fields in the
      // seed only this one is read by `sync_record_team_members()`. Writing the
      // creator into `relationship_manager` instead would grant nothing and
      // leave the insert's own read-back illegal.
      values: { [VISIBILITY_FIELD_KEY]: [ctx.userId] },
    });

  if (error) {
    if (error.code === '23505') return { error: 'duplicate' };
    throw error;
  }

  if (moduleIds.length) {
    const { error: memErr } = await supabase.rpc('set_record_memberships', {
      p_record_id: id,
      p_module_ids: moduleIds,
    });
    if (memErr) {
      /*
       * Both, or neither. A record is inserted before it can be placed —
       * `record_modules` has nothing to reference until the row exists — so a
       * failure here used to leave a record in NO module: invisible in every
       * display module, reachable only through the admin-only Records List,
       * and impossible for its own creator to find or finish.
       *
       * That is not hypothetical. It is exactly what happened whenever a
       * member pressed New record, for as long as `set_record_memberships`
       * refused a record that was not yet in a module (fixed in migration 84).
       * The orphans it made are the reason this rollback exists as well.
       *
       * Service-role, because the half-made record is not visible to the
       * request-scoped client — that is the whole problem — and `records` is
       * no longer deletable by `authenticated` at all (migration 82).
       */
      await supabaseAdmin().from('records').delete().eq('id', id);
      throw memErr;
    }
  }

  /*
   * Anyone else goes on through the same functions the drawer's picker uses,
   * so a new record is held to the same settings and each one is written to its
   * Updates tab. Both-or-neither, like the placement above.
   */
  if (others.length || teamIds.length) {
    const { data: teamRows, error: teamErr } = await supabaseAdmin().from('user_templates').select('user_id, template_id').in('user_id', others);
    if (teamErr) throw teamErr;
    const teamOf = new Map((teamRows ?? []).map((r) => [r.user_id as string, r.template_id as string]));
    for (const user of others) {
      const { error: e } = await supabase.rpc('assign_team_member', { p_record: id, p_team: teamOf.get(user) as string, p_user: user });
      if (e) {
        await supabaseAdmin().from('records').delete().eq('id', id);
        return { error: 'members', message: e.message };
      }
    }
    for (const teamId of teamIds) {
      const { error: e } = await supabase.rpc('assign_team', { p_record: id, p_team: teamId });
      if (e) {
        await supabaseAdmin().from('records').delete().eq('id', id);
        return { error: 'members', message: e.message };
      }
    }
  }

  return { id };
}

export type SetValueResult =
  | { ok: true; updatedAt: string }
  /** Compare-and-swap lost. `currentUpdatedAt` is the token the row actually
   *  holds now — returned so the caller can tell a conflict caused by its OWN
   *  earlier write (a stale token, nobody else involved) from a genuine
   *  third-party edit, and retry only in the first case. Without it the client
   *  could only give up, which is what made a lost token unrecoverable without
   *  a full page reload. */
  | { ok: false; currentUpdatedAt: string; currentValue: unknown; changedBy: string | null; changedAt: string | null }
  /** Refused before the write — the value itself is not one this field may
   * hold. Distinct from the compare-and-swap loss above, which is about
   * timing rather than content, and which the drawer words differently. */
  | { ok: false; refused: string };

/**
 * A field an admin marked read-only may never be written through a value path,
 * by anybody, admin included.
 *
 * ⚠️ THE PARAMETER WAS ALREADY BEING PASSED AND NEVER CHECKED. `readOnly` has
 * been on `setValue`'s field argument since it was written, and nothing looked
 * at it — the drawer simply rendered those fields with a View control and the
 * server trusted that. That was survivable while the drawer was the only way in.
 * It is not now the dashboard table can edit a cell, and it was never the
 * security boundary regardless: "UI-level hiding is never the security
 * boundary" is the client's own sentence.
 *
 * Today this covers `record_creator` ("set on creation, never editable") and
 * the four pipeline-synced Status fields — those the database refuses as well,
 * because their value is a projection of `record_pipelines` with exactly one
 * writer. This closes the same door one layer up, for the ones the database
 * does not know about.
 */
function assertWritable(field: { label: string; readOnly: boolean }): void {
  if (field.readOnly) {
    throw new Error(`${field.label} is read-only and cannot be edited.`);
  }
}

/**
 * One field, one value, compare-and-swap. §13.4: a losing writer gets back
 * what the CURRENT value is and who set it — "Sarah changed this a moment
 * ago" needs both, not a bare conflict flag.
 */
/**
 * A refusal the DATABASE raised, turned into a sentence.
 *
 * Deal Name is a column with a unique index and a NOT NULL, so renaming a
 * record onto a name another one already holds, or clearing it, is caught
 * there rather than by a check in front of it — which is the right place for
 * it: the index is the only thing that can decide without a race.
 *
 * The call sites previously did `if (error) throw error`, so both of those
 * ordinary user mistakes became an uncaught 500 and the drawer reported
 * "Could not reach the server" at somebody who had simply typed a name twice.
 * `setValue` already has a `refused` result for exactly this.
 *
 * Anything else still throws: an unexpected database error is not something
 * to paper over with a friendly sentence.
 */
function refusalFor(error: { code?: string; message?: string }): string | null {
  // 23505 unique_violation — only the Deal Name index can produce one here.
  if (error.code === '23505') {
    return 'Another record already uses that Deal Name.';
  }
  // 23514 check_violation — raised by name with its own message.
  if (error.code === '23514' && error.message?.includes('Deal Name')) {
    return error.message;
  }
  return null;
}

export async function setValue(
  ctx: AuthContext,
  recordId: string,
  field: { id: string; key: string; label: string; type: FieldType; readOnly: boolean },
  newValue: unknown,
  expectedUpdatedAt: string,
): Promise<SetValueResult> {
  // The full chain — module ceiling → the field's tab → the field itself —
  // checked HERE rather than in the action: the action is one caller of this
  // function, and rule 2 in CLAUDE.md puts the gate below the app layer
  // precisely so a future second caller cannot forget it.
  assertWritable(field);

  // `fieldCap` is the whole chain now, field included — capping it again with
  // a globally-resolved `fieldGrant` would reintroduce the per-module hole it
  // exists to close.
  const effective = await fieldCap(ctx, recordId, field.id);
  if (effective !== 'edit') throw new Error(`No edit access to ${field.label}`);

  // Same placement, same reason: a `team_member` write is a change to who can
  // read this record, so the check belongs below the app layer where every
  // caller passes through it, not in the one action that happens to exist now.
  const checked = await checkedValue(ctx, field.type, newValue);
  if (!checked.ok) return { ok: false, refused: checked.message };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .rpc('set_record_value', {
      p_record_id: recordId,
      p_field_key: field.key,
      p_new_value: checked.value,
      p_expected_updated_at: expectedUpdatedAt,
      p_summary: `${field.label} changed`,
    })
    .single();
  if (error) {
    const refused = refusalFor(error);
    if (refused) return { ok: false, refused };
    throw error;
  }

  const row = data as {
    ok: boolean; updated_at: string; current_value: unknown; changed_by: string | null; changed_at: string | null;
  };
  if (row.ok) return { ok: true, updatedAt: row.updated_at };
  return {
    ok: false,
    currentUpdatedAt: row.updated_at,
    currentValue: row.current_value,
    changedBy: row.changed_by,
    changedAt: row.changed_at,
  };
}

/** One field's worth of a batched write. */
export type ValueChange = {
  field: { id: string; key: string; label: string; type: FieldType; readOnly: boolean };
  value: unknown;
};

export type SetValuesResult =
  | { ok: true; updatedAt: string }
  | { ok: false; currentUpdatedAt: string; currentValues: Record<string, unknown> }
  | { ok: false; refused: string };

/**
 * Write SEVERAL fields at once — one round trip, one compare-and-swap.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 * `setValue` above writes one field, and the drawer called it once per edited
 * field with the calls serialised on the client (a queue that fixed a real CAS
 * race). Correct, and unusably slow: every call pays the proxy's session
 * check, `authorize()`'s user validation and then the RPC — three sequential
 * network waves, 1.5-2s each against a remote database. Five fields took over
 * ten seconds.
 *
 * Batching collapses that to one request for the whole batch, and removes the
 * race outright within it: there is a single token, so there is no second
 * write to go stale behind the first.
 *
 * ── THE PERMISSION CHAIN IS PER FIELD, NOT PER BATCH ─────────────────────
 * Same chain `setValue` applies — module ceiling → the field's tab → the field
 * itself — evaluated for EVERY field, and the whole batch is refused if any one
 * of them fails. Refusing the batch rather than dropping the offending field is
 * deliberate: a partial write the caller did not ask for is exactly the silent
 * failure CLAUDE.md rule 2 exists to prevent, and the UI shows one optimistic
 * change per field which would then disagree with the database for the field
 * that was quietly skipped.
 *
 * The module cap is fetched ONCE for the record and reused across fields; the
 * tab and field grants come from the per-request grant set, so a batch of
 * fifty fields costs the same lookups as a batch of one.
 */
export async function setValues(
  ctx: AuthContext,
  recordId: string,
  changes: ValueChange[],
  expectedUpdatedAt: string,
): Promise<SetValuesResult> {
  if (!changes.length) throw new Error('setValues called with no changes');

  const config = await loadConfig();

  // Checked for the WHOLE batch before anything is written: a batch that would
  // touch one read-only field is refused entirely rather than partially applied.
  for (const { field } of changes) assertWritable(field);

  /*
   * One resolution per DISTINCT field, each one the full module -> tab ->
   * subtab -> field chain capped inside every module this record is displayed
   * in.
   *
   * The previous shape cached a module ceiling, a tab grant and a subtab grant
   * separately and capped the three together. With per-module grants that is
   * not the same calculation: each part took its best across the record's
   * modules, so the combination could pass a check that no single module
   * allowed. `fieldCapsFor` does the capping inside each module first.
   */
  const capCache = new Map<string, Grant>();
  for (const { field } of changes) {
    const dbField = config.fields.find((f) => f.id === field.id || f.key === field.key);
    const cacheKey = dbField?.id ?? field.key;
    if (!capCache.has(cacheKey)) {
      const caps = await fieldCapsFor(ctx, [recordId], dbField);
      capCache.set(cacheKey, caps.get(recordId) ?? 'hidden');
    }
    if (capCache.get(cacheKey) !== 'edit') throw new Error(`No edit access to ${field.label}`);
  }

  // `team_member` is the one type whose VALUE is a permission, so it is checked
  // before anything is written — same placement and same reason as `setValue`.
  const payload: Record<string, unknown> = {};
  const summaries: Record<string, string> = {};
  for (const { field, value } of changes) {
    const checked = await checkedValue(ctx, field.type, value);
    if (!checked.ok) return { ok: false, refused: checked.message };
    // `null` is how the RPC is told to CLEAR a field (migration 46), and it
    // must survive JSON serialisation as a real JSON null rather than being
    // dropped from the object.
    payload[field.key] = checked.value ?? null;
    summaries[field.key] = `${field.label} changed`;
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .rpc('set_record_values', {
      p_record_id: recordId,
      p_changes: payload,
      p_expected_updated_at: expectedUpdatedAt,
      p_summaries: summaries,
    })
    .single();
  if (error) {
    const refused = refusalFor(error);
    if (refused) return { ok: false, refused };
    throw error;
  }

  const row = data as {
    ok: boolean; updated_at: string; current_values: Record<string, unknown> | null;
  };
  if (row.ok) return { ok: true, updatedAt: row.updated_at };
  return {
    ok: false,
    currentUpdatedAt: row.updated_at,
    currentValues: row.current_values ?? {},
  };
}

export type SkipReport = { applied: string[]; skipped: { id: string; reason: string }[] };

const BULK_CHUNK = 500;

/**
 * Set one field's value on every selected record. SCHEMA-DECISIONS §8:
 * chunked at 500 ids per statement — this loops the RPC in ≤500-id slices and
 * aggregates the skip report, rather than one giant UPDATE that either times
 * out and reports nothing or holds locks across thousands of rows.
 *
 * Per §10.3, the CALLER (the bulk-edit modal) has already restricted the
 * field list to ones the user holds Edit on — this still re-checks (never
 * trust the UI is the only gate) and throws before touching the database if
 * it hasn't.
 */
export async function bulkSetValue(
  ctx: AuthContext,
  recordIds: string[],
  field: { id: string; key: string; label: string; type: FieldType; readOnly: boolean },
  newValue: unknown,
): Promise<SkipReport> {
  const grant = await fieldGrant(ctx, field);
  if (grant !== 'edit') throw new Error(`No edit access to ${field.label}`);

  // A bulk `team_member` write reassigns visibility across up to 500 records at
  // once, which is the single largest permission change this app can make in one
  // click — so it goes through the same check a single write does, before any
  // chunk is sent. A bad value is refused whole rather than half-applied and
  // reported as 500 individual skips.
  const checked = await checkedValue(ctx, field.type, newValue);
  if (!checked.ok) {
    return { applied: [], skipped: recordIds.map((id) => ({ id, reason: checked.message })) };
  }
  const storedValue = checked.value;

  // The module → tab ceiling, per record — a selection can span modules, so
  // this skips the view-only ones and reports them rather than failing the
  // whole batch. Same shape as every other skip reason the modal renders.
  const caps = await fieldCaps(ctx, recordIds, field.id);
  const blocked = recordIds.filter((id) => capGrant(caps.get(id) ?? 'hidden', grant) !== 'edit');
  const writable = recordIds.filter((id) => capGrant(caps.get(id) ?? 'hidden', grant) === 'edit');

  const supabase = await createSupabaseServerClient();
  const applied: string[] = [];
  const requestedSet = new Set(writable);

  for (let i = 0; i < writable.length; i += BULK_CHUNK) {
    const chunk = writable.slice(i, i + BULK_CHUNK);
    const { data, error } = await supabase.rpc('bulk_set_values', {
      p_record_ids: chunk,
      p_field_key: field.key,
      p_new_value: storedValue,
      p_summary: `${field.label} bulk-edited`,
    });
    if (error) throw error;
    for (const id of (data as string[]) ?? []) applied.push(id);
  }

  const appliedSet = new Set(applied);
  const skipped = [
    ...blocked.map((id) => ({ id, reason: 'Read-only for you in every module it appears in' })),
    ...writable
      .filter((id) => requestedSet.has(id) && !appliedSet.has(id))
      .map((id) => ({ id, reason: 'Not visible, or changed since your selection' })),
  ];

  return { applied, skipped };
}

/** Records List only — "delete only on archived records", refused otherwise
 * by the database itself. */
export async function deleteRecord(ctx: AuthContext, recordId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('delete_record', { rec: recordId });
  if (error) throw error;
}

/** Always comes back archived — there is no membership set to restore. */
export type RestoreResult = { ok: true } | { ok: false; block: DuplicateBlock };

/**
 * Restore a record from the Recycle Bin.
 *
 * A soft-deleted record's name is released for reuse (the unique index is
 * `where deleted_at is null`, per §5.3), so somebody can take it while the
 * record sits in the bin. The client asks for that case by name: restore "is
 * refused with a clear, linked error message if the record's Deal Name would
 * now collide with an existing non-deleted record" (Overview §3.5, Admin §6).
 *
 * Migration 52 makes `restore_record` refuse before the write and hand back the
 * blocking record's id in the error hint; this turns that into the message,
 * with Amendment 2's disclosure gate applied by `describeDuplicate`.
 */
export async function restoreRecord(ctx: AuthContext, recordId: string): Promise<RestoreResult> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('restore_record', { rec: recordId });
  if (!error) return { ok: true };
  if (error.code !== '23505') throw error;

  // The name it is trying to come back as. Read from the deleted row itself,
  // not from the error text.
  const { data: row } = await supabase
    .from('records').select('deal_name').eq('id', recordId).maybeSingle();
  const block = await describeDuplicate(ctx, (row?.deal_name as string) ?? '', recordId);
  return { ok: false, block };
}

/** Permanent. Admin-only, and only on an already-deleted (Recycle Bin) record
 * — the database itself refuses otherwise. The activity trail survives (no
 * FK from record_activity to records — migration 18), exactly like an
 * auth_audit_log entry survives the deletion of the user it names. */
export async function purgeRecord(ctx: AuthContext, recordId: string): Promise<void> {
  if (!ctx.isAdmin) throw new Error('Admin only');
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('purge_record', { rec: recordId });
  if (error) throw error;
}

/** Recycle Bin sidebar badge — a cheap `head: true` count, same visibility
 * rule as `listDeletedRecords` below (admin-only, `supabaseAdmin()` since
 * deleted rows are invisible to the request-scoped client by design). */
export async function deletedRecordCount(ctx: AuthContext): Promise<number> {
  if (!ctx.isAdmin) return 0;
  const { count, error } = await supabaseAdmin()
    .from('records')
    .select('id', { count: 'exact', head: true })
    .not('deleted_at', 'is', null);
  if (error) throw error;
  return count ?? 0;
}

/** Recycle Bin listing — admin-only surface; `supabaseAdmin()` because
 * deleted records are invisible to the request-scoped client (RLS's
 * `records_select` requires `deleted_at IS NULL`) by design. */
export async function listDeletedRecords(ctx: AuthContext): Promise<RecordRow[]> {
  if (!ctx.isAdmin) throw new Error('Admin only');
  const { data, error } = await supabaseAdmin()
    .from('records')
    .select('*')
    .not('deleted_at', 'is', null)
    .order('deleted_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(mapRow);
}

export type { Grant };
