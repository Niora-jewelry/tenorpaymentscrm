-- =============================================================================
-- Module 2 — Part 41: resolve a user's whole grant set in ONE round trip.
--
-- ── THE PROBLEM THIS FIXES ───────────────────────────────────────────────
-- `effective_grant(u, kind, scope)` (migration 7) answers for exactly ONE
-- scope. `permissions.ts` calls it once per field, once per tab, once per
-- module — inside a `Promise.all`, which makes those calls concurrent but does
-- NOT make them one round trip. Measured against the live project (a remote
-- Supabase in us-west-2; every PostgREST call measured at 270-800ms from the
-- developer's machine), opening one record drawer as a non-admin issued ~292
-- separate `effective_grant` calls:
--
--     page.tsx            17   (dashboard columns)
--     listRecords         17   (hiddenKeysFor over those same columns)
--     getRecord          129   (hiddenKeysFor over every field)
--     RecordDrawer       129   (every field across every tab)
--     tabGrants           13
--
-- Every one of them is the same tiny two-table coalesce. This returns all of
-- them at once, and `permissions.ts` caches the result for the request.
--
-- ── WHY A WHOLE-USER SWEEP RATHER THAN A SCOPE-ID ARRAY ──────────────────
-- An `effective_grants(u, kind, scopes uuid[])` variant would still be one call
-- per (kind, call site) — four or five per request — and would have to be
-- re-issued whenever a different subset of fields came up. The rows involved
-- are per-USER and tiny: `user_grants` holds only explicit overrides, and
-- `template_grants` only what a role actually pins; for a user with no
-- customisation at all both are empty. Fetching the user's entire grant set is
-- therefore cheaper than any subsetting scheme, and it caches for the whole
-- request as a single value — see `allGrantsFor` in `permissions.ts`.
--
-- ── SEMANTICS ARE IDENTICAL TO effective_grant(), DELIBERATELY ───────────
-- `effective_grant` is `coalesce(override, template, 'edit')`. Preserving that
-- exactly matters more here than anywhere else in the app: this is the
-- permission system, and a batched version that resolved even one scope
-- differently would be a silent, invisible privilege change.
--
--   * A user override wins over the template grant. Spelled below as
--     `union all` + `distinct on (scope_kind, scope_id)` ordered by a source
--     rank, which is the set-based form of the same coalesce.
--   * A scope with NEITHER row is ABSENT from this result. The caller supplies
--     `GRANT_DEFAULT` ('edit') for a miss, which is the third arm of the
--     coalesce. Returning a row per known scope instead would mean joining
--     `modules`/`tabs`/`fields` for no benefit.
--   * `user_templates.user_id` is a PRIMARY KEY (migration 7), so a user has at
--     most ONE template and the join below cannot produce competing rows for a
--     scope. No tie-break is needed and none is invented here.
--   * The two field floors (Deal Name never Hidden, a read-only field capped at
--     View) stay in `applyFieldFloors` / `grantRules.ts` and are NOT applied
--     here — exactly as `effective_grant` does not apply them. This function is
--     the raw lookup half only, and the floors are re-applied on every read by
--     the resolver that wraps it.
--
-- `security definer` with a pinned `search_path` per CLAUDE.md §8, and revoked
-- from PUBLIC with no re-grant — the same posture migration 20 applies to
-- `effective_grant` itself: "everything called only via supabaseAdmin() gets no
-- client grant at all". Field-level permission is resolved by the data layer,
-- and is never something a browser may probe directly for an arbitrary user id.
-- =============================================================================

create or replace function effective_grants(u uuid)
returns table (
  scope_kind  grant_scope,
  scope_id    uuid,
  grant_level permission_level
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select distinct on (g.scope_kind, g.scope_id)
         g.scope_kind, g.scope_id, g.grant_level
    from (
      -- Rank 0: the user's own override. Always wins.
      select ug.scope_kind, ug.scope_id, ug.grant_level, 0 as source_rank
        from user_grants ug
       where ug.user_id = u

      union all

      -- Rank 1: whatever this user's template pins. At most one template per
      -- user (PK on user_templates.user_id), so this contributes at most one
      -- row per scope.
      select tg.scope_kind, tg.scope_id, tg.grant_level, 1
        from user_templates ut
        join template_grants tg on tg.template_id = ut.template_id
       where ut.user_id = u
    ) g
   order by g.scope_kind, g.scope_id, g.source_rank;
$$;

revoke execute on function effective_grants(uuid) from public;

comment on function effective_grants(uuid) is
  'Every resolved grant for one user, in one round trip. Same coalesce as '
  'effective_grant(); a scope absent from the result has no stored grant, and '
  'the caller applies the default (edit). Service-role only.';
