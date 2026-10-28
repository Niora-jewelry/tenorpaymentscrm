-- =============================================================================
-- UI/UX Redesign spec §4 — the Files field type ("Attach / view files").
--
-- A Files field's uploads live where every other upload lives — `file_rows` /
-- `files` / the `records` bucket — in one row per (record, field) of the new
-- kind `field`, so versioning, the 25 MB cap, the Recycle Bin and the activity
-- entry are inherited rather than rebuilt.
--
-- What differs is WHO may see and change them: the FIELD's grant, not the Files
-- tab's. A Files field on Overview is governed by Overview (and any override on
-- the field itself), exactly like a text field beside it. One helper decides
-- that for a file row, and every policy and writer asks it:
--
--   file_row_access(record, kind, field_key)
--     case_*  → the Cases tab grant
--     field   → record_field_grant(record, field_key)
--     else    → the Files tab grant
--
-- The bucket's paths for a field file are <record>/field/<field key>/…, and the
-- bucket policies ask the same question of the path.
-- =============================================================================

alter table file_rows
  add column if not exists field_key citext references fields(key) on update cascade on delete cascade;

alter table file_rows drop constraint if exists file_rows_case_anchor;
alter table file_rows add constraint file_rows_case_anchor check (
     (kind in ('application', 'other') and case_id is null and case_reply_id is null and field_key is null)
  or (kind = 'case_issue'    and case_id is not null and case_reply_id is null and field_key is null)
  or (kind = 'case_solution' and case_id is not null and case_reply_id is null and field_key is null)
  or (kind = 'case_reply'    and case_id is not null and case_reply_id is not null and field_key is null)
  or (kind = 'field'         and field_key is not null and case_id is null and case_reply_id is null)
);

create unique index if not exists file_rows_one_per_field
  on file_rows (record_id, field_key) where kind = 'field' and deleted_at is null;

-- ── the one access question ───────────────────────────────────────────────────
create or replace function file_row_access(p_record uuid, p_kind file_row_kind, p_field_key text)
returns permission_level
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
           when p_kind::text like 'case%' then record_tab_grant(p_record, 'cases')
           when p_kind = 'field'           then record_field_grant(p_record, p_field_key)
           else                                 record_tab_grant(p_record, 'files')
         end;
$$;
revoke execute on function file_row_access(uuid, file_row_kind, text) from public, anon;
grant execute on function file_row_access(uuid, file_row_kind, text) to authenticated;

-- ── file_rows ────────────────────────────────────────────────────────────────
drop policy if exists file_rows_select on file_rows;
drop policy if exists file_rows_insert on file_rows;
drop policy if exists file_rows_update on file_rows;
drop policy if exists file_rows_delete on file_rows;
create policy file_rows_select on file_rows for select
  using (record_visible(record_id) and file_row_access(record_id, kind, field_key::text) <> 'hidden');
create policy file_rows_insert on file_rows for insert
  with check (record_visible(record_id) and file_row_access(record_id, kind, field_key::text) = 'edit');
create policy file_rows_update on file_rows for update
  using (record_visible(record_id) and file_row_access(record_id, kind, field_key::text) = 'edit')
  with check (record_visible(record_id) and file_row_access(record_id, kind, field_key::text) = 'edit');
create policy file_rows_delete on file_rows for delete
  using (record_visible(record_id) and file_row_access(record_id, kind, field_key::text) = 'edit');

-- ── files ────────────────────────────────────────────────────────────────────
drop policy if exists files_select on files;
drop policy if exists files_insert on files;
drop policy if exists files_update on files;
drop policy if exists files_delete on files;
create policy files_select on files for select
  using (exists (select 1 from file_rows fr where fr.id = files.file_row_id
                 and record_visible(fr.record_id) and file_row_access(fr.record_id, fr.kind, fr.field_key::text) <> 'hidden'));
create policy files_insert on files for insert
  with check (exists (select 1 from file_rows fr where fr.id = files.file_row_id
                      and record_visible(fr.record_id) and file_row_access(fr.record_id, fr.kind, fr.field_key::text) = 'edit'));
create policy files_update on files for update
  using (exists (select 1 from file_rows fr where fr.id = files.file_row_id
                 and record_visible(fr.record_id) and file_row_access(fr.record_id, fr.kind, fr.field_key::text) = 'edit'))
  with check (exists (select 1 from file_rows fr where fr.id = files.file_row_id
                      and record_visible(fr.record_id) and file_row_access(fr.record_id, fr.kind, fr.field_key::text) = 'edit'));
create policy files_delete on files for delete
  using (exists (select 1 from file_rows fr where fr.id = files.file_row_id
                 and record_visible(fr.record_id) and file_row_access(fr.record_id, fr.kind, fr.field_key::text) = 'edit'));

-- ── writers ──────────────────────────────────────────────────────────────────
create or replace function record_file_upload(p_file_row_id uuid, p_storage_path text, p_name text, p_size_bytes bigint)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_record uuid; v_kind file_row_kind; v_field text; v_file_id uuid;
begin
  select fr.record_id, fr.kind, fr.field_key::text into v_record, v_kind, v_field
    from file_rows fr where fr.id = p_file_row_id;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;
  if file_row_access(v_record, v_kind, v_field) <> 'edit' then
    raise exception 'You do not have edit access to these files.' using errcode = '42501';
  end if;

  insert into files (file_row_id, storage_path, name, size_bytes, uploaded_by)
  values (p_file_row_id, p_storage_path, p_name, p_size_bytes, auth.uid())
  returning id into v_file_id;

  insert into record_activity (record_id, actor_id, kind, field_key, summary)
  values (v_record, auth.uid(), 'file', v_field, format('Uploaded %s', p_name));

  return v_file_id;
end;
$$;

create or replace function delete_file(p_file_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_record uuid; v_name text; v_kind file_row_kind; v_field text;
begin
  select fr.record_id, f.name, fr.kind, fr.field_key::text into v_record, v_name, v_kind, v_field
    from files f join file_rows fr on fr.id = f.file_row_id
   where f.id = p_file_id;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;
  if file_row_access(v_record, v_kind, v_field) <> 'edit' then
    raise exception 'You do not have edit access to these files.' using errcode = '42501';
  end if;

  update files set deleted_at = now() where id = p_file_id;

  insert into record_activity (record_id, actor_id, kind, field_key, summary)
  values (v_record, auth.uid(), 'file', v_field, format('Deleted %s', v_name));
end;
$$;

-- ── the bucket ───────────────────────────────────────────────────────────────
-- <record>/<kind>/… as before; <record>/field/<field key>/… for a Files field.
create or replace function storage_object_access(p_name text)
returns permission_level
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  segs text[] := storage.foldername(p_name);
  rec  uuid;
begin
  begin
    rec := segs[1]::uuid;
  exception when others then
    return 'hidden';
  end;
  if segs[2] = 'field' then
    return coalesce(record_field_grant(rec, segs[3]), 'hidden');
  end if;
  return storage_tab_access(rec, segs[2]);
end;
$$;
revoke execute on function storage_object_access(text) from public, anon;
grant execute on function storage_object_access(text) to authenticated;

drop policy if exists records_bucket_select on storage.objects;
drop policy if exists records_bucket_insert on storage.objects;
drop policy if exists records_bucket_update on storage.objects;
drop policy if exists records_bucket_delete on storage.objects;
create policy records_bucket_select on storage.objects for select
  using (bucket_id = 'records' and can_see_record(((storage.foldername(name))[1])::uuid)
         and storage_object_access(name) <> 'hidden');
create policy records_bucket_insert on storage.objects for insert
  with check (bucket_id = 'records' and can_see_record(((storage.foldername(name))[1])::uuid)
              and storage_object_access(name) = 'edit');
create policy records_bucket_update on storage.objects for update
  using (bucket_id = 'records' and can_see_record(((storage.foldername(name))[1])::uuid)
         and storage_object_access(name) = 'edit');
create policy records_bucket_delete on storage.objects for delete
  using (bucket_id = 'records' and can_see_record(((storage.foldername(name))[1])::uuid)
         and storage_object_access(name) = 'edit');
