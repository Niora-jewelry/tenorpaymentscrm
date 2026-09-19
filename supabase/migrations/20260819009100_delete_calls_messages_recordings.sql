-- =============================================================================
-- Part 91: let a call, a text or a recording be removed.
--
-- ── WHY THESE ARE RPCs AND NOT ROW POLICIES ──────────────────────────────
-- `phone_calls`, `phone_messages` and `phone_recordings` grant no INSERT,
-- UPDATE or DELETE to `authenticated` at all (migration 68) — every write is
-- made by a webhook holding the service role, so there is exactly one writer.
-- Opening those tables to client writes to add a delete button would undo that
-- for the sake of one action.
--
-- So deletion is three SECURITY DEFINER functions that each answer the
-- permission question themselves, in the same shape as `delete_file` and the
-- rest of the tab-backed writers after migration 85.
--
-- ── SOFT, LIKE EVERYTHING ELSE ───────────────────────────────────────────
-- All three tables carry `deleted_at`, and every read path already filters on
-- it. Setting it is the whole operation; nothing is destroyed, and the stored
-- recording audio is deliberately left in its bucket — the storage policy keys
-- on the call, so a deleted call's audio stops being reachable without a
-- second, racier delete against object storage.
--
-- ── WHO MAY ─────────────────────────────────────────────────────────────
-- A call or recording belongs to the person who made or received it. The rule
-- is the one already used for reading recordings: the OWNER, or an admin. A
-- colleague who can see the record cannot delete your call history.
--
-- Where a call is attached to a record, the Communication tab must also be
-- editable — otherwise someone holding View on a record could still erase its
-- telephony history, which is the exact hole migration 88 closed for cases and
-- updates.
-- =============================================================================


create or replace function public.delete_phone_call(p_call_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner  uuid;
  v_record uuid;
begin
  select owner_id, record_id into v_owner, v_record
    from phone_calls where id = p_call_id and deleted_at is null;
  if v_owner is null and v_record is null then
    -- Either it does not exist or it is already gone. Same answer for both, so
    -- this cannot be used to probe for call ids.
    raise exception 'not found';
  end if;

  if not auth_is_admin() and v_owner is distinct from auth.uid() then
    raise exception 'Only the person on the call, or an administrator, may delete it.'
      using errcode = '42501';
  end if;

  -- Attached to a record: the Communication tab has to be writable too.
  if v_record is not null then
    perform require_tab_edit(v_record, 'communication');
  end if;

  update phone_calls set deleted_at = now() where id = p_call_id;
  -- Its recordings go with it. Leaving them would orphan rows that every read
  -- path reaches through the call.
  update phone_recordings set deleted_at = now()
   where call_id = p_call_id and deleted_at is null;
end;
$$;


create or replace function public.delete_phone_recording(p_recording_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner  uuid;
  v_record uuid;
begin
  select c.owner_id, c.record_id into v_owner, v_record
    from phone_recordings r
    join phone_calls c on c.id = r.call_id
   where r.id = p_recording_id and r.deleted_at is null;
  if not found then
    raise exception 'not found';
  end if;

  if not auth_is_admin() and v_owner is distinct from auth.uid() then
    raise exception 'Only the person on the call, or an administrator, may delete its recording.'
      using errcode = '42501';
  end if;

  if v_record is not null then
    perform require_tab_edit(v_record, 'communication');
  end if;

  update phone_recordings set deleted_at = now() where id = p_recording_id;
end;
$$;


create or replace function public.delete_phone_message(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner  uuid;
  v_record uuid;
begin
  select owner_id, record_id into v_owner, v_record
    from phone_messages where id = p_message_id and deleted_at is null;
  if not found then
    raise exception 'not found';
  end if;

  if not auth_is_admin() and v_owner is distinct from auth.uid() then
    raise exception 'Only the person on the conversation, or an administrator, may delete it.'
      using errcode = '42501';
  end if;

  if v_record is not null then
    perform require_tab_edit(v_record, 'communication');
  end if;

  update phone_messages set deleted_at = now() where id = p_message_id;
end;
$$;


revoke execute on function public.delete_phone_call(uuid) from public, anon;
revoke execute on function public.delete_phone_recording(uuid) from public, anon;
revoke execute on function public.delete_phone_message(uuid) from public, anon;
grant execute on function public.delete_phone_call(uuid) to authenticated, service_role;
grant execute on function public.delete_phone_recording(uuid) to authenticated, service_role;
grant execute on function public.delete_phone_message(uuid) to authenticated, service_role;
