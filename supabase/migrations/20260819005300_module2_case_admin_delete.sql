-- =============================================================================
-- Module 2 — Part 53: an admin can delete a case reply or a whole thread.
--
-- ── THE REQUIREMENT, AND A CONFLICT BETWEEN TWO CLIENT DOCUMENTS ─────────
-- Modules Plan, **Amendment 3** (the client's own amendment block, which sits
-- at the top of that document and explicitly overrides the body below it):
--
--   "Admin override. Admins can edit the Issue, the Solution, and replies, and
--    can delete replies and entire case threads. Every admin edit displays a
--    visible marker on the content ('edited by {admin}') and writes the full
--    prior text to the activity log … Admin deletion of a reply or thread is a
--    soft delete to the Recycle Bin, restorable like any other object; the
--    deletion and any restore are activity-logged."
--
-- ⚠️ Two OTHER passages say the opposite: the Modules body §3.7 ("Case threads
-- can never be deleted — not by their author, not by an admin") and Admin Plan
-- §6 ("Cases can never be deleted by anyone under any circumstances; there is
-- no path by which a case thread reaches the bin").
--
-- Amendment 3 is implemented here because an amendment block exists precisely
-- to supersede the body it is attached to, and because it is the more specific
-- and more recent statement. **This conflict is flagged to the client rather
-- than silently resolved** — if he confirms the older rule instead, revoking
-- the two functions below restores it with no other change, since nothing else
-- writes `cases.deleted_at`.
--
-- ── WHAT IS DELIBERATELY UNCHANGED ───────────────────────────────────────
--   * NON-admins still cannot delete anything here, and nobody can EDIT a case
--     except an admin — `admin_edit_case` already covers that half.
--   * Case NUMBERS are never reused, deleted or purged (Amendment 6). Nothing
--     below touches the sequence, and a soft delete cannot free a number.
--   * The delete is soft. `deleted_at` already exists on both tables; every
--     read path in `cases.ts` already filters `.is('deleted_at', null)`, so
--     these functions need add nothing to make a deleted row disappear.
-- =============================================================================

create or replace function delete_case(p_case_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record uuid;
  v_number bigint;
  v_title  text;
begin
  select record_id, number, title into v_record, v_number, v_title
    from cases where id = p_case_id and deleted_at is null;
  if v_record is null then
    raise exception 'not found';
  end if;
  if not auth_is_admin() then
    raise exception 'Only an admin may delete a case thread' using errcode = '42501';
  end if;

  update cases set deleted_at = now() where id = p_case_id;

  -- The replies go with the thread, so restoring the thread brings back what
  -- was under it. Only replies still live are touched, so a reply deleted
  -- earlier on its own stays deleted on its own.
  update case_replies set deleted_at = now()
   where case_id = p_case_id and deleted_at is null;

  insert into record_activity (record_id, actor_id, kind, summary, from_value)
  values (v_record, auth.uid(), 'case',
          format('Deleted case #%s — moved to the Recycle Bin', v_number), v_title);
end;
$$;

create or replace function restore_case(p_case_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record uuid;
  v_number bigint;
begin
  if not auth_is_admin() then
    raise exception 'Only an admin may restore a case thread' using errcode = '42501';
  end if;
  select record_id, number into v_record, v_number
    from cases where id = p_case_id and deleted_at is not null;
  if v_record is null then
    raise exception 'not found';
  end if;

  update cases set deleted_at = null where id = p_case_id;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (v_record, auth.uid(), 'case', format('Restored case #%s from the Recycle Bin', v_number));
end;
$$;

create or replace function delete_case_reply(p_reply_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record uuid;
  v_body   text;
  v_number bigint;
begin
  select c.record_id, r.body, c.number into v_record, v_body, v_number
    from case_replies r join cases c on c.id = r.case_id
   where r.id = p_reply_id and r.deleted_at is null;
  if v_record is null then
    raise exception 'not found';
  end if;
  if not auth_is_admin() then
    raise exception 'Only an admin may delete a case reply' using errcode = '42501';
  end if;

  update case_replies set deleted_at = now() where id = p_reply_id;

  -- The full prior text goes to the log, matching what `admin_edit_case` does
  -- for an edit: an admin removing somebody else's words must leave them
  -- recoverable in the history even after the row is purged.
  insert into record_activity (record_id, actor_id, kind, summary, from_value)
  values (v_record, auth.uid(), 'case',
          format('Deleted a reply on case #%s', v_number), v_body);
end;
$$;

create or replace function restore_case_reply(p_reply_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record uuid;
  v_number bigint;
begin
  if not auth_is_admin() then
    raise exception 'Only an admin may restore a case reply' using errcode = '42501';
  end if;
  select c.record_id, c.number into v_record, v_number
    from case_replies r join cases c on c.id = r.case_id
   where r.id = p_reply_id and r.deleted_at is not null;
  if v_record is null then
    raise exception 'not found';
  end if;

  -- Refused while the thread itself is deleted: a reply cannot be live under a
  -- thread that is not. Restore the thread first, which brings its replies with
  -- it anyway.
  if exists (select 1 from case_replies r join cases c on c.id = r.case_id
              where r.id = p_reply_id and c.deleted_at is not null) then
    raise exception 'Restore the case thread first — this reply belongs to a deleted thread'
      using errcode = '23514';
  end if;

  update case_replies set deleted_at = null where id = p_reply_id;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (v_record, auth.uid(), 'case', format('Restored a reply on case #%s', v_number));
end;
$$;

revoke execute on function delete_case(uuid)        from public;
revoke execute on function restore_case(uuid)       from public;
revoke execute on function delete_case_reply(uuid)  from public;
revoke execute on function restore_case_reply(uuid) from public;
grant  execute on function delete_case(uuid)        to authenticated;
grant  execute on function restore_case(uuid)       to authenticated;
grant  execute on function delete_case_reply(uuid)  to authenticated;
grant  execute on function restore_case_reply(uuid) to authenticated;
