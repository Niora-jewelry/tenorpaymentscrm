-- =============================================================================
-- Module 2 — Part 19: authorization audit fixes
--
-- Two real, exploitable gaps found by auditing every mutation RPC's internal
-- checks and actual grants, not just trusting that writing a `revoke`
-- statement meant it worked:
--
-- 1. delete_record() had NO visibility check — any authenticated caller
--    (and, per the PUBLIC-grant bug below, literally anyone) could soft-
--    delete ANY archived record system-wide, not just one they can see.
-- 2. restore_record() had NO check at all — same reach, for undeleting.
--    Recycle Bin is an admin-only surface everywhere else it's touched
--    (`listDeletedRecords()` requires `ctx.isAdmin`, the /admin/recycle-bin
--    page redirects non-admins) — restore_record() itself never enforced
--    that, so a non-admin who knew a deleted record's id could still call it.
--
-- 3. The same PUBLIC-execute-grant bug as the auth-module hardening
--    migration: every function created in migrations 9, 11, 13–18 carries
--    Postgres's default PUBLIC grant, which `revoke ... from anon,
--    authenticated` never touched. Swept here the same way.
-- =============================================================================

create or replace function delete_record(rec uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not record_visible(rec) then
    raise exception 'not found';
  end if;
  if exists (select 1 from record_modules where record_id = rec) then
    raise exception 'Archive this record before deleting it — it is still displayed in a module'
      using errcode = '23514';
  end if;
  update records set deleted_at = now() where id = rec;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (rec, auth.uid(), 'record', 'Deleted — moved to the Recycle Bin');
end;
$$;

-- Admin-only, matching purge_record() and every other Recycle Bin entry
-- point (`listDeletedRecords()`, the /admin/recycle-bin page) — restore has
-- no legitimate non-admin caller, since a non-admin cannot even see that a
-- record was deleted in the first place (RLS's records_select already
-- excludes deleted_at IS NOT NULL rows from everyone).
create or replace function restore_record(rec uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not auth_is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;

  update records set deleted_at = null where id = rec;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (rec, auth.uid(), 'record', 'Restored from the Recycle Bin — archived (no display memberships)');
end;
$$;

-- -----------------------------------------------------------------------------
-- Grant sweep. Revoke PUBLIC on every Module 2 function; re-grant to
-- authenticated only where `lib/records/*` actually calls it via the
-- request-scoped client (verified by grepping every `.rpc()` call site, not
-- assumed) — everything called only via supabaseAdmin() (effective_grant)
-- gets no client grant at all, same posture as the auth module's
-- service-role-only functions.
-- -----------------------------------------------------------------------------
revoke execute on function
  can_see_record(uuid),
  record_visible(uuid),
  effective_grant(uuid, grant_scope, uuid),
  log_activity(uuid, activity_kind, text, citext, text, text),
  notify(uuid, text, uuid, text),
  open_case_managers_for(uuid),
  delete_record(uuid),
  restore_record(uuid),
  purge_record(uuid),
  set_record_value(uuid, text, jsonb, timestamptz, text),
  set_record_memberships(uuid, uuid[]),
  bulk_set_values(uuid[], text, jsonb, text),
  set_pipeline_step(uuid, uuid, uuid, uuid),
  clear_pipeline(uuid, uuid),
  toggle_case_state(uuid, boolean),
  reveal_password(uuid, text),
  store_login_password(uuid, text, text, text),
  edit_update(uuid, text),
  delete_update(uuid),
  create_case(uuid, text, text, uuid[]),
  add_case_reply(uuid, text),
  admin_edit_case(uuid, text, text),
  record_file_upload(uuid, text, text, bigint),
  delete_file(uuid)
from public;

grant execute on function
  open_case_managers_for(uuid),
  delete_record(uuid),
  restore_record(uuid),
  purge_record(uuid),
  set_record_value(uuid, text, jsonb, timestamptz, text),
  set_record_memberships(uuid, uuid[]),
  bulk_set_values(uuid[], text, jsonb, text),
  set_pipeline_step(uuid, uuid, uuid, uuid),
  clear_pipeline(uuid, uuid),
  toggle_case_state(uuid, boolean),
  reveal_password(uuid, text),
  store_login_password(uuid, text, text, text),
  edit_update(uuid, text),
  delete_update(uuid),
  create_case(uuid, text, text, uuid[]),
  add_case_reply(uuid, text),
  admin_edit_case(uuid, text, text),
  record_file_upload(uuid, text, text, bigint),
  delete_file(uuid)
to authenticated;

-- can_see_record, record_visible, effective_grant, log_activity, notify:
-- deliberately NO grant to authenticated. The first two are called only from
-- inside other SECURITY DEFINER functions or RLS policies (never a direct
-- client RPC); effective_grant is called exclusively via supabaseAdmin()
-- (lib/records/permissions.ts) — service role bypasses grants entirely, so
-- a client grant would only widen the surface for no reason; log_activity
-- and notify are single-writer helpers nothing currently calls (every
-- combined write function inlines its own activity insert instead of
-- calling log_activity; notify is built for a future @mentions consumer).
-- open_case_managers_for DOES get the authenticated grant above — it's the
-- one function here genuinely meant for direct client use once the Tickets
-- "Open case managers" column is wired into a caller, matching its original
-- design in migration 9.
