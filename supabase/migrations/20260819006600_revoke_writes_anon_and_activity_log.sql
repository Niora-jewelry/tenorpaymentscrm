-- =============================================================================
-- Part 66: stop the write grant from growing back — and make the activity log
-- append-only at the privilege level, not only by convention.
--
-- ── THE PATTERN THIS MIGRATION FINALLY BREAKS ────────────────────────────
-- Migration 11 revoked INSERT/UPDATE/DELETE from anon and authenticated on the
-- tables that existed when it ran. Migration 31 did it again for the tables
-- added since. 61 did it for TRUNCATE, 64 and 65 for EXECUTE. Five migrations,
-- one shape: Supabase's project-level `ALTER DEFAULT PRIVILEGES` re-grants the
-- privilege on every new object, so a one-time `revoke` fixes today's list and
-- nothing else.
--
-- Auditing that today, 78 tables carry DELETE/INSERT/UPDATE for `anon` again —
-- every `record_activity` partition from 2026_10 forward. They were created
-- after migration 31 ran, so they simply arrived with the grant restored. The
-- two partitions that predate it, 2026_08 and 2026_09, hold SELECT only. The
-- fix is not another list; it is the default.
--
-- ── HOW BAD IS IT TODAY: NOT LIVE, AND MEASURED ──────────────────────────
-- PostgREST does not put partitions in its schema cache, so there is no HTTP
-- path to one. Confirmed with the publishable anon key against the live API:
--
--   POST   /rest/v1/record_activity_2027_03  -> 404 PGRST205 "Could not find
--   DELETE /rest/v1/record_activity_2027_03      the table ... in the schema cache"
--
-- And even reached directly, each partition has RLS enabled with zero policies,
-- which is default-deny for any role that does not own it. So this is the same
-- verdict as migration 61's TRUNCATE: latent, not live, and closed anyway,
-- because both of those are facts about the current surface rather than
-- properties of the schema. PostgREST's partition handling is a version
-- detail, not a guarantee.
--
-- ── THE ACTIVITY LOG HALF ────────────────────────────────────────────────
-- CLAUDE.md rule 4 says one module writes the activity log, and the Database
-- section says a rule that must never break belongs in the database as well as
-- the code. Right now the database does not hold up its end: `authenticated`
-- has INSERT, UPDATE and DELETE on those 78 partitions.
--
-- Nothing in `src/` writes the table through a request-scoped client — checked
-- every `.from('record_activity')` call site; `src/lib/records/activity.ts` is
-- the only one and it is a SELECT. Writes go through SECURITY DEFINER
-- functions owned by `postgres`, which is unaffected by a revoke on client
-- roles. So revoking the three write verbs takes away an ability the app never
-- exercises and turns "append-only" into something the database enforces.
--
-- ⚠️ This is deliberately NOT applied to `authenticated` on ordinary tables.
-- The app genuinely writes many of them directly with the caller's own JWT —
-- `user_filters`, `user_field_order`, `notes`, `files`, `logins`,
-- `notifications`, `records` and more — where RLS is the boundary and is doing
-- its job. Revoking there would break the product. `anon` is different: no code
-- path in this app ever holds the anon role, so it needs no write anywhere.
-- =============================================================================

-- 1. Every table that exists: anon writes nothing. SELECT is left alone — RLS
--    genuinely covers reads, which is the same call migrations 11 and 31 made.
revoke insert, update, delete on all tables in schema public from anon;

-- 2. The activity log is append-only for client roles, partitions included.
--    `all tables in schema public` would sweep up tables the app must write, so
--    this is scoped by name to the partitioned parent and its children.
do $$
declare
  t record;
  n int := 0;
begin
  for t in
    select cl.oid::regclass::text as rel
      from pg_class cl
      join pg_namespace ns on ns.oid = cl.relnamespace
     where ns.nspname = 'public'
       and cl.relkind in ('r', 'p')
       and cl.relname like 'record\_activity%'
  loop
    execute format('revoke insert, update, delete on %s from anon, authenticated', t.rel);
    n := n + 1;
  end loop;
  raise notice 'activity log: revoked writes on % relation(s)', n;
end;
$$;

-- 3. The half that stops migration 67 having to do this again. A table created
--    after this point does not arrive writable by anon.
alter default privileges in schema public
  revoke insert, update, delete on tables from anon;

-- Same guard as 61, 64 and 65: `postgres` is not a member of `supabase_admin`
-- on a hosted project, and the bare statement raises 42501.
do $$
begin
  execute 'alter default privileges for role supabase_admin in schema public '
       || 'revoke insert, update, delete on tables from anon';
exception
  when insufficient_privilege then
    raise notice 'skipped supabase_admin default privileges (not a member) — postgres default applied';
end;
$$;
