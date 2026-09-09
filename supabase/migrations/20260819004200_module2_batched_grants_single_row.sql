-- =============================================================================
-- Module 2 — Part 42: effective_grants returns ONE jsonb row, not a row set.
--
-- ── THE BUG THIS CLOSES ──────────────────────────────────────────────────
-- Migration 41 made `effective_grants(u)` a set-returning function, which
-- PostgREST subjects to its `max_rows` limit (`supabase/config.toml:18`,
-- currently 1000). That is a silent, fail-OPEN truncation in the permission
-- system, and it is the worst possible shape for one:
--
--   * `permissions.ts`'s `rawGrant` treats a scope ABSENT from the result as
--     "no stored grant" and applies `GRANT_DEFAULT` — which is `edit`, not
--     `hidden` (see the long note on `GRANT_DEFAULT`; this default is correct
--     and specified, and is exactly what makes truncation dangerous).
--   * A truncated row set is byte-for-byte indistinguishable from a genuinely
--     smaller one. Nothing errors, nothing logs.
--
-- So a user with more than 1000 stored grants would silently be granted EDIT
-- on everything past the cut. The per-scope `effective_grant()` this replaced
-- could never do that: it returned a scalar for one scope and had no row set
-- to truncate.
--
-- Today a full config is ~148 scopes (17 columns + 13 tabs + 129 fields), so
-- this is not live. It is fixed now rather than tracked, because the trigger is
-- ordinary growth — more fields, more modules, one power user with per-field
-- overrides — and the symptom is invisible privilege escalation that no test
-- would catch and no screen would show.
--
-- ── THE FIX ──────────────────────────────────────────────────────────────
-- Return a single `jsonb` object keyed `"<kind>:<scope_id>"`. One row can never
-- be truncated by a row limit, and the payload is a fraction of the size of the
-- equivalent row set. `jsonb_object_agg` over the same `distinct on` subquery
-- keeps the resolution rules byte-identical to migration 41 and therefore to
-- `effective_grant()`:
--
--   user override (rank 0) wins over template (rank 1) wins over absent, and
--   absent still means "caller applies the default".
--
-- `coalesce(..., '{}'::jsonb)` because `jsonb_object_agg` over zero rows
-- returns NULL, and a user with no stored grants at all — the common case
-- today — must come back as an empty object rather than null.
--
-- DROP then CREATE rather than `create or replace`: the return type changes
-- from a table to a scalar, which Postgres will not let a replace do. Nothing
-- outside `permissions.ts` calls it, and that call site changes with this
-- migration.
--
-- `security definer` with a pinned `search_path` per CLAUDE.md §8, revoked from
-- PUBLIC with no re-grant — the same service-role-only posture migration 20
-- applies to `effective_grant`.
-- =============================================================================

drop function if exists effective_grants(uuid);

create function effective_grants(u uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    jsonb_object_agg(g.scope_kind::text || ':' || g.scope_id::text, g.grant_level),
    '{}'::jsonb
  )
  from (
    select distinct on (x.scope_kind, x.scope_id)
           x.scope_kind, x.scope_id, x.grant_level
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
      ) x
     order by x.scope_kind, x.scope_id, x.source_rank
  ) g;
$$;

revoke execute on function effective_grants(uuid) from public;

comment on function effective_grants(uuid) is
  'Every resolved grant for one user as a single jsonb object keyed '
  '"<scope_kind>:<scope_id>". One row, so PostgREST''s max_rows cannot '
  'truncate it — a truncated grant set would read as "no grant" and resolve '
  'to the default (edit). Same coalesce as effective_grant(). Service-role only.';
