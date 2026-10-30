/**
 * The authorized-context gate.
 *
 * SCHEMA.md: "the function that reads a record takes a permission token only
 * the gate can mint, so forgetting to filter is a compile error rather than a
 * leak." `AuthContext` is that token — its constructor (`authorize()`) is the
 * only exported way to produce one, so a data function that requires an
 * `AuthContext` argument cannot be called without having gone through this
 * gate first. There is no raw-userId escape hatch anywhere in `lib/records/*`.
 *
 * Resolution order: user override, if one exists → else the Role's
 * (template's) value → else **edit**.
 *
 * ⚠️ The last step is contradicted by one document and this comment used to
 * repeat it. `MODULE-2-PLAN.md:324` says *"→ else hidden (default-deny)"*.
 * Everything else says edit: the client's own words
 * (`CLIENT-SPEC-BY-MODULE.md` §8, *"otherwise Edit"*), `SCHEMA-DECISIONS.md:395`
 * (*"unlisted defaults to edit, matching the prototype's VIEWERS model"*),
 * migration 7's literal `coalesce(..., 'edit')`, and the live function itself —
 * checked against a real grantless template in Phase 6a, which returned `edit`.
 * MODULE-2-PLAN is a superseded planning document (the same one `CLAUDE.md`
 * records as stale on "Call recordings") and is stale here too; it is left
 * alone. Getting this backwards is the most dangerous misreading in the whole
 * permission model, so see `GRANT_DEFAULT` below.
 *
 * `effective_grant()` (migration 7) implements exactly this, called here with
 * the service-role client so the browser never gets a direct path to it — field/tab/module
 * permission is an app-gate concern, not RLS (RLS filters rows; it cannot
 * filter keys out of a JSONB document, or express a three-state grant).
 */
import 'server-only';
import { cache } from 'react';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getSessionUser } from '@/lib/auth/session';
import {
  GRANT_DEFAULT,
  resolveTabGrant,
  resolveSubtabGrant,
  resolveFieldGrant,
  type Grant,
  type GrantScope,
} from './grantRules';

/**
 * The resolution rules themselves moved to `grantRules.ts` in Phase 6c and are
 * re-exported here, so every existing `from './permissions'` import keeps
 * working and there is still exactly one implementation.
 *
 * They had to move because the grant matrix became interactive: the browser now
 * recomputes a row the instant a cell is clicked, and a `server-only` module
 * cannot be imported for its VALUES by a Client Component (`CLAUDE.md`
 * § Secrets — a build error by design). `grantRules.ts` holds no secrets and
 * reaches no database. Everything below this line still does both.
 */
export {
  GRANT_DEFAULT,
  GRANT_LEVELS,
  FROZEN_COLUMN_FIELD_KEY,
  VISIBILITY_FIELD_KEY,
  coalesceGrant,
  capGrant,
  resolveModuleGrant,
  resolveTabGrant,
  resolveSubtabGrant,
  resolveFieldGrant,
  resolveScope,
  grantWriteRefusal,
} from './grantRules';
export type { Grant, GrantScope, ScopeCaps, ResolvedScope } from './grantRules';

const AUTH_CONTEXT_BRAND = Symbol('AuthContext');

/**
 * Opaque. The only field anything outside this file may read is `userId`
 * (needed for e.g. `created_by`/`author_id` columns) — everything else about
 * "what can this person see" goes back through a function in this file.
 */
export type AuthContext = {
  readonly userId: string;
  readonly isAdmin: boolean;
  readonly [AUTH_CONTEXT_BRAND]: true;
};

export class NotAuthenticatedError extends Error {
  constructor() {
    super('Not authenticated');
    this.name = 'NotAuthenticatedError';
  }
}

/**
 * The one entry point. Every server action and route handler that touches
 * `lib/records/*` calls this first, before anything else.
 *
 * Deliberately does NOT accept demo-mode sessions — demo mode has no real
 * Supabase JWT, so `auth.uid()` is null for it and every RLS-gated read
 * returns nothing. That gap is real for Module 2 (unlike the auth screens,
 * which demo mode exists to make clickable) and is not silently worked
 * around here; a demo session simply cannot authorize into records.
 */
export const authorize = cache(async (): Promise<AuthContext> => {
  // `getSessionUser()` (validates the JWT against Supabase Auth) and the
  // `auth_is_admin()` RPC (reads `auth.uid()` from the same request's own
  // JWT, via RLS/PostgREST — it needs the request's cookies, not a
  // pre-fetched user object) are independent network round trips with no
  // real dependency between them; running them sequentially just adds their
  // latencies together. Measured live: ~700ms sequential for this pair
  // alone, on every single `authorize()` call across the whole app — the
  // single biggest fixed cost on every server action and page load. In the
  // rare case demo mode is enabled and returns a demo (non-Supabase) user,
  // the admin check's result is simply discarded below — a harmless wasted
  // call in dev only; demo mode is unreachable in production (see this
  // file's own class doc).
  const [user, adminCheck] = await Promise.all([
    getSessionUser(),
    (async () => {
      const supabase = await createSupabaseServerClient();
      return supabase.rpc('auth_is_admin');
    })(),
  ]);
  if (!user || user.isDemo) throw new NotAuthenticatedError();

  const { data, error } = adminCheck;
  if (error) throw error;

  return {
    userId: user.id,
    isAdmin: data === true,
    [AUTH_CONTEXT_BRAND]: true,
  };
});

/**
 * `effective_grants` returns ONE jsonb object keyed `"<kind>:<scope_id>"`, not
 * a row set — see migration 42. A row set was subject to PostgREST's
 * `max_rows` cap, and a truncated grant set is indistinguishable from a short
 * one: the missing scopes would fall through to `GRANT_DEFAULT` (`edit`) and
 * silently hand out access. A single row cannot be truncated by a row limit.
 */
async function fetchAllGrants(userId: string): Promise<Map<string, Grant>> {
  const { data, error } = await supabaseAdmin().rpc('effective_grants', { u: userId });
  if (error) throw error;
  // Fail closed on an unexpected shape rather than treating it as "no grants",
  // which would resolve every scope to `edit`.
  if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('effective_grants returned an unexpected shape');
  }
  return new Map(Object.entries(data as Record<string, Grant>));
}

/**
 * A per-request BOX rather than a plain `cache()`d value, so it can be CLEARED.
 *
 * A bare memo would be a real hazard here, not a theoretical one: the admin
 * permission screens write a grant and then re-render inside the same Server
 * Action response. A cache with no reset would answer that re-render from
 * before the write, so an admin would set a permission, see the old value, and
 * have no way to tell whether the write landed. In the permission system
 * specifically, a stale read that LOOKS authoritative is the worst possible
 * failure mode — hence `invalidateGrants()` below, which every grant writer
 * calls.
 */
const grantBox = cache((): { userId: string | null; grants: Promise<Map<string, Grant>> | null } => ({
  userId: null,
  grants: null,
}));

/**
 * Drops the cached grant set for this request. Called by every writer of
 * `user_grants` / `template_grants` / `user_templates` (`adminGrants.ts`,
 * `adminUsers.ts`) so a write is never read back stale within the request that
 * made it.
 *
 * Deliberately takes no user id and clears unconditionally: a template grant
 * changes the effective permissions of every user attached to that template,
 * not just the one whose screen is open, and this cache holds at most one
 * user's set anyway.
 */
export function invalidateGrants(): void {
  const box = grantBox();
  box.userId = null;
  box.grants = null;
}

/**
 * Every stored grant for one user, fetched ONCE per request.
 *
 * ⚠️ This replaced a per-scope `effective_grant()` call, and the reason is
 * worth keeping: `fieldGrants`/`tabGrants` below are `Promise.all` over a
 * per-scope lookup. Concurrent is not the same as batched — each element was
 * still its own PostgREST round trip. Against the live remote project
 * (us-west-2, 270-800ms measured per call) ONE drawer open as a non-admin
 * issued ~292 of them: 17 for the dashboard columns, 17 more inside
 * `listRecords`, 129 inside `getRecord`, 129 across the drawer's tabs, and 13
 * for the tab strip. They all read the same two tiny tables.
 *
 * `effective_grants(u)` returns the whole resolved set in one call, with the
 * same `coalesce(override, template, …)` precedence, and the box above keeps
 * it to one call per request no matter how many callers ask.
 *
 * Service-role, because the function is revoked from PUBLIC — field-level
 * permission is resolved by the data layer, never exposed for a browser to
 * probe directly (SCHEMA.md; same posture as `effective_grant` itself).
 *
 * ADMINS NEVER REACH THIS. Every caller below short-circuits on `ctx.isAdmin`
 * before calling `rawGrant`, so an admin request still costs zero grant
 * queries — this is lazy and simply never runs for them.
 */
async function allGrantsFor(userId: string): Promise<Map<string, Grant>> {
  const box = grantBox();
  if (box.userId !== userId || !box.grants) {
    box.userId = userId;
    // A REJECTED promise must not be cached. Storing it unconditionally meant
    // one transient failure was replayed to every later `rawGrant` in the
    // request with no retry, turning a blip into a guaranteed page error.
    // Clearing the box on rejection lets the next caller try again; the throw
    // still propagates to this one.
    box.grants = fetchAllGrants(userId).catch((e) => {
      if (box.grants) { box.userId = null; box.grants = null; }
      throw e;
    });
  }
  return box.grants;
}

/**
 * Raw grant for one scope, read out of the per-request set above.
 *
 * A scope with no stored grant is ABSENT from that set, and resolves to
 * `GRANT_DEFAULT` here — which is the third arm of `effective_grant()`'s own
 * coalesce, so a miss means exactly what it always meant. See `GRANT_DEFAULT`
 * for why that default is `edit` and not `hidden`.
 *
 * Callers outside this file should reach this only through `fieldGrant` /
 * `moduleGrant` / `tabGrant` below, never directly — those apply the floors
 * and admin shortcuts a bare lookup does not.
 */
async function rawGrant(
  ctx: AuthContext,
  kind: GrantScope,
  scopeId: string,
  moduleId?: string | null,
): Promise<Grant> {
  const grants = await allGrantsFor(ctx.userId);

  /*
   * Module-specific first, then global — the same order `effective_grant()`
   * applies in SQL, and the reason `effective_grants()` now emits two key
   * shapes (migration 79):
   *
   *   "tab:<id>"              a grant that applies everywhere
   *   "tab:<id>:<module_id>"  a grant for one module only
   *
   * Reading only the general key would ignore every per-module override;
   * reading only the specific one would ignore every global grant. Both, in
   * this order, is the rule.
   */
  if (moduleId) {
    const specific = grants.get(`${kind}:${scopeId}:${moduleId}`);
    if (specific) return specific;
  }
  return grants.get(`${kind}:${scopeId}`) ?? GRANT_DEFAULT;
}

/* -------------------------------------------------------------------------- */
/* The Permissions spec's settings (migrations 9810-9812)                      */
/* -------------------------------------------------------------------------- */

export type CompanyAction = 'create' | 'team' | 'archive' | 'modules' | 'pipeline' | 'pipeline_change';
export type AdminPage =
  | 'users' | 'permissions' | 'presets' | 'numbers' | 'residuals' | 'integrations' | 'automations' | 'recycle_bin';
export type ModuleScope = 'hidden' | 'mine' | 'all';

export type Permissions = {
  superAdmin: boolean;
  userType: string | null;
  /** Every resolved setting: `action.*`, `admin.*`, `*.scope`, `items.*`. */
  settings: Record<string, string>;
  /** Module id → Hidden / Only mine / All (Tickets already follows Cases). */
  modules: Record<string, ModuleScope>;
};

/**
 * The caller's whole resolved set, read once per request through the same
 * resolver the database policies use (`my_permissions`, migration 9812) — so
 * a button and the write behind it can never disagree.
 */
const permsBox = cache((): { userId: string | null; perms: Promise<Permissions> | null } => ({ userId: null, perms: null }));

export async function permissionsFor(ctx: AuthContext): Promise<Permissions> {
  const box = permsBox();
  if (box.userId !== ctx.userId || !box.perms) {
    box.userId = ctx.userId;
    box.perms = (async () => {
      const supabase = await createSupabaseServerClient();
      const { data, error } = await supabase.rpc('my_permissions');
      if (error) throw error;
      const p = (data ?? {}) as Partial<Permissions>;
      return {
        superAdmin: Boolean(p.superAdmin),
        userType: p.userType ?? null,
        settings: p.settings ?? {},
        modules: (p.modules ?? {}) as Record<string, ModuleScope>,
      };
    })().catch((e) => {
      box.userId = null;
      box.perms = null;
      throw e;
    });
  }
  return box.perms;
}

/** Re-read on the next ask — after a permission change in this request. */
export function invalidatePermissions(): void {
  const box = permsBox();
  box.userId = null;
  box.perms = null;
}

/** A company-wide action (Permissions spec): create, team, archive, modules, pipeline. */
export async function canDo(ctx: AuthContext, action: CompanyAction): Promise<boolean> {
  if (ctx.isAdmin) return true;
  return (await permissionsFor(ctx)).settings[`action.${action}`] === 'yes';
}

/** Full access to one admin page (Users, Permissions, Presets, …). */
export async function canOpenAdminPage(ctx: AuthContext, page: AdminPage): Promise<boolean> {
  if (ctx.isAdmin) return true;
  return (await permissionsFor(ctx)).settings[`admin.${page}`] === 'full';
}

/** Hidden / Only mine / All for one module. */
export async function moduleScope(ctx: AuthContext, moduleId: string): Promise<ModuleScope> {
  if (ctx.isAdmin) return 'all';
  return (await permissionsFor(ctx)).modules[moduleId] ?? 'hidden';
}

/** One of the own/all scopes — notifications, email, phone — or the
 *  Communication tab's own/whole-org. */
export async function seesAll(ctx: AuthContext, what: 'notifications' | 'email' | 'phone' | 'communication'): Promise<boolean> {
  if (ctx.isAdmin) return true;
  const v = (await permissionsFor(ctx)).settings[`${what}.scope`];
  return v === 'all' || v === 'org';
}

/**
 * A module's level, for the screens that still ask for one.
 *
 * Module access is Hidden / Only mine / All now (Permissions spec), not a
 * Hidden / View / Edit level: what a user may change is decided by tabs and
 * fields. So a module is `hidden` when the user cannot open it and `edit`
 * otherwise. The Records List is no longer forced Hidden for everyone but a
 * Super admin — its setting decides, as for any module (`Admin` has it).
 */
export async function moduleGrant(
  ctx: AuthContext,
  moduleId: string,
  // Kept for the existing call sites; the setting decides now.
  _moduleAdminOnly?: boolean,
): Promise<Grant> {
  void _moduleAdminOnly;
  if (ctx.isAdmin) return 'edit';
  return (await moduleScope(ctx, moduleId)) === 'hidden' ? 'hidden' : GRANT_DEFAULT;
}

/**
 * "Display / remove records from modules" — one company-wide yes/no, for a
 * display module the user can open. A module that shows open cases is
 * automatic and never set by hand. Mirrors `module_membership_allowed`.
 */
export async function membershipAllowed(
  ctx: AuthContext,
  module: { id: string; adminOnly: boolean; kind?: string; showsOpenCases?: boolean },
): Promise<boolean> {
  if (ctx.isAdmin) return true;
  if (module.kind && module.kind !== 'display') return false;
  if (module.showsOpenCases) return false;
  if (!(await canDo(ctx, 'modules'))) return false;
  return (await moduleScope(ctx, module.id)) !== 'hidden';
}

/**
 * Tab-level access.
 *
 * This carried a ⚠️ **"Nothing calls this"** warning from Phase 6b until the
 * grant chain was wired: the drawer built its tab strip from `tabsForModule()`
 * with no grant filter, so a tab set to Hidden still appeared and its contents
 * were restricted only where an individual field happened to carry its own
 * grant — nothing at all for Cases, Files, Logins, Statements, Updates or
 * Communication, none of which are made of fields. The warning is gone because
 * the control now does something, in both halves: `tabAccess.ts` resolves it
 * for every render and every write, and `capGrant` chains it under the module.
 */
export async function tabGrant(
  ctx: AuthContext,
  tabId: string,
  /** The module this tab is being viewed in. Omitted means "no particular
   *  module", which resolves to the global grant — the behaviour before
   *  per-module grants existed, and still the right answer when there is
   *  genuinely no module in hand. */
  moduleId?: string | null,
): Promise<Grant> {
  const raw = ctx.isAdmin ? GRANT_DEFAULT : await rawGrant(ctx, 'tab', tabId, moduleId);
  return resolveTabGrant(raw, ctx.isAdmin);
}

/**
 * A scope's OWN setting, or null when nothing is set on it — the "Not set"
 * of the Permissions screen. Same lookup order as `rawGrant`, without the
 * default, so a caller can fall back to the scope above instead.
 */
async function explicitGrant(
  ctx: AuthContext,
  kind: GrantScope,
  scopeId: string,
  moduleId?: string | null,
): Promise<Grant | null> {
  const grants = await allGrantsFor(ctx.userId);
  if (moduleId) {
    const specific = grants.get(`${kind}:${scopeId}:${moduleId}`);
    if (specific) return specific;
  }
  return grants.get(`${kind}:${scopeId}`) ?? null;
}

/**
 * Subtab-level access.
 *
 * Permissions spec: "Sub tabs and fields: by default these follow their tab
 * … The most specific setting wins. A field or sub tab setting beats its tab
 * setting." So with `tabId` given: the sub-tab's own setting if it has one —
 * higher OR lower than the tab — otherwise the tab's. Without `tabId`, only
 * the sub-tab's own scope (the old shape, for callers that have no tab).
 * The module stays the outer limit; callers cap with `capGrant`.
 */
export async function subtabGrant(
  ctx: AuthContext,
  subtabId: string,
  moduleId?: string | null,
  tabId?: string | null,
): Promise<Grant> {
  if (ctx.isAdmin) return resolveSubtabGrant(GRANT_DEFAULT, true);
  const raw =
    (await explicitGrant(ctx, 'subtab', subtabId, moduleId)) ??
    (tabId ? await explicitGrant(ctx, 'tab', tabId, moduleId) : null) ??
    GRANT_DEFAULT;
  return resolveSubtabGrant(raw, false);
}

/** Subtab grants for a whole tab's worth of subtabs, in no round trips beyond
 *  the one `allGrantsFor` already made. */
export async function subtabGrants(
  ctx: AuthContext,
  subtabs: { id: string; tabId: string }[],
  moduleId?: string | null,
): Promise<Map<string, Grant>> {
  const entries = await Promise.all(
    subtabs.map(async (s) => [s.id, await subtabGrant(ctx, s.id, moduleId, s.tabId)] as const),
  );
  return new Map(entries);
}

/** Tab grants for a whole drawer's tab strip. Genuinely one round trip now:
 * every element resolves out of the single per-request `allGrantsFor` set, so
 * this `Promise.all` awaits cached work rather than 13 separate queries. */
export async function tabGrants(
  ctx: AuthContext,
  tabIds: string[],
  moduleId?: string | null,
): Promise<Map<string, Grant>> {
  const entries = await Promise.all(
    tabIds.map(async (id) => [id, await tabGrant(ctx, id, moduleId)] as const),
  );
  return new Map(entries);
}

/**
 * Field-level access.
 *
 * Permissions spec — "the most specific setting wins": the field's own
 * setting if it has one (higher or lower than its tab: "Pricing can be View
 * only for Sales agents while one Pricing field is Edit"), else its
 * sub-tab's, else its tab's, else Edit. A config `Field` carries `tabId` and
 * `subtabId`, so every caller holding one gets the whole chain; the module
 * stays the outer limit (callers cap with `capGrant`). The SQL twin is
 * `user_record_field_grant` (migration 9832) — the two must agree.
 *
 * Then the two floors MODULE-2-PLAN §5.1 specifies:
 *   - Deal Name is never Hidden, clamped to View minimum.
 *   - Record creator (any field flagged `read_only`) is View at most, for
 *     everyone, including admins — never Edit, no matter what a template says.
 */
export async function fieldGrant(
  ctx: AuthContext,
  field: { id: string; key: string; readOnly: boolean; type?: string; tabId?: string; subtabId?: string | null },
  moduleId?: string | null,
): Promise<Grant> {
  const raw = ctx.isAdmin
    ? GRANT_DEFAULT
    : (await explicitGrant(ctx, 'field', field.id, moduleId)) ??
      (field.subtabId ? await explicitGrant(ctx, 'subtab', field.subtabId, moduleId) : null) ??
      (field.tabId ? await explicitGrant(ctx, 'tab', field.tabId, moduleId) : null) ??
      GRANT_DEFAULT;
  const resolved = resolveFieldGrant(raw, field, ctx.isAdmin);
  // Team pickers need "Add / remove team members" to change — the same cap
  // `user_record_field_grant` applies (migration 9811).
  if (!ctx.isAdmin && field.type === 'team_member' && resolved === 'edit' && !(await canDo(ctx, 'team'))) {
    return 'view';
  }
  return resolved;
}

/** Field grants for a whole tab/drawer's worth of fields.
 *
 * This comment used to claim "one round trip" while the body below issued one
 * PostgREST call PER FIELD — 129 of them for a full drawer. That is now true
 * rather than aspirational: `rawGrant` reads the per-request `allGrantsFor`
 * map, so the map is fetched once and every field is resolved in memory. */
export async function fieldGrants(
  ctx: AuthContext,
  fields: { id: string; key: string; readOnly: boolean; type?: string; tabId?: string; subtabId?: string | null }[],
  moduleId?: string | null,
): Promise<Map<string, Grant>> {
  const entries = await Promise.all(
    fields.map(async (f) => [f.id, await fieldGrant(ctx, f, moduleId)] as const),
  );
  return new Map(entries);
}

export function requireEdit(grant: Grant, what: string): void {
  if (grant !== 'edit') throw new Error(`No edit access to ${what}`);
}
