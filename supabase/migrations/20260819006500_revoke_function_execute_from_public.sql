-- =============================================================================
-- Part 65: the other half of 64 — take EXECUTE away from PUBLIC too.
--
-- ── WHY 64 WAS NOT ENOUGH ────────────────────────────────────────────────
-- Migration 64 revoked EXECUTE from the role `anon`. Re-checking afterwards,
-- nine of this project's own functions were still executable by `anon`:
--
--   field_choices_key_is_permanent     pipelines_module_is_permanent
--   grant_scope_must_exist             pipelines_sync_status_label
--   module_field_list_reject_frozen    record_pipelines_sync_status_value
--   pipeline_steps_pipeline_is_permanent  rls_auto_enable
--   pipeline_steps_sync_choices
--
-- Their ACLs read `=X/postgres` — the grant is to the pseudo-role PUBLIC, not
-- to `anon`, and `revoke ... from anon` does not remove it. 64 and 61 each hit
-- one side of this coin; together they cover both. That is the whole lesson of
-- this pair of migrations: **check the ACL, not the assumption.** A revoke aimed
-- at the wrong grantee silently does nothing.
--
-- ── THESE NINE WERE NOT REACHABLE, AND ARE STILL FIXED ───────────────────
-- Every one returns `trigger` or `event_trigger`. PostgREST will not expose a
-- trigger function at all — confirmed with the anon key against the live API:
--
--   POST /rest/v1/rpc/pipelines_sync_status_label
--     -> PGRST202 "no matches were found in the schema cache"
--
-- and Postgres itself refuses a direct `select` on one. So there is no path
-- from a browser today, which is exactly what migration 61 said about TRUNCATE
-- before closing it anyway. "No path today" describes the current surface, not
-- a property of the schema.
--
-- ── AND THE DEFAULT, SO IT DOES NOT COME BACK ────────────────────────────
-- Postgres grants EXECUTE to PUBLIC on every new function unless told not to.
-- That default is why the per-function `revoke execute on function X from
-- public` lines scattered through earlier migrations had to exist one at a
-- time, and why forgetting one was invisible. Revoking it at the default level
-- inverts that: a new function is closed unless deliberately opened.
--
-- ⚠️ `authenticated` is unaffected. Supabase's own project-level default
-- privileges grant it EXECUTE explicitly — that is a separate grantee from
-- PUBLIC, and 64 left it in place because the app depends on it. Verified
-- after 64: 70 of 95 functions executable by authenticated, unchanged.
-- `service_role` likewise keeps all 95.
-- =============================================================================

do $$
declare
  fn record;
  n   int := 0;
begin
  for fn in
    select p.oid::regprocedure::text as sig
      from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and not exists (
             select 1 from pg_depend d
              where d.objid = p.oid and d.deptype = 'e'
           )
  loop
    execute format('revoke execute on function %s from public', fn.sig);
    n := n + 1;
  end loop;
  raise notice 'revoked EXECUTE from PUBLIC on % function(s)', n;
end;
$$;

alter default privileges in schema public
  revoke execute on functions from public;

-- Same guard as 61 and 64: `postgres` is not a member of `supabase_admin` on a
-- hosted project, and the bare statement would raise 42501 and abort.
do $$
begin
  execute 'alter default privileges for role supabase_admin in schema public '
       || 'revoke execute on functions from public';
exception
  when insufficient_privilege then
    raise notice 'skipped supabase_admin default privileges (not a member) — postgres default applied';
end;
$$;
