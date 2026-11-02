-- =============================================================================
-- Automations: what two independent reviews of the code found.
--
--   A record that is an automation's Test record could not be purged.
--   A "new value" trigger on a multi-select field never fired.
--   Saving On over On moved "switched on", losing events in between.
--   An email report for a purged record could stop every tick.
--   A run that failed to start vanished with no history and no alert.
--   Off left an already queued email to go out.
--   A step's Updates entry could show the value of a field the viewer can't see.
--   A deleted team or status wrote a null detail, or a key nothing can show.
--   Asking "which record?" revealed that a record the writer can't see shared
--   the address.
-- =============================================================================

-- ── a field the viewer can't see ─────────────────────────────────────────────
alter table updates add column if not exists automation_field citext;

drop policy if exists updates_select on updates;
create policy updates_select on updates for select using (
  record_visible(record_id)
  and tab_visible(record_id, 'updates')
  and (field_key is null or record_field_grant(record_id, field_key::text) <> 'hidden')
  and (automation_field is null or record_field_grant(record_id, automation_field::text) <> 'hidden')
  and (automation_name is not null or (author_id = (select auth.uid())) or update_visible_to((select auth.uid()), id))
  and (team_id is null or author_id = (select auth.uid()) or team_log_visible((select auth.uid()), team_id, names_person))
);

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
declare
  v_at timestamptz := clock_timestamp();
begin
  insert into updates (record_id, author_id, body, automation_id, automation_name, automation_field, team_id, names_person, created_at)
  values (p_run.record_id, null, p_summary, p_run.automation_id, p_run.automation_name, p_field, p_team, p_names_person, v_at);
  insert into record_activity (record_id, actor_id, kind, field_key, summary, from_value, to_value, source, team_id, names_person, at)
  values (p_run.record_id, null, p_kind, p_field, p_summary, p_from, p_to, 'Automation: ' || p_run.automation_name, p_team, p_names_person, v_at);
end;
$$;

-- ── a multi-select holds an array; the trigger names one choice ──────────────
create or replace function automation_fire(
  p_kind    text,
  p_record  uuid,
  p_module  uuid,
  p_event   jsonb,
  p_actor   uuid,
  p_at      timestamptz default now(),
  p_dedupe  text default null,
  p_note    text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if current_setting('tapdash.automation', true) = 'on' then return; end if;

  insert into automation_queue (automation_id, version_id, trigger_id, trigger_kind, record_id, module_id, actor_id, note, occurred_at, dedupe_key)
  select t.automation_id, t.version_id, t.trigger_id, t.kind, p_record, p_module, p_actor, p_note, p_at,
         coalesce(p_record::text, 'none') || ':' || coalesce(p_dedupe, txid_current()::text)
    from automation_triggers t
   where t.kind = p_kind
     and p_event @> (t.match - 'value')
     and (not (t.match ? 'value')
          or p_event -> 'value' = t.match -> 'value'
          or (jsonb_typeof(p_event -> 'value') = 'array' and p_event -> 'value' ? (t.match ->> 'value')))
     and (t.only_record is null or t.only_record = p_record)
     and p_at >= t.active_from
  on conflict (automation_id, dedupe_key) do nothing;
end;
$$;

-- ── a Test record that goes away ─────────────────────────────────────────────
/* The foreign key would blank `test_record_id` while status is Test, which the
   check refuses, and the purge would fail. With nothing to test on, it goes Off. */
create or replace function automation_release_test_record()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  for v_id in select id from automations where test_record_id = old.id and status = 'test' loop
    perform automation_set_status(v_id, 'off', null, null);
  end loop;
  return old;
end;
$$;

create trigger automation_release_test_record
  before delete on records
  for each row execute function automation_release_test_record();

/* A Test automation with no record must never read as "every record". */
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
   where a.id = p_automation and a.status in ('test', 'on') and a.deleted_at is null
     and (a.status <> 'test' or a.test_record_id is not null);
end;
$$;

/* Only really going live moves `activated_at`. Whatever a run was waiting to send
   stops with it. */
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
           when a.status <> p_status or (p_status = 'test' and a.test_record_id is distinct from p_test_record) then now()
           else activated_at end,
         updated_by = p_actor, updated_at = now()
   where id = p_automation;

  update mail_outbox m
     set status = 'cancelled', cancelled_at = now(), updated_at = now()
    from automation_runs r
   where m.automation_run_id = r.id
     and m.status = 'held'
     and r.automation_id = p_automation
     and r.status = 'sending'
     and (p_status in ('off', 'draft') or (p_status = 'test' and r.record_id is distinct from p_test_record));

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

-- ── actions on something deleted since ───────────────────────────────────────
create or replace function automation_change_status(p_run automation_runs, s jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old   text;
  v_value text := s ->> 'value';
  v_label text;
begin
  if not exists (select 1 from field_choices c join fields f on f.id = c.field_id
                  where f.key = 'current_status' and c.key = v_value) then
    raise exception 'That status no longer exists.';
  end if;
  v_label := automation_status_label(v_value);
  select r.values ->> 'current_status' into v_old from records r where r.id = p_run.record_id for update;
  if v_old is not distinct from v_value then
    return automation_outcome('done', 'Status was already ' || v_label || '.');
  end if;
  update records set values = jsonb_set(values, '{current_status}', to_jsonb(v_value), true), updated_at = now() where id = p_run.record_id;
  perform automation_log(p_run, 'Changed Current Status to ' || v_label || '.', 'field', null, false, 'current_status', v_old, v_value);
  return automation_outcome('done', 'Changed Current Status to ' || v_label || '.');
end;
$$;

create or replace function automation_act(p_run automation_runs, s jsonb)
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
/* The step's history is inside its exception block, so an action and its record
   stand or fall together. */
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
      if v_out ->> 'outcome' <> 'skipped' then
        perform automation_step_log(r, s, 'done', v_out ->> 'detail');
      end if;
    exception when others then
      perform automation_stop_run(r, 'failed', s, sqlerrm);
      return;
    end;

    if v_out ->> 'outcome' = 'skipped' then
      perform automation_stop_run(r, 'skipped', s, v_out ->> 'detail');
      return;
    end if;

    r.position := r.position + 1;
    update automation_runs set status = 'running', position = r.position where id = r.id;
  end loop;
end;
$$;

/* Takes a share lock so an Off can't commit between this read and the run. An
   event from before it last went live, or for a record it no longer tests on,
   doesn't start it. */
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
  select * into a from automations where id = q.automation_id for share;
  if a.deleted_at is not null or a.status not in ('test', 'on') then return null; end if;
  if q.occurred_at < a.activated_at then return null; end if;
  if a.status = 'test' and q.record_id is distinct from a.test_record_id then return null; end if;
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

/* A record purged while its email was out has nothing left to log against. */
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

  if r.record_id is null then
    update automation_runs set status = 'cancelled', reason = 'The record was deleted.', finished_at = now(), resume_at = null, lease_until = null where id = r.id;
    return;
  end if;

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

/* Nothing fails silently: a run that can't start or carry on leaves a failed row
   and an alert. One bad row never stops the rest of the tick. */
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
  v_row  automation_runs;
begin
  perform set_config('tapdash.automation', 'on', true);

  for q in select * from automation_queue x where x.done_at is null order by x.occurred_at limit p_limit for update skip locked loop
    begin
      perform automation_start(q);
    exception when others then
      declare
        v_msg text := sqlerrm;
      begin
        insert into automation_runs (automation_id, version_id, automation_name, record_id, record_label, trigger_id, trigger_kind,
                                     module_id, actor_id, status, reason, finished_at)
        select q.automation_id, q.version_id, a.name, q.record_id, (select r.deal_name from records r where r.id = q.record_id),
               q.trigger_id, q.trigger_kind, q.module_id, q.actor_id, 'failed', v_msg, now()
          from automations a where a.id = q.automation_id
        returning * into v_row;
        perform automation_alert(v_row, '“' || v_row.automation_name || '” could not start: ' || v_msg);
      exception when others then
        raise warning 'automation_start %: %', q.id, sqlerrm;
      end;
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
    begin
      perform automation_mail_result(o.id, o.status = 'sent', o.last_error);
    exception when others then
      raise warning 'automation_mail_result %: %', o.id, sqlerrm;
      update automation_runs r set status = 'failed', reason = sqlerrm, finished_at = now(), lease_until = null
        from mail_outbox m where m.id = o.id and r.id = m.automation_run_id;
    end;
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
      declare
        v_msg text := sqlerrm;
      begin
        select * into v_row from automation_runs r where r.id = v_run;
        perform automation_stop_run(v_row, 'failed', '{"type": "run"}'::jsonb, v_msg);
      exception when others then
        raise warning 'automation_advance %: %', v_run, sqlerrm;
        update automation_runs r set status = 'failed', reason = v_msg, finished_at = now() where r.id = v_run;
      end;
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

/* Locks each run first: a tick resuming the same run must not be overwritten
   with a position read before it moved on. */
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
       for update of x
  loop
    select (e.ord - 1)::int into v_pos from jsonb_array_elements(v_new) with ordinality e(step, ord)
     where e.step ->> 'id' = r.step_id;
    update automation_runs
       set version_id = p_version, position = coalesce(v_pos, least(r.position, greatest(jsonb_array_length(v_new) - 1, 0)))
     where id = r.id and status = 'waiting';
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- ── the main record ──────────────────────────────────────────────────────────
/* The records this person can see, for each address. What they can't see isn't
   counted, so the answer says nothing about it. */
create or replace function mail_record_choices(p_addresses text[], p_mailbox uuid default null, p_conversation text default null)
returns table (address text, record_id uuid, deal_name text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select distinct e.email::text, r.id, r.deal_name
    from record_contact_emails e
    join records r on r.id = e.record_id and r.deleted_at is null
   where e.email = any (p_addresses::citext[])
     and record_visible(r.id)
     and not exists (select 1 from mail_record_links l
                      where l.mailbox_id = p_mailbox and l.conversation_id = p_conversation)
   order by 1, 3;
$$;

/* A short undo window can let the message go first. The row is still what the
   sync reads, so the choice counts whatever its status. */
create or replace function mail_set_main_record(p_outbox uuid, p_record uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not record_visible(p_record) then raise exception 'not found'; end if;
  update mail_outbox set record_id = p_record, updated_at = now()
   where id = p_outbox and user_id = auth.uid();
  if not found then raise exception 'not found'; end if;
end;
$$;

revoke all on function automation_release_test_record() from public, anon, authenticated;
