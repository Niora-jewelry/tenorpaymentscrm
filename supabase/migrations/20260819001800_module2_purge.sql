-- =============================================================================
-- Module 2 — Part 18: purge_record(), and the FK it exposed
--
-- FOUND BY: the smoke test's own cleanup step — deleting the throwaway
-- record failed with "Table record_activity_2026_08 is append-only", because
-- record_activity.record_id had `references records on delete cascade`. A
-- real Recycle Bin Purge (MODULE-2-PLAN §6: "Purge | Recycle Bin | Permanent")
-- would hit the exact same wall: the cascade attempts to delete the record's
-- activity rows, and the append-only trigger correctly refuses even a
-- cascade-triggered delete, failing the whole transaction.
--
-- THE FIX, same shape as 20260810000200_audit_log_independence.sql's fix for
-- auth_audit_log.actor_id: drop the foreign key. An activity log entry
-- records what happened; it must survive the deletion of the record it
-- refers to, or the trail is destroyed exactly when it matters most — a
-- purged record's history becomes an orphaned but still-readable-by-id trail,
-- exactly like auth_audit_log survives a deleted user.
--
-- purge_record() itself never existed as a database function before this —
-- the Recycle Bin's third lifecycle action (Restore, the other two, already
-- had delete_record()/restore_record() from migration 3) was a genuine gap,
-- not a deferred decision.
-- =============================================================================

alter table record_activity
  drop constraint if exists record_activity_record_id_fkey;

comment on column record_activity.record_id is
  'Deliberately NOT a foreign key, for the same reason as auth_audit_log.actor_id: '
  'the entry must survive a Recycle Bin purge of the record it refers to, or the '
  'trail is destroyed exactly when it matters most. A purged record''s activity '
  'rows become orphaned but remain individually readable by id.';

create index if not exists record_activity_record_lookup on record_activity (record_id);

create or replace function purge_record(rec uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not auth_is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if not exists (select 1 from records where id = rec and deleted_at is not null) then
    raise exception 'Only an already-deleted (Recycle Bin) record may be purged'
      using errcode = '23514';
  end if;

  -- Every other child table still cascades from `records` normally; only
  -- record_activity is exempt (no FK at all, see above), so it survives this
  -- delete as an orphaned trail rather than blocking it.
  delete from records where id = rec;
end;
$$;

revoke all on function purge_record(uuid) from anon, authenticated;
grant execute on function purge_record(uuid) to authenticated;
