/**
 * The permission resolution rules, as pure functions — and the only copy.
 *
 * ── WHY THIS FILE EXISTS, AND WHY IT IS NOT `server-only` ────────────────
 * Phase 6b extracted these out of `permissions.ts` so the grant matrix could
 * resolve permissions for someone who is NOT the viewer without a second copy
 * of the rules (every function in `permissions.ts` takes an `AuthContext`,
 * deliberately, and there is no raw-userId escape hatch there). That solved it
 * for the server half.
 *
 * Phase 6c needs the same rules in the BROWSER. The matrix is now interactive:
 * clicking a cell has to move the "Resolves" and "In the app" columns
 * immediately, because those two columns are the entire point of the screen and
 * a 148-row grid that repaints them a round trip later is a grid nobody can
 * read while editing. `permissions.ts` is `server-only`, so importing a *value*
 * from it into the client component is a build error by design (`CLAUDE.md`
 * § Secrets) — the same wall `grantEnforcement.ts` was carved out to get around
 * in 6b, and for the same reason: the alternative is a copy of the rules inside
 * the component, which is precisely the divergence this build has already been
 * bitten by twice (`listTemplates`, the choices key/label split).
 *
 * So: the rules live here, this file holds no secrets and reaches no database,
 * and `permissions.ts` re-exports every one of them. Three callers, one
 * implementation — the live enforcement path, the matrix's server render, and
 * the matrix's optimistic update.
 *
 * Nothing in this file may import anything that touches the database, the
 * service-role client or `server-only`. Adding such an import silently drags it
 * into the browser bundle.
 */

export type Grant = 'hidden' | 'view' | 'edit';
export type GrantScope = 'module' | 'tab' | 'subtab' | 'field';

/**
 * The three levels as a runtime list, ordered least → most permissive.
 *
 * Same job `FIELD_TYPES` and `SWATCHES` do in `adminSchemas.ts`, pinned the
 * same way: a level added to the `permission_level` enum without being offered
 * here becomes a compile error rather than a level the admin silently can never
 * pick.
 */
export const GRANT_LEVELS = ['hidden', 'view', 'edit'] as const satisfies readonly Grant[];

type MissingGrant = Exclude<Grant, (typeof GRANT_LEVELS)[number]>;
const _everyGrantIsOffered: [MissingGrant] extends [never] ? true : { missing: MissingGrant } = true;
void _everyGrantIsOffered;

/**
 * The four scope kinds, pinned the same way.
 *
 * `subtab` was added in migration 50. Before that this list read "the three
 * scope kinds … there is no subtab scope, which is why the matrix groups
 * fields under a subtab heading but gives that heading no state of its own" —
 * and that was a real gap against the client's own §8, which asks for the
 * grant at "module access, tab/subtab access, and individual field access".
 * `verify-grant-matrix.mjs` confirms this list against the live
 * `grant_scope` enum, so the two cannot drift.
 */
export const GRANT_SCOPES = ['module', 'tab', 'subtab', 'field'] as const satisfies readonly GrantScope[];

type MissingScope = Exclude<GrantScope, (typeof GRANT_SCOPES)[number]>;
const _everyScopeIsOffered: [MissingScope] extends [never] ? true : { missing: MissingScope } = true;
void _everyScopeIsOffered;

/**
 * What `effective_grant()` falls through to when NOTHING is configured —
 * neither a user override nor a template grant (migration 7's `coalesce`, last
 * argument).
 *
 * **Edit, not Hidden.** This is the single most misread fact in the permission
 * model: a scope with no row is fully editable, so an empty template restricts
 * nothing and a blank cell in the grant matrix is the most permissive state,
 * not the least. One planning document (`MODULE-2-PLAN.md:324`) says the
 * opposite; the client's own spec, `SCHEMA-DECISIONS.md:395`, migration 7's
 * literal `coalesce(..., 'edit')` and the live function all say edit. See
 * `permissions.ts`'s header for the full account.
 */
export const GRANT_DEFAULT: Grant = 'edit';

/**
 * The frozen first dashboard column — always column 1 in every module, never
 * de-selectable, never Hidden (the client's one universal exception,
 * `CLIENT-SPEC-BY-MODULE.md` §1). Named once because three unrelated rules
 * depend on it: the grant floor below, the archive block in `adminFields.ts`,
 * and the column-list guard in `adminColumns.ts`.
 */
export const FROZEN_COLUMN_FIELD_KEY = 'deal_name';

/**
 * The one field that grants record visibility.
 *
 * There are THREE fields of type `team_member` in the seed and they mean three
 * different things — a distinction the client was explicit about and which
 * nothing in the config schema can express:
 *
 *   - `team_members_assigned` — **this one.** `sync_record_team_members()`
 *     (migration 6) derives `record_team_members` from this key and no other,
 *     and `can_see_record()` reads that table on every row of every query.
 *   - `relationship_manager` — "informational only", the client's own words in
 *     migration 6's header. Grants nothing.
 *   - `record_creator` — "Record creator grants nothing", likewise; it is also
 *     `read_only`, so `applyFieldFloors` caps it at View for everyone.
 *
 * Named here rather than derived from a column because the fact is not
 * configuration: it is hard-coded in the trigger's SQL. The picker in
 * `value.tsx` reads this to decide whether to say "only these people can see
 * this record" — which is true of exactly one of the three, and would be a
 * dangerous lie on the other two.
 *
 * Lives in this module, next to `FROZEN_COLUMN_FIELD_KEY` and for the same
 * reason: `records.ts` is `server-only` and the drawer is a Client Component.
 */
export const VISIBILITY_FIELD_KEY = 'team_members_assigned';

/**
 * The database's own resolution order, in TypeScript: *"user override if one
 * exists, otherwise the template value, otherwise Edit"* — the client's words
 * (`CLIENT-SPEC-BY-MODULE.md` §8), and literally migration 7's three-argument
 * `coalesce`.
 *
 * `scripts/verify-grant-matrix.mjs` asserts this equals `effective_grant()` for
 * every real scope in the live database, including the both-absent case, rather
 * than trusting that the two stay in step.
 */
export function coalesceGrant(userOverride: Grant | null, templateGrant: Grant | null): Grant {
  return userOverride ?? templateGrant ?? GRANT_DEFAULT;
}

/**
 * Module access after the `adminOnly` floor. "Records List defaults to no
 * access for every non-admin" (MODULE-2-PLAN §5.1) is this, not a special case
 * inside `effective_grant()` — an admin-only module is unreachable by a
 * non-admin regardless of any template or override.
 */
export function resolveModuleGrant(raw: Grant, moduleAdminOnly: boolean, isAdmin: boolean): Grant {
  if (moduleAdminOnly && !isAdmin) return 'hidden';
  if (isAdmin) return 'edit';
  return raw;
}

export function resolveTabGrant(raw: Grant, isAdmin: boolean): Grant {
  return isAdmin ? 'edit' : raw;
}

/**
 * Subtab access — identical shape to a tab's, and a separate scope since
 * migration 50.
 *
 * The client specified the grant "at three levels: module access, **tab/subtab
 * access**, and individual field access". The `/subtab` half was unbuildable
 * until `grant_scope` gained a fourth value, so a subtab could only be
 * restricted by hiding its whole parent tab or by granting every field inside
 * it one at a time. Application → Private (EIN, account and routing numbers,
 * owner SSNs) is the case that makes this matter.
 *
 * A subtab resolves UNDER its tab, never around it: see `capGrant` at the call
 * sites. An unset subtab is `edit` like every other unset scope, so adding this
 * level changes nothing until somebody sets one.
 */
export function resolveSubtabGrant(raw: Grant, isAdmin: boolean): Grant {
  return isAdmin ? 'edit' : raw;
}

/**
 * The two field floors, expressed against the two booleans that actually decide
 * them rather than against a field row — the matrix carries these per scope and
 * has no `Field` to hand (`ScopeCaps` below).
 *
 * Note the asymmetry, because 6c's write guards and 6d's locked cells both
 * depend on it: the read-only cap applies to admins too, the frozen-column
 * floor is the only rule in the model that *lifts* a grant, and an admin is
 * otherwise Edit everywhere before either floor runs.
 */
function applyFieldFloors(
  raw: Grant,
  caps: { readOnly: boolean; frozenColumn: boolean },
  isAdmin: boolean,
): Grant {
  const g = isAdmin ? 'edit' : raw;
  if (caps.readOnly) return g === 'edit' ? 'view' : g;
  if (caps.frozenColumn) return g === 'hidden' ? 'view' : g;
  return g;
}

/**
 * Field access after the two floors MODULE-2-PLAN §5.1 specifies:
 *   - Deal Name is never Hidden — clamped up to View.
 *   - A `read_only` field (Record creator) is View at most, for EVERYONE,
 *     admins included — never Edit, whatever a template says.
 *
 * Keeps the field-row signature the live enforcement path already passes; the
 * matrix goes through `resolveScope` instead.
 */
export function resolveFieldGrant(
  raw: Grant,
  field: { key: string; readOnly: boolean },
  isAdmin: boolean,
): Grant {
  return applyFieldFloors(
    raw,
    { readOnly: field.readOnly, frozenColumn: field.key === FROZEN_COLUMN_FIELD_KEY },
    isAdmin,
  );
}

/**
 * An outer scope caps everything inside it: module over tab, tab over field.
 *
 * The three scopes resolve INDEPENDENTLY — `effective_grant()` looks up one
 * scope id and knows nothing about the module or tab a field belongs to — so
 * without this, "Leads = View" meant only that four buttons stopped rendering:
 * every field in the drawer carried its own grant, an untouched field resolves
 * to Edit (`GRANT_DEFAULT`), and a member handed a view-only module could still
 * edit every value in it. A control named View that does not make anything
 * read-only is the "lie about who can see what" `grantWriteRefusal` above
 * refuses to store, arrived at from the other direction.
 *
 * Capping rather than replacing is what makes it chain: View over an Edit field
 * is View, View over a Hidden field stays Hidden, Edit over anything changes
 * nothing — so `capGrant(module, capGrant(tab, field))` is the whole model, and
 * it does not matter which order the two caps are applied in. Applied AFTER the
 * field floors, so the frozen column's Hidden → View lift still happens and a
 * read-only field stays capped at View.
 *
 * Not applied to `adminOnly` — `resolveModuleGrant` has already turned that
 * into Hidden for a non-admin, and into Edit for an admin.
 */
export function capGrant(outer: Grant, inner: Grant): Grant {
  if (outer === 'hidden') return 'hidden';
  if (outer === 'view' && inner === 'edit') return 'view';
  return inner;
}

/**
 * The more permissive of two grants.
 *
 * A tab is not owned by one module — `tabs` is a flat table and
 * `module_tab_order` attaches the same tab to several modules — so "what does
 * this tab's ceiling resolve to" is a question about a SET of modules, and the
 * answer is the best of them: a person holding Leads = View and Deals = Edit
 * meets the Contact tab at Edit, by opening it from Deals. The runtime agrees
 * by construction — `moduleWriteCap` takes the same maximum over the modules a
 * record actually appears in.
 */
export function maxGrant(a: Grant, b: Grant): Grant {
  const rank = { hidden: 0, view: 1, edit: 2 } as const;
  return rank[a] >= rank[b] ? a : b;
}

/* -------------------------------------------------------------------------- */
/* One scope, resolved end to end                                             */
/* -------------------------------------------------------------------------- */

/**
 * Everything about a scope that changes its answer, other than the two stored
 * grants — flattened to booleans so it survives the trip to the browser as
 * plain JSON. The matrix carries one of these per row and hands it straight
 * back to `resolveScope` after an edit.
 */
export type ScopeCaps =
  | { kind: 'module'; adminOnly: boolean }
  | { kind: 'tab' }
  | { kind: 'field'; readOnly: boolean; frozenColumn: boolean };

export type ResolvedScope = {
  /** `coalesce(user, template, 'edit')` — exactly what `effective_grant()`
   * returns for this scope, before the app's own floors. */
  resolved: Grant;
  /** What the subject actually experiences afterwards. */
  effective: Grant;
  /** Why the two differ, or why this scope can never be changed. Null when
   * they agree and nothing is capped. */
  lock: string | null;
};

/**
 * The whole resolution for one scope: the database's coalesce, then the app's
 * floors, then the reason a floor decided it.
 *
 * The lock strings are rendered as hover text on a padlock in the matrix and
 * become 6d's disabled-control tooltips. They live here rather than in the
 * component so the server render and the optimistic client update cannot
 * disagree about *why* a row is capped — a screen that changes its explanation
 * depending on which half drew it is worse than one that gives none.
 */
export function resolveScope(
  caps: ScopeCaps,
  userGrant: Grant | null,
  templateGrant: Grant | null,
  isAdmin: boolean,
): ResolvedScope {
  const resolved = coalesceGrant(userGrant, templateGrant);
  const adminNote = 'Admin — resolves to Edit whatever is set here.';

  if (caps.kind === 'module') {
    const effective = resolveModuleGrant(resolved, caps.adminOnly, isAdmin);
    if (isAdmin) return { resolved, effective, lock: adminNote };
    if (caps.adminOnly) {
      return {
        resolved,
        effective,
        lock: 'Admin-only module — Hidden for every non-admin, whatever is set here.',
      };
    }
    return { resolved, effective, lock: null };
  }

  if (caps.kind === 'tab') {
    return { resolved, effective: resolveTabGrant(resolved, isAdmin), lock: isAdmin ? adminNote : null };
  }

  const effective = applyFieldFloors(resolved, caps, isAdmin);
  if (caps.readOnly) {
    return { resolved, effective, lock: 'Read-only field — capped at View for everyone, admins included.' };
  }
  // The only remaining way the two differ for a non-admin is the frozen-column
  // floor lifting Hidden to View.
  if (effective !== resolved && !isAdmin) {
    return { resolved, effective, lock: 'Deal Name is never hidden — Hidden is lifted to View.' };
  }
  if (isAdmin) return { resolved, effective, lock: adminNote };
  return { resolved, effective, lock: null };
}

/* -------------------------------------------------------------------------- */
/* What a grant is not allowed to say                                         */
/* -------------------------------------------------------------------------- */

/**
 * The two field caps, as a WRITE guard rather than a read-time floor.
 *
 * Both rules are already unbypassable: `applyFieldFloors` runs on every read,
 * so a `hidden` grant on Deal Name inserted by direct SQL still resolves to
 * View. Storing one is therefore harmless — and meaningless, which is the
 * problem. A cell that accepts Hidden, saves it, and then displays View is the
 * same class of lie as Phase 4's `status_field_id` or a Connect button that
 * connects nothing, except here it is a lie about who can see what.
 *
 * So 6c refuses the write and says why, instead of silently storing a no-op.
 * 6d disables the control so the refusal is never reached by an honest click.
 *
 * Deliberately NOT extended to the admin-only module floor. That one depends on
 * who is holding the template — a grant on Records List is a no-op for a
 * non-admin and a no-op for an admin, but for *different* reasons, and a
 * template is not attached to anybody in particular when it is being edited.
 * The matrix marks it with a lock; refusing it would refuse a row an admin may
 * legitimately want set for the day the module stops being admin-only.
 *
 * Returns the reason, or null when the write is allowed.
 */
export function grantWriteRefusal(caps: ScopeCaps, level: Grant): string | null {
  if (caps.kind !== 'field') return null;
  if (caps.readOnly && level === 'edit') {
    return 'This field is read-only — it is capped at View for everyone, admins included, so an Edit grant on it would never take effect. Choose View or Hidden.';
  }
  if (caps.frozenColumn && level === 'hidden') {
    return 'Deal Name is the frozen first column of every dashboard and can never be hidden — a Hidden grant on it resolves to View anyway. Choose View or Edit.';
  }
  return null;
}

export type GrantLock = { level: Grant; reason: string };

/**
 * Which levels the editor must not offer on this scope, and why — Phase 6d.
 *
 * **Derived from `grantWriteRefusal`, never listed alongside it.** That is the
 * entire point of this function existing rather than the component deciding
 * which options to grey out: the set the UI disables and the set the writer
 * refuses are then the same set by construction, and a third cap added to
 * `grantWriteRefusal` locks its control for free instead of becoming a refusal
 * an honest click can still reach.
 *
 * Note what is deliberately NOT here, because the plan's own wording for 6d
 * ("three locks, not two") reads as though it should be:
 *
 *   - **The admin shortcut.** An admin resolves to Edit everywhere, so every
 *     grant on their matrix is inert *today*. Their role can change, and the
 *     grant is stored against the person, not the role — disabling the control
 *     would make a real person's permissions unconfigurable because of a fact
 *     that is true this afternoon.
 *   - **The admin-only module floor.** Same shape: a grant on Records List is a
 *     no-op only while the module stays admin-only, and 6c deliberately declined
 *     to refuse it at the writer for exactly that reason.
 *
 * Both are explanations, and `resolveScope` already returns them as `lock`. A UI
 * that refused what the server accepts is the mirror image of the lie this phase
 * exists to remove, not a stricter version of it — so those two stay live
 * controls with a padlock's worth of hover text, and only the two hard field
 * caps become unreachable.
 *
 * "Not set" is never locked: clearing a grant is always allowed, and
 * `deleteGrant` has no cap check for the same reason.
 */
export function lockedGrantLevels(caps: ScopeCaps): GrantLock[] {
  return GRANT_LEVELS.flatMap((level) => {
    const reason = grantWriteRefusal(caps, level);
    return reason ? [{ level, reason }] : [];
  });
}
