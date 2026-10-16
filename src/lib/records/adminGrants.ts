/**
 * The permission grant matrix — read (Phase 6b) and write (Phase 6c).
 *
 * Renders what a template grants, and what one user actually resolves to,
 * across every scope the permission model has: modules, tabs and fields; and,
 * since 6c, changes them. The plan split the two on purpose: a wrong grant does
 * not crash, it quietly shows someone a field they should not see, so the screen
 * that DISPLAYS the model was verified against `effective_grant()` before any
 * code existed that could change it.
 *
 * ── FOUR STATES, NOT THREE ───────────────────────────────────────────────
 * `effective_grant()` resolves user override → template → **Edit**
 * (`GRANT_DEFAULT`). A scope with no row is therefore the MOST permissive
 * state, not the least. A matrix that renders three states leaves an admin
 * reading a blank cell as "no access", wrong in the most dangerous direction —
 * so "not set" is its own state here, labelled with what it actually does.
 *
 * ── WHAT IS ACTUALLY ENFORCED, WHICH IS NOT ALL OF IT ────────────────────
 * Surveyed across the whole of `src/` while building this, because a matrix
 * that offers a control with no effect is the same lie as Phase 4's
 * `status_field_id` or a Connect button that connects nothing:
 *
 *   - **field** — fully enforced, and enforced the way `CLAUDE.md` §3 demands.
 *     A hidden field's key is stripped from `records.values` before the row
 *     leaves the data layer (`records.ts:49,159,206`), dropped from dashboard
 *     columns and the drawer's field grid (`[module]/page.tsx:74,252`), removed
 *     from activity history (`activity.ts:65`), and refused on write
 *     (`records.ts:272,315`, `repeatGroups.ts:40`). Absent, not blanked.
 *   - **module** — enforced at the route: `hidden` redirects to `/dashboard`
 *     and `view` withholds every edit control (`[module]/page.tsx:61,109,129`).
 *     One honest caveat, shown on the screen: the SIDEBAR still lists a hidden
 *     module, because `(app)/layout.tsx:24-25` filters on `admin_only` alone.
 *     The link is visible; following it bounces.
 *   - **tab** — **stored and resolvable, but read by nothing.** `tabGrant()`
 *     exists in `permissions.ts` and has no callers anywhere; the drawer builds
 *     its tab strip from `tabsForModule()` with no grant filter. Setting a tab
 *     to Hidden today changes nothing an admin can observe. Rendered anyway —
 *     the rows are real and 6c can legitimately write them — but every tab row
 *     says so, rather than letting someone lock down "Private" and believe it.
 *
 * ── WHY THIS DOES NOT CALL `effective_grant()` ───────────────────────────
 * It would be 148 RPCs per page load (6 modules + 13 tabs + 129 fields), and
 * the function takes one scope. So resolution is done here with
 * `coalesceGrant()` and the floors from `permissions.ts` — the SAME functions
 * the live enforcement path calls, not a second copy of the rules.
 *
 * That still leaves an assumption to prove rather than assert, which is what
 * the plan's verify step asks for: `scripts/verify-grant-matrix.mjs` runs
 * `effective_grant()` against every real scope in the live database and
 * compares it to the same coalesce, including the both-absent case.
 *
 * ── NOT CACHED, DELIBERATELY ─────────────────────────────────────────────
 * No `revalidateConfig()`, no `unstable_cache`, no exception. Editing a
 * template must reach every attached user on their next request with no push
 * step (`CLIENT-SPEC-BY-MODULE.md` §8), which only works while permissions
 * resolve at call time. `adminConfig.test.ts` pins the inverse rule for this
 * module's siblings; a stale permission looks exactly like a correct one.
 *
 * The reflex in this codebase is now the opposite — every Presets write calls
 * `revalidateConfig()` — which is exactly why the guard test lists this module
 * and why the writers below say so at the point where the call would go.
 *
 * ── WHAT THE 6c WRITERS DO AND DO NOT VALIDATE ───────────────────────────
 * Shape is Zod's, at the action boundary. Existence of the scope is the
 * database's (migration 39's trigger — `scope_id` is polymorphic and cannot
 * carry a foreign key). What is left for this module is the one check that needs
 * the field row itself: refusing a grant that the read-time floors would cancel,
 * so a cell cannot accept Hidden, store it, and then display View.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { invalidateGrants, type AuthContext } from './permissions';
import {
  FROZEN_COLUMN_FIELD_KEY,
  grantWriteRefusal,
  resolveScope,
  type Grant,
  type GrantScope,
  type ScopeCaps,
} from './grantRules';
import { loadConfig } from './config';
import { assertAdmin } from './adminConfig';
import type {
  ClearTemplateGrantInput,
  ClearUserGrantInput,
  SetTemplateGrantInput,
  SetTemplateGrantsInput,
  SetUserGrantsInput,
  SetInviteGrantsInput,
  GrantBatchItem,
  SetUserGrantInput,
} from './adminSchemas';

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

/* `Enforcement` / `ENFORCEMENT_NOTE` — the survey summarised in this file's
 * header — live in `grantEnforcement.ts`, which is NOT `server-only`. The
 * matrix is a Client Component and importing a value from here would pull the
 * service-role client into the browser bundle. Same facts, one copy. */

/** One scope, with both sources of state and both resolutions. */
export type ScopeRow = {
  kind: GrantScope;
  id: string;
  label: string;
  /** Disambiguates the label — a field's key, a module's slug. 129 fields
   * include more than one "Notes" and more than one "Provider". */
  detail: string;
  /** `template_grants` for this template. Null = no row = inherits. */
  templateGrant: Grant | null;
  /** `user_grants` for this user. Null = no row. Always null on a template
   * matrix, which has no user. */
  userGrant: Grant | null;
  /** `coalesce(user, template, 'edit')` — exactly what `effective_grant()`
   * returns for this scope, before the app's own floors. */
  resolved: Grant;
  /** What the subject actually experiences, after `grantRules.ts` applies the
   * admin shortcut, the admin-only module floor and the two field caps. This
   * is the column that tells the truth; `resolved` is the column that explains
   * where it came from. */
  effective: Grant;
  /** Why `effective` differs from `resolved`, or why this scope can never be
   * changed. Null when the two agree and nothing is capped. 6d turns each of
   * these into a locked control. */
  lock: string | null;
  /** Everything else that decides this row's answer, flattened to booleans so
   * it survives the trip to the browser. Phase 6c: the matrix is interactive,
   * and clicking a cell has to move `resolved` and `effective` immediately —
   * those two columns are the whole point of the screen. The client recomputes
   * them by handing this straight back to `resolveScope`, the same function
   * that produced them here, rather than by re-deriving the rules. */
  caps: ScopeCaps;
};

export type SubtabGroup = {
  subtabId: string | null;
  subtabLabel: string | null;
  /** The subtab's OWN grant row. A real scope since migration 50; `null` for
   *  the synthetic "loose fields" group, which has no subtab behind it. */
  subtab: ScopeRow | null;
  fields: ScopeRow[];
};

export type TabGroup = {
  /** The tab's own grant row. */
  tab: ScopeRow;
  /** True when the tab holds no fields at all — a system tab like Updates or
   * Cases, whose content is not field-shaped. Its own grant is the only lever
   * over it. */
  fieldless: boolean;
  /**
   * Every module this tab appears in, via `module_tab_order`.
   *
   * The matrix needs it to show the CHAIN rather than three independent
   * answers: a tab's real ceiling is the best module grant among these, and a
   * field's is that capped tab. Carried as ids rather than a resolved grant
   * because the browser recomputes the whole column the instant a module cell
   * is clicked — a precomputed ceiling would be stale one keystroke later,
   * which is the exact divergence this screen is written against.
   */
  moduleIds: string[];
  groups: SubtabGroup[];
};

export type MatrixSubject =
  | {
      kind: 'template';
      id: string;
      label: string;
      attachedUsers: number;
    }
  | {
      kind: 'user';
      id: string;
      label: string;
      email: string;
      /** The subject's own admin status — NOT the viewing admin's. Every grant
       * below is overridden to Edit for an admin, so this decides whether the
       * matrix means anything at all for this person. */
      isAdmin: boolean;
      roleName: string;
      templateId: string | null;
      templateLabel: string | null;
      /** "Template: X" / "Template: X (edited)" / "Custom" / "Default" — the
       * client's three labels plus the state he did not name. Computed, never
       * stored (`adminUsers.ts` computes the same thing for its badge). */
      permissionLabel: string;
    };

/** A grant row pointing at a scope the matrix cannot show — an archived field,
 * or a tab/module removed by direct SQL. The row still resolves in
 * `effective_grant()`, so it is a real permission nobody can see or clear. */
export type OrphanGrant = {
  source: 'template' | 'user';
  kind: GrantScope;
  scopeId: string;
  level: Grant;
};

export type GrantMatrix = {
  subject: MatrixSubject;
  /**
   * Which module this matrix describes, or null for "All modules".
   *
   * Carried so the BROWSER can tell two matrices apart. A grant is stored per
   * (scope, module), and the screen lets you switch modules without
   * remounting — on the page through a `?module=` navigation, in the invite
   * dialog through a refetch. Without this the client had no way to know the
   * subject under its feet had changed, so its optimistic edits from one
   * module were still being painted onto the next one's rows.
   */
  moduleScopeId: string | null;
  /** The SUBJECT's admin status, lifted out of `subject` so the client can pass
   * it to `resolveScope` without narrowing the union first. False for a
   * template, which describes a role rather than a person. */
  subjectIsAdmin: boolean;
  modules: ScopeRow[];
  /**
   * One `membership` row per display module the subject could move records
   * into or out of — "may add records to / remove them from this module"
   * (migration 9766). Keyed to its module by `id`, which IS the module id.
   * Admin-only modules and modules that fill themselves from open cases
   * (migration 9764) are left out: nobody chooses membership there.
   */
  memberships: ScopeRow[];
  tabs: TabGroup[];
  counts: {
    scopes: number;
    /** Scopes with a `template_grants` row. */
    templateSet: number;
    /** Scopes with a `user_grants` row. */
    userSet: number;
    /** Scopes where the subject ends up with less than Edit. */
    restricted: number;
  };
  orphans: OrphanGrant[];
};

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export type GrantKey = `${GrantScope}:${string}`;
const grantKey = (kind: GrantScope, scopeId: string): GrantKey => `${kind}:${scopeId}`;

/**
 * The grants in force for one subject, in one module context.
 *
 * ⚠ THE MODULE FILTER IS NOT OPTIONAL POLISH. Rows are keyed `kind:id`, and
 * since §2.2's per-module granularity a subject can hold TWO rows for the same
 * scope — one global, one for a module. Reading both into the same map would
 * let whichever arrived last win, so the matrix would show Leads' value while
 * claiming to describe every module, at random.
 *
 * `moduleId` null means the global rows alone — the "All modules" view, and
 * exactly what this function returned before modules existed.
 *
 * With a module, the module's own row wins where it exists and the global row
 * shows through where it does not, which is the same precedence
 * `effective_grant()` applies. `moduleSpecific` reports WHICH keys came from
 * the module, so the matrix can mark them as overrides rather than leaving an
 * admin unable to tell an inherited value from one set here.
 */
async function readGrants(
  table: 'template_grants' | 'user_grants' | 'invite_grants',
  column: 'template_id' | 'user_id' | 'invite_id',
  ownerId: string,
  moduleId: string | null = null,
): Promise<{ grants: Map<GrantKey, Grant>; moduleSpecific: Set<GrantKey> }> {
  const { data, error } = await supabaseAdmin()
    .from(table)
    .select('scope_kind, scope_id, grant_level, module_id')
    .eq(column, ownerId);
  if (error) throw error;

  const rows = (data ?? []) as {
    scope_kind: GrantScope;
    scope_id: string;
    grant_level: Grant;
    module_id: string | null;
  }[];

  const grants = new Map<GrantKey, Grant>();
  const moduleSpecific = new Set<GrantKey>();

  // Global first, so the module pass below overwrites rather than races.
  for (const r of rows) {
    if (r.module_id === null) grants.set(grantKey(r.scope_kind, r.scope_id), r.grant_level);
  }
  if (moduleId) {
    for (const r of rows) {
      if (r.module_id !== moduleId) continue;
      const key = grantKey(r.scope_kind, r.scope_id);
      grants.set(key, r.grant_level);
      moduleSpecific.add(key);
    }
  }

  return { grants, moduleSpecific };
}

export async function listTemplateGrants(
  ctx: AuthContext,
  templateId: string,
  moduleId: string | null = null,
): Promise<Map<GrantKey, Grant>> {
  assertAdmin(ctx);
  return (await readGrants('template_grants', 'template_id', templateId, moduleId)).grants;
}

export async function listUserGrants(
  ctx: AuthContext,
  userId: string,
  moduleId: string | null = null,
): Promise<Map<GrantKey, Grant>> {
  assertAdmin(ctx);
  return (await readGrants('user_grants', 'user_id', userId, moduleId)).grants;
}

/* -------------------------------------------------------------------------- */
/* Building the matrix                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Assembles every scope row for one subject.
 *
 * `isAdmin` is the SUBJECT's, never the viewer's — an admin resolves to Edit
 * everywhere by the shortcut in `permissions.ts`, so passing the wrong one
 * would make the matrix describe the person reading it.
 */
async function buildMatrix(
  subject: MatrixSubject,
  templateGrants: Map<GrantKey, Grant>,
  userGrants: Map<GrantKey, Grant>,
  isAdmin: boolean,
  moduleScopeId: string | null,
): Promise<GrantMatrix> {
  const config = await loadConfig();

  const seen = new Set<GrantKey>();
  let restricted = 0;

  /* One row, resolved by the SAME function the browser calls after an edit —
   * `resolveScope` owns both the floors and the lock wording (`grantRules.ts`),
   * so the server render and the optimistic update cannot disagree about what a
   * cell means or why it is capped. */
  const row = (kind: GrantScope, id: string, label: string, detail: string, caps: ScopeCaps): ScopeRow => {
    const key = grantKey(kind, id);
    seen.add(key);
    const templateGrant = templateGrants.get(key) ?? null;
    const userGrant = userGrants.get(key) ?? null;
    const { resolved, effective, lock } = resolveScope(caps, userGrant, templateGrant, isAdmin);
    if (effective !== 'edit') restricted++;
    return { kind, id, label, detail, templateGrant, userGrant, resolved, effective, lock, caps };
  };

  /* ---- modules ---- */
  const modules = [...config.modules]
    .sort((a, b) => a.position - b.position)
    .map((m) => row('module', m.id, m.label, m.slug, { kind: 'module', adminOnly: m.adminOnly }));

  /* ---- add / remove records, per module ---- */
  const memberships = [...config.modules]
    .sort((a, b) => a.position - b.position)
    .filter((m) => m.kind === 'display' && !m.adminOnly && !m.showsOpenCases)
    .map((m) =>
      row('membership', m.id, 'Add / remove records', m.slug, { kind: 'membership', adminOnly: m.adminOnly }),
    );

  /* ---- tabs, with their fields ---- */
  const subtabsByTab = new Map<string, typeof config.subtabs>();
  for (const s of config.subtabs) {
    const list = subtabsByTab.get(s.tabId) ?? [];
    list.push(s);
    subtabsByTab.set(s.tabId, list);
  }

  const fieldsByTab = new Map<string, typeof config.fields>();
  for (const f of config.fields) {
    const list = fieldsByTab.get(f.tabId) ?? [];
    list.push(f);
    fieldsByTab.set(f.tabId, list);
  }

  const tabs: TabGroup[] = [...config.tabs]
    .sort((a, b) => a.position - b.position)
    .map((t) => {
      const tabRow = row('tab', t.id, t.label, t.key, { kind: 'tab' });

      const tabFields = (fieldsByTab.get(t.id) ?? []).sort((a, b) => a.position - b.position);
      const subtabs = (subtabsByTab.get(t.id) ?? []).sort((a, b) => a.position - b.position);

      // `detail` IS the field key for a field row, which is what makes the
      // frozen-column cap expressible as a boolean here rather than as a key
      // comparison the browser would have to repeat.
      const fieldRow = (f: (typeof config.fields)[number]) =>
        row('field', f.id, f.label, f.key, {
          kind: 'field',
          readOnly: f.readOnly,
          frozenColumn: f.key === FROZEN_COLUMN_FIELD_KEY,
        });

      // Subtabs ARE a grant scope, since migration 50 — this block used to say
      // the opposite ("there is no fourth value"), which was true of the schema
      // and false of the client's §8, which asks for the grant at "module
      // access, tab/subtab access, and individual field access".
      const groups: SubtabGroup[] = subtabs.length
        ? subtabs.map((s) => ({
            subtabId: s.id,
            subtabLabel: s.label,
            subtab: row('subtab', s.id, s.label, s.key, { kind: 'tab' }),
            fields: tabFields.filter((f) => f.subtabId === s.id).map(fieldRow),
          }))
        : [];

      // The synthetic group for fields sitting directly on the tab. It has no
      // subtab behind it, so it gets no grant row — its fields answer to the
      // tab itself.
      const looseFields = tabFields.filter((f) => !f.subtabId);
      if (looseFields.length || !groups.length) {
        groups.unshift({ subtabId: null, subtabLabel: null, subtab: null, fields: looseFields.map(fieldRow) });
      }

      const moduleIds = config.moduleTabOrder
        .filter((r) => r.tabId === t.id)
        .map((r) => r.moduleId);

      return { tab: tabRow, fieldless: tabFields.length === 0, moduleIds, groups };
    });

  /* ---- grants pointing at scopes that are not in the tree ---- */
  const orphans: OrphanGrant[] = [];
  const collectOrphans = (source: 'template' | 'user', grants: Map<GrantKey, Grant>) => {
    for (const [key, level] of grants) {
      if (seen.has(key)) continue;
      // Split on the FIRST colon only — the scope id is a uuid, but nothing
      // guarantees that forever, and a greedy split would silently mangle it.
      const at = key.indexOf(':');
      orphans.push({
        source,
        kind: key.slice(0, at) as GrantScope,
        scopeId: key.slice(at + 1),
        level,
      });
    }
  };
  collectOrphans('template', templateGrants);
  collectOrphans('user', userGrants);

  return {
    subject,
    subjectIsAdmin: isAdmin,
    moduleScopeId,
    modules,
    memberships,
    tabs,
    counts: {
      scopes: seen.size,
      templateSet: templateGrants.size - orphans.filter((o) => o.source === 'template').length,
      userSet: userGrants.size - orphans.filter((o) => o.source === 'user').length,
      restricted,
    },
    orphans,
  };
}

/**
 * What one template grants, and what a **non-admin** user carrying only it
 * would resolve to.
 *
 * `isAdmin: false` is the right frame even though every profile in this
 * database is currently a super_admin: a template is a description of a role,
 * not of a person, and showing it as "everything Edit, because whoever holds it
 * is an admin" would make it unreadable. The per-user matrix is where a real
 * person's admin status enters.
 */
export async function templateGrantMatrix(
  ctx: AuthContext,
  templateId: string,
  /** Which module's values to show. Null is the "All modules" view: the global
   *  grants, and what this screen showed before §2.2's per-module granularity. */
  moduleId: string | null = null,
): Promise<GrantMatrix | null> {
  assertAdmin(ctx);
  const supabase = supabaseAdmin();

  const [templateRes, attachedRes] = await Promise.all([
    supabase.from('permission_templates').select('id, label').eq('id', templateId).maybeSingle(),
    supabase.from('user_templates').select('user_id').eq('template_id', templateId),
  ]);
  if (templateRes.error) throw templateRes.error;
  if (attachedRes.error) throw attachedRes.error;
  if (!templateRes.data) return null;

  const templateGrants = await listTemplateGrants(ctx, templateId, moduleId);

  return buildMatrix(
    {
      kind: 'template',
      id: templateRes.data.id,
      label: templateRes.data.label,
      attachedUsers: (attachedRes.data ?? []).length,
    },
    templateGrants,
    new Map(),
    false,
    moduleId,
  );
}

/**
 * What one real person resolves to, with both sources of state side by side —
 * the template's grant, their own override, and the result.
 *
 * The scope decision of 2026-09-05 (`remaining-plan.md` § The scope question)
 * is why the override column exists: two of the client's three permission
 * labels are *defined by* `user_grants` rows, and nothing in the build could
 * create one before 6c. This screen is where they become visible.
 */
export async function userGrantMatrix(
  ctx: AuthContext,
  userId: string,
  moduleId: string | null = null,
): Promise<GrantMatrix | null> {
  assertAdmin(ctx);
  const supabase = supabaseAdmin();

  const { data: profile, error: profileErr } = await supabase
    .from('profiles')
    .select('id, email, full_name, role_id')
    .eq('id', userId)
    .is('deleted_at', null)
    .maybeSingle();
  if (profileErr) throw profileErr;
  if (!profile) return null;

  const [roleRes, assignmentRes, userGrants] = await Promise.all([
    supabase.from('roles').select('name, is_admin').eq('id', profile.role_id).maybeSingle(),
    supabase.from('user_templates').select('template_id').eq('user_id', userId).maybeSingle(),
    listUserGrants(ctx, userId, moduleId),
  ]);
  if (roleRes.error) throw roleRes.error;
  if (assignmentRes.error) throw assignmentRes.error;

  const templateId = assignmentRes.data?.template_id ?? null;
  let templateLabel: string | null = null;
  let templateGrants = new Map<GrantKey, Grant>();
  if (templateId) {
    const { data: template, error } = await supabase
      .from('permission_templates')
      .select('label')
      .eq('id', templateId)
      .maybeSingle();
    if (error) throw error;
    templateLabel = template?.label ?? null;
    templateGrants = await listTemplateGrants(ctx, templateId, moduleId);
  }

  const hasOverrides = userGrants.size > 0;
  const permissionLabel = templateLabel
    ? hasOverrides
      ? `Template: ${templateLabel} (edited)`
      : `Template: ${templateLabel}`
    : hasOverrides
      ? 'Custom'
      : 'Default';

  return buildMatrix(
    {
      kind: 'user',
      id: profile.id,
      label: profile.full_name ?? profile.email,
      email: profile.email,
      isAdmin: roleRes.data?.is_admin ?? false,
      roleName: roleRes.data?.name ?? 'Unknown role',
      templateId,
      templateLabel,
      permissionLabel,
    },
    templateGrants,
    userGrants,
    roleRes.data?.is_admin ?? false,
    moduleId,
  );
}

/* -------------------------------------------------------------------------- */
/* Writes — Phase 6c                                                          */
/* -------------------------------------------------------------------------- */

/**
 * What a grant write hands back to the matrix: nothing on success (the screen
 * already knows what it asked for and has drawn it), or a sentence to render
 * beside the row.
 *
 * Not `Result` from `adminConfig.ts` — that returns an `id` on success, and a
 * grant has none: its identity is (owner, kind, scope), all three of which the
 * caller supplied. A `Result` here would mean inventing a value to satisfy a
 * shape.
 */
export type GrantResult = { ok: true } | { ok: false; message: string };

/** Migration 39's trigger, and the underlying `23503` class generally. */
const FOREIGN_KEY_VIOLATION = '23503';

const scopeGone: GrantResult = {
  ok: false,
  message:
    'That module, tab or field no longer exists — this screen is out of date. Reload the page before setting anything else.',
};

/**
 * The one validation that needs the config rather than the request: is this
 * grant one the read-time floors would immediately cancel?
 *
 * The caps come from the same `loadConfig()` the matrix rendered from, never
 * from the caller — a request that claimed a field was not read-only would
 * otherwise talk the check out of running. Returns null when the write may
 * proceed. See `grantWriteRefusal` for why the two field caps are refused here
 * while the admin-only module floor is not.
 */
async function refuseCappedGrant(
  scopeKind: GrantScope,
  scopeId: string,
  level: Grant,
): Promise<GrantResult | null> {
  if (scopeKind === 'membership') {
    const config = await loadConfig();
    const mod = config.modules.find((m) => m.id === scopeId);
    if (!mod) return null;
    const message = grantWriteRefusal({ kind: 'membership', adminOnly: mod.adminOnly }, level);
    return message ? { ok: false, message } : null;
  }
  if (scopeKind !== 'field') return null;

  const config = await loadConfig();
  const field = config.fields.find((f) => f.id === scopeId);
  // Not found means archived (`loadConfig()` filters `archived_at`) or gone.
  // Either way there are no caps to check and no row on the screen that could
  // have been clicked; the trigger decides whether it exists at all.
  if (!field) return null;

  const message = grantWriteRefusal(
    { kind: 'field', readOnly: field.readOnly, frozenColumn: field.key === FROZEN_COLUMN_FIELD_KEY },
    level,
  );
  return message ? { ok: false, message } : null;
}

/**
 * Upserts one grant row.
 *
 * ⚠️ **No `revalidateConfig()` here or in the actions that call this**, and the
 * reflex to add one is strong: every Presets write calls it, and
 * `adminConfig.test.ts` fails the build for a Presets action that forgets. This
 * is the inverse case, pinned by the same test file. `permission_templates` and
 * its grants are not in `loadConfig()` at all, and more importantly a permission
 * must resolve at call time — editing a template changes every attached user on
 * their **next request**, with no push step, which is the live-linked property
 * the client relies on (`CLIENT-SPEC-BY-MODULE.md` §8). A cache in front of this
 * would break it silently: a stale permission looks exactly like a correct one.
 */
async function upsertGrant(
  table: 'template_grants' | 'user_grants' | 'invite_grants',
  column: 'template_id' | 'user_id' | 'invite_id',
  ownerId: string,
  scopeKind: GrantScope,
  scopeId: string,
  level: Grant,
  /** Null writes the GLOBAL row — the grant that applies in every module, and
   *  what every grant was before Admin-Module-Plan §2.2's per-module
   *  granularity was implemented. A module id writes an override for that
   *  module alone. */
  moduleId: string | null = null,
): Promise<GrantResult> {
  const capped = await refuseCappedGrant(scopeKind, scopeId, level);
  if (capped) return capped;

  const { error } = await supabaseAdmin()
    .from(table)
    .upsert(
      {
        [column]: ownerId,
        scope_kind: scopeKind,
        scope_id: scopeId,
        // A module-scope grant already names its module in scope_id; carrying
        // one here too is refused by a CHECK (migration 77). A membership
        // grant is shaped the same way (migration 9766).
        module_id: scopeKind === 'module' || scopeKind === 'membership' ? null : moduleId,
        grant_level: level,
      },
      // The unique index, spelled out: PostgREST needs the conflict target to
      // UPDATE rather than fail, and every one of these is a re-set of a cell
      // that usually already has a row. It includes module_id now, so setting
      // a Deals override does not overwrite the global row.
      { onConflict: `${column},scope_kind,scope_id,module_id` },
    );
  if (error) {
    if (error.code === FOREIGN_KEY_VIOLATION) return scopeGone;
    return { ok: false, message: error.message };
  }
  // The request-scoped grant cache in `permissions.ts` now holds a set that
  // predates this write. Anything re-rendered inside this same Server Action
  // response would otherwise show the OLD permission as though it were saved.
  invalidateGrants();
  return { ok: true };
}

/**
 * Deletes one grant row — "not set", which is not the same as Hidden and not
 * the same as Edit either. It means *inherit*: a cleared template grant falls
 * through to `GRANT_DEFAULT` (Edit), and a cleared user override falls back to
 * the template's value, which may be anything.
 *
 * A delete matching nothing is not an error in Postgres and is not one here: the
 * cell is already unset, which is the state the caller asked for.
 */
async function deleteGrant(
  table: 'template_grants' | 'user_grants' | 'invite_grants',
  column: 'template_id' | 'user_id' | 'invite_id',
  ownerId: string,
  scopeKind: GrantScope,
  scopeId: string,
  moduleId: string | null = null,
): Promise<GrantResult> {
  let query = supabaseAdmin()
    .from(table)
    .delete()
    .eq(column, ownerId)
    .eq('scope_kind', scopeKind)
    .eq('scope_id', scopeId);

  /*
   * `.is()` for the global row, `.eq()` for a module's. PostgREST renders
   * `.eq('module_id', null)` as `module_id=eq.null`, which matches NOTHING in
   * SQL — clearing a global grant would silently do nothing and the cell would
   * keep its value with no error.
   */
  query = moduleId ? query.eq('module_id', moduleId) : query.is('module_id', null);

  const { error } = await query;
  if (error) return { ok: false, message: error.message };
  invalidateGrants();
  return { ok: true };
}

/**
 * Sets what a template grants on one scope.
 *
 * Live-linked, by design: every user attached to this template resolves the new
 * value on their next request, with no push step and nothing to propagate. The
 * template screen shows the attached-user count for exactly that reason — it is
 * the blast radius of this call.
 */
export async function setTemplateGrant(ctx: AuthContext, input: SetTemplateGrantInput): Promise<GrantResult> {
  assertAdmin(ctx);
  return upsertGrant(
    'template_grants',
    'template_id',
    input.templateId,
    input.scopeKind,
    input.scopeId,
    input.level,
    input.moduleId ?? null,
  );
}

export async function clearTemplateGrant(ctx: AuthContext, input: ClearTemplateGrantInput): Promise<GrantResult> {
  assertAdmin(ctx);
  return deleteGrant(
    'template_grants',
    'template_id',
    input.templateId,
    input.scopeKind,
    input.scopeId,
    input.moduleId ?? null,
  );
}

/**
 * Sets one person's own override on one scope — the branch of
 * `effective_grant()`'s coalesce that nothing in this build could reach before
 * now (`adminUsers.ts:54` only ever read the table, `:164` only ever emptied
 * it), and therefore the first thing that can make two of the client's three
 * permission labels mean anything.
 *
 * ⚠️ Every row this writes is deleted, without warning, by assigning that user a
 * template on `Admin → Users`. That clear is deliberate and load-bearing —
 * "Template: X" without "(edited)" has to mean the person has no overrides — so
 * it was narrowed by *confirmation* rather than by scope: see
 * `adminUsers.ts`'s `assignTemplate`, which now refuses unless the caller
 * acknowledges the count it is about to destroy.
 */
export async function setUserGrant(ctx: AuthContext, input: SetUserGrantInput): Promise<GrantResult> {
  assertAdmin(ctx);
  return upsertGrant(
    'user_grants',
    'user_id',
    input.userId,
    input.scopeKind,
    input.scopeId,
    input.level,
    input.moduleId ?? null,
  );
}

export async function clearUserGrant(ctx: AuthContext, input: ClearUserGrantInput): Promise<GrantResult> {
  assertAdmin(ctx);
  return deleteGrant(
    'user_grants',
    'user_id',
    input.userId,
    input.scopeKind,
    input.scopeId,
    input.moduleId ?? null,
  );
}

/* -------------------------------------------------------------------------- */
/* Writes — several cells at once (the client's Addition 4, 16 Oct 2026)       */
/* -------------------------------------------------------------------------- */

/**
 * What a batch write hands back: every item that did NOT land, with the same
 * sentence the single-cell write would have put beside its row. An empty list
 * is total success. The matrix rolls back exactly those rows and leaves the
 * rest as drawn.
 */
export type GrantBatchResult = {
  ok: boolean;
  failed: { scopeKind: GrantScope; scopeId: string; message: string }[];
};

/**
 * One item at a time through the SAME two writers the single-cell path uses,
 * so a batch can never store what a click could not — the cap refusals, the
 * module-id shaping and the cache invalidation all happen per item exactly as
 * before. The gain is one round trip from the browser instead of one per row;
 * a hundred rows is a hundred small statements inside one request, which is
 * fine, and a per-row result is the honest shape when some may be capped.
 */
async function writeGrantBatch(
  table: 'template_grants' | 'user_grants' | 'invite_grants',
  column: 'template_id' | 'user_id' | 'invite_id',
  ownerId: string,
  moduleId: string | null,
  items: GrantBatchItem[],
): Promise<GrantBatchResult> {
  const failed: GrantBatchResult['failed'] = [];
  for (const it of items) {
    const result =
      it.level === null
        ? await deleteGrant(table, column, ownerId, it.scopeKind, it.scopeId, moduleId)
        : await upsertGrant(table, column, ownerId, it.scopeKind, it.scopeId, it.level, moduleId);
    if (!result.ok) failed.push({ scopeKind: it.scopeKind, scopeId: it.scopeId, message: result.message });
  }
  return { ok: failed.length === 0, failed };
}

export async function setTemplateGrants(ctx: AuthContext, input: SetTemplateGrantsInput): Promise<GrantBatchResult> {
  assertAdmin(ctx);
  return writeGrantBatch('template_grants', 'template_id', input.templateId, input.moduleId ?? null, input.items);
}

export async function setUserGrants(ctx: AuthContext, input: SetUserGrantsInput): Promise<GrantBatchResult> {
  assertAdmin(ctx);
  return writeGrantBatch('user_grants', 'user_id', input.userId, input.moduleId ?? null, input.items);
}

export async function setInviteGrants(ctx: AuthContext, input: SetInviteGrantsInput): Promise<GrantBatchResult> {
  assertAdmin(ctx);
  return writeGrantBatch('invite_grants', 'invite_id', input.inviteId, input.moduleId ?? null, input.items);
}


/* -------------------------------------------------------------------------- */
/* Invites — permissions chosen BEFORE the person exists                      */
/* -------------------------------------------------------------------------- */

/**
 * The client's ask: "assign a template and also adjust permissions before
 * sending invite". The template half has been on the invite since migration
 * 71; these three functions are the override half (migration 93).
 *
 * ── IT REUSES THE `user` SUBJECT SHAPE DELIBERATELY ──────────────────────
 * `GrantMatrix` reads exactly three things off its subject: whether to show
 * the override column, the template name for the inline hint, and whether the
 * subject is an admin (in which case every grant is moot). An invite answers
 * all three, so it renders as the identical screen the admin will use after
 * the person signs up — same columns, same wording, same behaviour — with no
 * change to the shared component and therefore no risk to the two screens
 * already built on it.
 */
export async function inviteGrantMatrix(
  ctx: AuthContext,
  inviteId: string,
  moduleId: string | null = null,
): Promise<GrantMatrix | null> {
  assertAdmin(ctx);
  const supabase = supabaseAdmin();

  const { data: invite, error } = await supabase
    .from('invites')
    .select('id, email, role_id, template_id, status')
    .eq('id', inviteId)
    .maybeSingle();
  if (error) throw error;
  if (!invite) return null;

  const [roleRes, inviteGrants] = await Promise.all([
    supabase.from('roles').select('name, is_admin').eq('id', invite.role_id as string).maybeSingle(),
    readGrants('invite_grants', 'invite_id', inviteId, moduleId).then((r) => r.grants),
  ]);
  if (roleRes.error) throw roleRes.error;

  const templateId = (invite.template_id as string | null) ?? null;
  let templateLabel: string | null = null;
  let templateGrants = new Map<GrantKey, Grant>();
  if (templateId) {
    const { data: template, error: tErr } = await supabase
      .from('permission_templates')
      .select('label')
      .eq('id', templateId)
      .maybeSingle();
    if (tErr) throw tErr;
    templateLabel = template?.label ?? null;
    templateGrants = await listTemplateGrants(ctx, templateId, moduleId);
  }

  const hasOverrides = inviteGrants.size > 0;
  const permissionLabel = templateLabel
    ? hasOverrides
      ? `Template: ${templateLabel} (edited)`
      : `Template: ${templateLabel}`
    : hasOverrides
      ? 'Custom'
      : 'Default';

  return buildMatrix(
    {
      kind: 'user',
      id: invite.id as string,
      label: invite.email as string,
      email: invite.email as string,
      isAdmin: roleRes.data?.is_admin ?? false,
      roleName: roleRes.data?.name ?? 'Unknown role',
      templateId,
      templateLabel,
      permissionLabel,
    },
    templateGrants,
    inviteGrants,
    roleRes.data?.is_admin ?? false,
    moduleId,
  );
}

export async function setInviteGrant(
  ctx: AuthContext,
  input: { inviteId: string; scopeKind: GrantScope; scopeId: string; level: Grant; moduleId?: string | null },
): Promise<GrantResult> {
  assertAdmin(ctx);
  return upsertGrant(
    'invite_grants',
    'invite_id',
    input.inviteId,
    input.scopeKind,
    input.scopeId,
    input.level,
    input.moduleId ?? null,
  );
}

export async function clearInviteGrant(
  ctx: AuthContext,
  input: { inviteId: string; scopeKind: GrantScope; scopeId: string; moduleId?: string | null },
): Promise<GrantResult> {
  assertAdmin(ctx);
  return deleteGrant(
    'invite_grants',
    'invite_id',
    input.inviteId,
    input.scopeKind,
    input.scopeId,
    input.moduleId ?? null,
  );
}
