-- =============================================================================
-- Module 2 — Part 11: hardening found by the extended verify-schema.mjs run
--
-- FOUND BY: running scripts/verify-schema.mjs against the live database right
-- after the first 10 migrations landed — the same "prove it, don't trust it"
-- discipline the auth module's own verify script already established.
--
-- WHAT IT FOUND
--
-- 1. Supabase's project-level `ALTER DEFAULT PRIVILEGES` grants anon and
--    authenticated full INSERT/SELECT/UPDATE/DELETE on every newly CREATEd
--    table in `public`, automatically, at creation time. The auth module's
--    tables were never actually exposed by this — its own
--    `revoke all on all tables in schema public from anon, authenticated`
--    runs AFTER creating its tables, in the SAME migration, which strips the
--    auto-grant before that transaction commits. None of migrations 2–9 here
--    issued that revoke, so record_activity, credential_reveals,
--    record_team_members and messages — all four intended to be
--    definer/trigger-written only, gated purely by "zero INSERT/UPDATE/DELETE
--    policy exists" — actually still carry the broad default grant. RLS with
--    zero applicable policies already blocks every one of those operations
--    regardless (a table with RLS enabled and no permissive policy for a
--    command denies that command outright, independent of the GRANT), so
--    this was not an active hole — but it is a gap in the SECOND layer the
--    rest of this project deliberately keeps ("the trigger catches the table
--    owner, whom the revoke does not" — SCHEMA.md's own reasoning for why
--    record_activity carries both a revoke AND a trigger). Closing it here
--    means a future accidental INSERT policy on one of these tables is still
--    caught by the missing grant, not just by RLS being the only line left.
--
-- 2. `notifications` never got an explicit RLS pass at all in migration 9 — a
--    plain omission, not a design choice. It came up as `rowsecurity = true`
--    already (Supabase enables RLS by default on new public tables, but does
--    NOT force it and creates no policy), which happened to leave it
--    default-deny-safe by accident, but with no owner-scoped read/write path
--    at all. Given a real shape here instead of leaving it as a gap.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Explicit revoke, matching the auth module's own defense-in-depth pattern
-- -----------------------------------------------------------------------------
revoke insert, update, delete on record_activity, credential_reveals, record_team_members, messages
  from authenticated, anon;

-- -----------------------------------------------------------------------------
-- 2. notifications — recipient reads/marks-read their own; nothing else is
--    ever granted directly. Written exclusively by notify(), the same
--    single-writer shape as log_activity().
-- -----------------------------------------------------------------------------
alter table notifications force row level security;

create policy notifications_select_own on notifications for select to authenticated
  using (recipient_id = auth.uid());

create policy notifications_update_own on notifications for update to authenticated
  using (recipient_id = auth.uid())
  with check (recipient_id = auth.uid());

revoke insert, delete on notifications from authenticated, anon;
grant select on notifications to authenticated;
-- Column-restricted: a recipient may mark their own notification read, and
-- change nothing else about it.
grant update (read_at) on notifications to authenticated;

create or replace function notify(
  p_recipient_id uuid,
  p_body         text,
  p_record_id    uuid,
  p_source_kind  text
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into notifications (recipient_id, body, record_id, source_kind)
  values (p_recipient_id, p_body, p_record_id, p_source_kind);
$$;

revoke all on function notify(uuid, text, uuid, text) from anon, authenticated;
