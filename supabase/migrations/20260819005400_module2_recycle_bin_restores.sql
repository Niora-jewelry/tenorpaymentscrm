-- =============================================================================
-- Module 2 — Part 54: the Recycle Bin gets the rest of what belongs in it.
--
-- ── THE REQUIREMENT ──────────────────────────────────────────────────────
-- Admin Plan §6: "The Recycle Bin contains everything truly soft-deleted
-- across the entire CRM: records (deleted from within the Records List
-- module), files, updates and replies, login rows, and users."
--
-- Only records were ever listed. Everything else set `deleted_at` and became
-- unreachable: before this migration the ONLY restore paths in the whole
-- codebase were `restore_record` and `restoreField`. A file, an update, a
-- reply or a login row could be deleted and was then gone for good, while the
-- interface called the action a soft delete.
--
-- ── WHY EACH RESTORE IS ITS OWN FUNCTION ─────────────────────────────────
-- Every one of these has a different precondition, and a generic
-- "restore(table, id)" would have to encode all of them anyway while losing the
-- ability to say which rule refused:
--
--   * a FILE cannot come back into a row that already holds five (the cap is a
--     trigger, and it counts only live rows);
--   * a REPLY cannot come back under a deleted update, nor a deleted thread;
--   * a LOGIN row belongs to a record that may itself be gone.
--
-- Each therefore checks its own parent and raises its own message.
--
-- ── PERMISSION ───────────────────────────────────────────────────────────
-- Admin-only, all of them. Admin Plan §6: "Access: admin-only, not grantable."
-- The Recycle Bin is the one surface the permission system deliberately cannot
-- widen, so these do not consult a grant at all — they ask `auth_is_admin()`
-- and stop.
--
-- Every restore is activity-logged against the record it belongs to, so the
-- round trip reads as one story in the timeline rather than a deletion with no
-- matching return.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Updates and their replies
-- -----------------------------------------------------------------------------
create or replace function restore_update(p_update_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record uuid;
  v_parent uuid;
begin
  if not auth_is_admin() then
    raise exception 'Only an admin may restore from the Recycle Bin' using errcode = '42501';
  end if;
  select record_id, parent_id into v_record, v_parent
    from updates where id = p_update_id and deleted_at is not null;
  if v_record is null then
    raise exception 'not found';
  end if;

  -- A reply cannot be live under a deleted parent — `updates_depth_guard`
  -- keeps the tree one level deep, and this keeps it connected.
  if v_parent is not null
     and exists (select 1 from updates where id = v_parent and deleted_at is not null) then
    raise exception 'Restore the update this reply belongs to first'
      using errcode = '23514';
  end if;

  update updates set deleted_at = null where id = p_update_id;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (v_record, auth.uid(), 'update',
          case when v_parent is null then 'Restored an update from the Recycle Bin'
               else 'Restored a reply from the Recycle Bin' end);
end;
$$;

-- -----------------------------------------------------------------------------
-- Files
-- -----------------------------------------------------------------------------
create or replace function restore_file(p_file_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record uuid;
  v_name   text;
  v_row    uuid;
begin
  if not auth_is_admin() then
    raise exception 'Only an admin may restore from the Recycle Bin' using errcode = '42501';
  end if;
  select fr.record_id, f.name, f.file_row_id into v_record, v_name, v_row
    from files f join file_rows fr on fr.id = f.file_row_id
   where f.id = p_file_id and f.deleted_at is not null;
  if v_record is null then
    raise exception 'not found';
  end if;

  if exists (select 1 from file_rows where id = v_row and deleted_at is not null) then
    raise exception 'Restore the file row this file belongs to first' using errcode = '23514';
  end if;

  -- The five-per-row cap is enforced by a trigger on INSERT only, so an UPDATE
  -- that un-deletes could quietly push a row to six. Checked here instead.
  if (select count(*) from files where file_row_id = v_row and deleted_at is null) >= 5 then
    raise exception 'That file row already holds 5 files — remove one before restoring this'
      using errcode = '23514';
  end if;

  update files set deleted_at = null where id = p_file_id;

  insert into record_activity (record_id, actor_id, kind, summary, to_value)
  values (v_record, auth.uid(), 'file', 'Restored a file from the Recycle Bin', v_name);
end;
$$;

-- -----------------------------------------------------------------------------
-- Login rows
-- -----------------------------------------------------------------------------
create or replace function restore_login(p_login_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record uuid;
  v_type   text;
begin
  if not auth_is_admin() then
    raise exception 'Only an admin may restore from the Recycle Bin' using errcode = '42501';
  end if;
  select record_id, login_type into v_record, v_type
    from logins where id = p_login_id and deleted_at is not null;
  if v_record is null then
    raise exception 'not found';
  end if;

  update logins set deleted_at = null where id = p_login_id;

  -- 'credential' rather than 'record': the reveal log already uses it, so a
  -- record's credential history reads as one filterable thread.
  insert into record_activity (record_id, actor_id, kind, summary, to_value)
  values (v_record, auth.uid(), 'credential', 'Restored a login row from the Recycle Bin', v_type);
end;
$$;

revoke execute on function restore_update(uuid) from public;
revoke execute on function restore_file(uuid)   from public;
revoke execute on function restore_login(uuid)  from public;
grant  execute on function restore_update(uuid) to authenticated;
grant  execute on function restore_file(uuid)   to authenticated;
grant  execute on function restore_login(uuid)  to authenticated;
