-- =============================================================================
-- Ticket Automation Flow Builder (client spec, 1 Nov 2026).
--
-- A ticket is a case: it has a number, a title, an Issue and an open/closed
-- state, and an open one places its record in the module flagged
-- `shows_open_cases`. Ticket automations are automations of a second kind, run
-- by the same engine (versions, waits, runs, alerts, Test, no chaining), with
-- their own triggers, conditions and actions:
--
--   Triggers    Awaiting client clicked on an open ticket · Email received in a
--               chosen inbox
--   Conditions  And ticket is open · And ticket is not open · Email connects to
--               a record
--   Actions     Send merchant an email · Close ticket · Notify user · Create a
--               team assignment · Open ticket · Clear Awaiting client
--
-- What is new around them:
--   cases.awaiting_client_*  the tag, set by people, cleared by people or a flow
--   case_log                 the ticket's log: every action a flow takes, and
--                            every click of the button, by name
--   ticket_choices           an email on a record with several open tickets,
--                            waiting up to 24 hours for someone to pick one
--   messages                 an email in a ticket inbox from a record's contact
--                            or owner, and a flow's sent email, are copied to the
--                            record's Communication tab
--   action.awaiting_client   yes/no permission, default Yes for every type
--
-- A run belongs to a ticket: `automation_runs.case_id`. One live run per
-- automation, record and ticket.
-- =============================================================================

-- ── the kind of automation ───────────────────────────────────────────────────
alter table automations add column if not exists kind text not null default 'record'
  check (kind in ('record', 'ticket'));
-- Test on one ticket. `test_record_id` stays the ticket's record, so the trigger
-- table keeps listening on that record only.
alter table automations add column if not exists test_case_id uuid references cases(id) on delete set null;

alter table automation_queue add column if not exists case_id uuid references cases(id) on delete set null;
alter table automation_queue add column if not exists mail_message_id uuid references mail_messages(id) on delete set null;

alter table automation_runs add column if not exists case_id uuid references cases(id) on delete set null;
alter table automation_runs add column if not exists case_label text;
alter table automation_runs add column if not exists mail_message_id uuid references mail_messages(id) on delete set null;

-- choosing: an email waits for a person to pick the ticket. expired: nobody did.
alter table automation_runs drop constraint if exists automation_runs_status_check;
alter table automation_runs add constraint automation_runs_status_check check (status in (
  'running', 'waiting', 'sending', 'choosing',
  'completed', 'skipped', 'failed',
  'not_matched', 'switched_off', 'cancelled', 'expired'));

drop index if exists automation_runs_one_active;
create unique index automation_runs_one_active
  on automation_runs (automation_id, record_id, coalesce(case_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status in ('running', 'waiting', 'sending', 'choosing');
create index if not exists automation_runs_by_case on automation_runs (case_id) where case_id is not null;

-- ── Awaiting client ──────────────────────────────────────────────────────────
alter table cases add column if not exists awaiting_client_at timestamptz;
alter table cases add column if not exists awaiting_client_by uuid references profiles(id) on delete set null;

-- ── the ticket's log ─────────────────────────────────────────────────────────
create table if not exists case_log (
  id               uuid primary key default gen_random_uuid(),
  case_id          uuid not null references cases(id) on delete cascade,
  record_id        uuid not null references records(id) on delete cascade,
  body             text not null,
  actor_id         uuid references profiles(id) on delete set null,
  automation_id    uuid references automations(id) on delete set null,
  automation_name  text,
  created_at       timestamptz not null default clock_timestamp()
);
create index if not exists case_log_case on case_log (case_id, created_at);

alter table case_log enable row level security;
alter table case_log force row level security;
drop policy if exists case_log_select on case_log;
-- The ticket's own rule: a log line is seen by whoever sees the ticket.
create policy case_log_select on case_log for select to authenticated
  using (exists (select 1 from cases c where c.id = case_log.case_id));
revoke all on case_log from anon, authenticated;
grant select on case_log to authenticated;

-- ── an email waiting for its ticket ──────────────────────────────────────────
create table if not exists ticket_choices (
  id               uuid primary key default gen_random_uuid(),
  run_id           uuid not null unique references automation_runs(id) on delete cascade,
  record_id        uuid not null references records(id) on delete cascade,
  automation_name  text not null,
  sender           text,
  subject          text,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default now() + interval '24 hours',
  chosen_case_id   uuid references cases(id) on delete set null,
  chosen_by        uuid references profiles(id) on delete set null,
  resolved_at      timestamptz
);
create index if not exists ticket_choices_open on ticket_choices (record_id) where resolved_at is null;
alter table ticket_choices enable row level security;
alter table ticket_choices force row level security;
-- No policy: read and answered through the functions below only.
revoke all on ticket_choices from anon, authenticated;

-- ── permission: Use Awaiting client ──────────────────────────────────────────
create or replace function public.permission_setting_valid(p_key text, p_value text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_key ~ '^action\.(create|team|archive|modules|pipeline|pipeline_change|team_view_open|team_take|mark_files_required|awaiting_client)$' then p_value in ('yes', 'no')
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
          'action.team_view_open', 'action.team_take', 'action.mark_files_required', 'action.awaiting_client',
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

-- Spec: "Default: Yes for every user type."
insert into permission_settings (owner_kind, owner_id, key, value)
select 'template', pt.id, 'action.awaiting_client', 'yes'
  from permission_templates pt
 where pt.user_type is not null
on conflict (owner_kind, owner_id, key) do nothing;

-- ── who may see a ticket, and who is asked to choose one ─────────────────────
/* The cases policy, as a question about the caller. */
create or replace function case_open_to_me(p_case uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from cases c
     where c.id = p_case and c.deleted_at is null
       and record_visible(c.record_id)
       and tab_visible(c.record_id, 'cases')
       and ((c.issue_author = auth.uid() and auth_perm('items.cases') <> 'hidden')
            or case_visible_to(auth.uid(), c.id)));
$$;

/* Spec, "Who is asked": the users assigned to the record's open tickets; if no
   one is assigned to any of them, every user who can open the record in the
   Tickets module. Only people with that module ever see it. */
create or replace function ticket_choice_for_me(p_record uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with mod as (
    select m.id from modules m
     where m.shows_open_cases
       and exists (select 1 from record_modules rm where rm.record_id = p_record and rm.module_id = m.id)
       and user_module_scope(auth.uid(), m.id) <> 'hidden'
  ), assigned as (
    select m.user_id
      from cases c join case_managers m on m.case_id = c.id
      join profiles p on p.id = m.user_id and p.status = 'active' and p.deleted_at is null
     where c.record_id = p_record and c.state = 'open' and c.deleted_at is null
  )
  select record_visible(p_record)
     and exists (select 1 from mod)
     and case when exists (select 1 from assigned)
              then exists (select 1 from assigned where user_id = auth.uid())
              else true end;
$$;

-- ── logging on the ticket ────────────────────────────────────────────────────
create or replace function case_log_write(p_case uuid, p_body text, p_actor uuid, p_automation uuid, p_automation_name text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into case_log (case_id, record_id, body, actor_id, automation_id, automation_name)
  select c.id, c.record_id, p_body, p_actor, p_automation, p_automation_name from cases c where c.id = p_case;
$$;

create or replace function case_label(p_case uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select '#' || c.number || ' ' || c.title from cases c where c.id = p_case;
$$;

-- ── Awaiting client: the button ──────────────────────────────────────────────
/* Spec: anyone who can open the ticket and has Use Awaiting client. Clicking an
   already tagged ticket does nothing and starts no flow. Clearing by hand is the
   same permission. Both are logged with the person's name. Returns whether
   anything changed. */
create or replace function set_awaiting_client(p_case uuid, p_on boolean)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c       cases;
  v_name  text;
  v_body  text;
  v_at    timestamptz := clock_timestamp();
begin
  if auth.uid() is null or not case_open_to_me(p_case) then raise exception 'not found'; end if;
  if not (auth_is_admin() or auth_perm('action.awaiting_client') = 'yes') then
    raise exception 'You don''t have permission to use Awaiting client.' using errcode = '42501';
  end if;

  select * into c from cases where id = p_case for update;
  if p_on then
    if c.state <> 'open' then raise exception 'Only an open ticket can be marked Awaiting client.' using errcode = '23514'; end if;
    if c.awaiting_client_at is not null then return false; end if;
    update cases set awaiting_client_at = v_at, awaiting_client_by = auth.uid() where id = p_case;
  else
    if c.awaiting_client_at is null then return false; end if;
    update cases set awaiting_client_at = null, awaiting_client_by = null where id = p_case;
  end if;

  select coalesce(nullif(btrim(full_name), ''), email::text) into v_name from profiles where id = auth.uid();
  v_body := case when p_on then 'Marked ticket #' || c.number || ' Awaiting client.'
                 else 'Cleared Awaiting client on ticket #' || c.number || '.' end;
  perform case_log_write(p_case, case when p_on then 'Marked Awaiting client.' else 'Cleared Awaiting client.' end, auth.uid(), null, null);
  perform record_log(c.record_id, auth.uid(), 'case', v_body);

  -- The trigger: a person's click on this ticket, and only this ticket.
  if p_on and current_setting('tapdash.automation', true) is distinct from 'on' then
    insert into automation_queue (automation_id, version_id, trigger_id, trigger_kind, record_id, module_id, actor_id,
                                  occurred_at, dedupe_key, case_id)
    select t.automation_id, t.version_id, t.trigger_id, t.kind, c.record_id, null, auth.uid(), v_at,
           'awaiting:' || p_case || ':' || txid_current(), p_case
      from automation_triggers t
     where t.kind = 'awaiting_client'
       and (t.only_record is null or t.only_record = c.record_id)
       and v_at >= t.active_from
    on conflict (automation_id, dedupe_key) do nothing;
  end if;
  return true;
end;
$$;

-- ── matching ─────────────────────────────────────────────────────────────────
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
    when 'ticket_email'    then jsonb_build_object('mailbox', t -> 'mailboxId')
    else '{}'::jsonb
  end;
$$;

/* An inbox chosen by any ticket automation that still exists, whatever its
   status: spec, "Every email in the inbox that matches a record is added to that
   record's Communication tab, whether or not any flow exists." */
create or replace function ticket_inbox(p_mailbox uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from automations a
      join automation_versions v on v.id = a.current_version_id
      cross join lateral jsonb_array_elements(coalesce(v.steps -> 'triggers', '[]'::jsonb)) t
     where a.kind = 'ticket' and a.deleted_at is null
       and t ->> 'type' = 'ticket_email' and t ->> 'mailboxId' = p_mailbox::text);
$$;

/* Email: the client replied, the Communication tab, and the trigger. One email
   is one event however many connected inboxes it reached. Mail the CRM sent
   itself is never a person's. */
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
    select rid, 'email', 'inbound', coalesce(new.from_address::text, ''), coalesce(v_to, ''), new.subject,
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

drop trigger if exists ticket_capture_mail on mail_messages;
create trigger ticket_capture_mail
  after insert or update of is_draft on mail_messages
  for each row execute function ticket_capture_mail();

-- ── conditions ───────────────────────────────────────────────────────────────
/* Checked once, when the flow starts. For an email, both ticket conditions look
   at all of the record's tickets; for the button, at the ticket clicked. */
create or replace function automation_ticket_condition(p_c jsonb, p_record uuid, p_case uuid, p_email boolean)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_open boolean;
begin
  if p_email then
    v_open := exists (select 1 from cases c where c.record_id = p_record and c.state = 'open' and c.deleted_at is null);
  else
    v_open := exists (select 1 from cases c where c.id = p_case and c.state = 'open' and c.deleted_at is null);
  end if;
  case p_c ->> 'type'
    when 'ticket_open'     then return v_open;
    when 'ticket_not_open' then return not v_open;
    when 'email_connects'  then return p_email and p_record is not null;
    else raise exception 'Unknown condition %', p_c ->> 'type';
  end case;
end;
$$;

create or replace function automation_ticket_conditions_met(p_conditions jsonb, p_record uuid, p_case uuid, p_email boolean)
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
      v_this := coalesce(automation_ticket_condition(c, p_record, p_case, p_email), false);
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

/* Spec, "Choosing a ticket": a step that uses the ticket. */
create or replace function automation_needs_ticket(p_steps jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from jsonb_array_elements(coalesce(p_steps -> 'flow', '[]'::jsonb)) s
     where s ->> 'type' in ('close_ticket', 'assign_team', 'clear_awaiting')
        or (s ->> 'type' = 'send_email'
            and coalesce(s ->> 'subject', '') || ' ' || coalesce(s ->> 'body', '') ~* '\{ticket (title|number)\}'));
$$;

create or replace function automation_has_condition(p_steps jsonb, p_type text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from jsonb_array_elements(coalesce(p_steps -> 'conditions' -> 'groups', '[]'::jsonb)) g
    cross join lateral jsonb_array_elements(coalesce(g -> 'conditions', '[]'::jsonb)) c
     where c ->> 'type' = p_type);
$$;

-- ── starting a run ───────────────────────────────────────────────────────────
create or replace function automation_start_ticket(q automation_queue, a automations)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_steps   jsonb;
  v_email   boolean := q.trigger_kind = 'ticket_email';
  v_label   text;
  v_case    uuid := q.case_id;
  v_status  text := 'running';
  v_reason  text;
  v_open    uuid[];
  v_id      uuid;
  m         mail_messages;
begin
  select v.steps into v_steps from automation_versions v where v.id = q.version_id;
  if a.status = 'test' then
    if q.record_id is distinct from a.test_record_id then return null; end if;
    if not v_email and q.case_id is distinct from a.test_case_id then return null; end if;
  end if;

  if q.record_id is null then
    v_status := 'not_matched';
    v_reason := coalesce(q.note, 'The email matches no record.');
  else
    select r.deal_name into v_label from records r where r.id = q.record_id and r.deleted_at is null;
    if not found then return null; end if;
    if exists (select 1 from automation_runs x where x.automation_id = a.id and x.record_id = q.record_id
                and x.status in ('running', 'waiting', 'sending', 'choosing')
                and (v_email or x.case_id is not distinct from q.case_id)) then
      v_status := 'not_matched';
      v_reason := case when v_email then 'Already running on this record.' else 'Already running on this ticket.' end;
    elsif not automation_ticket_conditions_met(v_steps -> 'conditions', q.record_id, q.case_id, v_email) then
      v_status := 'not_matched';
      v_reason := 'Conditions not met.';
    elsif v_email and automation_has_condition(v_steps, 'ticket_open') then
      select coalesce(array_agg(c.id order by c.created_at), '{}') into v_open
        from cases c where c.record_id = q.record_id and c.state = 'open' and c.deleted_at is null;
      if cardinality(v_open) = 1 then
        v_case := v_open[1];
      elsif cardinality(v_open) > 1 and automation_needs_ticket(v_steps) then
        v_status := 'choosing';
        v_reason := 'Waiting for someone to choose the ticket.';
      end if;
    end if;
  end if;

  insert into automation_runs (automation_id, version_id, automation_name, record_id, record_label, trigger_id, trigger_kind,
                               module_id, actor_id, status, reason, finished_at, case_id, case_label, mail_message_id)
  values (a.id, q.version_id, a.name, q.record_id, v_label, q.trigger_id, q.trigger_kind, q.module_id, q.actor_id,
          v_status, v_reason, case when v_status in ('running', 'choosing') then null else now() end,
          v_case, case_label(v_case), q.mail_message_id)
  returning id into v_id;

  if v_status = 'choosing' then
    select * into m from mail_messages where id = q.mail_message_id;
    insert into ticket_choices (run_id, record_id, automation_name, sender, subject)
    values (v_id, q.record_id, a.name, coalesce(nullif(btrim(m.from_name), ''), m.from_address::text), m.subject);
  end if;
  return v_id;
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
  if a.kind = 'ticket' then return automation_start_ticket(q, a); end if;
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

-- ── ticket actions ───────────────────────────────────────────────────────────
/* Title and Issue for Open ticket: {Email subject}, {Email body}, {Merchant
   name}, {Contact name}. */
create or replace function automation_ticket_text(p_run automation_runs, p_text text)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_values jsonb;
  v_deal   text;
  v_subj   text := '';
  v_body   text := '';
  v_first  jsonb;
begin
  select r.values, r.deal_name into v_values, v_deal from records r where r.id = p_run.record_id;
  if p_run.mail_message_id is not null then
    select coalesce(m.subject, ''), coalesce(m.body_text, m.preview, '') into v_subj, v_body from mail_messages m where m.id = p_run.mail_message_id;
  end if;
  v_first := case when jsonb_typeof(v_values -> 'contact') = 'array' then v_values -> 'contact' -> 0 else '{}'::jsonb end;
  return replace(replace(replace(replace(coalesce(p_text, ''),
    '{Email subject}', v_subj),
    '{Email body}', left(v_body, 4000)),
    '{Merchant name}', coalesce(nullif(btrim(v_values ->> 'dba'), ''), nullif(btrim(v_values ->> 'legal_business_name'), ''), v_deal, '')),
    '{Contact name}', coalesce(nullif(btrim(v_first ->> 'name'), ''),
                               nullif(btrim(concat_ws(' ', v_first ->> 'first', v_first ->> 'last')), ''), ''));
end;
$$;

create or replace function automation_close_ticket(p_run automation_runs, s jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c cases;
begin
  if p_run.case_id is null then return automation_outcome('skipped', 'There is no ticket to close.'); end if;
  select * into c from cases where id = p_run.case_id for update;
  if not found or c.deleted_at is not null then return automation_outcome('skipped', 'The ticket was deleted.'); end if;
  if c.state = 'closed' then return automation_outcome('skipped', 'Ticket #' || c.number || ' is already closed.'); end if;
  -- The reason is always "Closed by Automation". A Solution a person already
  -- wrote is theirs and stays.
  update cases
     set state = 'closed',
         solution = coalesce(nullif(btrim(solution), ''), 'Closed by Automation'),
         solution_at = case when nullif(btrim(solution), '') is null then now() else solution_at end
   where id = c.id;
  perform automation_log(p_run, 'Closed ticket #' || c.number || ': Closed by Automation.', 'case');
  return automation_outcome('done', 'Closed ticket #' || c.number || ': Closed by Automation.');
end;
$$;

create or replace function automation_open_ticket(p_run automation_runs, s jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_issue    text := btrim(automation_ticket_text(p_run, s ->> 'issue'));
  v_title    text := btrim(automation_ticket_text(p_run, s ->> 'title'));
  v_case     uuid;
  v_number   bigint;
  v_managers uuid[];
begin
  -- Spec: a second ticket is never created while one is open.
  if exists (select 1 from cases c where c.record_id = p_run.record_id and c.state = 'open' and c.deleted_at is null) then
    return automation_outcome('skipped', 'The record already has an open ticket.');
  end if;
  if coalesce(v_issue, '') = '' then raise exception 'A ticket needs an Issue.'; end if;
  v_title := left(coalesce(nullif(v_title, ''), v_issue), 200);

  select array_agg(p.id) into v_managers
    from records r
    cross join lateral jsonb_array_elements_text(
      case when jsonb_typeof(r.values -> 'team_members_assigned') = 'array' then r.values -> 'team_members_assigned' else '[]'::jsonb end) x(id)
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
  returning id, number into v_case, v_number;
  insert into case_managers (case_id, user_id) select v_case, m from unnest(coalesce(v_managers, '{}')) m on conflict do nothing;
  -- Later steps act on the new ticket.
  update automation_runs set case_id = v_case, case_label = case_label(v_case) where id = p_run.id;
  perform automation_log(p_run, 'Opened ticket #' || v_number || ': ' || v_title, 'case');
  return automation_outcome('done', 'Opened ticket #' || v_number || ': ' || v_title);
end;
$$;

create or replace function automation_clear_awaiting(p_run automation_runs, s jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c cases;
begin
  if p_run.case_id is null then return automation_outcome('skipped', 'There is no ticket to clear.'); end if;
  select * into c from cases where id = p_run.case_id for update;
  if not found or c.deleted_at is not null then return automation_outcome('skipped', 'The ticket was deleted.'); end if;
  if c.awaiting_client_at is null then
    return automation_outcome('skipped', 'Ticket #' || c.number || ' isn''t marked Awaiting client.');
  end if;
  update cases set awaiting_client_at = null, awaiting_client_by = null where id = c.id;
  perform automation_log(p_run, 'Cleared Awaiting client on ticket #' || c.number || '.', 'case');
  return automation_outcome('done', 'Cleared Awaiting client on ticket #' || c.number || '.');
end;
$$;

/* Create a team assignment: the team's assignment on the ticket's record, which
   is the ticket's row in the Tickets module. Open until someone on it takes it. */
create or replace function automation_ticket_assign_team(p_run automation_runs, s jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return automation_assign_team(p_run, s);
end;
$$;

/* In-CRM only. Nobody to tell is a skip, like any action with nothing to act on.
   Ticket flows may also name one user. */
create or replace function automation_send_notification(p_run automation_runs, s jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_who  text := s ->> 'who';
  v_team uuid := nullif(s ->> 'teamId', '')::uuid;
  v_user uuid := nullif(s ->> 'userId', '')::uuid;
  v_to   uuid[];
  v_body text := coalesce(nullif(btrim(s ->> 'message'), ''),
                          '“' || p_run.automation_name || '” ran on '
                          || coalesce(p_run.case_label || ' (' || coalesce(p_run.record_label, 'a record') || ')', p_run.record_label, 'a record') || '.');
  v_n    int := 0;
  u      uuid;
begin
  if v_who = 'team' then
    if not exists (select 1 from record_team_assignments a where a.record_id = p_run.record_id and a.team_id = v_team) then
      return automation_outcome('skipped', team_name(v_team) || ' is not assigned to this record.');
    end if;
    select array_agg(p.id) into v_to from profiles p
     where user_team(p.id) = v_team and p.status = 'active' and p.deleted_at is null;
  elsif v_who = 'user' then
    select array_agg(p.id) into v_to from profiles p where p.id = v_user and p.status = 'active' and p.deleted_at is null;
    if v_to is null then return automation_outcome('skipped', 'That user is no longer active.'); end if;
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
    insert into notifications (recipient_id, actor_id, body, record_id, source_kind, automation_run_id, preview, case_id)
    values (u, null, v_body, p_run.record_id, 'automation', p_run.id, p_run.automation_name, p_run.case_id);
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
    when 'close_ticket'       then return automation_close_ticket(p_run, s);
    when 'open_ticket'        then return automation_open_ticket(p_run, s);
    when 'clear_awaiting'     then return automation_clear_awaiting(p_run, s);
    else raise exception 'Unknown action %', s ->> 'type';
  end case;
end;
$$;

-- ── running ──────────────────────────────────────────────────────────────────
/* The step's history is inside its exception block, so an action and its record
   stand or fall together. A ticket's run also writes the ticket's log. */
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
  v_pos int;
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
        -- Open ticket gives the run its ticket: the log goes on that one.
        v_pos := r.position;
        select * into r from automation_runs where id = r.id;
        r.position := v_pos;
        if r.case_id is not null then
          perform case_log_write(r.case_id, v_out ->> 'detail', null, r.automation_id, r.automation_name);
        end if;
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

/* A ticket flow's email is the record's too: it goes on the Communication tab
   and the ticket's log. A record purged while its email was out has nothing
   left to log against. */
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
    values (r.record_id, 'email', 'outbound', coalesce(v_from, ''), coalesce(v_to, ''), o.subject,
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

/* Nothing fails silently: a run that can't start or carry on leaves a failed row
   and an alert. One bad row never stops the rest of the tick. An email nobody
   chose a ticket for in 24 hours expires. */
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

  for q in select * from automation_queue x where x.done_at is null and (x.not_before is null or x.not_before <= now())
            order by x.occurred_at limit p_limit for update skip locked loop
    begin
      perform automation_start(q);
    exception when others then
      declare
        v_msg text := sqlerrm;
      begin
        insert into automation_runs (automation_id, version_id, automation_name, record_id, record_label, trigger_id, trigger_kind,
                                     module_id, actor_id, status, reason, finished_at, case_id)
        select q.automation_id, q.version_id, a.name, q.record_id, (select r.deal_name from records r where r.id = q.record_id),
               q.trigger_id, q.trigger_kind, q.module_id, q.actor_id, 'failed', v_msg, now(), q.case_id
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

  -- Spec: nobody chose within 24 hours, so the flow doesn't run for that email.
  for v_row in
    select r.* from automation_runs r join ticket_choices c on c.run_id = r.id
     where r.status = 'choosing' and c.resolved_at is null and c.expires_at <= now()
     limit p_limit
       for update of r skip locked
  loop
    update automation_runs r set status = 'expired', reason = 'Expired: no ticket chosen.', finished_at = now() where r.id = v_row.id;
    update ticket_choices c set resolved_at = now() where c.run_id = v_row.id;
    insert into automation_run_steps (run_id, position, step_id, step_type, outcome, detail)
    values (v_row.id, v_row.position, null, 'choose', 'skipped', 'Expired: no ticket chosen.');
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

-- ── status ───────────────────────────────────────────────────────────────────
/* Only really going live moves `activated_at`. Whatever a run was waiting to send
   stops with it, and so does an email waiting for its ticket. A ticket
   automation tests on one ticket. */
drop function if exists automation_set_status(uuid, text, uuid, uuid);
create or replace function automation_set_status(p_automation uuid, p_status text, p_test_record uuid, p_actor uuid, p_test_case uuid default null)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a      automations;
  v_end  int := 0;
  v_rec  uuid := p_test_record;
begin
  select * into a from automations where id = p_automation and deleted_at is null for update;
  if not found then raise exception 'That automation no longer exists.'; end if;
  if p_status not in ('draft', 'test', 'on', 'off') then raise exception 'bad status'; end if;
  if a.kind = 'ticket' and p_status = 'test' then
    select c.record_id into v_rec from cases c where c.id = p_test_case and c.deleted_at is null;
    if v_rec is null then raise exception 'Pick the ticket to test it on.'; end if;
  end if;

  update automations
     set status = p_status,
         test_record_id = case when p_status = 'test' then v_rec else test_record_id end,
         test_case_id = case when p_status = 'test' and a.kind = 'ticket' then p_test_case else test_case_id end,
         activated_at = case
           when p_status not in ('test', 'on') then activated_at
           when a.status <> p_status
             or (p_status = 'test' and (a.test_record_id is distinct from v_rec or (a.kind = 'ticket' and a.test_case_id is distinct from p_test_case)))
             then now()
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
     and (p_status in ('off', 'draft') or (p_status = 'test' and r.record_id is distinct from v_rec));

  update ticket_choices c set resolved_at = now()
    from automation_runs r
   where c.run_id = r.id and c.resolved_at is null and r.automation_id = p_automation and r.status = 'choosing'
     and (p_status in ('off', 'draft') or (p_status = 'test' and r.record_id is distinct from v_rec));

  update automation_runs r
     set status = 'cancelled', finished_at = now(), resume_at = null,
         reason = case when p_status = 'test' then 'Automation moved to Test on another record.' else 'Automation switched off.' end
   where r.automation_id = p_automation
     and r.status in ('running', 'waiting', 'sending', 'choosing')
     and (p_status in ('off', 'draft') or (p_status = 'test' and r.record_id is distinct from v_rec));
  get diagnostics v_end = row_count;

  perform automation_refresh_triggers(p_automation);
  return v_end;
end;
$$;

-- ── choosing the ticket for an email ─────────────────────────────────────────
/* The note in Vital Info: what is waiting on this record, for the person asking. */
create or replace function ticket_choices_for(p_record uuid)
returns table (choice_id uuid, automation_name text, sender text, subject text, created_at timestamptz, expires_at timestamptz, tickets jsonb)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select ch.id, ch.automation_name, ch.sender, ch.subject, ch.created_at, ch.expires_at,
         coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'number', c.number, 'title', c.title) order by c.number)
                     from cases c where c.record_id = ch.record_id and c.state = 'open' and c.deleted_at is null), '[]'::jsonb)
    from ticket_choices ch
   where ch.record_id = p_record and ch.resolved_at is null and ch.expires_at > now()
     and ticket_choice_for_me(p_record)
   order by ch.created_at;
$$;

/* The badge on a row in the Tickets list. */
create or replace function ticket_choice_records()
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select distinct ch.record_id from ticket_choices ch
   where ch.resolved_at is null and ch.expires_at > now() and ticket_choice_for_me(ch.record_id);
$$;

create or replace function ticket_choose(p_choice uuid, p_case uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  ch     ticket_choices;
  c      cases;
  v_name text;
begin
  select * into ch from ticket_choices where id = p_choice for update;
  if not found or not ticket_choice_for_me(ch.record_id) then raise exception 'not found'; end if;
  if ch.resolved_at is not null then raise exception 'Someone already chose the ticket for this email.' using errcode = '23514'; end if;
  if ch.expires_at <= now() then raise exception 'This choice expired.' using errcode = '23514'; end if;
  select * into c from cases where id = p_case and record_id = ch.record_id and deleted_at is null;
  if not found or c.state <> 'open' then raise exception 'That ticket isn''t open any more. Choose another.' using errcode = '23514'; end if;

  update ticket_choices set chosen_case_id = p_case, chosen_by = auth.uid(), resolved_at = now() where id = p_choice;
  update automation_runs set status = 'running', case_id = p_case, case_label = case_label(p_case), reason = null
   where id = ch.run_id and status = 'choosing';
  if not found then return; end if;

  select coalesce(nullif(btrim(full_name), ''), email::text) into v_name from profiles where id = auth.uid();
  insert into automation_run_steps (run_id, position, step_id, step_type, outcome, detail)
  values (ch.run_id, 0, null, 'choose', 'done', coalesce(v_name, 'Someone') || ' chose ticket #' || c.number || '.');
  perform case_log_write(p_case, 'Chosen for the email “' || coalesce(ch.subject, '(no subject)') || '” from ' || coalesce(ch.sender, 'the client') || '.',
                         auth.uid(), null, null);
end;
$$;

-- ── grants ───────────────────────────────────────────────────────────────────
revoke all on function case_open_to_me(uuid) from public, anon;
grant execute on function case_open_to_me(uuid) to authenticated;
revoke all on function ticket_choice_for_me(uuid) from public, anon;
grant execute on function ticket_choice_for_me(uuid) to authenticated;
revoke all on function case_log_write(uuid, text, uuid, uuid, text) from public, anon, authenticated;
revoke all on function case_label(uuid) from public, anon, authenticated;
revoke all on function set_awaiting_client(uuid, boolean) from public, anon;
grant execute on function set_awaiting_client(uuid, boolean) to authenticated;
revoke all on function ticket_inbox(uuid) from public, anon, authenticated;
revoke all on function ticket_capture_mail() from public, anon, authenticated;
revoke all on function automation_ticket_condition(jsonb, uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function automation_ticket_conditions_met(jsonb, uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function automation_needs_ticket(jsonb) from public, anon, authenticated;
revoke all on function automation_has_condition(jsonb, text) from public, anon, authenticated;
revoke all on function automation_start_ticket(automation_queue, automations) from public, anon, authenticated;
revoke all on function automation_start(automation_queue) from public, anon, authenticated;
revoke all on function automation_ticket_text(automation_runs, text) from public, anon, authenticated;
revoke all on function automation_close_ticket(automation_runs, jsonb) from public, anon, authenticated;
revoke all on function automation_open_ticket(automation_runs, jsonb) from public, anon, authenticated;
revoke all on function automation_clear_awaiting(automation_runs, jsonb) from public, anon, authenticated;
revoke all on function automation_ticket_assign_team(automation_runs, jsonb) from public, anon, authenticated;
revoke all on function automation_send_notification(automation_runs, jsonb) from public, anon, authenticated;
revoke all on function automation_act(automation_runs, jsonb) from public, anon, authenticated;
revoke all on function automation_advance(uuid) from public, anon, authenticated;
revoke all on function automation_mail_result(uuid, boolean, text) from public, anon, authenticated;
grant execute on function automation_mail_result(uuid, boolean, text) to service_role;
revoke all on function automation_work(int) from public, anon, authenticated;
grant execute on function automation_work(int) to service_role;
revoke all on function automation_set_status(uuid, text, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function automation_set_status(uuid, text, uuid, uuid, uuid) to service_role;
revoke all on function ticket_choices_for(uuid) from public, anon;
grant execute on function ticket_choices_for(uuid) to authenticated;
revoke all on function ticket_choice_records() from public, anon;
grant execute on function ticket_choice_records() to authenticated;
revoke all on function ticket_choose(uuid, uuid) from public, anon;
grant execute on function ticket_choose(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
