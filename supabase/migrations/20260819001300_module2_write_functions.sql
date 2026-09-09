-- =============================================================================
-- Module 2 — Part 13: the combined write functions
--
-- MODULE-2-PLAN.md §7.1: "A value change and its history are one transaction.
-- Not by convention — by construction, in a single database function." This
-- migration is that construction: every mutation `lib/records/*` (Stage 2)
-- exposes to the app is one of these functions, never a bare INSERT/UPDATE
-- from the client followed by a separate activity-log call that could
-- succeed while the other fails.
--
-- §13.4 (Concurrency) shapes set_record_value() specifically: a losing writer
-- is TOLD — "both values shown" — not just handed a bare conflict flag, so it
-- returns the current value, who changed it, and when.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- set_record_value — compare-and-swap on ONE field, plus its history entry,
-- in one transaction. SCHEMA-DECISIONS §5's CAS mechanism, extended with the
-- "tell the loser" data §13.4 requires.
-- -----------------------------------------------------------------------------
create or replace function set_record_value(
  p_record_id           uuid,
  p_field_key           text,
  p_new_value           jsonb,
  p_expected_updated_at timestamptz,
  p_summary             text
)
returns table (
  ok          boolean,
  updated_at  timestamptz,
  current_value jsonb,
  changed_by    uuid,
  changed_at    timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old_value jsonb;
  v_new_at    timestamptz;
begin
  if not record_visible(p_record_id) then
    raise exception 'not found';
  end if;

  select r.values -> p_field_key into v_old_value from records r where r.id = p_record_id;

  update records
     set values = jsonb_set(values, array[p_field_key], p_new_value, true),
         updated_at = now()
   where id = p_record_id
     and records.updated_at = p_expected_updated_at
     and deleted_at is null
  returning records.updated_at into v_new_at;

  if v_new_at is not null then
    insert into record_activity (record_id, actor_id, kind, field_key, summary, from_value, to_value)
    values (p_record_id, auth.uid(), 'field', p_field_key, p_summary,
            v_old_value #>> '{}', p_new_value #>> '{}');

    return query select true, v_new_at, null::jsonb, null::uuid, null::timestamptz;
    return;
  end if;

  -- CAS lost: someone else saved first. Tell the loser who, what, and when —
  -- "Sarah changed this a moment ago" needs all three, not a bare boolean.
  return query
    select
      false,
      r.updated_at,
      r.values -> p_field_key,
      (select a.actor_id from record_activity a
        where a.record_id = p_record_id and a.field_key = p_field_key and a.kind = 'field'
        order by a.at desc limit 1),
      (select a.at from record_activity a
        where a.record_id = p_record_id and a.field_key = p_field_key and a.kind = 'field'
        order by a.at desc limit 1)
    from records r
    where r.id = p_record_id;
end;
$$;

revoke all on function set_record_value(uuid, text, jsonb, timestamptz, text) from anon, authenticated;
grant execute on function set_record_value(uuid, text, jsonb, timestamptz, text) to authenticated;

-- -----------------------------------------------------------------------------
-- set_record_memberships — replaces a record's module membership set in one
-- statement, logs the delta, and detects the Archive transition (last
-- membership cleared) as ITS own logged event, not silently folded into a
-- generic membership-change line.
-- -----------------------------------------------------------------------------
create or replace function set_record_memberships(p_record_id uuid, p_module_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_had_any boolean;
begin
  if not record_visible(p_record_id) then
    raise exception 'not found';
  end if;

  select exists(select 1 from record_modules where record_id = p_record_id) into v_had_any;

  delete from record_modules
   where record_id = p_record_id and module_id <> all (coalesce(p_module_ids, '{}'));

  insert into record_modules (record_id, module_id, added_by)
  select p_record_id, m, auth.uid()
    from unnest(coalesce(p_module_ids, '{}')) as m
  on conflict (record_id, module_id) do nothing;

  if v_had_any and coalesce(array_length(p_module_ids, 1), 0) = 0 then
    insert into record_activity (record_id, actor_id, kind, summary)
    values (p_record_id, auth.uid(), 'membership', 'Archived — no longer displayed in any module');
  else
    insert into record_activity (record_id, actor_id, kind, summary)
    values (p_record_id, auth.uid(), 'membership', 'Module membership updated');
  end if;
end;
$$;

revoke all on function set_record_memberships(uuid, uuid[]) from anon, authenticated;
grant execute on function set_record_memberships(uuid, uuid[]) to authenticated;

-- -----------------------------------------------------------------------------
-- Pipelines — step change and clear, each its own logged event.
-- -----------------------------------------------------------------------------
create or replace function set_pipeline_step(
  p_record_id   uuid,
  p_module_id   uuid,
  p_pipeline_id uuid,
  p_step_id     uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_step_label text;
begin
  if not record_visible(p_record_id) then
    raise exception 'not found';
  end if;

  select label into v_step_label from pipeline_steps where id = p_step_id;

  insert into record_pipelines (record_id, module_id, pipeline_id, step_id)
  values (p_record_id, p_module_id, p_pipeline_id, p_step_id)
  on conflict (record_id, module_id) do update
    set pipeline_id = excluded.pipeline_id, step_id = excluded.step_id, updated_at = now();

  insert into record_activity (record_id, actor_id, kind, summary, to_value)
  values (p_record_id, auth.uid(), 'pipeline', 'Pipeline step changed', v_step_label);
end;
$$;

create or replace function clear_pipeline(p_record_id uuid, p_module_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not record_visible(p_record_id) then
    raise exception 'not found';
  end if;

  delete from record_pipelines where record_id = p_record_id and module_id = p_module_id;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (p_record_id, auth.uid(), 'pipeline', 'Pipeline removed');
end;
$$;

revoke all on function set_pipeline_step(uuid, uuid, uuid, uuid) from anon, authenticated;
revoke all on function clear_pipeline(uuid, uuid) from anon, authenticated;
grant execute on function set_pipeline_step(uuid, uuid, uuid, uuid) to authenticated;
grant execute on function clear_pipeline(uuid, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- delete_record / restore_record — now also logged. `create or replace`
-- against the versions in migration 3; the archive-before-delete guard is
-- unchanged, logging is the only addition.
-- -----------------------------------------------------------------------------
create or replace function delete_record(rec uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from record_modules where record_id = rec) then
    raise exception 'Archive this record before deleting it — it is still displayed in a module'
      using errcode = '23514';
  end if;
  update records set deleted_at = now() where id = rec;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (rec, auth.uid(), 'record', 'Deleted — moved to the Recycle Bin');
end;
$$;

create or replace function restore_record(rec uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update records set deleted_at = null where id = rec;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (rec, auth.uid(), 'record', 'Restored from the Recycle Bin — archived (no display memberships)');
end;
$$;

-- -----------------------------------------------------------------------------
-- toggle_case_state — now also logged, each direction its own summary.
-- -----------------------------------------------------------------------------
create or replace function toggle_case_state(p_case_id uuid, p_close boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_record uuid;
begin
  select record_id into v_record from cases where id = p_case_id;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;

  if p_close then
    update cases set state = 'closed' where id = p_case_id and solution is not null;
    if not found then
      raise exception 'A case cannot be closed until its Solution has been written'
        using errcode = '23514';
    end if;
    insert into record_activity (record_id, actor_id, kind, summary)
    values (v_record, auth.uid(), 'case', 'Case closed');
  else
    update cases set state = 'open' where id = p_case_id;
    insert into record_activity (record_id, actor_id, kind, summary)
    values (v_record, auth.uid(), 'case', 'Case reopened');
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- reveal_password — now also logged to record_activity, not only
-- credential_reveals. §7.1 lists "credential reveals" as an activity_kind
-- event; credential_reveals stays the authoritative per-reveal audit row
-- (SCHEMA-DECISIONS §15), this is the same fact surfaced on the record's own
-- timeline.
-- -----------------------------------------------------------------------------
create or replace function reveal_password(p_login_id uuid, p_key text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record uuid;
  v_enc    bytea;
  v_type   text;
begin
  select record_id, password_enc, login_type into v_record, v_enc, v_type
    from logins where id = p_login_id;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;

  insert into credential_reveals (login_id, user_id) values (p_login_id, auth.uid());
  insert into record_activity (record_id, actor_id, kind, summary)
  values (v_record, auth.uid(), 'credential', format('Revealed the %s password', v_type));

  return extensions.pgp_sym_decrypt(v_enc, p_key);
end;
$$;

-- -----------------------------------------------------------------------------
-- Updates — creation is not itself a logged history event (the update row IS
-- the record); edits and deletions are (§7.1: "update edits and deletions").
-- -----------------------------------------------------------------------------
create or replace function edit_update(p_update_id uuid, p_body text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_record uuid; v_author uuid;
begin
  select record_id, author_id into v_record, v_author from updates where id = p_update_id;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;
  if v_author <> auth.uid() and not auth_is_admin() then
    raise exception 'Only the author or an admin may edit this update' using errcode = '42501';
  end if;

  update updates set body = p_body, edited_at = now() where id = p_update_id;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (v_record, auth.uid(), 'update', 'Update edited');
end;
$$;

create or replace function delete_update(p_update_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_record uuid; v_author uuid;
begin
  select record_id, author_id into v_record, v_author from updates where id = p_update_id;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;
  if v_author <> auth.uid() and not auth_is_admin() then
    raise exception 'Only the author or an admin may delete this update' using errcode = '42501';
  end if;

  update updates set deleted_at = now() where id = p_update_id;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (v_record, auth.uid(), 'update', 'Update deleted');
end;
$$;

revoke all on function toggle_case_state(uuid, boolean) from anon, authenticated;
revoke all on function reveal_password(uuid, text) from anon, authenticated;
revoke all on function edit_update(uuid, text) from anon, authenticated;
revoke all on function delete_update(uuid) from anon, authenticated;
grant execute on function toggle_case_state(uuid, boolean) to authenticated;
grant execute on function reveal_password(uuid, text) to authenticated;
grant execute on function edit_update(uuid, text) to authenticated;
grant execute on function delete_update(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Cases — create (with its manager list) and reply, each one transaction.
-- -----------------------------------------------------------------------------
create or replace function create_case(
  p_record_id   uuid,
  p_title       text,
  p_issue       text,
  p_manager_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_case_id uuid;
  v_managers uuid[];
begin
  if not record_visible(p_record_id) then
    raise exception 'not found';
  end if;

  -- "Ticket managers, always >= 1; issue author auto-assigned."
  v_managers := (select array_agg(distinct m) from unnest(
    array_append(coalesce(p_manager_ids, '{}'), auth.uid())
  ) as m);

  insert into cases (record_id, title, issue, issue_author)
  values (p_record_id, p_title, p_issue, auth.uid())
  returning id into v_case_id;

  insert into case_managers (case_id, user_id)
  select v_case_id, m from unnest(v_managers) as m;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (p_record_id, auth.uid(), 'case', format('Case opened: %s', p_title));

  return v_case_id;
end;
$$;

create or replace function add_case_reply(p_case_id uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_record uuid; v_reply_id uuid;
begin
  select record_id into v_record from cases where id = p_case_id;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;

  insert into case_replies (case_id, author_id, body)
  values (p_case_id, auth.uid(), p_body)
  returning id into v_reply_id;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (v_record, auth.uid(), 'case', 'Case reply added');

  return v_reply_id;
end;
$$;

-- Admin override: edit issue/solution text under full audit — "an 'edited by'
-- marker and prior text logged" (§12). Non-admins never reach this; RLS's
-- `cases_all` policy already lets an author write their own case row for the
-- ordinary edit path, but issue/solution text is otherwise "immutable to
-- non-admins including authors" per spec, enforced here rather than by RLS
-- (RLS cannot express "only these two columns, only if admin, only with a
-- marker set").
create or replace function admin_edit_case(
  p_case_id     uuid,
  p_new_issue   text,
  p_new_solution text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_record uuid; v_old_issue text; v_old_solution text;
begin
  if not auth_is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;

  select record_id, issue, solution into v_record, v_old_issue, v_old_solution
    from cases where id = p_case_id;
  if v_record is null then raise exception 'not found'; end if;

  update cases
     set issue = coalesce(p_new_issue, issue),
         solution = coalesce(p_new_solution, solution),
         edited_by = auth.uid()
   where id = p_case_id;

  insert into record_activity (record_id, actor_id, kind, summary, from_value, to_value)
  values (
    v_record, auth.uid(), 'case', 'Case edited by admin',
    concat_ws(' / ', v_old_issue, v_old_solution),
    concat_ws(' / ', coalesce(p_new_issue, v_old_issue), coalesce(p_new_solution, v_old_solution))
  );
end;
$$;

revoke all on function create_case(uuid, text, text, uuid[]) from anon, authenticated;
revoke all on function add_case_reply(uuid, text) from anon, authenticated;
revoke all on function admin_edit_case(uuid, text, text) from anon, authenticated;
grant execute on function create_case(uuid, text, text, uuid[]) to authenticated;
grant execute on function add_case_reply(uuid, text) to authenticated;
grant execute on function admin_edit_case(uuid, text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- Files — metadata write (the actual bytes go to Storage first, from the app
-- layer; this records the row and its history entry together once that
-- succeeds) and soft delete.
-- -----------------------------------------------------------------------------
create or replace function record_file_upload(
  p_file_row_id  uuid,
  p_storage_path text,
  p_name         text,
  p_size_bytes   bigint
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_record uuid; v_file_id uuid;
begin
  select record_id into v_record from file_rows where id = p_file_row_id;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;

  insert into files (file_row_id, storage_path, name, size_bytes, uploaded_by)
  values (p_file_row_id, p_storage_path, p_name, p_size_bytes, auth.uid())
  returning id into v_file_id;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (v_record, auth.uid(), 'file', format('Uploaded %s', p_name));

  return v_file_id;
end;
$$;

create or replace function delete_file(p_file_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_record uuid; v_name text;
begin
  select fr.record_id, f.name into v_record, v_name
    from files f join file_rows fr on fr.id = f.file_row_id
   where f.id = p_file_id;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;

  update files set deleted_at = now() where id = p_file_id;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (v_record, auth.uid(), 'file', format('Deleted %s', v_name));
end;
$$;

revoke all on function record_file_upload(uuid, text, text, bigint) from anon, authenticated;
revoke all on function delete_file(uuid) from anon, authenticated;
grant execute on function record_file_upload(uuid, text, text, bigint) to authenticated;
grant execute on function delete_file(uuid) to authenticated;
