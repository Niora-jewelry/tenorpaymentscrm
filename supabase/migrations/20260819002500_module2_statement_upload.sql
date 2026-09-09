-- =============================================================================
-- Module 2 — Part 25: Statements tab upload/delete RPCs.
--
-- statement_files already has direct authenticated grant + RLS
-- (record_visible(record_id)), same as `files`/`file_rows` — but every other
-- upload path in this build (record_file_upload/delete_file) wraps the raw
-- table write in a combined RPC so the record_activity insert is atomic with
-- it and the caller doesn't have to remember to log it separately.
-- log_activity() itself has no grant (migration 22: "unused by any current
-- caller ... if it ever gains a caller it should be through a wrapper that
-- validates first") — this is that wrapper, one per mutation, matching
-- record_file_upload/delete_file exactly.
-- =============================================================================

create or replace function statement_file_upload(
  p_record_id    uuid,
  p_period_id    uuid,
  p_storage_path text,
  p_name         text,
  p_size_bytes   bigint
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_file_id uuid; v_period text;
begin
  if not record_visible(p_record_id) then
    raise exception 'not found';
  end if;
  if not exists (select 1 from statement_periods where id = p_period_id) then
    raise exception 'unknown period';
  end if;

  insert into statement_files (record_id, period_id, storage_path, name, size_bytes, uploaded_by)
  values (p_record_id, p_period_id, p_storage_path, p_name, p_size_bytes, auth.uid())
  returning id into v_file_id;

  select to_char(make_date(year, month, 1), 'Mon YYYY') into v_period
    from statement_periods where id = p_period_id;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (p_record_id, auth.uid(), 'file', format('Uploaded %s to %s statements', p_name, v_period));

  return v_file_id;
end;
$$;

create or replace function delete_statement_file(p_file_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_record uuid; v_name text;
begin
  select record_id, name into v_record, v_name from statement_files where id = p_file_id;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;

  update statement_files set deleted_at = now() where id = p_file_id;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (v_record, auth.uid(), 'file', format('Deleted %s from statements', v_name));
end;
$$;

revoke all on function statement_file_upload(uuid, uuid, text, text, bigint) from anon, authenticated;
revoke all on function delete_statement_file(uuid) from anon, authenticated;
grant execute on function statement_file_upload(uuid, uuid, text, text, bigint) to authenticated;
grant execute on function delete_statement_file(uuid) to authenticated;
