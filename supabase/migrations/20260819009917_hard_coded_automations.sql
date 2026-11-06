-- Hard-coded automations (client, 6 Nov 2026: "Admin panel UI-UX changes").
--
-- The jobs the CRM runs by itself — not built in the Automations builder —
-- listed on their own tab, each with History, Status, Edit and Turn off, and
-- Delete once it is off. Turning one off stops it at its next step: every job
-- asks `system_automation_on(key)` before it does anything.
--
-- Also the job the client expected and the CRM never had: Last outreach and
-- Last merchant response fill themselves from the newest call, text or email
-- on the record (spec: "These fields work across phone and email taking the
-- absolute last item either of the two"). They stay editable by hand; a newer
-- communication moves them forward, never back.

create table public.system_automations (
  key           text primary key check (key ~ '^[a-z_]{2,40}$'),
  enabled       boolean not null default true,
  switched_by   uuid references public.profiles(id) on delete set null,
  switched_at   timestamptz,
  deleted_at    timestamptz,
  deleted_by    uuid references public.profiles(id) on delete set null,
  last_run_at   timestamptz,
  last_outcome  text check (last_outcome in ('ok', 'failed')),
  last_note     text check (char_length(last_note) <= 300),
  -- Delete is only offered once it is off, and a deleted one never runs.
  check (deleted_at is null or not enabled)
);

create table public.system_automation_events (
  id        bigint generated always as identity primary key,
  key       text not null references public.system_automations(key) on delete cascade,
  kind      text not null check (kind in ('ran', 'failed', 'turned_on', 'turned_off', 'deleted')),
  at        timestamptz not null default now(),
  actor_id  uuid references public.profiles(id) on delete set null,
  count     int check (count >= 0),
  note      text check (char_length(note) <= 300)
);
create index system_automation_events_key_at on public.system_automation_events (key, at desc);

-- Server-only: the Automations page reads these through the service role
-- after its own permission check. No browser policy at all.
alter table public.system_automations enable row level security;
alter table public.system_automations force row level security;
alter table public.system_automation_events enable row level security;
alter table public.system_automation_events force row level security;
revoke all on public.system_automations from anon, authenticated;
revoke all on public.system_automation_events from anon, authenticated;

insert into public.system_automations (key) values
  ('comm_dates'),
  ('mail_sync'),
  ('text_broadcasts'),
  ('maverick_sync'),
  ('agreement_downloads'),
  ('agreement_expiry'),
  ('agreement_reminders'),
  ('agreement_status_check'),
  ('notifications_cleanup'),
  ('upload_cleanup'),
  ('automation_history_cleanup')
on conflict (key) do nothing;

-- Unknown key = on: a job added in code before its row exists still runs.
create or replace function public.system_automation_on(p_key text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select enabled and deleted_at is null from system_automations where key = p_key), true);
$$;

-- One run's result. Every run moves "Last run"; only a run that did something,
-- or failed, becomes a History line (the per-minute jobs would bury it otherwise).
create or replace function public.system_automation_record(p_key text, p_ok boolean, p_count int, p_note text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update system_automations
     set last_run_at = now(),
         last_outcome = case when p_ok then 'ok' else 'failed' end,
         last_note = left(p_note, 300)
   where key = p_key;
  if not p_ok or coalesce(p_count, 0) > 0 then
    insert into system_automation_events (key, kind, count, note)
    values (p_key, case when p_ok then 'ran' else 'failed' end, greatest(coalesce(p_count, 0), 0), left(p_note, 300));
  end if;
  delete from system_automation_events where key = p_key and at < now() - interval '180 days';
end;
$$;

-- On / off / delete, with the History line in the same transaction.
create or replace function public.system_automation_set(p_key text, p_action text, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r system_automations;
begin
  select * into r from system_automations where key = p_key for update;
  if not found then raise exception 'unknown automation' using errcode = 'P0002'; end if;
  if r.deleted_at is not null then raise exception 'That automation was deleted.' using errcode = '42501'; end if;

  if p_action = 'turn_on' then
    if r.enabled then return; end if;
    update system_automations set enabled = true, switched_by = p_actor, switched_at = now() where key = p_key;
    insert into system_automation_events (key, kind, actor_id) values (p_key, 'turned_on', p_actor);
  elsif p_action = 'turn_off' then
    if not r.enabled then return; end if;
    update system_automations set enabled = false, switched_by = p_actor, switched_at = now() where key = p_key;
    insert into system_automation_events (key, kind, actor_id) values (p_key, 'turned_off', p_actor);
  elsif p_action = 'delete' then
    if r.enabled then raise exception 'Turn it off before deleting it.' using errcode = '42501'; end if;
    update system_automations set deleted_at = now(), deleted_by = p_actor where key = p_key;
    insert into system_automation_events (key, kind, actor_id) values (p_key, 'deleted', p_actor);
  else
    raise exception 'unknown action' using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.system_automation_on(text) from public, anon;
revoke all on function public.system_automation_record(text, boolean, int, text) from public, anon, authenticated;
revoke all on function public.system_automation_set(text, text, uuid) from public, anon, authenticated;
grant execute on function public.system_automation_on(text) to authenticated, service_role;
grant execute on function public.system_automation_record(text, boolean, int, text) to service_role;
grant execute on function public.system_automation_set(text, text, uuid) to service_role;

-- ── Last outreach / Last merchant response ─────────────────────────────
-- Inbound (the merchant called, texted or emailed) → Last merchant response;
-- outbound → Last outreach. The date is New York's, the CRM's business day.
-- A later date already there (typed by hand, say) is left alone. History is
-- written in the same transaction as the value, like every other value change.
create or replace function public.records_touch_comm_date(p_record uuid, p_inbound boolean, p_at timestamptz)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  k     text := case when p_inbound then 'last_merchant_response' else 'last_outreach' end;
  d     text;
  v_old text;
begin
  if p_record is null or p_at is null or p_at > now() + interval '1 day' then return; end if;
  if not system_automation_on('comm_dates') then return; end if;
  if not exists (select 1 from fields where key = k and archived_at is null) then return; end if;
  d := to_char(p_at at time zone 'America/New_York', 'YYYY-MM-DD');

  select r.values ->> k into v_old from records r where r.id = p_record and r.deleted_at is null for update;
  if not found then return; end if;
  if v_old is not null and v_old ~ '^\d{4}-\d{2}-\d{2}' and left(v_old, 10) >= d then return; end if;

  update records set values = jsonb_set(values, array[k], to_jsonb(d), true) where id = p_record;
  insert into record_activity (record_id, actor_id, kind, field_key, summary, from_value, to_value, source)
  values (p_record, null, 'field', k,
          case when p_inbound then 'Filled in from the latest message from the merchant' else 'Filled in from the latest outreach to the merchant' end,
          v_old, d, 'Communication');
  update system_automations set last_run_at = now(), last_outcome = 'ok', last_note = null where key = 'comm_dates';
end;
$$;
revoke all on function public.records_touch_comm_date(uuid, boolean, timestamptz) from public, anon, authenticated;

create or replace function public.tg_comm_date_phone()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.record_id is null or new.deleted_at is not null then return null; end if;
  if tg_op = 'UPDATE' and new.record_id is not distinct from old.record_id then return null; end if;
  perform records_touch_comm_date(
    new.record_id,
    new.direction = 'in',
    coalesce(case when tg_table_name = 'phone_calls' then (to_jsonb(new) ->> 'started_at')::timestamptz else (to_jsonb(new) ->> 'sent_at')::timestamptz end, new.created_at)
  );
  return null;
end;
$$;

create trigger phone_calls_comm_date after insert or update of record_id on public.phone_calls
  for each row execute function public.tg_comm_date_phone();
create trigger phone_messages_comm_date after insert or update of record_id on public.phone_messages
  for each row execute function public.tg_comm_date_phone();

create or replace function public.tg_comm_date_message()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.record_id is null then return null; end if;
  perform records_touch_comm_date(new.record_id, new.direction = 'in', coalesce(new.sent_at, new.created_at));
  return null;
end;
$$;
create trigger messages_comm_date after insert on public.messages
  for each row execute function public.tg_comm_date_message();

-- Email module: a conversation linked to a record (mail_record_links). A new
-- message in a linked conversation moves the date; so does linking one, from
-- its newest message each way.
create or replace function public.tg_comm_date_mail()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  l record;
begin
  if new.is_draft or new.deleted_at is not null or new.conversation_id is null then return null; end if;
  for l in
    select record_id from mail_record_links where mailbox_id = new.mailbox_id and conversation_id = new.conversation_id
  loop
    perform records_touch_comm_date(l.record_id, new.direction = 'inbound', coalesce(new.received_at, new.sent_at, new.created_at));
  end loop;
  return null;
end;
$$;
create trigger mail_messages_comm_date after insert on public.mail_messages
  for each row execute function public.tg_comm_date_mail();

create or replace function public.tg_comm_date_mail_link()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  m record;
begin
  for m in
    select distinct on (direction) direction, coalesce(received_at, sent_at, created_at) as at
      from mail_messages
     where mailbox_id = new.mailbox_id and conversation_id = new.conversation_id
       and not is_draft and deleted_at is null
     order by direction, coalesce(received_at, sent_at, created_at) desc
  loop
    perform records_touch_comm_date(new.record_id, m.direction = 'inbound', m.at);
  end loop;
  return null;
end;
$$;
create trigger mail_record_links_comm_date after insert on public.mail_record_links
  for each row execute function public.tg_comm_date_mail_link();

revoke all on function public.tg_comm_date_phone() from public, anon, authenticated;
revoke all on function public.tg_comm_date_message() from public, anon, authenticated;
revoke all on function public.tg_comm_date_mail() from public, anon, authenticated;
revoke all on function public.tg_comm_date_mail_link() from public, anon, authenticated;
