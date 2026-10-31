-- =============================================================================
-- Automations: noticing what people do.
--
-- Each write path gets a trigger that asks one question first: does a live
-- automation listen for this? With none switched on, that is a lookup on an
-- empty table. A capture only queues the event; running it happens elsewhere.
--
-- The rules this file holds:
--   Future events only   A trigger row exists only while Test or On, and carries
--                        the moment it went live.
--   People only          A signed-in viewer, or a merchant through an application.
--                        A migration or a system job has neither.
--   No chaining          Everything an automation does runs with
--                        `tapdash.automation` on, and `automation_fire` stops there.
-- =============================================================================

/* The module the person was in. The app sends the page on every request from a
   signed-in session; `tapdash.page` is how a test says the same thing. */
create or replace function automation_page_module()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_page text := nullif(current_setting('tapdash.page', true), '');
begin
  if v_page is null then
    begin
      v_page := nullif(current_setting('request.headers', true), '')::json ->> 'x-tapdash-page';
    exception when others then
      return null;
    end;
  end if;
  if v_page is null then return null; end if;
  return (select m.id from modules m where m.slug = split_part(ltrim(v_page, '/'), '/', 1) and m.kind = 'display');
end;
$$;

/* Who a change belongs to: a user id, 'merchant', or null for no person at all. */
create or replace function automation_person()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(auth.uid()::text, nullif(current_setting('tapdash.event_actor', true), ''));
$$;

create or replace function automation_person_id(p_person text)
returns uuid
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when p_person ~ '^[0-9a-f-]{36}$' then p_person::uuid end;
$$;

/* Queues the event for every live automation listening for it. Two triggers of
   one automation hit by one change start it once. */
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
     and p_event @> t.match
     and (t.only_record is null or t.only_record = p_record)
     and p_at >= t.active_from
  on conflict (automation_id, dedupe_key) do nothing;
end;
$$;

-- A member of a repeat group is addressed as `group.member`.
create or replace function automation_member_values(p_group jsonb, p_member text)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(e -> p_member), '[]'::jsonb)
    from jsonb_array_elements(case when jsonb_typeof(p_group) = 'array' then p_group else '[]'::jsonb end) e;
$$;

create or replace function automation_field_value(p_values jsonb, p_deal_name text, p_field text)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_field = 'deal_name' then to_jsonb(p_deal_name)
    when position('.' in p_field) > 0 then automation_member_values(p_values -> split_part(p_field, '.', 1), split_part(p_field, '.', 2))
    else p_values -> p_field
  end;
$$;

-- ── fields, and Current Status ───────────────────────────────────────────────
create or replace function automation_capture_field()
returns trigger
language plpgsql
security definer
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
    select distinct case kind when 'status' then 'current_status' else match ->> 'field' end
      from automation_triggers where kind in ('status', 'field')
  loop
    v_old := automation_field_value(old.values, old.deal_name, v_field);
    v_new := automation_field_value(new.values, new.deal_name, v_field);
    continue when v_old is not distinct from v_new;
    v_value := case when jsonb_typeof(v_new) in ('array', 'object') then v_new else to_jsonb(v_new #>> '{}') end;
    if v_field = 'current_status' then
      perform automation_fire('status', new.id, v_module, jsonb_build_object('value', v_value), automation_person_id(v_person));
    end if;
    perform automation_fire('field', new.id, v_module, jsonb_build_object('field', v_field, 'value', v_value), automation_person_id(v_person));
  end loop;
  return null;
end;
$$;

create trigger automation_capture_field
  after update of values, deal_name on records
  for each row
  when (old.values is distinct from new.values or old.deal_name is distinct from new.deal_name)
  execute function automation_capture_field();

-- ── pipeline stage ───────────────────────────────────────────────────────────
create or replace function automation_capture_stage()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not exists (select 1 from automation_triggers where kind = 'stage') then return null; end if;
  if tg_op = 'UPDATE' and old.step_id = new.step_id and old.pipeline_id = new.pipeline_id then return null; end if;
  perform automation_fire('stage', new.record_id, new.module_id,
                          jsonb_build_object('pipeline', new.pipeline_id, 'step', new.step_id), auth.uid());
  return null;
end;
$$;

create trigger automation_capture_stage
  after insert or update of step_id, pipeline_id on record_pipelines
  for each row execute function automation_capture_stage();

-- ── modules ──────────────────────────────────────────────────────────────────
create or replace function automation_capture_module()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record uuid := coalesce(new.record_id, old.record_id);
  v_module uuid := coalesce(new.module_id, old.module_id);
  v_kind   text := case tg_op when 'INSERT' then 'module_assigned' else 'module_removed' end;
begin
  if auth.uid() is null or not exists (select 1 from automation_triggers where kind = v_kind) then return null; end if;
  if not exists (select 1 from records where id = v_record and deleted_at is null) then return null; end if;
  perform automation_fire(v_kind, v_record, v_module, jsonb_build_object('module', v_module), auth.uid());
  return null;
end;
$$;

create trigger automation_capture_module
  after insert or delete on record_modules
  for each row execute function automation_capture_module();

-- ── teams ────────────────────────────────────────────────────────────────────
/* A row appears when a team is assigned; taking one with Assign to me only fills
   `taken_by` on the row, so it never comes through here (spec). A row added only
   because the field already holds someone (a new record's creator) has no
   `assigned_by`: nobody assigned that team. */
create or replace function automation_capture_team()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record uuid := coalesce(new.record_id, old.record_id);
  v_team   uuid := coalesce(new.team_id, old.team_id);
  v_kind   text := case tg_op when 'INSERT' then 'team_assigned' else 'team_removed' end;
begin
  if auth.uid() is null or not exists (select 1 from automation_triggers where kind = v_kind) then return null; end if;
  if tg_op = 'INSERT' and new.assigned_by is null then return null; end if;
  if not exists (select 1 from records where id = v_record and deleted_at is null) then return null; end if;
  perform automation_fire(v_kind, v_record, automation_page_module(), jsonb_build_object('team', v_team), auth.uid());
  return null;
end;
$$;

create trigger automation_capture_team
  after insert or delete on record_team_assignments
  for each row execute function automation_capture_team();

-- ── contracts ────────────────────────────────────────────────────────────────
create or replace function automation_capture_agreement()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind text := case new.status::text when 'sent' then 'contract_sent' when 'completed' then 'contract_received' end;
begin
  if v_kind is null or old.status = new.status then return null; end if;
  perform automation_fire(v_kind, new.record_id, null, '{}'::jsonb, new.sent_by, now(), v_kind || ':' || new.id::text);
  return null;
end;
$$;

create trigger automation_capture_agreement
  after update of status on agreements
  for each row execute function automation_capture_agreement();

-- ── applications ─────────────────────────────────────────────────────────────
/* Sent is said by the app once delivery worked: a failed send deletes the row. */
create or replace function automation_application_sent(p_application uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
begin
  select ap.record_id, ap.sent_by into a from applications ap where ap.id = p_application;
  if a.record_id is not null then
    perform automation_fire('application_sent', a.record_id, null, '{}'::jsonb, a.sent_by);
  end if;
end;
$$;

/* Received fires where a return is recorded: a partly filled application only
   ever writes its draft columns, so it cannot arrive here. A return fires once.
   The values an application writes are a person's change too, so the writer says
   whose: the staff member deciding, or the merchant. */
do $do$
declare
  v_def text;
begin
  v_def := pg_get_functiondef('application_write_values(uuid, jsonb, jsonb, uuid[], text, uuid[], uuid, text, timestamptz)'::regprocedure);
  if position('tapdash.event_actor' in v_def) = 0 then
    v_def := regexp_replace(v_def, '\mbegin\M', $r$begin
  perform set_config('tapdash.event_actor', coalesce(p_actor::text, 'merchant'), true);$r$);
    execute v_def;
  end if;

  v_def := pg_get_functiondef('application_record_return(uuid, jsonb, jsonb, jsonb, text, uuid, timestamptz)'::regprocedure);
  if position('application_received' in v_def) = 0 then
    v_def := replace(v_def, 'return query select coalesce(cardinality(v_applied), 0), coalesce(v_pending, 0);',
      $r$perform automation_fire('application_received', a.record_id, null, '{}'::jsonb, p_actor, now(), 'application_received:' || p_application::text);

  return query select coalesce(cardinality(v_applied), 0), coalesce(v_pending, 0);$r$);
    execute v_def;
  end if;
end;
$do$;

-- ── emails ───────────────────────────────────────────────────────────────────
/* Main contact (the first of the Contacts group, the one the drawer marks
   Primary) and every owner. */
create or replace function record_contact_emails_sync()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE'
     and old.values -> 'contact' is not distinct from new.values -> 'contact'
     and old.values -> 'owner_ownership' is not distinct from new.values -> 'owner_ownership' then
    return null;
  end if;

  delete from record_contact_emails where record_id = new.id;
  insert into record_contact_emails (record_id, email, source)
  select new.id, lower(btrim(x.email)), x.source
    from (
      select new.values -> 'contact' -> 0 ->> 'email' as email, 'contact' as source
      union all
      select o ->> 'email', 'owner'
        from jsonb_array_elements(case when jsonb_typeof(new.values -> 'owner_ownership') = 'array' then new.values -> 'owner_ownership' else '[]'::jsonb end) o
    ) x
   where x.email like '%@%'
  on conflict do nothing;
  return null;
end;
$$;

create trigger records_contact_emails_sync
  after insert or update of values on records
  for each row execute function record_contact_emails_sync();

insert into record_contact_emails (record_id, email, source)
select r.id, lower(btrim(x.email)), x.source
  from records r
  cross join lateral (
    select r.values -> 'contact' -> 0 ->> 'email' as email, 'contact' as source
    union all
    select o ->> 'email', 'owner'
      from jsonb_array_elements(case when jsonb_typeof(r.values -> 'owner_ownership') = 'array' then r.values -> 'owner_ownership' else '[]'::jsonb end) o
  ) x
 where x.email like '%@%'
on conflict do nothing;

/* One email, one event, however many connected mailboxes it landed in. Mail
   older than a day, or stored while a mailbox was still seeding, is history and
   not an event. An email an automation sent is not a person's. */
create or replace function automation_capture_mail()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind    text := case new.direction when 'inbound' then 'email_received' else 'email_sent' end;
  v_at      timestamptz := coalesce(new.received_at, new.sent_at, now());
  v_key     text := 'mail:' || coalesce(new.internet_message_id, new.id::text);
  v_main    uuid;
  v_robot   boolean := false;
  v_address text;
  v_records uuid[];
  v_link    uuid;
begin
  if new.is_draft or new.deleted_at is not null then return null; end if;
  if tg_op = 'UPDATE' and not old.is_draft then return null; end if;
  if not exists (select 1 from automation_triggers where kind = v_kind) then return null; end if;
  if v_at < now() - interval '1 day' then return null; end if;
  if (select seeded_at from mail_mailboxes where id = new.mailbox_id) is null then return null; end if;

  if new.direction = 'outbound' and new.internet_message_id is not null then
    select o.automation_run_id is not null, o.record_id into v_robot, v_main
      from mail_outbox o
     where o.internet_message_id = new.internet_message_id
     order by o.created_at desc limit 1;
    if coalesce(v_robot, false) then return null; end if;
  end if;

  select l.record_id into v_link from mail_record_links l
   where l.mailbox_id = new.mailbox_id and l.conversation_id = new.conversation_id;

  if v_main is not null then
    if new.conversation_id is not null then
      insert into mail_record_links (mailbox_id, conversation_id, record_id)
      values (new.mailbox_id, new.conversation_id, v_main)
      on conflict (mailbox_id, conversation_id) do update set record_id = excluded.record_id, set_at = now();
    end if;
    perform automation_fire(v_kind, v_main, null, '{}'::jsonb, null, v_at, v_key);
    return null;
  end if;

  for v_address in
    select new.from_address::text where new.direction = 'inbound'
    union
    select r ->> 'address'
      from jsonb_array_elements(new.to_recipients || new.cc_recipients || new.bcc_recipients) r
     where new.direction = 'outbound'
  loop
    select coalesce(array_agg(distinct e.record_id), '{}') into v_records
      from record_contact_emails e
      join records rec on rec.id = e.record_id and rec.deleted_at is null
     where e.email = v_address::citext;

    if cardinality(v_records) = 1 then
      perform automation_fire(v_kind, v_records[1], null, '{}'::jsonb, null, v_at, v_key);
    elsif cardinality(v_records) > 1 then
      if v_link = any (v_records) then
        perform automation_fire(v_kind, v_link, null, '{}'::jsonb, null, v_at, v_key);
      else
        perform automation_fire(v_kind, null, null, '{}'::jsonb, null, v_at, v_key || ':' || v_address,
          v_address || ' belongs to ' || cardinality(v_records) || ' records and nobody has chosen the main one.');
      end if;
    end if;
  end loop;
  return null;
end;
$$;

create trigger automation_capture_mail
  after insert or update of is_draft on mail_messages
  for each row execute function automation_capture_mail();

revoke all on function automation_page_module() from public, anon, authenticated;
revoke all on function automation_person() from public, anon, authenticated;
revoke all on function automation_fire(text, uuid, uuid, jsonb, uuid, timestamptz, text, text) from public, anon, authenticated;
revoke all on function automation_application_sent(uuid) from public, anon, authenticated;
grant execute on function automation_application_sent(uuid) to service_role;
