-- =============================================================================
-- Add only (client spec of 1 Nov 2026). The enum value and `tabs.allows_add_only`
-- are in 9856.
--
-- The one rule: Add only sits below View, and every read gate now asks for AT
-- LEAST View instead of "not Hidden". Anything missed fails closed.
--
-- Three things go through definer functions, because the viewer can't read what
-- they write:
--   add_login            one call for the row and its password
--   add_file_row         a new row on the Files tab
--   file_rows_for_adding the row names, and a check on preset rows holding a file
-- `record_file_upload` takes the Add only case itself.
--
-- `record_log` is the writer behind Updates entries whose detail not everyone may
-- read. The `updates` row carries wording that names nothing; `update_details`
-- carries the versions that do, each behind the items it names, and the reader
-- gets the highest one they may see. So nothing has to be filtered in the app.
-- =============================================================================

-- ── the read gates ───────────────────────────────────────────────────────────

create or replace function public.tab_visible(rec uuid, p_tab_key text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select record_tab_grant(rec, p_tab_key) >= 'view'::permission_level;
$$;

create or replace function public.require_tab_view(rec uuid, p_tab_key text)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if record_tab_grant(rec, p_tab_key) < 'view'::permission_level then
    raise exception 'You do not have access to this tab.' using errcode = '42501';
  end if;
end;
$$;

-- A record someone may only read until they take it: they can't add, and Add
-- only shows nothing else, so the tab isn't offered.
create or replace function public.record_scope_grant(rec uuid, p_kind grant_scope, p_scope uuid)
returns permission_level
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when g.level = 'edit' and not user_can_see_record_by_rules(auth.uid(), rec) then 'view'::permission_level
    when g.level = 'add_only' and not user_can_see_record_by_rules(auth.uid(), rec) then 'hidden'::permission_level
    else g.level
  end
  from (select user_record_scope_grant(auth.uid(), rec, p_kind, p_scope) as level) g;
$$;

drop policy if exists file_rows_select on file_rows;
create policy file_rows_select on file_rows for select using (
  record_visible(record_id)
  and file_row_access(record_id, kind, field_key::text) >= 'view'::permission_level
);

drop policy if exists files_select on files;
create policy files_select on files for select using (
  exists (
    select 1 from file_rows fr
     where fr.id = files.file_row_id
       and record_visible(fr.record_id)
       and file_row_access(fr.record_id, fr.kind, fr.field_key::text) >= 'view'::permission_level
  )
);

drop policy if exists records_bucket_select on storage.objects;
create policy records_bucket_select on storage.objects for select using (
  bucket_id = 'records'
  and can_see_record(((storage.foldername(name))[1])::uuid)
  and storage_object_access(name) >= 'view'::permission_level
);

-- ── which tabs may hold it, and the guardrail ────────────────────────────────

create or replace function public.grants_respect_tab_access_options()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_opts  text;
  v_label text;
  v_add   boolean;
begin
  if new.scope_kind = 'tab' then
    select access_options, label, allows_add_only into v_opts, v_label, v_add from tabs where id = new.scope_id;
  elsif new.scope_kind = 'subtab' then
    select t.access_options, t.label, false into v_opts, v_label, v_add
      from subtabs s join tabs t on t.id = s.tab_id where s.id = new.scope_id;
  else
    if new.grant_level = 'add_only' then
      raise exception 'Add only is a tab level, for the Logins and Files tabs.' using errcode = '23514';
    end if;
    return new;
  end if;

  if v_opts = 'setting' then
    raise exception 'The % tab has no tab or sub-tab level — its setting decides it.', v_label using errcode = '23514';
  end if;
  if v_opts = 'hidden_full' and new.scope_kind = 'tab' and new.grant_level = 'view' then
    raise exception 'The % tab is Hidden or Full access — there is no View only.', v_label using errcode = '23514';
  end if;
  if new.grant_level = 'add_only' and not coalesce(v_add, false) then
    raise exception 'Add only is for the Logins and Files tabs, not %.', v_label using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.permission_value_rank(p_value text)
returns integer
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_value
    when 'no' then 0 when 'hidden' then 0 when 'own' then 0
    when 'add_only' then 1
    when 'mine' then 2 when 'view' then 2
    when 'yes' then 3 when 'all' then 3 when 'full' then 3 when 'org' then 3 when 'edit' then 3
    else 0
  end;
$$;

-- ── log entries ──────────────────────────────────────────────────────────────

alter table updates add column if not exists is_log boolean not null default false;
alter table updates add column if not exists actor_label text;
alter table updates drop constraint if exists updates_author_or_automation;
alter table updates add constraint updates_author_or_automation
  check (author_id is not null or automation_name is not null or actor_label is not null);

alter table record_activity add column if not exists items text[];

create table if not exists update_details (
  id        uuid primary key default gen_random_uuid(),
  update_id uuid not null references updates (id) on delete cascade,
  record_id uuid not null references records (id) on delete cascade,
  rank      int  not null default 1,
  items     text[] not null,
  body      text not null,
  unique (update_id, rank)
);
create index if not exists update_details_record on update_details (record_id);

alter table update_details enable row level security;
alter table update_details force row level security;
revoke all on update_details from public, anon, authenticated;
grant select on update_details to authenticated;

-- May this viewer read something named in a log entry? An item is `tab:<key>`,
-- `listed:<key>` for a tab whose row names an Add only viewer sees, or `row:<id>`.
create or replace function public.item_visible(p_record uuid, p_item text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case split_part(p_item, ':', 1)
    when 'tab'    then tab_visible(p_record, split_part(p_item, ':', 2))
    when 'listed' then record_tab_grant(p_record, split_part(p_item, ':', 2)) <> 'hidden'::permission_level
    when 'row'    then tab_visible(p_record, 'files')
    else false
  end;
$$;

create or replace function public.items_visible(p_record uuid, p_items text[])
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select not exists (select 1 from unnest(p_items) i where not item_visible(p_record, i));
$$;

drop policy if exists update_details_select on update_details;
create policy update_details_select on update_details for select using (
  record_visible(record_id)
  and tab_visible(record_id, 'updates')
  and items_visible(record_id, items)
);

-- A log entry is for everyone who can open Updates, as an automation's is: "only
-- mine" is about people's posts.
drop policy if exists updates_select on updates;
create policy updates_select on updates for select using (
  record_visible(record_id)
  and tab_visible(record_id, 'updates')
  and (field_key is null or record_field_grant(record_id, field_key::text) <> 'hidden'::permission_level)
  and (automation_field is null or record_field_grant(record_id, automation_field::text) <> 'hidden'::permission_level)
  and (automation_name is not null or is_log or author_id = (select auth.uid()) or update_visible_to((select auth.uid()), id))
  and (team_id is null or author_id = (select auth.uid()) or team_log_visible((select auth.uid()), team_id, names_person))
);

-- The activity row of a file event names the file. Older rows carry no items, so
-- a file event with no field answers to the Files tab.
drop policy if exists record_activity_select on record_activity;
create policy record_activity_select on record_activity for select using (
  record_visible(record_id)
  and (field_key is null or record_field_grant(record_id, field_key::text) <> 'hidden'::permission_level)
  and (items is null or items_visible(record_id, items))
  and (items is not null or kind <> 'file' or field_key is not null or tab_visible(record_id, 'files'))
  and (team_id is null or actor_id = (select auth.uid()) or team_log_visible((select auth.uid()), team_id, names_person))
  and (field_key is distinct from 'team_members_assigned' or cardinality((select viewer_hidden_assignees())) = 0)
);

-- p_details: [{ "rank": 1, "items": ["row:<id>"], "body": "..." }, ...]. The row
-- and its details go in one transaction with the change they describe.
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
begin
  insert into updates (record_id, author_id, body, is_log, automation_id, automation_name, actor_label, created_at)
  values (p_record, p_actor, p_generic, true, p_automation_id, p_automation_name, p_actor_label, v_at)
  returning id into v_update;

  insert into update_details (update_id, record_id, rank, items, body)
  select v_update, p_record, (d ->> 'rank')::int,
         array(select jsonb_array_elements_text(d -> 'items')), d ->> 'body'
    from jsonb_array_elements(p_details) d;

  select d into v_top from jsonb_array_elements(p_details) d order by (d ->> 'rank')::int desc limit 1;

  insert into record_activity (record_id, actor_id, kind, summary, items, source, at)
  values (p_record, p_actor, p_kind, coalesce(v_top ->> 'body', p_generic),
          case when v_top is null then null else array(select jsonb_array_elements_text(v_top -> 'items')) end,
          coalesce('Automation: ' || p_automation_name, p_actor_label), v_at);
end;
$$;

revoke all on function public.record_log(uuid, uuid, activity_kind, text, jsonb, uuid, text, text) from public, anon, authenticated;

-- A log entry is a record of what happened, not a post.
create or replace function public.edit_update_with_mentions(p_update_id uuid, p_body text, p_mentioned_user_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record uuid;
  v_author uuid;
  v_field  citext;
  v_log    boolean;
  v_old    uuid[];
  v_new    uuid[];
  v_added  uuid[];
  v_gone   uuid[];
begin
  select record_id, author_id, field_key, is_log into v_record, v_author, v_field, v_log
    from updates where id = p_update_id and deleted_at is null;
  if v_record is null or not record_writable(v_record) then
    raise exception 'not found';
  end if;
  perform require_tab_edit(v_record, 'updates');
  if v_author <> auth.uid() and not auth_is_admin() then
    raise exception 'Only the author or an admin may edit this update' using errcode = '42501';
  end if;
  if v_field is not null then
    raise exception 'A field mention cannot be edited' using errcode = '42501';
  end if;
  if v_log then
    raise exception 'A log entry cannot be edited' using errcode = '42501';
  end if;

  select coalesce(array_agg(user_id), '{}') into v_old from update_mentions where update_id = p_update_id;
  select coalesce(array_agg(distinct m), '{}') into v_new
    from unnest(coalesce(p_mentioned_user_ids, '{}')) as m
   where m = any (mention_candidates(v_record, 'updates'));

  select coalesce(array_agg(x), '{}') into v_added from unnest(v_new) as x where not (x = any (v_old));
  select coalesce(array_agg(x), '{}') into v_gone  from unnest(v_old) as x where not (x = any (v_new));

  update updates set body = p_body, edited_at = now() where id = p_update_id;

  if cardinality(v_added) > 0 then
    insert into update_mentions (update_id, user_id) select p_update_id, m from unnest(v_added) as m
    on conflict do nothing;
    perform mention_notify(v_added, 'mention_update', v_record, p_update_id, null, null, null,
                           mention_preview(p_body), null, null, null);
  end if;
  if cardinality(v_gone) > 0 then
    delete from update_mentions where update_id = p_update_id and user_id = any (v_gone);
    update notifications set revoked_at = now()
     where update_id = p_update_id and recipient_id = any (v_gone) and revoked_at is null;
  end if;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (v_record, auth.uid(), 'update', 'Update edited');
end;
$$;

create or replace function public.delete_update(p_update_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_record uuid; v_author uuid; v_log boolean;
begin
  select record_id, author_id, is_log into v_record, v_author, v_log from updates where id = p_update_id;
  if v_record is null or not record_writable(v_record) then
    raise exception 'not found';
  end if;
  perform require_tab_edit(v_record, 'updates');
  if v_author <> auth.uid() and not auth_is_admin() then
    raise exception 'Only the author or an admin may delete this update' using errcode = '42501';
  end if;
  if v_log then
    raise exception 'A log entry cannot be deleted' using errcode = '42501';
  end if;

  update updates set deleted_at = now() where id = p_update_id;

  -- The post's mentions go, and its replies' (a reply is not shown without its post).
  update notifications set revoked_at = now()
   where revoked_at is null
     and (update_id = p_update_id
          or update_id in (select id from updates where parent_id = p_update_id));

  insert into record_activity (record_id, actor_id, kind, summary)
  values (v_record, auth.uid(), 'update', 'Update deleted');
end;
$$;

-- ── adding ───────────────────────────────────────────────────────────────────

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
  if record_tab_grant(p_record, 'logins') not in ('edit', 'add_only') then
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

revoke all on function public.add_login(uuid, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.add_login(uuid, text, text, text, text, text, text, text) to authenticated;

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
  if record_tab_grant(p_record, 'files') not in ('edit', 'add_only') then
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

revoke all on function public.add_file_row(uuid, text, file_row_kind) from public, anon;
grant execute on function public.add_file_row(uuid, text, file_row_kind) to authenticated;

-- What an Add only viewer gets of the Files tab: names, and the check on a preset
-- row that holds a file. No file data, no count, and no note.
create or replace function public.file_rows_for_adding(p_record uuid, p_names text[], p_positions int[])
returns table (row_id uuid, row_name text, row_kind file_row_kind, has_file boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not record_visible(p_record) or record_tab_grant(p_record, 'files') not in ('edit', 'add_only') then
    raise exception 'You do not have access to add files here.' using errcode = '42501';
  end if;
  if record_writable(p_record) then
    perform ensure_application_file_rows(p_record, p_names, p_positions);
  end if;

  return query
    select fr.id, fr.name, fr.kind,
           fr.locked and exists (select 1 from files f where f.file_row_id = fr.id and f.deleted_at is null)
      from file_rows fr
     where fr.record_id = p_record
       and fr.kind in ('application', 'other')
       and fr.deleted_at is null
     order by fr.position, fr.name;
end;
$$;

revoke all on function public.file_rows_for_adding(uuid, text[], int[]) from public, anon;
grant execute on function public.file_rows_for_adding(uuid, text[], int[]) to authenticated;

-- Refused before the bytes go to Storage: an Add only viewer can't count the row.
create or replace function public.file_row_full(p_file_row uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_record uuid; v_kind file_row_kind; v_field text;
begin
  select record_id, kind, field_key::text into v_record, v_kind, v_field from file_rows where id = p_file_row;
  if v_record is null or not record_visible(v_record)
     or file_row_access(v_record, v_kind, v_field) not in ('edit', 'add_only') then
    raise exception 'not found';
  end if;
  return (select count(*) >= 5 from files where file_row_id = p_file_row and deleted_at is null);
end;
$$;

revoke all on function public.file_row_full(uuid) from public, anon;
grant execute on function public.file_row_full(uuid) to authenticated;

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

  insert into files (file_row_id, storage_path, name, size_bytes, uploaded_by)
  values (p_file_row_id, p_storage_path, p_name, p_size_bytes, auth.uid())
  returning id into v_file_id;

  if v_kind in ('application', 'other') then
    perform record_log(v_record, auth.uid(), 'file', 'Uploaded a file.', jsonb_build_array(
      jsonb_build_object('rank', 1, 'items', jsonb_build_array('row:' || p_file_row_id), 'body', format('Uploaded %s to %s.', p_name, v_row))
    ));
  else
    insert into record_activity (record_id, actor_id, kind, field_key, summary)
    values (v_record, auth.uid(), 'file', v_field, format('Uploaded %s', p_name));
  end if;

  return v_file_id;
end;
$$;

-- ── defaults (spec table: everyone full access, Sales and Reconcilers Add only
--    on Logins). Not user overrides: there are none on these tabs.
-- ─────────────────────────────────────────────────────────────────────────────

update template_grants g
   set grant_level = case
         when t.key = 'logins' and pt.user_type in ('sales_agent', 'accounting') then 'add_only'::permission_level
         else 'edit'::permission_level
       end
  from tabs t, permission_templates pt
 where g.scope_kind = 'tab' and g.module_id is null
   and g.scope_id = t.id and t.key in ('logins', 'files')
   and g.template_id = pt.id and pt.user_type is not null;
