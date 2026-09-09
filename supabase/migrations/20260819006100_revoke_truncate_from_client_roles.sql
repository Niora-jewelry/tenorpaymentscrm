-- =============================================================================
-- Part 61: take TRUNCATE (and TRIGGER/REFERENCES) away from anon and
-- authenticated, on every table and on every table created from here on.
--
-- ── WHAT WAS WRONG ───────────────────────────────────────────────────────
-- ⚠️ ROW-LEVEL SECURITY DOES NOT RESTRICT TRUNCATE. It is a table-level
-- privilege, checked against the GRANT and nothing else — no policy is ever
-- consulted, so "RLS is forced with policies scoped to authenticated" does not
-- cover it the way it covers SELECT/INSERT/UPDATE/DELETE.
--
-- Supabase's project-level `ALTER DEFAULT PRIVILEGES` grants anon and
-- authenticated the full `arwdDxtm` set on every newly created public table.
-- Migrations 11 and 31 found that gap and revoked INSERT/UPDATE/DELETE —
-- deliberately not SELECT, because RLS genuinely does cover reads. Neither
-- considered TRUNCATE, and RLS does not cover it.
--
-- Measured before writing this, not assumed. Running as `anon`, with no JWT:
--
--     select count(*) from records;   ->  0 rows      (RLS did its job)
--     truncate records cascade;       ->  SUCCEEDED   (RLS never ran)
--
-- 117 tables were reachable that way, including `records`, `cases`, `logins`,
-- `notes`, `updates`, `files` and all 78 partitions of `record_activity` — the
-- append-only history CLAUDE.md rule 4 exists to keep "complete and unbroken",
-- which a TRUNCATE empties without leaving so much as a deleted row behind.
--
-- ── WHY IT WAS NOT AN ACTIVE BREACH, AND WHY IT IS STILL FIXED ───────────
-- PostgREST has no TRUNCATE verb, and `anon`/`authenticated` are not login
-- roles, so there is no path from a browser to it today. The same reasoning
-- migrations 11 and 31 gave applies here and reaches the same conclusion: the
-- second layer is closed anyway, because "no path today" is a statement about
-- the current surface, not a property of the schema. A future SQL-executing
-- path, or one `security invoker` function too many, turns it into a live way
-- to erase an audit trail.
--
-- ── SCOPE, DELIBERATELY NARROW ───────────────────────────────────────────
-- Only TRUNCATE, TRIGGER and REFERENCES, and only from anon/authenticated.
-- The application never uses any of the three: they are DDL-adjacent
-- privileges, and both roles lack CREATE on the schema in the first place.
-- SELECT/INSERT/UPDATE/DELETE are left exactly as migrations 11 and 31 set
-- them, so nothing the app does can change behaviour.
--
-- ⚠️ `service_role` is untouched. It is the server's own key and must keep
-- working; it also bypasses RLS by design.
--
-- ── BOTH HALVES, OR IT COMES BACK ────────────────────────────────────────
-- The revoke below fixes the 117 tables that exist. The ALTER DEFAULT
-- PRIVILEGES is what stops table number 118 from arriving with the grant
-- restored — which is exactly how this gap survived migration 11: that
-- migration revoked four tables and the next `create table` re-granted the
-- rest.
-- =============================================================================

revoke truncate, trigger, references on all tables in schema public
  from anon, authenticated;

-- Future tables created by `postgres` (every migration in this project runs as
-- postgres, so this is the one that matters in practice).
alter default privileges in schema public
  revoke truncate, trigger, references on tables from anon, authenticated;

-- And tables created by `supabase_admin`, which owns some of what the platform
-- creates. Wrapped because `postgres` is not a member of that role on a hosted
-- project and the statement then raises 42501 — the postgres default above is
-- the one this project's own migrations rely on, so failing here must not take
-- the migration down with it.
do $$
begin
  execute 'alter default privileges for role supabase_admin in schema public '
       || 'revoke truncate, trigger, references on tables from anon, authenticated';
exception
  when insufficient_privilege then
    raise notice 'skipped supabase_admin default privileges (not a member) — postgres default applied';
end;
$$;
