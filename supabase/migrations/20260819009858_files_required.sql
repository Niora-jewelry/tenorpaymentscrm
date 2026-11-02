-- =============================================================================
-- Files Required (client spec of 1 Nov 2026).
--
-- A Files row can be marked required, with how many files it needs. What is still
-- outstanding is kept on the record, so the list can show, filter and sort it on
-- every module without counting files per row, and so it needs no Files access to
-- read: the column shows to everyone who can see the record.
--
-- `file_row_settle` is the one place that decides what a row's state is now. It
-- runs from triggers on `files` and `file_rows`, so no path into either table can
-- leave the column stale, whoever or whatever made the change.
--
-- Also here, because the spec's rules depend on them:
--   file_versions       replacing a file keeps the file's row, so a row's count
--                       can't change, and keeps what it replaced
--   move_file           moving a file between rows
--   rename_file_row, delete_file_row, restore_file_row   for user-added rows
--   record_pings        how an open screen hears that something changed
-- =============================================================================

alter table file_rows add column if not exists required boolean not null default false;
alter table file_rows add column if not exists files_needed int not null default 1;
alter table file_rows add column if not exists received boolean not null default false;
alter table file_rows drop constraint if exists file_rows_files_needed_range;
alter table file_rows add constraint file_rows_files_needed_range check (files_needed between 1 and 5);

alter table records add column if not exists files_required jsonb not null default '[]'::jsonb;
alter table records add column if not exists files_required_count int not null default 0;
alter table records add column if not exists files_required_names text[] not null default '{}';
create index if not exists records_files_required_names on records using gin (files_required_names);

grant select (files_required, files_required_count, files_required_names) on records to authenticated;

-- The list's view, with the three columns on the end. Nothing in them depends on
-- the Files tab: that is the spec.
do $$
declare
  v_def  text := pg_get_viewdef('records_filterable'::regclass, true);
  v_opts text[];
  v_with text := '';
  v_tail text := '   FROM records r';
begin
  if position(v_tail in v_def) = 0 then raise exception 'records_filterable: unexpected shape'; end if;
  v_def := replace(v_def, v_tail, ', r.files_required, r.files_required_count, r.files_required_names ' || v_tail);
  select reloptions into v_opts from pg_class where oid = 'records_filterable'::regclass;
  if v_opts is not null then v_with := ' with (' || array_to_string(v_opts, ', ') || ')'; end if;
  execute 'create or replace view records_filterable' || v_with || ' as ' || v_def;
end $$;

-- ── who may change these ─────────────────────────────────────────────────────

-- Marking takes its own permission, and moving and locks follow, so neither table
-- is written from a browser session except through the functions below. Rows are
-- still created directly (`ensure_application_file_rows`, a Files field's row).
revoke update on file_rows from authenticated, anon;
revoke insert on file_rows from authenticated, anon;
grant insert (record_id, kind, name, locked, position, field_key) on file_rows to authenticated;
revoke update, insert on files from authenticated, anon;

create or replace function public.permission_setting_valid(p_key text, p_value text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_key ~ '^action\.(create|team|archive|modules|pipeline|pipeline_change|team_view_open|team_take|mark_files_required)$' then p_value in ('yes', 'no')
    when p_key ~ '^team\.[a-z_]+\.(assign|assign_member|unassign|see_open|see_team|see_users)$' then p_value in ('yes', 'no')
    when p_key ~ '^module:[0-9a-f-]{36}$'                          then p_value in ('hidden', 'mine', 'all')
    when p_key in ('notifications.scope', 'email.scope', 'phone.scope') then p_value in ('own', 'all')
    when p_key = 'admin.automations'                                then p_value in ('hidden', 'view', 'full')
    when p_key ~ '^admin\.(users|permissions|presets|numbers|residuals|integrations|recycle_bin)$'
                                                                    then p_value in ('hidden', 'full')
    when p_key = 'communication.scope'                              then p_value in ('own', 'org')
    when p_key = 'items.cases'                                      then p_value in ('hidden', 'mine', 'all')
    when p_key in ('items.updates', 'items.notes')                  then p_value in ('mine', 'all')
    when p_key = 'applications.pdfs'                                then p_value in ('hidden', 'full')
    when p_key = 'agreements.send'                                  then p_value in ('yes', 'no')
    else false
  end;
$$;

create or replace function user_permissions(u uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'superAdmin', user_is_admin(u),
    'userType', (select pt.user_type from user_templates ut join permission_templates pt on pt.id = ut.template_id where ut.user_id = u),
    'settings', (
      select jsonb_object_agg(k, user_perm(u, k))
        from unnest(array[
          'action.create', 'action.team', 'action.archive', 'action.modules', 'action.pipeline', 'action.pipeline_change',
          'action.team_view_open', 'action.team_take', 'action.mark_files_required',
          'notifications.scope', 'email.scope', 'phone.scope',
          'admin.users', 'admin.permissions', 'admin.presets', 'admin.numbers', 'admin.residuals',
          'admin.integrations', 'admin.automations', 'admin.recycle_bin',
          'communication.scope', 'items.cases', 'items.updates', 'items.notes',
          'applications.pdfs', 'agreements.send'
        ] || array(
          select 'team.' || pt.user_type || '.' || s
            from permission_templates pt
           cross join unnest(array['assign', 'assign_member', 'unassign', 'see_open', 'see_team', 'see_users']) s
           where pt.user_type is not null
        )) as k
    ),
    'modules', (select coalesce(jsonb_object_agg(m.id::text, user_module_scope(u, m.id)), '{}'::jsonb) from modules m)
  );
$$;

insert into permission_settings (owner_kind, owner_id, key, value)
select 'template', pt.id, 'action.mark_files_required', case when pt.user_type = 'accounting' then 'no' else 'yes' end
  from permission_templates pt
 where pt.user_type is not null
on conflict (owner_kind, owner_id, key) do nothing;

-- ── an open screen hears about a change ──────────────────────────────────────

create table if not exists record_pings (
  record_id uuid primary key references records (id) on delete cascade,
  at        timestamptz not null default now()
);

alter table record_pings enable row level security;
alter table record_pings force row level security;
revoke all on record_pings from public, anon, authenticated;
grant select on record_pings to authenticated;
drop policy if exists record_pings_select on record_pings;
create policy record_pings_select on record_pings for select using (record_visible(record_id));

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'record_pings') then
    alter publication supabase_realtime add table record_pings;
  end if;
end $$;

create or replace function public.record_ping(p_record uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into record_pings (record_id, at) values (p_record, clock_timestamp())
  on conflict (record_id) do update set at = excluded.at;
$$;

revoke all on function public.record_ping(uuid) from public, anon, authenticated;

-- ── the state of a row ───────────────────────────────────────────────────────

create or replace function public.files_required_refresh(p_record uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_items jsonb;
  v_names text[];
begin
  select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'have', o.have, 'need', o.need) order by o.position, o.name), '[]'::jsonb),
         coalesce(array_agg(o.name), '{}')
    into v_items, v_names
    from (
      select fr.id, fr.name, fr.position, fr.files_needed need, count(f.id)::int have
        from file_rows fr
        left join files f on f.file_row_id = fr.id and f.deleted_at is null
       where fr.record_id = p_record and fr.required and fr.deleted_at is null
         and fr.kind in ('application', 'other')
       group by fr.id
      having count(f.id) < fr.files_needed
    ) o;

  update records
     set files_required = v_items, files_required_count = jsonb_array_length(v_items), files_required_names = v_names
   where id = p_record and files_required is distinct from v_items;
end;
$$;

revoke all on function public.files_required_refresh(uuid) from public, anon, authenticated;

-- Who an entry about a row names: the person, or the automation doing this. Set
-- around an automation's own change, because that runs with no signed-in user.
create or replace function public.file_row_log(p_record uuid, p_generic text, p_detail text, p_item text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_auto text := nullif(current_setting('tapdash.automation_name', true), '');
  v_id   uuid := nullif(current_setting('tapdash.automation_id', true), '')::uuid;
begin
  perform record_log(p_record, auth.uid(), 'file', p_generic,
    jsonb_build_array(jsonb_build_object('rank', 1, 'items', jsonb_build_array(p_item), 'body', p_detail)),
    v_id, v_auto, case when auth.uid() is null and v_auto is null then 'System' end);
end;
$$;

revoke all on function public.file_row_log(uuid, text, text, text) from public, anon, authenticated;

create or replace function public.file_row_settle(p_row uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r      file_rows;
  v_have int;
  v_done boolean;
begin
  select * into r from file_rows where id = p_row;
  if not found or r.kind not in ('application', 'other') then return; end if;

  perform files_required_refresh(r.record_id);
  perform record_ping(r.record_id);
  if r.deleted_at is not null then return; end if;

  select count(*) into v_have from files where file_row_id = p_row and deleted_at is null;
  v_done := r.required and v_have >= r.files_needed;
  if v_done = r.received then return; end if;

  update file_rows set received = v_done where id = p_row;
  if not r.required then return; end if;

  if v_done then
    perform file_row_log(r.record_id, 'A file row was completed.',
      format('%s received (%s of %s).', r.name, v_have, r.files_needed), 'row:' || r.id);
  else
    perform file_row_log(r.record_id, 'A file row was reopened.',
      format('%s is missing files again (%s of %s).', r.name, v_have, r.files_needed), 'row:' || r.id);
  end if;
end;
$$;

revoke all on function public.file_row_settle(uuid) from public, anon, authenticated;

create or replace function public.tg_files_settle()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform file_row_settle(new.file_row_id);
  if tg_op = 'UPDATE' and old.file_row_id is distinct from new.file_row_id then
    perform file_row_settle(old.file_row_id);
  end if;
  return null;
end;
$$;

drop trigger if exists files_settle on files;
create trigger files_settle
  after insert or update of deleted_at, file_row_id on files
  for each row execute function tg_files_settle();

create or replace function public.tg_file_rows_settle()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform file_row_settle(new.id);
  return null;
end;
$$;

drop trigger if exists file_rows_settle on file_rows;
create trigger file_rows_settle
  after update of required, files_needed, name, deleted_at, position on file_rows
  for each row execute function tg_file_rows_settle();

-- The five-per-row rule on a move too, not only on an upload.
drop trigger if exists files_cap_on_move on files;
create trigger files_cap_on_move
  before update of file_row_id on files
  for each row when (old.file_row_id is distinct from new.file_row_id)
  execute function files_cap_guard();

-- ── marking ──────────────────────────────────────────────────────────────────

create or replace function public.set_file_row_required(p_row uuid, p_required boolean, p_needed int)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r file_rows;
begin
  select * into r from file_rows where id = p_row and deleted_at is null for update;
  if not found or r.kind not in ('application', 'other') or not record_writable(r.record_id) then
    raise exception 'not found';
  end if;
  if not (auth_is_admin() or auth_perm('action.mark_files_required') = 'yes') then
    raise exception 'You do not have access to mark files required.' using errcode = '42501';
  end if;
  if file_row_access(r.record_id, r.kind, r.field_key::text) < 'view' then
    raise exception 'not found';
  end if;
  if p_needed is null or p_needed not between 1 and 5 then
    raise exception 'Files needed is from 1 to 5.' using errcode = '22023';
  end if;

  if r.required = p_required and (not p_required or r.files_needed = p_needed) then return; end if;

  -- Written first, so a completion it causes reads after it.
  if p_required and not r.required then
    perform file_row_log(r.record_id, 'A file row was marked required.',
      format('Marked %s required (%s %s).', r.name, p_needed, case when p_needed = 1 then 'file' else 'files' end), 'row:' || r.id);
  elsif not p_required then
    perform file_row_log(r.record_id, 'A file row was unmarked.', format('Unmarked %s.', r.name), 'row:' || r.id);
  else
    perform file_row_log(r.record_id, 'Files needed was changed on a row.',
      format('Changed files needed on %s from %s to %s.', r.name, r.files_needed, p_needed), 'row:' || r.id);
  end if;

  update file_rows set required = p_required, files_needed = p_needed where id = p_row;
end;
$$;

revoke all on function public.set_file_row_required(uuid, boolean, int) from public, anon;
grant execute on function public.set_file_row_required(uuid, boolean, int) to authenticated;

-- ── user-added rows ──────────────────────────────────────────────────────────

create or replace function public.file_row_for_edit(p_row uuid)
returns file_rows
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare r file_rows;
begin
  select * into r from file_rows where id = p_row and deleted_at is null;
  if not found or r.kind not in ('application', 'other') or not record_writable(r.record_id) then
    raise exception 'not found';
  end if;
  if file_row_access(r.record_id, r.kind, r.field_key::text) <> 'edit' then
    raise exception 'You do not have edit access to these files.' using errcode = '42501';
  end if;
  if r.locked then
    raise exception 'The preset rows can''t be renamed or deleted.' using errcode = '42501';
  end if;
  return r;
end;
$$;

revoke all on function public.file_row_for_edit(uuid) from public, anon, authenticated;

create or replace function public.rename_file_row(p_row uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare r file_rows := file_row_for_edit(p_row);
begin
  if r.name = p_name then return; end if;
  perform file_row_log(r.record_id, 'A file row was renamed.', format('Renamed file row %s to %s.', r.name, p_name), 'row:' || r.id);
  update file_rows set name = p_name where id = p_row;
end;
$$;

create or replace function public.delete_file_row(p_row uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare r file_rows := file_row_for_edit(p_row);
begin
  perform file_row_log(r.record_id, 'A file row was deleted.', format('Deleted file row %s.', r.name), 'row:' || r.id);
  update file_rows set deleted_at = now() where id = p_row;
end;
$$;

create or replace function public.restore_file_row(p_row_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare r file_rows;
begin
  if not auth_admin_page('recycle_bin') then
    raise exception 'Only an admin may restore from the Recycle Bin' using errcode = '42501';
  end if;
  select * into r from file_rows where id = p_row_id and deleted_at is not null;
  if not found then raise exception 'not found'; end if;
  if r.kind = 'application' and exists (
    select 1 from file_rows x
     where x.record_id = r.record_id and x.name = r.name and x.kind = 'application' and x.deleted_at is null
  ) then
    raise exception 'A row with that name is already on this record — rename it before restoring this.' using errcode = '23514';
  end if;

  perform file_row_log(r.record_id, 'A file row was restored.', format('Restored file row %s.', r.name), 'row:' || r.id);
  update file_rows set deleted_at = null where id = p_row_id;
end;
$$;

revoke all on function public.rename_file_row(uuid, text) from public, anon;
revoke all on function public.delete_file_row(uuid) from public, anon;
revoke all on function public.restore_file_row(uuid) from public, anon;
grant execute on function public.rename_file_row(uuid, text) to authenticated;
grant execute on function public.delete_file_row(uuid) to authenticated;
grant execute on function public.restore_file_row(uuid) to authenticated;

-- ── a file's versions, and moving one ────────────────────────────────────────

create table if not exists file_versions (
  id           uuid primary key default gen_random_uuid(),
  file_id      uuid not null references files (id) on delete cascade,
  version      int  not null,
  storage_path text not null,
  name         text not null,
  size_bytes   bigint not null,
  uploaded_by  uuid not null,
  uploaded_at  timestamptz not null,
  replaced_at  timestamptz not null default now(),
  unique (file_id, version)
);

alter table file_versions enable row level security;
alter table file_versions force row level security;
revoke all on file_versions from public, anon, authenticated;
grant select on file_versions to authenticated;
drop policy if exists file_versions_select on file_versions;
create policy file_versions_select on file_versions for select using (
  exists (
    select 1 from files f join file_rows fr on fr.id = f.file_row_id
     where f.id = file_versions.file_id
       and record_visible(fr.record_id)
       and file_row_access(fr.record_id, fr.kind, fr.field_key::text) >= 'view'::permission_level
  )
);

create or replace function public.replace_file(p_file uuid, p_storage_path text, p_name text, p_size_bytes bigint)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  f files;
  r file_rows;
begin
  select * into f from files where id = p_file and deleted_at is null for update;
  if not found then raise exception 'not found'; end if;
  select * into r from file_rows where id = f.file_row_id;
  if r.kind not in ('application', 'other') or not record_writable(r.record_id) then
    raise exception 'not found';
  end if;
  if file_row_access(r.record_id, r.kind, r.field_key::text) <> 'edit' then
    raise exception 'You do not have edit access to these files.' using errcode = '42501';
  end if;

  insert into file_versions (file_id, version, storage_path, name, size_bytes, uploaded_by, uploaded_at)
  values (f.id, f.version, f.storage_path, f.name, f.size_bytes, f.uploaded_by, f.uploaded_at);

  update files
     set storage_path = p_storage_path, name = p_name, size_bytes = p_size_bytes,
         uploaded_by = auth.uid(), uploaded_at = now(), version = f.version + 1
   where id = p_file;

  perform file_row_log(r.record_id, 'A file was replaced.', format('Replaced %s with %s on %s.', f.name, p_name, r.name), 'row:' || r.id);
end;
$$;

revoke all on function public.replace_file(uuid, text, text, bigint) from public, anon;
grant execute on function public.replace_file(uuid, text, text, bigint) to authenticated;

create or replace function public.move_file(p_file uuid, p_to_row uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  f    files;
  src  file_rows;
  dest file_rows;
begin
  select * into f from files where id = p_file and deleted_at is null for update;
  if not found then raise exception 'not found'; end if;
  select * into src from file_rows where id = f.file_row_id and deleted_at is null;
  select * into dest from file_rows where id = p_to_row and deleted_at is null;
  if src.id is null or dest.id is null or src.record_id <> dest.record_id
     or src.kind not in ('application', 'other') or dest.kind not in ('application', 'other')
     or not record_writable(src.record_id) then
    raise exception 'not found';
  end if;
  if file_row_access(src.record_id, src.kind, src.field_key::text) <> 'edit' then
    raise exception 'You do not have edit access to these files.' using errcode = '42501';
  end if;
  if src.id = dest.id then return; end if;

  perform 1 from file_rows where id = dest.id for update;
  if (select count(*) from files where file_row_id = dest.id and deleted_at is null) >= 5 then
    raise exception 'That row already has 5 files.' using errcode = '23514';
  end if;

  -- Each reader gets the entry naming only the rows they can see.
  perform record_log(src.record_id, auth.uid(), 'file', 'Moved a file.', jsonb_build_array(
    jsonb_build_object('rank', 1, 'items', jsonb_build_array('row:' || dest.id), 'body', format('Moved %s to %s.', f.name, dest.name)),
    jsonb_build_object('rank', 2, 'items', jsonb_build_array('row:' || src.id), 'body', format('Moved %s out of %s.', f.name, src.name)),
    jsonb_build_object('rank', 3, 'items', jsonb_build_array('row:' || src.id, 'row:' || dest.id), 'body', format('Moved %s from %s to %s.', f.name, src.name, dest.name))
  ));

  update files set file_row_id = dest.id where id = p_file;
end;
$$;

revoke all on function public.move_file(uuid, uuid) from public, anon;
grant execute on function public.move_file(uuid, uuid) to authenticated;

-- The entry goes in before the file, so a completion it causes reads after it.
create or replace function public.record_file_upload(p_file_row_id uuid, p_storage_path text, p_name text, p_size_bytes bigint)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record uuid; v_kind file_row_kind; v_field text; v_row text; v_file_id uuid;
  v_access permission_level;
begin
  select fr.record_id, fr.kind, fr.field_key::text, fr.name into v_record, v_kind, v_field, v_row
    from file_rows fr where fr.id = p_file_row_id and fr.deleted_at is null;
  if v_record is null or not record_writable(v_record) then
    raise exception 'not found';
  end if;
  v_access := file_row_access(v_record, v_kind, v_field);
  if not (v_access = 'edit' or (v_access = 'add_only' and v_kind in ('application', 'other'))) then
    raise exception 'You do not have edit access to these files.' using errcode = '42501';
  end if;

  if v_kind in ('application', 'other') then
    perform record_log(v_record, auth.uid(), 'file', 'Uploaded a file.', jsonb_build_array(
      jsonb_build_object('rank', 1, 'items', jsonb_build_array('row:' || p_file_row_id), 'body', format('Uploaded %s to %s.', p_name, v_row))
    ));
  else
    insert into record_activity (record_id, actor_id, kind, field_key, summary)
    values (v_record, auth.uid(), 'file', v_field, format('Uploaded %s', p_name));
  end if;

  insert into files (file_row_id, storage_path, name, size_bytes, uploaded_by)
  values (p_file_row_id, p_storage_path, p_name, p_size_bytes, auth.uid())
  returning id into v_file_id;

  return v_file_id;
end;
$$;

-- ── automations ──────────────────────────────────────────────────────────────

create or replace function public.automation_condition(p_c jsonb, p_record uuid, p_module uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_date date;
  v_days int;
begin
  case p_c ->> 'type'
    when 'field_filled' then
      if nullif(p_c ->> 'fileRow', '') is not null then
        return automation_file_row_filled(p_record, p_c ->> 'fileRow');
      end if;
      return automation_field_filled(p_record, p_c ->> 'field');
    when 'all_filled' then
      return automation_all_filled(p_record, (p_c ->> 'tabId')::uuid, nullif(p_c ->> 'subtabId', '')::uuid);
    when 'status_is' then
      return exists (select 1 from records r where r.id = p_record and r.values ->> 'current_status' = p_c ->> 'value');
    when 'pipeline_is' then
      return exists (select 1 from record_pipelines rp where rp.record_id = p_record and rp.pipeline_id = (p_c ->> 'pipelineId')::uuid);
    when 'in_module' then
      return p_module is not null and p_module = (p_c ->> 'moduleId')::uuid;
    when 'date_is' then
      v_date := automation_date_value(p_record, p_c ->> 'field');
      if v_date is null then return false; end if;
      return case p_c ->> 'op'
        when 'before' then v_date < (p_c ->> 'date')::date
        when 'after'  then v_date > (p_c ->> 'date')::date
        else v_date = (p_c ->> 'date')::date
      end;
    when 'days_from' then
      v_date := automation_date_value(p_record, p_c ->> 'field');
      if v_date is null then return false; end if;
      v_days := (p_c ->> 'days')::int;
      return automation_today() = case p_c ->> 'direction' when 'before' then v_date - v_days else v_date + v_days end;
    when 'files_required_empty' then
      return exists (select 1 from records r where r.id = p_record and r.files_required_count = 0);
    when 'files_required_filled' then
      return exists (
        select 1 from records r
         where r.id = p_record and r.files_required_count > 0
           and (nullif(p_c ->> 'fileRow', '') is null or (p_c ->> 'fileRow') = any (r.files_required_names))
      );
    else
      raise exception 'Unknown condition %', p_c ->> 'type';
  end case;
end;
$$;

create or replace function public.automation_mark_file_required(p_run automation_runs, s jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_names text[] := array['Owner ID', 'Bank statements', 'Processing statements', 'Corp docs', 'Voided check'];
  v_done  text[] := '{}';
  e       jsonb;
  v_need  int;
  r       file_rows;
begin
  perform ensure_application_file_rows(p_run.record_id, v_names, array[0, 10, 20, 30, 40]);
  perform set_config('tapdash.automation_name', p_run.automation_name, true);
  perform set_config('tapdash.automation_id', p_run.automation_id::text, true);

  for e in select * from jsonb_array_elements(coalesce(s -> 'rows', '[]'::jsonb)) loop
    select * into r from file_rows
     where record_id = p_run.record_id and kind = 'application' and locked and name = e ->> 'name' and deleted_at is null
     for update;
    continue when not found;
    v_need := greatest(1, least(5, coalesce((e ->> 'needed')::int, 1)));
    v_done := v_done || format('%s (%s)', r.name, v_need);
    continue when r.required and r.files_needed = v_need;

    if r.required then
      perform file_row_log(r.record_id, 'Files needed was changed on a row.',
        format('Changed files needed on %s from %s to %s.', r.name, r.files_needed, v_need), 'row:' || r.id);
    else
      perform file_row_log(r.record_id, 'A file row was marked required.',
        format('Marked %s required (%s %s).', r.name, v_need, case when v_need = 1 then 'file' else 'files' end), 'row:' || r.id);
    end if;
    update file_rows set required = true, files_needed = v_need where id = r.id;
  end loop;

  perform set_config('tapdash.automation_name', '', true);
  perform set_config('tapdash.automation_id', '', true);

  if cardinality(v_done) = 0 then
    return automation_outcome('skipped', 'None of the chosen rows are on this record.');
  end if;
  return automation_outcome('done', 'Marked required: ' || array_to_string(v_done, ', ') || '.');
end;
$$;

revoke all on function public.automation_mark_file_required(automation_runs, jsonb) from public, anon, authenticated;

create or replace function public.automation_act(p_run automation_runs, s jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if nullif(s ->> 'teamId', '') is not null
     and not exists (select 1 from permission_templates where id = (s ->> 'teamId')::uuid and user_type is not null) then
    raise exception 'That team no longer exists.';
  end if;
  case s ->> 'type'
    when 'change_status'      then return automation_change_status(p_run, s);
    when 'change_stage'       then return automation_change_stage(p_run, s);
    when 'assign_team'        then return automation_assign_team(p_run, s);
    when 'assign_user'        then return automation_assign_person(p_run, (s ->> 'userId')::uuid);
    when 'round_robin'        then return automation_round_robin(p_run, s);
    when 'remove_team'        then return automation_remove_team(p_run, s);
    when 'add_module'         then return automation_add_module(p_run, s);
    when 'remove_module'      then return automation_remove_module(p_run, s);
    when 'create_ticket'      then return automation_create_ticket(p_run, s);
    when 'send_notification'  then return automation_send_notification(p_run, s);
    when 'mark_file_required' then return automation_mark_file_required(p_run, s);
    else raise exception 'Unknown action %', s ->> 'type';
  end case;
end;
$$;
