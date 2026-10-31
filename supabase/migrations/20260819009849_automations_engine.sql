-- =============================================================================
-- Automations: running them.
--
-- An action and its history commit together, because both happen here. Each step
-- runs under an exception block, so a step that fails is rolled back alone, the
-- run stops, and what earlier steps did stands (spec: "the automation stops for
-- that record and no further steps run").
--
-- Sending an email is the one step that leaves the database: the run parks as
-- `sending`, the app renders and queues the message, and `done`/`fail` in the
-- sender report back through `automation_mail_result`.
-- =============================================================================

/* "Today" for a date condition: the business's day, not the server's. */
create or replace function automation_today()
returns date
language sql
stable
set search_path = public, pg_temp
as $$
  select (now() at time zone 'America/New_York')::date;
$$;

create or replace function automation_blank(v jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select case jsonb_typeof(v)
    when 'string' then btrim(v #>> '{}') = ''
    when 'array'  then not exists (select 1 from jsonb_array_elements(v) e where not automation_blank(e))
    when 'object' then not exists (select 1 from jsonb_each(v) e where not automation_blank(e.value))
    when 'null'   then true
    when 'number' then false
    when 'boolean' then false
    else true
  end;
$$;

create or replace function automation_field_filled(p_record uuid, p_field text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_values jsonb;
  v_deal   text;
  v_type   text;
begin
  select r.values, r.deal_name into v_values, v_deal from records r where r.id = p_record;
  if position('.' in p_field) = 0 then
    select f.type::text into v_type from fields f where f.key = p_field::citext and f.archived_at is null;
  end if;
  if v_type = 'file' then
    return exists (select 1 from file_rows fr join files fl on fl.file_row_id = fr.id
                    where fr.record_id = p_record and fr.field_key = p_field::citext
                      and fr.deleted_at is null and fl.deleted_at is null);
  end if;
  return not automation_blank(automation_field_value(v_values, v_deal, p_field));
end;
$$;

/* A preset row of the Files tab: at least one file on it (spec). A row added with
   "Add another file row" is not locked, so it can never match. */
create or replace function automation_file_row_filled(p_record uuid, p_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from file_rows fr join files fl on fl.file_row_id = fr.id
                  where fr.record_id = p_record and fr.kind = 'application' and fr.locked
                    and fr.name = p_name and fr.deleted_at is null and fl.deleted_at is null);
$$;

/* Every field on a tab or sub-tab. A repeat group counts as one field, or a tab
   made only of groups would always read as filled; the pipeline's synced Status
   field is not a field anyone fills in. Nothing to fill is not filled. */
create or replace function automation_all_filled(p_record uuid, p_tab uuid, p_subtab uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(bool_and(automation_field_filled(p_record, f.key::text)), false)
    from fields f
   where f.archived_at is null
     and f.tab_id = p_tab
     and (p_subtab is null or f.subtab_id = p_subtab)
     and not exists (select 1 from pipelines p where p.status_field_id = f.id);
$$;

create or replace function automation_date_value(p_record uuid, p_field text)
returns date
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v text;
begin
  select r.values ->> p_field into v from records r where r.id = p_record;
  if v is null or v !~ '^\d{4}-\d{2}-\d{2}' then return null; end if;
  return left(v, 10)::date;
exception when others then
  return null;
end;
$$;

create or replace function automation_condition(p_c jsonb, p_record uuid, p_module uuid)
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
    else
      raise exception 'Unknown condition %', p_c ->> 'type';
  end case;
end;
$$;

/* Brackets, one level deep: inside a group `join`, between groups the outer `join`. */
create or replace function automation_conditions_met(p_conditions jsonb, p_record uuid, p_module uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_outer  text := coalesce(p_conditions ->> 'join', 'and');
  v_result boolean;
  v_group  boolean;
  v_this   boolean;
  g        jsonb;
  c        jsonb;
begin
  for g in select * from jsonb_array_elements(coalesce(p_conditions -> 'groups', '[]'::jsonb)) loop
    v_group := null;
    for c in select * from jsonb_array_elements(coalesce(g -> 'conditions', '[]'::jsonb)) loop
      v_this := coalesce(automation_condition(c, p_record, p_module), false);
      v_group := case when v_group is null then v_this
                      when coalesce(g ->> 'join', 'and') = 'or' then v_group or v_this
                      else v_group and v_this end;
    end loop;
    continue when v_group is null;
    v_result := case when v_result is null then v_group
                     when v_outer = 'or' then v_result or v_group
                     else v_result and v_group end;
  end loop;
  return coalesce(v_result, true);
end;
$$;

-- ── history ──────────────────────────────────────────────────────────────────
/* The one writer of an automation's history: an Updates entry shown as done by
   the automation, and the activity row. Spec: every action is recorded. */
create or replace function automation_log(
  p_run          automation_runs,
  p_summary      text,
  p_kind         activity_kind default 'automation',
  p_team         uuid default null,
  p_names_person boolean default false,
  p_field        text default null,
  p_from         text default null,
  p_to           text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into updates (record_id, author_id, body, automation_id, automation_name, team_id, names_person)
  values (p_run.record_id, null, p_summary, p_run.automation_id, p_run.automation_name, p_team, p_names_person);
  insert into record_activity (record_id, actor_id, kind, field_key, summary, from_value, to_value, source, team_id, names_person)
  values (p_run.record_id, null, p_kind, p_field, p_summary, p_from, p_to, 'Automation: ' || p_run.automation_name, p_team, p_names_person);
end;
$$;

create or replace function automation_step_log(p_run automation_runs, p_step jsonb, p_outcome text, p_detail text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into automation_run_steps (run_id, position, step_id, step_type, outcome, detail)
  values (p_run.id, p_run.position, p_step ->> 'id', coalesce(p_step ->> 'type', 'step'), p_outcome, p_detail);
$$;

/* Spec: the admin who built it gets an alert. If they have left, every admin
   does, so a failure is never told to nobody. */
create or replace function automation_alert(p_run automation_runs, p_body text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_to uuid;
begin
  for v_to in
    select p.id from automations a join profiles p on p.id = a.created_by
     where a.id = p_run.automation_id and p.deleted_at is null and p.status = 'active'
    union
    select p.id from profiles p join roles ro on ro.id = p.role_id
     where ro.is_admin and p.deleted_at is null and p.status = 'active'
       and not exists (select 1 from automations a join profiles b on b.id = a.created_by
                        where a.id = p_run.automation_id and b.deleted_at is null and b.status = 'active')
  loop
    insert into notifications (recipient_id, actor_id, body, record_id, source_kind, automation_run_id, preview)
    values (v_to, null, p_body, p_run.record_id, 'automation_alert', p_run.id, p_run.automation_name);
  end loop;
  update automation_runs set alerted_at = now() where id = p_run.id;
end;
$$;

create or replace function automation_stop_run(p_run automation_runs, p_status text, p_step jsonb, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform automation_step_log(p_run, p_step, case p_status when 'skipped' then 'skipped' else 'failed' end, p_reason);
  update automation_runs
     set status = p_status, reason = p_reason, finished_at = now(), resume_at = null, lease_until = null
   where id = p_run.id;
  perform automation_alert(p_run, '“' || p_run.automation_name || '” stopped on ' || coalesce(p_run.record_label, 'a record') || ': ' || p_reason);
end;
$$;

-- ── actions ──────────────────────────────────────────────────────────────────
create or replace function automation_outcome(p_outcome text, p_detail text)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_build_object('outcome', p_outcome, 'detail', p_detail);
$$;

create or replace function automation_status_label(p_value text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select c.value from field_choices c join fields f on f.id = c.field_id
      where f.key = 'current_status' and c.key = p_value
      order by c.module_id nulls first limit 1),
    p_value);
$$;

create or replace function automation_change_status(p_run automation_runs, s jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old   text;
  v_value text := s ->> 'value';
  v_label text := automation_status_label(v_value);
begin
  select r.values ->> 'current_status' into v_old from records r where r.id = p_run.record_id for update;
  if v_old is not distinct from v_value then
    return automation_outcome('done', 'Status was already ' || v_label || '.');
  end if;
  update records set values = jsonb_set(values, '{current_status}', to_jsonb(v_value), true), updated_at = now() where id = p_run.record_id;
  perform automation_log(p_run, 'Changed Current Status to ' || v_label || '.', 'field', null, false, 'current_status', v_old, v_value);
  return automation_outcome('done', 'Changed Current Status to ' || v_label || '.');
end;
$$;

/* Spec: skipped when the record isn't on a pipeline in that module. A stage
   belongs to one pipeline and that to one module, so the event's module, when
   there is one, has to be that module. */
create or replace function automation_change_stage(p_run automation_runs, s jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_step_id uuid := (s ->> 'stepId')::uuid;
  v_step    text;
  v_pipe    uuid;
  v_pipe_l  text;
  v_module  uuid;
  v_mod_l   text;
  v_on_pipe uuid;
  v_on_step uuid;
begin
  select st.label, p.id, p.label, p.module_id, m.label into v_step, v_pipe, v_pipe_l, v_module, v_mod_l
    from pipeline_steps st join pipelines p on p.id = st.pipeline_id join modules m on m.id = p.module_id
   where st.id = v_step_id;
  if v_step is null then
    raise exception 'That pipeline stage no longer exists.';
  end if;

  if p_run.module_id is not null and p_run.module_id <> v_module then
    return automation_outcome('skipped', 'This happened in another module, and ' || v_step || ' is on ' || v_pipe_l || ' in ' || v_mod_l || '.');
  end if;
  select rp.pipeline_id, rp.step_id into v_on_pipe, v_on_step from record_pipelines rp
   where rp.record_id = p_run.record_id and rp.module_id = v_module for update;
  if v_on_pipe is distinct from v_pipe
     or not exists (select 1 from record_modules rm where rm.record_id = p_run.record_id and rm.module_id = v_module) then
    return automation_outcome('skipped', 'The record isn''t on ' || v_pipe_l || ' in ' || v_mod_l || '.');
  end if;
  if v_on_step = v_step_id then
    return automation_outcome('done', 'Stage was already ' || v_step || '.');
  end if;

  update record_pipelines set step_id = v_step_id, updated_at = now()
   where record_id = p_run.record_id and module_id = v_module;
  perform automation_log(p_run, 'Moved to ' || v_step || ' on ' || v_pipe_l || '.', 'pipeline', null, false, null, null, v_step);
  return automation_outcome('done', 'Moved to ' || v_step || ' on ' || v_pipe_l || '.');
end;
$$;

/* The team rules, with nobody's permission asked (spec: full access). A team that
   is already on the record is what the step wanted, so it carries on. */
create or replace function automation_assign_team(p_run automation_runs, s jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_team uuid := (s ->> 'teamId')::uuid;
begin
  if not exists (select 1 from permission_templates where id = v_team and user_type is not null) then
    raise exception 'That team no longer exists.';
  end if;
  perform team_lock_record(p_run.record_id);
  insert into record_team_assignments (record_id, team_id) values (p_run.record_id, v_team)
  on conflict (record_id, team_id) do nothing;
  if not found then
    return automation_outcome('done', team_name(v_team) || ' was already assigned.');
  end if;
  perform automation_log(p_run, 'Assigned the ' || team_name(v_team) || ' team.', 'assignment', v_team, false);
  return automation_outcome('done', 'Assigned the ' || team_name(v_team) || ' team.');
end;
$$;

create or replace function automation_assign_person(p_run automation_runs, p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_team  uuid := user_team(p_user);
  v_name  text := team_person_name(p_user);
  v_ids   jsonb;
  v_taker uuid;
begin
  if not exists (select 1 from profiles where id = p_user and status = 'active' and deleted_at is null) then
    return automation_outcome('skipped', coalesce(v_name, 'That person') || ' is not an active user.');
  end if;
  v_ids := team_lock_record(p_run.record_id);
  if v_ids ? p_user::text then
    return automation_outcome('done', v_name || ' was already assigned.');
  end if;
  if v_team is not null then
    select taken_by into v_taker from record_team_assignments where record_id = p_run.record_id and team_id = v_team;
    if v_taker is not null then
      return automation_outcome('skipped', team_name(v_team) || ' is already taken on this record.');
    end if;
    insert into record_team_assignments (record_id, team_id, taken_by, taken_at)
    values (p_run.record_id, v_team, p_user, now())
    on conflict (record_id, team_id) do update set taken_by = excluded.taken_by, taken_at = excluded.taken_at;
  end if;
  perform team_write_field(p_run.record_id, v_ids || to_jsonb(p_user::text));
  perform automation_log(p_run,
    'Assigned ' || v_name || case when v_team is not null then ' from the ' || team_name(v_team) || ' team' else '' end || '.',
    'assignment', v_team, true);
  return automation_outcome('done', 'Assigned ' || v_name || '.');
end;
$$;

/* Last name, or the only name there is. The whole name and id settle a tie, so
   the order never depends on the database's mood. */
create or replace function automation_rotation_key(p_name text, p_id uuid)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select lower(regexp_replace(btrim(p_name), '^.*\s', '')) || ' ' || lower(btrim(p_name)) || ' ' || p_id::text;
$$;

create or replace function automation_rotation_pool(p_teams uuid[], p_users uuid[])
returns table (user_id uuid, sort_key text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, automation_rotation_key(coalesce(nullif(btrim(p.full_name), ''), p.email::text), p.id)
    from profiles p
   where p.status = 'active' and p.deleted_at is null
     and (p.id = any (p_users) or user_team(p.id) = any (p_teams));
$$;

create or replace function automation_round_robin(p_run automation_runs, s jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_teams uuid[] := array(select x::uuid from jsonb_array_elements_text(coalesce(s -> 'teamIds', '[]'::jsonb)) x);
  v_users uuid[] := array(select x::uuid from jsonb_array_elements_text(coalesce(s -> 'userIds', '[]'::jsonb)) x);
  v_last  text;
  v_next  uuid;
  v_key   text;
  v_out   jsonb;
begin
  insert into automation_rotations (automation_id, step_id) values (p_run.automation_id, s ->> 'id')
  on conflict (automation_id, step_id) do nothing;
  select last_key into v_last from automation_rotations
   where automation_id = p_run.automation_id and step_id = s ->> 'id' for update;

  select x.user_id, x.sort_key into v_next, v_key from automation_rotation_pool(v_teams, v_users) x
   where v_last is null or x.sort_key collate "C" > v_last collate "C"
   order by x.sort_key collate "C" limit 1;
  if v_next is null then
    select x.user_id, x.sort_key into v_next, v_key from automation_rotation_pool(v_teams, v_users) x
     order by x.sort_key collate "C" limit 1;
  end if;
  if v_next is null then
    return automation_outcome('skipped', 'Nobody active is in the rotation.');
  end if;

  v_out := automation_assign_person(p_run, v_next);
  if v_out ->> 'outcome' = 'done' then
    update automation_rotations set last_key = v_key, updated_at = now()
     where automation_id = p_run.automation_id and step_id = s ->> 'id';
  end if;
  return v_out;
end;
$$;

/* Spec: if someone from that team took the record, they are removed too. */
create or replace function automation_remove_team(p_run automation_runs, s jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_team uuid := (s ->> 'teamId')::uuid;
  v_ids  jsonb;
  v_next jsonb;
begin
  v_ids := team_lock_record(p_run.record_id);
  delete from record_team_assignments where record_id = p_run.record_id and team_id = v_team;
  if not found then
    return automation_outcome('done', team_name(v_team) || ' was not assigned.');
  end if;
  select coalesce(jsonb_agg(x.id order by x.ord), '[]'::jsonb) into v_next
    from jsonb_array_elements_text(v_ids) with ordinality as x(id, ord)
   where user_team(x.id::uuid) is distinct from v_team;
  if v_next <> v_ids then perform team_write_field(p_run.record_id, v_next); end if;
  perform automation_log(p_run, 'Removed the ' || team_name(v_team) || ' team.', 'assignment', v_team, false);
  return automation_outcome('done', 'Removed the ' || team_name(v_team) || ' team.');
end;
$$;

create or replace function automation_add_module(p_run automation_runs, s jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_module uuid := (s ->> 'moduleId')::uuid;
  v_label  text;
begin
  select m.label into v_label from modules m where m.id = v_module and m.kind = 'display' and not m.shows_open_cases;
  if v_label is null then raise exception 'That module can''t take records this way.'; end if;
  insert into record_modules (record_id, module_id) values (p_run.record_id, v_module)
  on conflict (record_id, module_id) do nothing;
  if not found then
    return automation_outcome('done', 'Already in ' || v_label || '.');
  end if;
  perform automation_log(p_run, 'Added to ' || v_label || '.', 'membership');
  return automation_outcome('done', 'Added to ' || v_label || '.');
end;
$$;

/* Taking a record out of its last module archives it, as it does by hand. */
create or replace function automation_remove_module(p_run automation_runs, s jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_module uuid := (s ->> 'moduleId')::uuid;
  v_label  text;
begin
  select m.label into v_label from modules m where m.id = v_module and m.kind = 'display' and not m.shows_open_cases;
  if v_label is null then raise exception 'That module can''t lose records this way.'; end if;
  delete from record_modules where record_id = p_run.record_id and module_id = v_module;
  if not found then
    return automation_outcome('done', 'Was not in ' || v_label || '.');
  end if;
  perform automation_log(p_run,
    case when exists (select 1 from record_modules where record_id = p_run.record_id)
         then 'Removed from ' || v_label || '.'
         else 'Removed from ' || v_label || '. Archived — no longer displayed in any module.' end,
    'membership');
  return automation_outcome('done', 'Removed from ' || v_label || '.');
end;
$$;

/* A ticket needs someone to run it: the people on the record, or failing that
   whoever built the automation, or failing that an admin. */
create or replace function automation_create_ticket(p_run automation_runs, s jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_issue    text := btrim(s ->> 'issue');
  v_title    text := coalesce(nullif(btrim(s ->> 'title'), ''), left(btrim(s ->> 'issue'), 80));
  v_case     uuid;
  v_managers uuid[];
begin
  if coalesce(v_issue, '') = '' then raise exception 'A ticket needs an Issue.'; end if;

  select array_agg(p.id) into v_managers
    from records r
    cross join lateral jsonb_array_elements_text(coalesce(r.values -> 'team_members_assigned', '[]'::jsonb)) x(id)
    join profiles p on p.id = x.id::uuid and p.status = 'active' and p.deleted_at is null
   where r.id = p_run.record_id;
  if v_managers is null then
    select array[p.id] into v_managers from automations a join profiles p on p.id = a.created_by
     where a.id = p_run.automation_id and p.status = 'active' and p.deleted_at is null;
  end if;
  if v_managers is null then
    select array[p.id] into v_managers from profiles p join roles ro on ro.id = p.role_id
     where ro.is_admin and p.status = 'active' and p.deleted_at is null order by p.created_at limit 1;
  end if;

  insert into cases (record_id, title, issue, issue_author, automation_id, automation_name)
  values (p_run.record_id, v_title, v_issue, null, p_run.automation_id, p_run.automation_name)
  returning id into v_case;
  insert into case_managers (case_id, user_id) select v_case, m from unnest(v_managers) m on conflict do nothing;
  perform automation_log(p_run, 'Opened a ticket: ' || v_title, 'case');
  return automation_outcome('done', 'Opened a ticket: ' || v_title);
end;
$$;

/* In-CRM only. Nobody to tell is a skip, like any action with nothing to act on. */
create or replace function automation_send_notification(p_run automation_runs, s jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_who  text := s ->> 'who';
  v_team uuid := nullif(s ->> 'teamId', '')::uuid;
  v_to   uuid[];
  v_body text := coalesce(nullif(btrim(s ->> 'message'), ''), '“' || p_run.automation_name || '” ran on ' || coalesce(p_run.record_label, 'a record') || '.');
  v_n    int := 0;
  u      uuid;
begin
  if v_who = 'team' then
    if not exists (select 1 from record_team_assignments a where a.record_id = p_run.record_id and a.team_id = v_team) then
      return automation_outcome('skipped', team_name(v_team) || ' is not assigned to this record.');
    end if;
    select array_agg(p.id) into v_to from profiles p
     where user_team(p.id) = v_team and p.status = 'active' and p.deleted_at is null;
  else
    select array_agg(p.id) into v_to
      from records r
      cross join lateral jsonb_array_elements_text(
        case when jsonb_typeof(r.values -> (case v_who when 'relationship_manager' then 'relationship_manager' else 'team_members_assigned' end)) = 'array'
             then r.values -> (case v_who when 'relationship_manager' then 'relationship_manager' else 'team_members_assigned' end)
             else '[]'::jsonb end) x(id)
      join profiles p on p.id = x.id::uuid and p.status = 'active' and p.deleted_at is null
     where r.id = p_run.record_id;
  end if;

  if v_to is null then
    return automation_outcome('skipped', 'Nobody to notify on this record.');
  end if;
  foreach u in array v_to loop
    continue when exists (select 1 from notification_mutes m where m.user_id = u and m.record_id = p_run.record_id);
    insert into notifications (recipient_id, actor_id, body, record_id, source_kind, automation_run_id, preview)
    values (u, null, v_body, p_run.record_id, 'automation', p_run.id, p_run.automation_name);
    v_n := v_n + 1;
  end loop;
  perform automation_log(p_run, 'Sent a notification to ' || v_n || case when v_n = 1 then ' person.' else ' people.' end);
  return automation_outcome('done', 'Notified ' || v_n || case when v_n = 1 then ' person.' else ' people.' end);
end;
$$;

create or replace function automation_act(p_run automation_runs, s jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  case s ->> 'type'
    when 'change_status'     then return automation_change_status(p_run, s);
    when 'change_stage'      then return automation_change_stage(p_run, s);
    when 'assign_team'       then return automation_assign_team(p_run, s);
    when 'assign_user'       then return automation_assign_person(p_run, (s ->> 'userId')::uuid);
    when 'round_robin'       then return automation_round_robin(p_run, s);
    when 'remove_team'       then return automation_remove_team(p_run, s);
    when 'add_module'        then return automation_add_module(p_run, s);
    when 'remove_module'     then return automation_remove_module(p_run, s);
    when 'create_ticket'     then return automation_create_ticket(p_run, s);
    when 'send_notification' then return automation_send_notification(p_run, s);
    else raise exception 'Unknown action %', s ->> 'type';
  end case;
end;
$$;

-- ── running ──────────────────────────────────────────────────────────────────
create or replace function automation_wait_label(s jsonb)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select (s ->> 'amount') || ' ' || case when (s ->> 'amount')::int = 1 then rtrim(s ->> 'unit', 's') else s ->> 'unit' end;
$$;

/* As far as this run can go now. Spec: a wait does not re-check conditions, and
   a skip or failure ends it. */
create or replace function automation_advance(p_run uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r     automation_runs;
  v_flow jsonb;
  s     jsonb;
  v_out jsonb;
begin
  select * into r from automation_runs where id = p_run for update skip locked;
  if not found or r.status not in ('running', 'waiting') then return; end if;

  if not exists (select 1 from records where id = r.record_id and deleted_at is null) then
    update automation_runs set status = 'cancelled', reason = 'The record was deleted.', finished_at = now(), resume_at = null where id = r.id;
    return;
  end if;

  select v.steps -> 'flow' into v_flow from automation_versions v where v.id = r.version_id;

  loop
    s := v_flow -> r.position;
    if s is null then
      update automation_runs set status = 'completed', finished_at = now(), resume_at = null where id = r.id;
      return;
    end if;

    if s ->> 'type' = 'wait' then
      if r.resume_at is null then
        update automation_runs
           set status = 'waiting',
               resume_at = now() + case s ->> 'unit' when 'days' then make_interval(days => (s ->> 'amount')::int) else make_interval(hours => (s ->> 'amount')::int) end
         where id = r.id;
        perform automation_step_log(r, s, 'waiting', 'Waiting ' || automation_wait_label(s) || '.');
        return;
      end if;
      perform automation_step_log(r, s, 'done', 'Waited ' || automation_wait_label(s) || '.');
      r.resume_at := null;
      r.position := r.position + 1;
      update automation_runs set status = 'running', resume_at = null, position = r.position where id = r.id;
      continue;
    end if;

    if s ->> 'type' = 'send_email' then
      update automation_runs set status = 'sending', lease_until = null where id = r.id;
      return;
    end if;

    begin
      v_out := automation_act(r, s);
    exception when others then
      perform automation_stop_run(r, 'failed', s, sqlerrm);
      return;
    end;

    if v_out ->> 'outcome' = 'skipped' then
      perform automation_stop_run(r, 'skipped', s, v_out ->> 'detail');
      return;
    end if;

    perform automation_step_log(r, s, 'done', v_out ->> 'detail');
    r.position := r.position + 1;
    update automation_runs set status = 'running', position = r.position where id = r.id;
  end loop;
end;
$$;

/* Spec: conditions are checked once, here. */
create or replace function automation_start(q automation_queue)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a        automations;
  v_steps  jsonb;
  v_label  text;
  v_id     uuid;
  v_met    boolean;
  v_status text := 'running';
  v_reason text;
begin
  select * into a from automations where id = q.automation_id;
  if a.deleted_at is not null or a.status not in ('test', 'on') then return null; end if;
  select v.steps into v_steps from automation_versions v where v.id = q.version_id;

  if q.record_id is null then
    v_status := 'not_matched';
    v_reason := coalesce(q.note, 'No single record for this event.');
  else
    select r.deal_name into v_label from records r where r.id = q.record_id and r.deleted_at is null;
    if not found then return null; end if;
    if exists (select 1 from automation_runs x where x.automation_id = a.id and x.record_id = q.record_id
                and x.status in ('running', 'waiting', 'sending')) then
      v_status := 'not_matched';
      v_reason := 'Already running on this record.';
    else
      v_met := automation_conditions_met(v_steps -> 'conditions', q.record_id, q.module_id);
      if not v_met then
        v_status := 'not_matched';
        v_reason := 'Conditions not met.';
      end if;
    end if;
  end if;

  insert into automation_runs (automation_id, version_id, automation_name, record_id, record_label, trigger_id, trigger_kind,
                               module_id, actor_id, status, reason, finished_at)
  values (a.id, q.version_id, a.name, q.record_id, v_label, q.trigger_id, q.trigger_kind, q.module_id, q.actor_id,
          v_status, v_reason, case when v_status = 'running' then null else now() end)
  returning id into v_id;
  return v_id;
end;
$$;

/* One pass: start what was queued, carry on what is due, and hand back the emails
   the app has to render. Called by the tick on the service role, so no change
   made here can look like a person's. The switch below is the second lock on
   that door. */
create or replace function automation_work(p_limit int default 25)
returns table (run_id uuid, record_id uuid, automation_id uuid, automation_name text, module_id uuid, step jsonb, did int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  q      automation_queue;
  v_run  uuid;
  v_did  int := 0;
  o      record;
begin
  perform set_config('tapdash.automation', 'on', true);

  for q in select * from automation_queue x where x.done_at is null order by x.occurred_at limit p_limit for update skip locked loop
    begin
      perform automation_start(q);
    exception when others then
      raise warning 'automation_start %: %', q.id, sqlerrm;
    end;
    update automation_queue x set done_at = now() where x.id = q.id;
    v_did := v_did + 1;
  end loop;

  -- A send whose report never arrived: the row knows how it ended.
  for o in
    select m.id, m.status, m.last_error from mail_outbox m
      join automation_runs r on r.id = m.automation_run_id
     where r.status = 'sending' and m.status in ('sent', 'failed', 'cancelled')
       and m.automation_step_id = (select v.steps -> 'flow' -> r.position ->> 'id' from automation_versions v where v.id = r.version_id)
     limit p_limit
  loop
    perform automation_mail_result(o.id, o.status = 'sent', o.last_error);
    v_did := v_did + 1;
  end loop;

  for v_run in
    select r.id from automation_runs r
     where r.status = 'running' or (r.status = 'waiting' and r.resume_at <= now())
     order by r.started_at limit p_limit
  loop
    begin
      perform automation_advance(v_run);
    exception when others then
      raise warning 'automation_advance %: %', v_run, sqlerrm;
      update automation_runs r set status = 'failed', reason = sqlerrm, finished_at = now() where r.id = v_run;
    end;
    v_did := v_did + 1;
  end loop;

  return query
  with due as (
    select r.id from automation_runs r
     where r.status = 'sending'
       and (r.lease_until is null or r.lease_until < now())
       and not exists (select 1 from mail_outbox m where m.automation_run_id = r.id
                        and m.automation_step_id = (select v.steps -> 'flow' -> r.position ->> 'id' from automation_versions v where v.id = r.version_id))
     order by r.started_at limit p_limit
     for update skip locked
  ), leased as (
    update automation_runs r set lease_until = now() + interval '5 minutes' from due where r.id = due.id
    returning r.id, r.record_id, r.automation_id, r.automation_name, r.module_id, r.version_id, r.position
  )
  select l.id, l.record_id, l.automation_id, l.automation_name, l.module_id,
         (select v.steps -> 'flow' -> l.position from automation_versions v where v.id = l.version_id), v_did
    from leased l;

  if not found and v_did > 0 then
    return query select null::uuid, null::uuid, null::uuid, null::text, null::uuid, null::jsonb, v_did;
  end if;
end;
$$;

-- ── the email step ───────────────────────────────────────────────────────────
/* Whose sign-in sends from this inbox. Full access (spec): it need not be anyone
   connected with the automation. */
create or replace function automation_mail_sender(p_mailbox uuid)
returns table (user_id uuid, identity_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.user_id, c.identity_id
    from mail_connections c
    join mail_mailboxes m on m.id = c.mailbox_id
   where c.mailbox_id = p_mailbox and c.disconnected_at is null and c.status in ('ok', 'degraded')
     and m.deleted_at is null and m.deactivated_at is null
   order by (c.status = 'ok') desc, (c.identity_id = m.sync_identity_id) desc, c.connected_at
   limit 1;
$$;

/* A new message, never a reply (spec), released at once: nobody is there to undo
   it. Idempotent per run and step, so a crash and a retry send one email. */
create or replace function automation_mail_enqueue(p_run uuid, p_mailbox uuid, p_subject text, p_body text, p_to jsonb, p_attachments jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r       automation_runs;
  v_step  text;
  v_user  uuid;
  v_ident uuid;
  v_id    uuid;
begin
  select * into r from automation_runs where id = p_run;
  if not found or r.status <> 'sending' then raise exception 'That run is not sending.'; end if;
  select v.steps -> 'flow' -> r.position ->> 'id' into v_step from automation_versions v where v.id = r.version_id;
  select s.user_id, s.identity_id into v_user, v_ident from automation_mail_sender(p_mailbox) s;
  if v_user is null then raise exception 'That inbox has no working connection.'; end if;

  insert into mail_outbox (idempotency_key, mailbox_id, user_id, identity_id, kind, subject, body_html, to_recipients,
                           attachments, status, release_at, automation_run_id, automation_step_id, record_id)
  values (md5(p_run::text || ':' || v_step)::uuid, p_mailbox, v_user, v_ident, 'new', left(p_subject, 255), p_body, p_to,
          coalesce(p_attachments, '[]'::jsonb), 'held', now(), p_run, v_step, r.record_id)
  on conflict (idempotency_key) do update set updated_at = now()
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function automation_mail_result(p_outbox uuid, p_ok boolean, p_error text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o mail_outbox;
  r automation_runs;
  s jsonb;
  v_to text;
begin
  select * into o from mail_outbox where id = p_outbox;
  if o.automation_run_id is null then return; end if;
  select * into r from automation_runs where id = o.automation_run_id for update;
  if not found or r.status <> 'sending' then return; end if;
  select v.steps -> 'flow' -> r.position into s from automation_versions v where v.id = r.version_id;
  if s ->> 'id' is distinct from o.automation_step_id then return; end if;

  if not p_ok then
    perform automation_stop_run(r, 'failed', s, 'The email didn''t send. ' || coalesce(p_error, ''));
    return;
  end if;

  select string_agg(x ->> 'address', ', ') into v_to from jsonb_array_elements(o.to_recipients) x;
  perform set_config('tapdash.automation', 'on', true);
  perform automation_log(r, 'Sent the email “' || coalesce(o.subject, '') || '” to ' || coalesce(v_to, 'its recipients') || '.');
  perform automation_step_log(r, s, 'done', 'Sent “' || coalesce(o.subject, '') || '” to ' || coalesce(v_to, 'its recipients') || '.');
  update automation_runs set status = 'running', position = position + 1, lease_until = null where id = r.id;
end;
$$;

/* The app couldn't build the email: no recipient, a missing file, too large. */
create or replace function automation_mail_stop(p_run uuid, p_status text, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r automation_runs;
  s jsonb;
begin
  if p_status not in ('skipped', 'failed') then raise exception 'bad status'; end if;
  select * into r from automation_runs where id = p_run for update;
  if not found or r.status <> 'sending' then return; end if;
  select v.steps -> 'flow' -> r.position into s from automation_versions v where v.id = r.version_id;
  perform automation_stop_run(r, p_status, s, p_reason);
end;
$$;

-- ── status, versions ─────────────────────────────────────────────────────────
create or replace function automation_trigger_match(t jsonb)
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
    else '{}'::jsonb
  end;
$$;

create or replace function automation_refresh_triggers(p_automation uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from automation_triggers where automation_id = p_automation;
  insert into automation_triggers (automation_id, trigger_id, version_id, kind, match, only_record, active_from)
  select a.id, t ->> 'id', v.id, t ->> 'type', automation_trigger_match(t),
         case when a.status = 'test' then a.test_record_id end, a.activated_at
    from automations a
    join automation_versions v on v.id = a.current_version_id
    cross join lateral jsonb_array_elements(v.steps -> 'triggers') t
   where a.id = p_automation and a.status in ('test', 'on') and a.deleted_at is null;
end;
$$;

/* Going live sets the moment events start counting. Leaving (Off, Draft, or
   Test on another record) ends what was waiting: spec, Off is "not running". */
create or replace function automation_set_status(p_automation uuid, p_status text, p_test_record uuid, p_actor uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a     automations;
  v_end int := 0;
begin
  select * into a from automations where id = p_automation and deleted_at is null for update;
  if not found then raise exception 'That automation no longer exists.'; end if;
  if p_status not in ('draft', 'test', 'on', 'off') then raise exception 'bad status'; end if;

  update automations
     set status = p_status,
         test_record_id = case when p_status = 'test' then p_test_record else test_record_id end,
         activated_at = case
           when p_status not in ('test', 'on') then activated_at
           when a.status <> p_status or a.test_record_id is distinct from p_test_record then now()
           else activated_at end,
         updated_by = p_actor, updated_at = now()
   where id = p_automation;

  update automation_runs r
     set status = 'cancelled', finished_at = now(), resume_at = null,
         reason = case when p_status = 'test' then 'Automation moved to Test on another record.' else 'Automation switched off.' end
   where r.automation_id = p_automation
     and r.status in ('running', 'waiting', 'sending')
     and (p_status in ('off', 'draft') or (p_status = 'test' and r.record_id is distinct from p_test_record));
  get diagnostics v_end = row_count;

  perform automation_refresh_triggers(p_automation);
  return v_end;
end;
$$;

/* Records partway through a wait, moved to the new version. A step keeps its id
   across saves, so a run carries on after the step it stopped at; if that step
   was deleted, from the same place in the list. */
create or replace function automation_move_runs(p_automation uuid, p_version uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r      record;
  v_new  jsonb;
  v_pos  int;
  v_n    int := 0;
begin
  select steps -> 'flow' into v_new from automation_versions where id = p_version;
  for r in
    select x.id, x.position, v.steps -> 'flow' -> x.position ->> 'id' as step_id
      from automation_runs x join automation_versions v on v.id = x.version_id
     where x.automation_id = p_automation and x.status = 'waiting'
  loop
    select (e.ord - 1)::int into v_pos from jsonb_array_elements(v_new) with ordinality e(step, ord)
     where e.step ->> 'id' = r.step_id;
    update automation_runs
       set version_id = p_version, position = coalesce(v_pos, least(r.position, greatest(jsonb_array_length(v_new) - 1, 0)))
     where id = r.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

create or replace function automation_delete(p_automation uuid, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform automation_set_status(p_automation, 'off', null, p_actor);
  update automations set deleted_at = now(), updated_by = p_actor, updated_at = now() where id = p_automation;
  perform automation_refresh_triggers(p_automation);
end;
$$;

create or replace function automation_prune()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from automation_queue where done_at < now() - interval '7 days';
  delete from automation_runs where status = 'not_matched' and started_at < now() - interval '30 days';
end;
$$;

do $do$
declare
  v_fn regprocedure;
begin
  for v_fn in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'automation\_%' and p.prosecdef
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
  end loop;
end;
$do$;

grant execute on function automation_work(int) to service_role;
grant execute on function automation_mail_sender(uuid) to service_role;
grant execute on function automation_mail_enqueue(uuid, uuid, text, text, jsonb, jsonb) to service_role;
grant execute on function automation_mail_result(uuid, boolean, text) to service_role;
grant execute on function automation_mail_stop(uuid, text, text) to service_role;
grant execute on function automation_refresh_triggers(uuid) to service_role;
grant execute on function automation_set_status(uuid, text, uuid, uuid) to service_role;
grant execute on function automation_move_runs(uuid, uuid) to service_role;
grant execute on function automation_delete(uuid, uuid) to service_role;
grant execute on function automation_prune() to service_role;
