-- =============================================================================
-- Part 92: take SELECT away from `anon`, which had it on ~110 tables.
--
-- ── NOTHING IS LEAKING TODAY ─────────────────────────────────────────────
-- This is not a live hole, and the audit that found it says so: every one of
-- those tables was probed unauthenticated, over PostgREST, with the anon key
-- and no bearer token. Every single one returned zero rows, because RLS is
-- enabled AND forced everywhere and every policy is written `to authenticated`.
--
--   records / logins / profiles      401
--   user_grants, template_grants,
--   credential_reveals, phone_calls,
--   notifications, cases, notes, …   200, and an empty array
--
-- ── SO WHY CHANGE IT ─────────────────────────────────────────────────────
-- Because the privilege is reach nobody needs, and it is the half of the
-- mechanism that is quiet when it fails. RLS is doing all the work: a single
-- future policy written without `to authenticated` — the default, if someone
-- omits the clause — and `anon` reads that table from the public internet
-- immediately, with nothing in the diff to suggest it.
--
-- The grant comes from Supabase's own defaults, which hand `anon` and
-- `authenticated` SELECT on everything in `public`. Migrations 64/65 removed
-- the equivalent for FUNCTIONS after `anon` turned out to be able to execute
-- three of them; this is the same clean-up for tables, and it should have gone
-- with it.
--
-- ── CHECKED BEFORE REMOVING ──────────────────────────────────────────────
-- Nothing unauthenticated reads a table. `lib/auth/*` uses the service role for
-- every sensitive read (`session_state_for`, `issue_otp_challenge`,
-- `verify_otp_challenge`, `mark_login`), sign-in goes to `/auth/v1` rather than
-- to any table, and `anon` can already execute none of our functions. The Edge
-- middleware calls `session_state()` and `touch_last_seen()` — RPCs, unaffected
-- by table privileges.
--
-- `authenticated` keeps exactly what it has. This migration touches one role.
-- =============================================================================

do $$
declare
  r record;
begin
  for r in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'p')            -- tables and partitioned parents
       and has_table_privilege('anon', c.oid, 'select')
  loop
    execute format('revoke select on public.%I from anon', r.relname);
  end loop;
end;
$$;

-- And stop it coming back. `ALTER DEFAULT PRIVILEGES` is what re-grants this on
-- every new table created by the migration role, which is how it would quietly
-- return on the next table anyone adds.
alter default privileges in schema public revoke select on tables from anon;
