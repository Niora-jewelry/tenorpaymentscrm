-- Current Status belongs to a module, like a pipeline (client, 6 Nov 2026: "A
-- status set on Deals should not reflect on leads").
--
-- It was one field with one value and a different list of choices per module. So
-- a status set on Deals sat on the record in Leads too, and because Leads has no
-- such choice it showed as its raw key: `proposal_sent`.
--
-- Now each display module has its own field, `<slug>_current_status`, marked by
-- `fields.module_id`, with that module's choices. Being real fields, they keep
-- filters, sorting, history and permissions with nothing new. `current_status`
-- stays as the Records List's own. A field with `module_id` set shows only in
-- that module; every other field is unchanged (NULL = everywhere).

alter table fields add column module_id uuid references modules (id) on delete cascade;

comment on column fields.module_id is
  'Shown only in this module. NULL shows it everywhere. Current Status is the use: one field per module.';

do $$
declare
  src      fields;
  m        modules;
  v_new    uuid;
  v_key    text;
  v_shared boolean;
begin
  select * into strict src from fields where key = 'current_status';

  for m in select * from modules where kind = 'display' order by position loop
    v_key := m.slug || '_current_status';

    insert into fields (
      key, label, type, tab_id, subtab_id, position, hint, notes_enabled, sync_enabled, is_system,
      read_only, required, sensitive, wide, placeholder, width, grid_columns, section, module_id
    ) values (
      v_key, src.label, src.type, src.tab_id, src.subtab_id, src.position, null, src.notes_enabled, src.sync_enabled, src.is_system,
      src.read_only, src.required, src.sensitive, src.wide, src.placeholder, src.width, src.grid_columns, src.section, m.id
    ) returning id into v_new;

    -- Its own list moves over. A module that used the shared list gets a copy, so
    -- changing one module's choices never reaches another.
    update field_choices set field_id = v_new where field_id = src.id and module_id = m.id;
    v_shared := not found;
    if v_shared then
      insert into field_choices (field_id, module_id, key, value, swatch, position)
      select v_new, m.id, c.key, c.value, c.swatch, c.position
        from field_choices c where c.field_id = src.id and c.module_id is null;
    end if;

    update module_columns          set field_id = v_new where module_id = m.id and field_id = src.id;
    update module_header_fields    set field_id = v_new where module_id = m.id and field_id = src.id;
    update user_column_order       set field_id = v_new where module_id = m.id and field_id = src.id;
    update user_column_visibility  set field_id = v_new where module_id = m.id and field_id = src.id;
    insert into user_field_order (user_id, tab_id, subtab_id, field_id, position)
    select o.user_id, o.tab_id, o.subtab_id, v_new, o.position
      from user_field_order o where o.field_id = src.id
    on conflict do nothing;

    -- A value goes to the module whose list holds it. Those keys are each in one
    -- list, so it lands where it was set. The shared Urgent/High/Mid/Low keys are
    -- in several, so they go only to a module the record is in.
    update records r
       set values = r.values || jsonb_build_object(v_key, r.values -> 'current_status')
     where r.values ? 'current_status'
       and exists (select 1 from field_choices c where c.field_id = v_new and c.key = r.values ->> 'current_status')
       and (not v_shared or exists (select 1 from record_modules rm where rm.record_id = r.id and rm.module_id = m.id));
  end loop;

  -- What is left is the Records List's own: a value from one module's list has
  -- moved there, and would only show as a raw key here.
  update records r
     set values = r.values - 'current_status'
   where r.values ? 'current_status'
     and not exists (select 1 from field_choices c where c.field_id = src.id and c.key = r.values ->> 'current_status');

  update fields set module_id = (select id from modules where kind = 'storage' order by position limit 1), hint = null where id = src.id;
end;
$$;

-- ── automations: "Current Status" now means whichever module it happened in ──

create or replace function module_status_keys()
returns setof text
language sql stable security definer
set search_path = public, pg_temp
as $$
  select key from fields where type = 'status' and module_id is not null and archived_at is null;
$$;

create or replace function automation_status_label(p_value text)
returns text
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select c.value from field_choices c join fields f on f.id = c.field_id
      where f.key in (select module_status_keys()) and c.key = p_value
      order by c.module_id nulls first limit 1),
    p_value);
$$;

create or replace function automation_change_status(p_run automation_runs, s jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_old   text;
  v_value text := s ->> 'value';
  v_label text;
  v_field text;
begin
  -- The module the run started in when its list has this status; else the
  -- module whose list does.
  select f.key into v_field
    from field_choices c join fields f on f.id = c.field_id
   where f.key in (select module_status_keys()) and c.key = v_value
   order by (f.module_id is not distinct from p_run.module_id) desc, (f.key = 'current_status') desc, f.key
   limit 1;
  if v_field is null then
    raise exception 'That status no longer exists.';
  end if;
  v_label := automation_status_label(v_value);
  select r.values ->> v_field into v_old from records r where r.id = p_run.record_id for update;
  if v_old is not distinct from v_value then
    return automation_outcome('done', 'Status was already ' || v_label || '.');
  end if;
  update records set values = jsonb_set(values, array[v_field], to_jsonb(v_value), true), updated_at = now() where id = p_run.record_id;
  perform automation_log(p_run, 'Changed Current Status to ' || v_label || '.', 'field', null, false, v_field, v_old, v_value);
  return automation_outcome('done', 'Changed Current Status to ' || v_label || '.');
end;
$$;

create or replace function automation_capture_field()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_person text;
  v_module uuid;
  v_field  text;
  v_old    jsonb;
  v_new    jsonb;
  v_value  jsonb;
begin
  if not exists (select 1 from automation_triggers where kind in ('status', 'field')) then return null; end if;
  if current_setting('tapdash.automation', true) = 'on' or new.deleted_at is not null then return null; end if;
  v_person := automation_person();
  if v_person is null then return null; end if;
  v_module := automation_page_module();

  for v_field in
    select k from module_status_keys() k where exists (select 1 from automation_triggers where kind = 'status')
    union
    select match ->> 'field' from automation_triggers where kind = 'field'
  loop
    v_old := automation_field_value(old.values, old.deal_name, v_field);
    v_new := automation_field_value(new.values, new.deal_name, v_field);
    continue when v_old is not distinct from v_new;
    v_value := case when jsonb_typeof(v_new) in ('array', 'object') then v_new else to_jsonb(v_new #>> '{}') end;
    if v_field in (select module_status_keys()) then
      perform automation_fire('status', new.id, v_module, jsonb_build_object('value', v_value), automation_person_id(v_person));
    end if;
    perform automation_fire('field', new.id, v_module, jsonb_build_object('field', v_field, 'value', v_value), automation_person_id(v_person));
  end loop;
  return null;
end;
$$;

-- Status is: any module's status on the record.
CREATE OR REPLACE FUNCTION public.automation_condition(p_c jsonb, p_record uuid, p_module uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
      return exists (select 1 from records r, module_status_keys() k where r.id = p_record and r.values ->> k = p_c ->> 'value');
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
$function$
;

-- "All fields filled" on a tab: a module's status is not one of them, or a record
-- could never pass until every other module had set one too.
create or replace function automation_all_filled(p_record uuid, p_tab uuid, p_subtab uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(bool_and(automation_field_filled(p_record, f.key::text)), false)
    from fields f
   where f.archived_at is null
     and f.module_id is null
     and f.tab_id = p_tab
     and (p_subtab is null or f.subtab_id = p_subtab)
     and not exists (select 1 from pipelines p where p.status_field_id = f.id);
$$;
