-- =============================================================================
-- Automations: what people see of them outside the admin page.
-- =============================================================================

-- ── Updates ──────────────────────────────────────────────────────────────────
-- Spec: every action is recorded in the record's Updates tab. "Only mine" hides
-- what other people wrote; an automation's entry is the record's own history, not
-- someone else's post. The team rules still apply to it.
drop policy if exists updates_select on updates;
create policy updates_select on updates for select using (
  record_visible(record_id)
  and tab_visible(record_id, 'updates')
  and (field_key is null or record_field_grant(record_id, field_key::text) <> 'hidden')
  and (automation_name is not null or (author_id = (select auth.uid())) or update_visible_to((select auth.uid()), id))
  and (team_id is null or author_id = (select auth.uid()) or team_log_visible((select auth.uid()), team_id, names_person))
);

-- ── Notifications ────────────────────────────────────────────────────────────
create or replace function public.notification_visible(n public.notifications)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select n.revoked_at is null
     and (
       (n.source_kind not like 'mention\_%' and n.source_kind not in ('agreement', 'automation'))
       or (n.source_kind = 'automation' and record_visible(n.record_id))
       or (n.source_kind = 'agreement' and record_visible(n.record_id) and tab_visible(n.record_id, agreements_tab_key()))
       or (
         n.source_kind like 'mention\_%'
         and record_visible(n.record_id)
         and case n.source_kind
               when 'mention_update' then
                 tab_visible(n.record_id, 'updates')
                 and exists (select 1 from updates u
                              where u.id = n.update_id and u.deleted_at is null
                                and (u.parent_id is null or exists (select 1 from updates p where p.id = u.parent_id and p.deleted_at is null)))
               when 'mention_case_reply' then
                 tab_visible(n.record_id, 'cases')
                 and exists (select 1 from case_replies r join cases c on c.id = r.case_id
                              where r.id = n.case_reply_id and r.deleted_at is null and c.deleted_at is null)
               when 'mention_field' then
                 record_field_grant(n.record_id, n.field_key::text) <> 'hidden'
                 and exists (select 1 from fields f where f.key = n.field_key and f.archived_at is null)
               else false
             end
       )
     );
$$;

-- Automation notifications count with the mentions in the sidebar badge.
create or replace function public.my_unread_counts()
returns table (mentions int, phone int)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    count(*) filter (where n.source_kind like 'mention\_%' or n.source_kind in ('agreement', 'automation', 'automation_alert'))::int,
    count(*) filter (where n.source_kind in ('call', 'voicemail', 'recording', 'sms'))::int
    from notifications n
   where n.recipient_id = auth.uid()
     and n.read_at is null
     and n.created_at >= now() - interval '90 days'
     and notification_visible(n);
$$;

-- ── waiting on a record ──────────────────────────────────────────────────────
/* Spec: anyone can see the icon; who may switch it off is set per automation, by
   team and then by user. Whoever has Full edit on Automations could turn the
   whole thing off, so they may also do this. */
create or replace function automation_can_switch_off(p_user uuid, a automations)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select user_is_admin(p_user)
      or user_perm(p_user, 'admin.automations') = 'full'
      or (user_team(p_user) = any (a.stop_team_ids)
          and (cardinality(a.stop_user_ids) = 0 or p_user = any (a.stop_user_ids)));
$$;

create or replace function automation_waiting_on(p_record uuid)
returns table (run_id uuid, automation_name text, resume_at timestamptz, can_switch_off boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.id, r.automation_name, r.resume_at, automation_can_switch_off(auth.uid(), a)
    from automation_runs r
    join automations a on a.id = r.automation_id
   where r.record_id = p_record and r.status = 'waiting' and record_visible(p_record)
   order by r.resume_at;
$$;

create or replace function automation_switch_off(p_run uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r automation_runs;
  a automations;
  s jsonb;
begin
  select * into r from automation_runs where id = p_run for update;
  if not found or not record_visible(r.record_id) then raise exception 'not found'; end if;
  if r.status <> 'waiting' then
    raise exception 'This automation has already moved on.' using errcode = '23514';
  end if;
  select * into a from automations where id = r.automation_id;
  if not automation_can_switch_off(auth.uid(), a) then
    raise exception 'You cannot switch this automation off.' using errcode = '42501';
  end if;

  select v.steps -> 'flow' -> r.position into s from automation_versions v where v.id = r.version_id;
  update automation_runs
     set status = 'switched_off', stopped_by = auth.uid(), finished_at = now(), resume_at = null,
         reason = 'Switched off for this record by ' || team_person_name(auth.uid()) || '.'
   where id = r.id;
  perform automation_step_log(r, s, 'skipped', 'Switched off for this record by ' || team_person_name(auth.uid()) || '.');
  insert into updates (record_id, author_id, body) values (r.record_id, auth.uid(), 'Switched off “' || r.automation_name || '” for this record.');
  insert into record_activity (record_id, actor_id, kind, summary, source)
  values (r.record_id, auth.uid(), 'automation', 'Switched off “' || r.automation_name || '” for this record.', 'Automation: ' || r.automation_name);
end;
$$;

revoke all on function automation_can_switch_off(uuid, automations) from public, anon, authenticated;
revoke all on function automation_waiting_on(uuid) from public, anon;
revoke all on function automation_switch_off(uuid) from public, anon;
grant execute on function automation_waiting_on(uuid) to authenticated;
grant execute on function automation_switch_off(uuid) to authenticated;

-- ── main record of an email ──────────────────────────────────────────────────
/* Spec: if an address belongs to more than one record, the person writing the
   email is asked which is the main record. They are offered the ones they can
   see. A conversation that already has one is not asked again. */
create or replace function mail_record_choices(p_addresses text[], p_mailbox uuid default null, p_conversation text default null)
returns table (address text, record_id uuid, deal_name text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with shared as (
    select e.email
      from record_contact_emails e
      join records r on r.id = e.record_id and r.deleted_at is null
     where e.email = any (p_addresses::citext[])
     group by e.email
    having count(distinct e.record_id) > 1
  )
  select distinct e.email::text, r.id, r.deal_name
    from shared s
    join record_contact_emails e on e.email = s.email
    join records r on r.id = e.record_id and r.deleted_at is null
   where record_visible(r.id)
     and not exists (select 1 from mail_record_links l
                      where l.mailbox_id = p_mailbox and l.conversation_id = p_conversation and l.record_id = r.id)
     and not exists (select 1 from mail_record_links l
                      where l.mailbox_id = p_mailbox and l.conversation_id = p_conversation)
   order by 1, 3;
$$;

create or replace function mail_set_main_record(p_outbox uuid, p_record uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not record_visible(p_record) then raise exception 'not found'; end if;
  update mail_outbox set record_id = p_record, updated_at = now()
   where id = p_outbox and user_id = auth.uid() and status in ('held', 'scheduled', 'sending');
  if not found then raise exception 'not found'; end if;
end;
$$;

revoke all on function mail_record_choices(text[], uuid, text) from public, anon;
revoke all on function mail_set_main_record(uuid, uuid) from public, anon;
grant execute on function mail_record_choices(text[], uuid, text) to authenticated;
grant execute on function mail_set_main_record(uuid, uuid) to authenticated;
