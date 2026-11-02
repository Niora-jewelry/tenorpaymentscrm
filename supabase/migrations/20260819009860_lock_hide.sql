-- =============================================================================
-- Lock, Hide, Unlock, Unhide and the File uploaded trigger (client spec of 1 Nov
-- 2026).
--
-- A lock or hide is a row in `record_restrictions`, per item, per record. Nothing
-- about a person's permissions is ever changed: each read works out the normal
-- grant and then caps it by what is active. So "back to before" needs no snapshot:
-- lifting a row leaves whatever is under it, and a lift can only ever land on the
-- normal permission, never above it.
--
-- `user_record_scope_grant` and `user_record_field_grant` become that cap over
-- their old selves, kept as `*_base`. Everything that asks for a grant already
-- goes through them (every policy, every write, @mention), so that is the one
-- change that reaches all of it. Adding goes the other way, asking `*_base`,
-- because a lock doesn't stop someone adding: what they add is simply covered.
--
-- An item is a string: tab:<key>, subtab:<id>, field:<key>, notes:<tab key>, or
-- row:<id> for a Files row.
-- =============================================================================

alter table tabs add column if not exists restriction_level text not null default 'field';
alter table tabs drop constraint if exists tabs_restriction_level_valid;
alter table tabs add constraint tabs_restriction_level_valid check (restriction_level in ('field', 'row', 'tab', 'none'));

update tabs set restriction_level = case
    when kind = 'files' then 'row'
    when kind in ('logins', 'statements') then 'tab'
    when kind = 'custom' and access_options = 'levels' then 'field'
    else 'none'
  end;

create table if not exists record_restrictions (
  id                uuid primary key default gen_random_uuid(),
  record_id         uuid not null references records (id) on delete cascade,
  batch_id          uuid not null,
  kind              text not null check (kind in ('lock', 'hide')),
  item              text not null,
  automation_id     uuid references automations (id) on delete set null,
  automation_name   text not null,
  can_lift          jsonb not null default '{}'::jsonb,
  can_see           jsonb not null default '{}'::jsonb,
  allow_download    boolean not null default true,
  applied_at        timestamptz not null default now(),
  lifted_at         timestamptz,
  lifted_by         uuid references profiles (id) on delete set null
);

create index if not exists record_restrictions_active on record_restrictions (record_id) where lifted_at is null;
create index if not exists record_restrictions_batch on record_restrictions (batch_id);
create index if not exists record_restrictions_automation on record_restrictions (automation_id, record_id);

-- Read only through `viewer_restrictions`: whether something is hidden is itself
-- what someone who can't see it mustn't learn.
alter table record_restrictions enable row level security;
alter table record_restrictions force row level security;
revoke all on record_restrictions from public, anon, authenticated;

create table if not exists automation_file_fires (
  automation_id uuid not null references automations (id) on delete cascade,
  record_id     uuid not null references records (id) on delete cascade,
  row_name      text not null,
  fired_at      timestamptz not null default now(),
  primary key (automation_id, record_id, row_name)
);

alter table automation_file_fires enable row level security;
alter table automation_file_fires force row level security;
revoke all on automation_file_fires from public, anon, authenticated;

-- ── who a restriction applies to ─────────────────────────────────────────────

create or replace function public.user_in_group(u uuid, g jsonb)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(g -> 'userIds', '[]'::jsonb) ? u::text
      or coalesce(g -> 'teamIds', '[]'::jsonb) ? coalesce(user_team(u)::text, '');
$$;

-- What the active restrictions on these items do to this person: 'hide', 'lock'
-- or null. Items are judged one at a time, and anyone in a group of ANY restriction
-- of that kind on an item is out of it: "anyone in either group can lift it".
create or replace function public.restriction_effect(u uuid, rec uuid, p_items text[])
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with active as (
    select r.item, r.kind, user_in_group(u, r.can_lift) as lifts, user_in_group(u, r.can_see) as sees
      from record_restrictions r
     where r.record_id = rec and r.lifted_at is null and r.item = any (p_items)
  )
  select case
    when user_is_admin(u) then null
    when exists (select 1 from active where kind = 'hide' group by item having not bool_or(lifts or sees)) then 'hide'
    when exists (select 1 from active where kind = 'lock' group by item having not bool_or(lifts)) then 'lock'
  end;
$$;

create or replace function public.restriction_cap(p_base permission_level, p_effect text, p_keeps_adding boolean)
returns permission_level
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_effect is null then p_base
    when p_effect = 'lock' then least(p_base, 'view'::permission_level)
    -- Hidden, except that Logins and Files stay open for adding, and only to
    -- someone who could add before: a hide never gives anyone more.
    when p_keeps_adding and p_base in ('edit', 'add_only') then 'add_only'::permission_level
    else 'hidden'::permission_level
  end;
$$;

-- The old functions, under their new names, exactly as they stand.
do $$
declare
  v_def text;
begin
  select pg_get_functiondef('public.user_record_scope_grant(uuid,uuid,grant_scope,uuid)'::regprocedure) into v_def;
  execute replace(v_def, 'public.user_record_scope_grant(', 'public.user_record_scope_grant_base(');
  select pg_get_functiondef('public.user_record_field_grant(uuid,uuid,text)'::regprocedure) into v_def;
  execute replace(v_def, 'public.user_record_field_grant(', 'public.user_record_field_grant_base(');
end $$;

create or replace function public.field_items(p_key text)
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select array_remove(array['field:' || f.key::text, 'tab:' || t.key::text,
                            case when f.subtab_id is not null then 'subtab:' || f.subtab_id end], null)
    from fields f join tabs t on t.id = f.tab_id
   where f.key = p_key::citext;
$$;

create or replace function public.user_record_scope_grant(u uuid, rec uuid, p_kind grant_scope, p_scope uuid)
returns permission_level
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_base  permission_level := user_record_scope_grant_base(u, rec, p_kind, p_scope);
  v_items text[];
  v_add   boolean := false;
begin
  if p_kind not in ('tab', 'subtab') or not exists (select 1 from record_restrictions where record_id = rec and lifted_at is null) then
    return v_base;
  end if;
  if p_kind = 'tab' then
    select array['tab:' || t.key::text], t.allows_add_only into v_items, v_add from tabs t where t.id = p_scope;
  else
    select array['subtab:' || s.id, 'tab:' || t.key::text] into v_items
      from subtabs s join tabs t on t.id = s.tab_id where s.id = p_scope;
  end if;
  return restriction_cap(v_base, restriction_effect(u, rec, v_items), v_add);
end;
$$;

create or replace function public.user_record_field_grant(u uuid, rec uuid, p_field_key text)
returns permission_level
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_base permission_level := user_record_field_grant_base(u, rec, p_field_key);
begin
  if not exists (select 1 from record_restrictions where record_id = rec and lifted_at is null) then
    return v_base;
  end if;
  return restriction_cap(v_base, restriction_effect(u, rec, field_items(p_field_key)), false);
end;
$$;

-- What the viewer holds on a tab before any lock or hide: whether they may add.
create or replace function public.record_tab_base_grant(rec uuid, p_tab_key text)
returns permission_level
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when g.level = 'edit' and not user_can_see_record_by_rules(auth.uid(), rec) then 'view'::permission_level
    when g.level = 'add_only' and not user_can_see_record_by_rules(auth.uid(), rec) then 'hidden'::permission_level
    else coalesce(g.level, 'hidden'::permission_level)
  end
  from (
    select (select user_record_scope_grant_base(auth.uid(), rec, 'tab'::grant_scope, t.id) from tabs t where t.key = p_tab_key) as level
  ) g;
$$;

revoke all on function public.record_tab_base_grant(uuid, text) from public, anon;
grant execute on function public.record_tab_base_grant(uuid, text) to authenticated;

-- ── values ───────────────────────────────────────────────────────────────────

create or replace function public.restriction_hidden_keys(rec uuid)
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when not exists (select 1 from record_restrictions where record_id = rec and lifted_at is null and kind = 'hide') then '{}'::text[]
    else coalesce((
      select array_agg(f.key::text) from fields f
       where f.archived_at is null and restriction_effect(auth.uid(), rec, field_items(f.key::text)) = 'hide'
    ), '{}'::text[])
  end;
$$;

create or replace function public.hidden_field_keys_for_record(rec uuid)
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select hidden_field_keys_for_modules(record_display_module_set(rec)) || restriction_hidden_keys(rec);
$$;

create or replace function public.record_values_for(p_ids uuid[])
returns table (id uuid, "values" jsonb)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with recs as (
    select r.id, r.values, r.deal_name, r.creator_kind, r.creator_user_id,
           record_display_module_set(r.id) as mods
      from records r
     where r.id = any(p_ids)
       and record_listable(r.id)
  ),
  hidden as (
    select s.mods, hidden_field_keys_for_modules(s.mods) as keys
      from (select distinct mods from recs) s
  ),
  people as (select viewer_hidden_assignees() as ids)
  select r.id,
         strip_hidden_assignees(r.values - (h.keys || restriction_hidden_keys(r.id)), (select ids from people))
         || case
              when 'deal_name' = any(h.keys) then '{}'::jsonb
              else jsonb_build_object('deal_name', r.deal_name)
            end
         || case
              when 'record_creator' = any(h.keys)
                or r.creator_kind <> 'user'
                or r.creator_user_id is null
                then '{}'::jsonb
              else jsonb_build_object(
                     'record_creator', jsonb_build_array(r.creator_user_id::text))
            end
    from recs r
    join hidden h on h.mods = r.mods;
$$;

-- ── Files rows ───────────────────────────────────────────────────────────────

-- What the viewer holds on one row: the tab, then anything on the row itself.
create or replace function public.file_row_level(p_row uuid, p_record uuid, p_kind file_row_kind, p_field text)
returns permission_level
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_kind not in ('application', 'other') then file_row_access(p_record, p_kind, p_field)
    else restriction_cap(file_row_access(p_record, p_kind, p_field),
                         restriction_effect(auth.uid(), p_record, array['row:' || p_row]), true)
  end;
$$;

drop policy if exists file_rows_select on file_rows;
create policy file_rows_select on file_rows for select using (
  record_visible(record_id)
  and file_row_level(id, record_id, kind, field_key::text) >= 'view'::permission_level
);

drop policy if exists files_select on files;
create policy files_select on files for select using (
  exists (
    select 1 from file_rows fr
     where fr.id = files.file_row_id
       and record_visible(fr.record_id)
       and file_row_level(fr.id, fr.record_id, fr.kind, fr.field_key::text) >= 'view'::permission_level
  )
);

drop policy if exists file_versions_select on file_versions;
create policy file_versions_select on file_versions for select using (
  exists (
    select 1 from files f join file_rows fr on fr.id = f.file_row_id
     where f.id = file_versions.file_id
       and record_visible(fr.record_id)
       and file_row_level(fr.id, fr.record_id, fr.kind, fr.field_key::text) >= 'view'::permission_level
  )
);

-- Allow download = No, for someone who can see but can't lift it. Locked Statements
-- never allow download.
create or replace function public.download_blocked(rec uuid, p_items text[])
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select not user_is_admin(auth.uid()) and exists (
    select 1 from record_restrictions r
     where r.record_id = rec and r.lifted_at is null and r.item = any (p_items)
       and not user_in_group(auth.uid(), r.can_lift)
       and (not r.allow_download or (r.kind = 'lock' and r.item = 'tab:statements'))
  );
$$;

-- The storage path names the row, so a signed link obeys the row too, and a
-- blocked download can't be got by asking Storage directly. Below View is what
-- the bucket's read policy refuses.
create or replace function public.storage_object_access(p_name text)
returns permission_level
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  segs   text[] := storage.foldername(p_name);
  rec    uuid;
  v_row  uuid;
  v_kind file_row_kind;
  v_lvl  permission_level;
begin
  begin
    rec := segs[1]::uuid;
  exception when others then
    return 'hidden';
  end;
  if segs[2] = 'field' then
    return coalesce(record_field_grant(rec, segs[3]), 'hidden');
  end if;
  if segs[2] in ('application', 'other') then
    begin
      v_row := segs[3]::uuid;
    exception when others then
      return 'hidden';
    end;
    select kind into v_kind from file_rows where id = v_row and record_id = rec;
    if not found then return 'hidden'; end if;
    v_lvl := file_row_level(v_row, rec, v_kind, null);
    if v_lvl >= 'view' and download_blocked(rec, array['row:' || v_row, 'tab:files']) then return 'add_only'; end if;
    return v_lvl;
  end if;
  v_lvl := storage_tab_access(rec, segs[2]);
  if segs[2] = 'statements' and v_lvl >= 'view' and download_blocked(rec, array['tab:statements']) then return 'add_only'; end if;
  return v_lvl;
end;
$$;

create or replace function public.file_download_allowed(p_file uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select not download_blocked(fr.record_id, array['row:' || fr.id, 'tab:files'])
    from files f join file_rows fr on fr.id = f.file_row_id where f.id = p_file;
$$;

revoke all on function public.file_download_allowed(uuid) from public, anon;
grant execute on function public.file_download_allowed(uuid) to authenticated;

-- ── writes that a lock must stop, or must let through ────────────────────────

create or replace function public.delete_file(p_file_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_record uuid; v_name text; v_kind file_row_kind; v_field text; v_row uuid;
begin
  select fr.record_id, f.name, fr.kind, fr.field_key::text, fr.id into v_record, v_name, v_kind, v_field, v_row
    from files f join file_rows fr on fr.id = f.file_row_id
   where f.id = p_file_id;
  if v_record is null or not record_writable(v_record) then
    raise exception 'not found';
  end if;
  if file_row_level(v_row, v_record, v_kind, v_field) <> 'edit' then
    raise exception 'You do not have edit access to these files.' using errcode = '42501';
  end if;

  update files set deleted_at = now() where id = p_file_id;

  insert into record_activity (record_id, actor_id, kind, field_key, summary)
  values (v_record, auth.uid(), 'file', v_field, format('Deleted %s', v_name));
end;
$$;

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
  if file_row_level(r.id, r.record_id, r.kind, r.field_key::text) <> 'edit' then
    raise exception 'You do not have edit access to these files.' using errcode = '42501';
  end if;
  if r.locked then
    raise exception 'The preset rows can''t be renamed or deleted.' using errcode = '42501';
  end if;
  return r;
end;
$$;

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
  -- A lock doesn't stop this (spec). Not being able to see the row does.
  if file_row_level(r.id, r.record_id, r.kind, r.field_key::text) < 'view' then
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
  if file_row_level(r.id, r.record_id, r.kind, r.field_key::text) <> 'edit' then
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

create or replace function public.add_login(
  p_record      uuid,
  p_type        text,
  p_link        text,
  p_username    text,
  p_note        text,
  p_plaintext   text,
  p_key         text,
  p_key_version text default 'v1'
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_login uuid;
begin
  if not record_writable(p_record) then
    raise exception 'not found';
  end if;
  -- The normal permission: a lock or hide doesn't stop adding, and covers what's added.
  if record_tab_base_grant(p_record, 'logins') not in ('edit', 'add_only') then
    raise exception 'You do not have access to add logins here.' using errcode = '42501';
  end if;

  insert into logins (record_id, login_type, link, username, note, position)
  values (p_record, p_type, p_link, p_username, p_note,
          coalesce((select max(position) + 1 from logins where record_id = p_record), 0))
  returning id into v_login;

  if p_plaintext is not null then
    update logins
       set password_enc = extensions.pgp_sym_encrypt(p_plaintext, p_key),
           password_key = p_key_version
     where id = v_login;
  end if;

  perform record_log(p_record, auth.uid(), 'credential', 'Added a login.', jsonb_build_array(
    jsonb_build_object('rank', 1, 'items', jsonb_build_array('tab:logins'), 'body', format('Added a login: %s.', p_type))
  ));
end;
$$;

create or replace function public.add_file_row(p_record uuid, p_name text, p_kind file_row_kind default 'application')
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not record_writable(p_record) then
    raise exception 'not found';
  end if;
  if p_kind not in ('application', 'other') then
    raise exception 'Unknown row kind.' using errcode = '22023';
  end if;
  if record_tab_base_grant(p_record, 'files') not in ('edit', 'add_only') then
    raise exception 'You do not have access to add file rows here.' using errcode = '42501';
  end if;

  insert into file_rows (record_id, kind, name, locked, position)
  values (p_record, p_kind, p_name, false,
          coalesce((select max(position) + 10 from file_rows
                     where record_id = p_record and kind in ('application', 'other') and deleted_at is null), 0));

  perform record_log(p_record, auth.uid(), 'file', 'Added a file row.', jsonb_build_array(
    jsonb_build_object('rank', 1, 'items', jsonb_build_array('listed:files'), 'body', format('Added file row %s.', p_name))
  ));
end;
$$;

-- `can_see`: false on a row someone holding the tab can add to and not see.
drop function if exists public.file_rows_for_adding(uuid, text[], int[]);
create function public.file_rows_for_adding(p_record uuid, p_names text[], p_positions int[])
returns table (row_id uuid, row_name text, row_kind file_row_kind, has_file boolean, can_see boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not record_visible(p_record) or record_tab_base_grant(p_record, 'files') not in ('edit', 'add_only') then
    raise exception 'You do not have access to add files here.' using errcode = '42501';
  end if;
  if record_writable(p_record) then
    perform ensure_application_file_rows(p_record, p_names, p_positions);
  end if;

  return query
    select fr.id, fr.name, fr.kind,
           fr.locked and exists (select 1 from files f where f.file_row_id = fr.id and f.deleted_at is null),
           file_row_level(fr.id, fr.record_id, fr.kind, null) >= 'view'::permission_level
      from file_rows fr
     where fr.record_id = p_record
       and fr.kind in ('application', 'other')
       and fr.deleted_at is null
     order by fr.position, fr.name;
end;
$$;

revoke all on function public.file_rows_for_adding(uuid, text[], int[]) from public, anon;
grant execute on function public.file_rows_for_adding(uuid, text[], int[]) to authenticated;

create or replace function public.file_row_full(p_file_row uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_record uuid;
begin
  select record_id into v_record from file_rows where id = p_file_row;
  if v_record is null or not record_visible(v_record)
     or record_tab_base_grant(v_record, 'files') not in ('edit', 'add_only') then
    raise exception 'not found';
  end if;
  return (select count(*) >= 5 from files where file_row_id = p_file_row and deleted_at is null);
end;
$$;

create or replace function public.statement_file_upload(p_record_id uuid, p_period_id uuid, p_storage_path text, p_name text, p_size_bytes bigint)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_file_id uuid; v_period text;
begin
  if not record_writable(p_record_id) then
    raise exception 'not found';
  end if;
  -- A lock lets statements in. A hide removes the tab, uploads included.
  if record_tab_base_grant(p_record_id, 'statements') <> 'edit' or record_tab_grant(p_record_id, 'statements') < 'view' then
    raise exception 'You do not have edit access to statements.' using errcode = '42501';
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

-- Hidden Agreements users still get agreement alerts (spec).
do $$
declare
  v_def text := pg_get_functiondef('public.notification_visible(notifications)'::regprocedure);
  v_old text := 'tab_visible(n.record_id, agreements_tab_key())';
begin
  if position(v_old in v_def) = 0 then raise exception 'notification_visible: unexpected shape'; end if;
  execute replace(v_def, v_old, '(record_tab_base_grant(n.record_id, agreements_tab_key()) >= ''view''::permission_level)');
end $$;

-- ── notes ────────────────────────────────────────────────────────────────────

-- Field notes follow their field, and Tab notes are an item of their own inside
-- their tab or sub-tab.
create or replace function public.note_effect(p_record uuid, p_kind text, p_scope text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when not exists (select 1 from record_restrictions where record_id = p_record and lifted_at is null) then null
    when p_kind = 'field' then restriction_effect(auth.uid(), p_record, (
      select field_items(f.key::text) from fields f where f.key = p_scope::citext or f.id::text = p_scope limit 1))
    when p_kind = 'tab' then (
      select restriction_effect(auth.uid(), p_record, array_remove(array[
               'notes:' || t.key::text, 'tab:' || t.key::text,
               case when split_part(p_scope, '/', 2) <> '' then 'subtab:' || split_part(p_scope, '/', 2) end], null))
        from tabs t where t.id::text = split_part(p_scope, '/', 1))
  end;
$$;

drop policy if exists notes_select on notes;
create policy notes_select on notes for select using (
  record_visible(record_id)
  and coalesce(tab_visible(record_id, note_scope_tab_key(scope_kind::text, scope_id)), true)
  and note_effect(record_id, scope_kind::text, scope_id) is distinct from 'hide'
  and (scope_kind <> 'tab' or author_id = (select auth.uid()) or note_visible_to((select auth.uid()), id))
);

drop policy if exists notes_insert on notes;
create policy notes_insert on notes for insert with check (
  record_visible(record_id)
  and coalesce(record_tab_grant(record_id, note_scope_tab_key(scope_kind::text, scope_id)) = 'edit', record_module_editable(record_id))
  and note_effect(record_id, scope_kind::text, scope_id) is null
);

drop policy if exists notes_update on notes;
create policy notes_update on notes for update using (
  record_visible(record_id)
  and coalesce(record_tab_grant(record_id, note_scope_tab_key(scope_kind::text, scope_id)) = 'edit', record_module_editable(record_id))
  and note_effect(record_id, scope_kind::text, scope_id) is null
) with check (
  record_visible(record_id)
  and coalesce(record_tab_grant(record_id, note_scope_tab_key(scope_kind::text, scope_id)) = 'edit', record_module_editable(record_id))
  and note_effect(record_id, scope_kind::text, scope_id) is null
);

drop policy if exists notes_delete on notes;
create policy notes_delete on notes for delete using (
  record_visible(record_id)
  and coalesce(record_tab_grant(record_id, note_scope_tab_key(scope_kind::text, scope_id)) = 'edit', record_module_editable(record_id))
  and note_effect(record_id, scope_kind::text, scope_id) is null
);

-- ── naming an item ───────────────────────────────────────────────────────────

create or replace function public.item_label(p_item text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case split_part(p_item, ':', 1)
    when 'tab'    then (select t.label from tabs t where t.key = split_part(p_item, ':', 2)::citext)
    when 'notes'  then (select t.label || ' Tab notes' from tabs t where t.key = split_part(p_item, ':', 2)::citext)
    when 'subtab' then (select t.label || ' › ' || s.label from subtabs s join tabs t on t.id = s.tab_id where s.id::text = split_part(p_item, ':', 2))
    when 'field'  then (select f.label from fields f where f.key = split_part(p_item, ':', 2)::citext and f.archived_at is null)
    when 'row'    then (select fr.name from file_rows fr where fr.id::text = split_part(p_item, ':', 2))
  end;
$$;

create or replace function public.item_visible(p_record uuid, p_item text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind text := split_part(p_item, ':', 1);
  v_val  text := split_part(p_item, ':', 2);
  r      file_rows;
begin
  case v_kind
    when 'tab' then return tab_visible(p_record, v_val);
    when 'listed' then return record_tab_grant(p_record, v_val) <> 'hidden';
    when 'field' then return record_field_grant(p_record, v_val) <> 'hidden';
    when 'subtab' then return record_scope_grant(p_record, 'subtab', v_val::uuid) >= 'view';
    when 'notes' then return tab_visible(p_record, v_val)
                         and restriction_effect(auth.uid(), p_record, array['notes:' || v_val]) is distinct from 'hide';
    when 'row' then
      select * into r from file_rows where id = v_val::uuid;
      if not found then return tab_visible(p_record, 'files'); end if;
      return file_row_level(r.id, r.record_id, r.kind, null) >= 'view';
    else return false;
  end case;
end;
$$;

-- ── what a viewer may know ───────────────────────────────────────────────────

-- One row per item the viewer has a reason to know about. Nothing for a hide
-- they're on the wrong side of, unless it's the Files or Logins tab, whose add
-- screens they still get: `effect` is what it does to them, null if nothing.
create or replace function public.viewer_restrictions(rec uuid)
returns table (
  item text, kind text, effect text, automation_name text, applied_at timestamptz,
  can_lift boolean, allow_download boolean, batch_id uuid, batch_items text[], lifted boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with me as (select auth.uid() as u, auth_is_admin() as admin),
  mine as (
    select r.*, m.admin or user_in_group(m.u, r.can_lift) as lifts,
           m.admin or user_in_group(m.u, r.can_lift) or user_in_group(m.u, r.can_see) as sees
      from record_restrictions r cross join me m
     where r.record_id = rec and record_visible(rec)
  ),
  merged as (
    select a.item, a.kind, bool_or(a.lifts) as lifts, bool_or(a.sees) as sees
      from mine a where a.lifted_at is null group by a.item, a.kind
  )
  select r.item, r.kind,
         case
           when r.lifted_at is not null then null
           when r.kind = 'hide' and not g.sees then 'hide'
           when r.kind = 'lock' and not g.lifts then 'lock'
         end,
         r.automation_name, r.applied_at, coalesce(g.lifts, r.lifts) and r.lifted_at is null, r.allow_download, r.batch_id,
         (select array_agg(l.label) from (select distinct item_label(x.item) as label from mine x where x.batch_id = r.batch_id) l where l.label is not null),
         r.lifted_at is not null
    from mine r
    left join merged g on g.item = r.item and g.kind = r.kind
   where (r.lifted_at is null and (r.kind = 'lock' or g.sees or split_part(r.item, ':', 1) = 'row' or r.item in ('tab:files', 'tab:logins')))
      or (r.lifted_at is not null and r.lifted_by is not null and r.lifts
          and not exists (select 1 from mine n where n.batch_id = r.batch_id and n.lifted_at is null)
          and not exists (select 1 from mine n where n.item = r.item and n.kind = r.kind and n.lifted_at is null));
$$;

revoke all on function public.viewer_restrictions(uuid) from public, anon;
grant execute on function public.viewer_restrictions(uuid) to authenticated;

-- The app's guards, for many records at once. Rows only where something applies.
create or replace function public.restriction_effects(p_ids uuid[], p_items text[])
returns table (record_id uuid, effect text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select e.id, e.effect
    from (
      select distinct r.record_id as id, restriction_effect(auth.uid(), r.record_id, p_items) as effect
        from record_restrictions r
       where r.record_id = any (p_ids) and r.lifted_at is null and r.item = any (p_items)
    ) e
   where e.effect is not null;
$$;

revoke all on function public.restriction_effects(uuid[], text[]) from public, anon;
grant execute on function public.restriction_effects(uuid[], text[]) to authenticated;

-- ── logging ──────────────────────────────────────────────────────────────────

-- A part per item, so each reader gets the items they can see named and no others.
create or replace function public.restriction_log(
  p_record uuid, p_actor uuid, p_verb text, p_items text[], p_automation_id uuid, p_automation_name text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_details jsonb := '[]'::jsonb;
  v_rank    int := 0;
  v_item    text;
  v_label   text;
begin
  foreach v_item in array p_items loop
    v_label := item_label(v_item);
    continue when v_label is null;
    v_rank := v_rank + 1;
    v_details := v_details || jsonb_build_object('rank', v_rank, 'items', jsonb_build_array(v_item), 'body', v_label, 'part', p_verb);
  end loop;
  perform record_log(p_record, p_actor, 'automation', p_verb || ' items.', v_details, p_automation_id, p_automation_name);
end;
$$;

revoke all on function public.restriction_log(uuid, uuid, text, text[], uuid, text) from public, anon, authenticated;

alter table update_details add column if not exists part text;

create or replace function public.record_log(
  p_record          uuid,
  p_actor           uuid,
  p_kind            activity_kind,
  p_generic         text,
  p_details         jsonb default '[]'::jsonb,
  p_automation_id   uuid  default null,
  p_automation_name text  default null,
  p_actor_label     text  default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_at     timestamptz := clock_timestamp();
  v_update uuid;
  v_top    jsonb;
  v_parts  text;
begin
  insert into updates (record_id, author_id, body, is_log, automation_id, automation_name, actor_label, created_at)
  values (p_record, p_actor, p_generic, true, p_automation_id, p_automation_name, p_actor_label, v_at)
  returning id into v_update;

  insert into update_details (update_id, record_id, rank, items, body, part)
  select v_update, p_record, (d ->> 'rank')::int,
         array(select jsonb_array_elements_text(d -> 'items')), d ->> 'body', d ->> 'part'
    from jsonb_array_elements(p_details) d;

  -- An entry in parts can't be one activity row per reader: the row keeps the
  -- wording that names nothing, and Updates carries the names.
  if exists (select 1 from jsonb_array_elements(p_details) d where d ? 'part') then
    insert into record_activity (record_id, actor_id, kind, summary, source, at)
    values (p_record, p_actor, p_kind, p_generic, coalesce('Automation: ' || p_automation_name, p_actor_label), v_at);
    return;
  end if;

  select d into v_top from jsonb_array_elements(p_details) d order by (d ->> 'rank')::int desc limit 1;

  insert into record_activity (record_id, actor_id, kind, summary, items, source, at)
  values (p_record, p_actor, p_kind, coalesce(v_top ->> 'body', p_generic),
          case when v_top is null then null else array(select jsonb_array_elements_text(v_top -> 'items')) end,
          coalesce('Automation: ' || p_automation_name, p_actor_label), v_at);
end;
$$;

-- ── lifting by hand, and putting it back ─────────────────────────────────────

create or replace function public.restrictions_can_lift(rec uuid, p_item text, p_kind text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth_is_admin() or exists (
    select 1 from record_restrictions r
     where r.record_id = rec and r.item = p_item and r.kind = p_kind and user_in_group(auth.uid(), r.can_lift)
  );
$$;

revoke all on function public.restrictions_can_lift(uuid, text, text) from public, anon, authenticated;

-- A click lifts what the action put on, for everyone, and anything else of that
-- kind on the item: "One lift removes both."
create or replace function public.lift_restriction(p_record uuid, p_item text, p_kind text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_batches uuid[];
  v_items   text[];
begin
  if not record_visible(p_record) or not restrictions_can_lift(p_record, p_item, p_kind) then
    raise exception 'You can''t lift this.' using errcode = '42501';
  end if;
  select array_agg(distinct batch_id) into v_batches
    from record_restrictions where record_id = p_record and item = p_item and kind = p_kind and lifted_at is null;
  if v_batches is null then return; end if;

  with lifted as (
    update record_restrictions set lifted_at = now(), lifted_by = auth.uid()
     where record_id = p_record and kind = p_kind and lifted_at is null and batch_id = any (v_batches)
    returning item
  )
  select array_agg(distinct item) into v_items from lifted;

  perform restriction_log(p_record, auth.uid(), case p_kind when 'lock' then 'Unlocked' else 'Unhid' end, v_items, null, null);
  perform record_ping(p_record);
end;
$$;

-- The same items, groups and Allow download: those rows, put back.
create or replace function public.reapply_restriction(p_record uuid, p_batch uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind  text;
  v_items text[];
begin
  select kind into v_kind from record_restrictions where record_id = p_record and batch_id = p_batch limit 1;
  if v_kind is null or not record_visible(p_record) then raise exception 'not found'; end if;
  if not (auth_is_admin() or exists (
    select 1 from record_restrictions r where r.record_id = p_record and r.batch_id = p_batch and user_in_group(auth.uid(), r.can_lift)
  )) then
    raise exception 'You can''t do this.' using errcode = '42501';
  end if;

  with back as (
    update record_restrictions set lifted_at = null, lifted_by = null
     where record_id = p_record and batch_id = p_batch and lifted_at is not null
    returning item
  )
  select array_agg(distinct item) into v_items from back;
  if v_items is null then return; end if;

  perform restriction_log(p_record, auth.uid(), case v_kind when 'lock' then 'Re-locked' else 'Re-hid' end, v_items, null, null);
  perform record_ping(p_record);
end;
$$;

revoke all on function public.lift_restriction(uuid, text, text) from public, anon;
revoke all on function public.reapply_restriction(uuid, uuid) from public, anon;
grant execute on function public.lift_restriction(uuid, text, text) to authenticated;
grant execute on function public.reapply_restriction(uuid, uuid) to authenticated;

-- May this viewer void? A locked Agreements tab says no, and nothing else here
-- asks, since sending stays open.
create or replace function public.item_locked_for_viewer(p_record uuid, p_item text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select restriction_effect(auth.uid(), p_record, array[p_item]) is not null;
$$;

revoke all on function public.item_locked_for_viewer(uuid, text) from public, anon;
grant execute on function public.item_locked_for_viewer(uuid, text) to authenticated;

-- ── the actions ──────────────────────────────────────────────────────────────

-- A row is picked by name in a step, and is a row of this record once run. Gone
-- items resolve to nothing, and the action carries on with the rest (spec).
create or replace function public.automation_resolve_items(p_record uuid, p_refs jsonb)
returns text[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_out  text[] := '{}';
  v_ref  text;
  v_id   uuid;
begin
  perform ensure_application_file_rows(p_record,
    array['Owner ID', 'Bank statements', 'Processing statements', 'Corp docs', 'Voided check'], array[0, 10, 20, 30, 40]);
  for v_ref in select * from jsonb_array_elements_text(coalesce(p_refs, '[]'::jsonb)) loop
    if split_part(v_ref, ':', 1) = 'row' then
      select id into v_id from file_rows
       where record_id = p_record and kind = 'application' and locked and deleted_at is null
         and name = substr(v_ref, 5);
      if found then v_out := v_out || ('row:' || v_id); end if;
    elsif item_label(v_ref) is not null then
      v_out := v_out || v_ref;
    end if;
  end loop;
  return v_out;
end;
$$;

revoke all on function public.automation_resolve_items(uuid, jsonb) from public, anon, authenticated;

create or replace function public.automation_restrict(p_run automation_runs, s jsonb, p_kind text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_items text[] := automation_resolve_items(p_run.record_id, s -> 'items');
  v_batch uuid := gen_random_uuid();
  v_verb  text := case p_kind when 'lock' then 'Locked' else 'Hid' end;
begin
  if cardinality(v_items) = 0 then
    return automation_outcome('done', 'Nothing to ' || p_kind || ': the chosen items no longer exist.');
  end if;

  insert into record_restrictions (record_id, batch_id, kind, item, automation_id, automation_name, can_lift, can_see, allow_download)
  select p_run.record_id, v_batch, p_kind, i, p_run.automation_id, p_run.automation_name,
         coalesce(s -> 'canLift', '{}'::jsonb), coalesce(s -> 'canSee', '{}'::jsonb),
         coalesce((s ->> 'allowDownload')::boolean, true)
    from unnest(v_items) i;

  perform restriction_log(p_run.record_id, null, v_verb, v_items, p_run.automation_id, p_run.automation_name);
  perform record_ping(p_run.record_id);
  return automation_outcome('done', v_verb || ': ' || (select string_agg(item_label(i), ', ') from unnest(v_items) i) || '.');
end;
$$;

create or replace function public.automation_lift(p_run automation_runs, s jsonb, p_kind text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_items text[] := automation_resolve_items(p_run.record_id, s -> 'items');
  v_done  text[];
  v_verb  text := case p_kind when 'lock' then 'Unlocked' else 'Unhid' end;
begin
  with lifted as (
    update record_restrictions set lifted_at = now()
     where record_id = p_run.record_id and kind = p_kind and lifted_at is null and item = any (v_items)
    returning item
  )
  select array_agg(distinct item) into v_done from lifted;

  if v_done is null then
    return automation_outcome('skipped', case p_kind when 'lock' then 'Nothing was locked on this record.' else 'Nothing was hidden on this record.' end);
  end if;

  perform restriction_log(p_run.record_id, null, v_verb, v_done, p_run.automation_id, p_run.automation_name);
  perform record_ping(p_run.record_id);
  return automation_outcome('done', v_verb || ': ' || (select string_agg(item_label(i), ', ') from unnest(v_done) i) || '.');
end;
$$;

revoke all on function public.automation_restrict(automation_runs, jsonb, text) from public, anon, authenticated;
revoke all on function public.automation_lift(automation_runs, jsonb, text) from public, anon, authenticated;

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
    when 'lock'               then return automation_restrict(p_run, s, 'lock');
    when 'hide'               then return automation_restrict(p_run, s, 'hide');
    when 'unlock'             then return automation_lift(p_run, s, 'lock');
    when 'unhide'             then return automation_lift(p_run, s, 'hide');
    else raise exception 'Unknown action %', s ->> 'type';
  end case;
end;
$$;

-- ── File uploaded ────────────────────────────────────────────────────────────

create or replace function public.automation_trigger_match(t jsonb)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select case t ->> 'type'
    when 'status'          then jsonb_build_object('value', t -> 'value')
    when 'stage'           then jsonb_build_object('pipeline', t -> 'pipelineId', 'step', t -> 'stepId')
    when 'team_assigned'   then jsonb_build_object('team', t -> 'teamId')
    when 'team_removed'    then jsonb_build_object('team', t -> 'teamId')
    when 'module_assigned' then jsonb_build_object('module', t -> 'moduleId')
    when 'module_removed'  then jsonb_build_object('module', t -> 'moduleId')
    when 'field'           then jsonb_build_object('field', t -> 'field')
                                || case when nullif(t ->> 'value', '') is null then '{}'::jsonb else jsonb_build_object('value', t -> 'value') end
    when 'file_uploaded'   then jsonb_build_object('rows', t -> 'rows', 'frequency', t -> 'frequency')
    else '{}'::jsonb
  end;
$$;

-- Files in one go count once: a minute's bucket per row and person. How often it
-- may fire is the trigger's own setting, so it is decided here, per automation.
create or replace function public.automation_fire_file(p_row file_rows, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  t      automation_triggers;
  v_last timestamptz;
  v_freq text;
  v_at   timestamptz := clock_timestamp();
begin
  if current_setting('tapdash.automation', true) = 'on' or p_actor is null then return; end if;
  if p_row.kind <> 'application' or not p_row.locked then return; end if;

  for t in
    select * from automation_triggers x
     where x.kind = 'file_uploaded' and (x.match -> 'rows') ? p_row.name
       and (x.only_record is null or x.only_record = p_row.record_id)
       and v_at >= x.active_from
  loop
    v_freq := coalesce(t.match ->> 'frequency', 'every');
    select fired_at into v_last from automation_file_fires
     where automation_id = t.automation_id and record_id = p_row.record_id and row_name = p_row.name;

    if v_last is not null and v_freq = 'first' then continue; end if;
    if v_last is not null and v_freq = 'first_after_unlock' and (
      exists (select 1 from record_restrictions r where r.automation_id = t.automation_id and r.record_id = p_row.record_id and r.lifted_at is null)
      or not exists (select 1 from record_restrictions r where r.automation_id = t.automation_id and r.record_id = p_row.record_id and r.lifted_at > v_last)
    ) then
      continue;
    end if;

    insert into automation_queue (automation_id, version_id, trigger_id, trigger_kind, record_id, module_id, actor_id, note, occurred_at, dedupe_key)
    values (t.automation_id, t.version_id, t.trigger_id, t.kind, p_row.record_id, null, p_actor, null, v_at,
            p_row.record_id || ':file:' || p_row.id || ':' || p_actor || ':' || floor(extract(epoch from v_at) / 60)::bigint)
    on conflict (automation_id, dedupe_key) do nothing;

    if found then
      insert into automation_file_fires (automation_id, record_id, row_name, fired_at)
      values (t.automation_id, p_row.record_id, p_row.name, v_at)
      on conflict (automation_id, record_id, row_name) do update set fired_at = excluded.fired_at;
    end if;
  end loop;
end;
$$;

revoke all on function public.automation_fire_file(file_rows, uuid) from public, anon, authenticated;

-- Adding goes by the normal permission, as with logins. A row can be hidden or
-- locked and still take files, which it then covers.
create or replace function public.record_file_upload(p_file_row_id uuid, p_storage_path text, p_name text, p_size_bytes bigint)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r         file_rows;
  v_file_id uuid;
  v_access  permission_level;
begin
  select * into r from file_rows fr where fr.id = p_file_row_id and fr.deleted_at is null;
  if not found or not record_writable(r.record_id) then
    raise exception 'not found';
  end if;
  if r.kind in ('application', 'other') then
    v_access := record_tab_base_grant(r.record_id, 'files');
  else
    v_access := file_row_access(r.record_id, r.kind, r.field_key::text);
  end if;
  if not (v_access = 'edit' or (v_access = 'add_only' and r.kind in ('application', 'other'))) then
    raise exception 'You do not have edit access to these files.' using errcode = '42501';
  end if;

  if r.kind in ('application', 'other') then
    perform record_log(r.record_id, auth.uid(), 'file', 'Uploaded a file.', jsonb_build_array(
      jsonb_build_object('rank', 1, 'items', jsonb_build_array('row:' || p_file_row_id), 'body', format('Uploaded %s to %s.', p_name, r.name))
    ));
  else
    insert into record_activity (record_id, actor_id, kind, field_key, summary)
    values (r.record_id, auth.uid(), 'file', r.field_key, format('Uploaded %s', p_name));
  end if;

  insert into files (file_row_id, storage_path, name, size_bytes, uploaded_by)
  values (p_file_row_id, p_storage_path, p_name, p_size_bytes, auth.uid())
  returning id into v_file_id;

  perform automation_fire_file(r, auth.uid());
  return v_file_id;
end;
$$;

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
  -- Out of a locked row is like deleting from it, and into one is held the same.
  if file_row_level(src.id, src.record_id, src.kind, null) <> 'edit'
     or file_row_level(dest.id, dest.record_id, dest.kind, null) <> 'edit' then
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

  -- A move in counts as an upload to that row. A move out fires nothing.
  perform automation_fire_file(dest, auth.uid());
end;
$$;

-- ── who may call what ────────────────────────────────────────────────────────

-- These answer for any person, or say what is hidden, so none is reachable from a
-- browser. They run inside definer functions and policies' definer helpers.
revoke all on function public.user_in_group(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.restriction_effect(uuid, uuid, text[]) from public, anon, authenticated;
revoke all on function public.restriction_cap(permission_level, text, boolean) from public, anon, authenticated;
revoke all on function public.field_items(text) from public, anon, authenticated;
revoke all on function public.download_blocked(uuid, text[]) from public, anon, authenticated;
revoke all on function public.item_label(text) from public, anon, authenticated;
revoke all on function public.user_record_scope_grant_base(uuid, uuid, grant_scope, uuid) from public, anon, authenticated;
revoke all on function public.user_record_field_grant_base(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.file_row_level(uuid, uuid, file_row_kind, text) from public, anon;
revoke all on function public.note_effect(uuid, text, text) from public, anon;
revoke all on function public.restriction_hidden_keys(uuid) from public, anon;
grant execute on function public.file_row_level(uuid, uuid, file_row_kind, text) to authenticated;
grant execute on function public.note_effect(uuid, text, text) to authenticated;
grant execute on function public.restriction_hidden_keys(uuid) to authenticated;
