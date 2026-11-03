-- =============================================================================
-- Ticket automations: the copy to the Communication tab used the wrong words.
--
-- `messages.direction` is the `message_direction` enum, 'in' / 'out'. Migration
-- 9893 wrote 'inbound' / 'outbound' into it, which Postgres refuses. Inside the
-- trigger on `mail_messages` that refusal would have stopped the mail sync from
-- storing an email from a client in a ticket inbox; inside the send report it
-- would have left a ticket flow's run stuck on Sending. Caught by the
-- integration tests before any ticket automation existed, so nothing was lost.
-- Both functions as in 9893 otherwise.
-- =============================================================================

create or replace function ticket_capture_mail()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_at      timestamptz := coalesce(new.received_at, new.sent_at, now());
  v_key     text := 'mail:' || coalesce(new.internet_message_id, new.id::text);
  v_records uuid[];
  v_link    uuid;
  v_to      text;
  r         record;
begin
  if new.is_draft or new.deleted_at is not null or new.direction <> 'inbound' then return null; end if;
  if tg_op = 'UPDATE' and not old.is_draft then return null; end if;
  if v_at < now() - interval '1 day' then return null; end if;
  if (select seeded_at from mail_mailboxes where id = new.mailbox_id) is null then return null; end if;
  if new.internet_message_id is not null
     and exists (select 1 from mail_outbox o where o.internet_message_id = new.internet_message_id) then
    return null;
  end if;

  select coalesce(array_agg(distinct e.record_id), '{}') into v_records
    from record_contact_emails e
    join records rec on rec.id = e.record_id and rec.deleted_at is null
   where e.email = new.from_address;

  -- A wait ends the flow when the client writes, in any connected inbox.
  for r in
    select x.* from automation_runs x join automations a on a.id = x.automation_id
     where a.kind = 'ticket' and x.status = 'waiting' and x.record_id = any (v_records)
       for update of x
  loop
    update automation_runs set status = 'cancelled', reason = 'Cancelled: client replied.', finished_at = now(), resume_at = null
     where id = r.id;
    insert into automation_run_steps (run_id, position, step_id, step_type, outcome, detail)
    values (r.id, r.position, null, 'wait', 'skipped', 'Cancelled: client replied.');
  end loop;

  -- A ticket inbox: the email is the record's.
  if cardinality(v_records) > 0 and ticket_inbox(new.mailbox_id) then
    select address into v_to from mail_mailboxes where id = new.mailbox_id;
    insert into messages (record_id, channel, direction, from_identity, to_identity, subject, body, external_id, sent_at)
    select rid, 'email', 'in', coalesce(new.from_address::text, ''), coalesce(v_to, ''), new.subject,
           left(coalesce(new.body_text, new.preview, ''), 50000), v_key || ':' || rid, v_at
      from unnest(v_records) rid
    on conflict (channel, external_id) do nothing;
  end if;

  if current_setting('tapdash.automation', true) = 'on' then return null; end if;
  if not exists (select 1 from automation_triggers where kind = 'ticket_email' and match ->> 'mailbox' = new.mailbox_id::text) then
    return null;
  end if;

  if cardinality(v_records) > 1 then
    select l.record_id into v_link from mail_record_links l
     where l.mailbox_id = new.mailbox_id and l.conversation_id = new.conversation_id and l.record_id = any (v_records);
  end if;

  insert into automation_queue (automation_id, version_id, trigger_id, trigger_kind, record_id, module_id, actor_id,
                                note, occurred_at, dedupe_key, mail_message_id)
  select t.automation_id, t.version_id, t.trigger_id, t.kind,
         case when cardinality(v_records) = 1 then v_records[1] else v_link end,
         null, null,
         case when cardinality(v_records) = 0 then 'The email from ' || coalesce(new.from_address::text, 'an unknown sender') || ' matches no record.'
              when cardinality(v_records) > 1 and v_link is null
                then new.from_address::text || ' belongs to ' || cardinality(v_records) || ' records and nobody has chosen the main one.'
         end,
         v_at, v_key, new.id
    from automation_triggers t
   where t.kind = 'ticket_email'
     and t.match ->> 'mailbox' = new.mailbox_id::text
     and (t.only_record is null or t.only_record = case when cardinality(v_records) = 1 then v_records[1] else v_link end)
     and v_at >= t.active_from
  on conflict (automation_id, dedupe_key) do nothing;
  return null;
end;
$$;

create or replace function automation_mail_result(p_outbox uuid, p_ok boolean, p_error text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o      mail_outbox;
  r      automation_runs;
  s      jsonb;
  v_to   text;
  v_from text;
  v_kind text;
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

  select a.kind into v_kind from automations a where a.id = r.automation_id;
  if v_kind = 'ticket' then
    select address into v_from from mail_mailboxes where id = o.mailbox_id;
    insert into messages (record_id, channel, direction, from_identity, to_identity, subject, body, external_id, sent_at)
    values (r.record_id, 'email', 'out', coalesce(v_from, ''), coalesce(v_to, ''), o.subject,
            left(btrim(regexp_replace(regexp_replace(coalesce(o.body_html, ''), '<br\s*/?>|</p>', E'\n', 'gi'), '<[^>]+>', '', 'g')), 50000),
            'outbox:' || o.id, coalesce(o.sent_at, now()))
    on conflict (channel, external_id) do nothing;
    if r.case_id is not null then
      perform case_log_write(r.case_id, 'Sent the email “' || coalesce(o.subject, '') || '” to ' || coalesce(v_to, 'its recipients') || '.',
                             null, r.automation_id, r.automation_name);
    end if;
  end if;
  update automation_runs set status = 'running', position = position + 1, lease_until = null where id = r.id;
end;
$$;

revoke all on function ticket_capture_mail() from public, anon, authenticated;
revoke all on function automation_mail_result(uuid, boolean, text) from public, anon, authenticated;
grant execute on function automation_mail_result(uuid, boolean, text) to service_role;
