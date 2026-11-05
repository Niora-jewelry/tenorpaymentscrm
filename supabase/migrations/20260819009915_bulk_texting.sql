-- Broadcast and group texting.
--
-- A broadcast is one message sent as separate 1-to-1 texts, so a reply lands in the
-- normal thread with that person. A group is one shared conversation in Twilio
-- Conversations, the only part of the CRM that uses Conversations.
--
-- Additive: this is live on the site before the code that uses it is deployed.

-- ── 1. Who may send to many people ───────────────────────────────────────
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
    when p_key in ('notifications.scope', 'email.scope', 'phone.scope', 'calendar.scope', 'chat.scope') then p_value in ('own', 'all')
    when p_key = 'phone.bulk'                                       then p_value in ('yes', 'no')
    when p_key = 'admin.automations'                                then p_value in ('hidden', 'view', 'full')
    when p_key ~ '^admin\.(users|permissions|presets|numbers|residuals|integrations|recycle_bin)$'
                                                                    then p_value in ('hidden', 'full')
    when p_key = 'communication.scope'                              then p_value in ('own', 'org')
    when p_key = 'items.cases'                                      then p_value in ('hidden', 'mine', 'all')
    when p_key in ('items.updates', 'items.notes')                  then p_value in ('mine', 'all')
    when p_key = 'applications.pdfs'                                then p_value in ('hidden', 'full')
    when p_key = 'agreements.send'                                  then p_value in ('yes', 'no')
    when p_key = 'fields.highlights'                                then p_value in ('yes', 'no')
    when p_key = 'equipment.add_providers'                          then p_value in ('yes', 'no')
    when p_key ~ '^reporting\.(tab|acquiring|ach)$'                 then p_value in ('hidden', 'view')
    when p_key ~ '^maverick\.(status|send|update|check|other_cases|sync_case|unmatched_flag|resolve_unmatched|alerts|connection)$'
                                                                    then p_value in ('yes', 'no')
    else false
  end;
$$;

create or replace function public.permission_setting_max(p_key text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_key like 'action.%' then 'yes'
    when p_key like 'team.%' then 'yes'
    when p_key like 'module:%' then 'all'
    when p_key like 'admin.%' then 'full'
    when p_key = 'applications.pdfs' then 'full'
    when p_key = 'agreements.send' then 'yes'
    when p_key = 'phone.bulk' then 'yes'
    when p_key = 'fields.highlights' then 'yes'
    when p_key = 'equipment.add_providers' then 'yes'
    when p_key like 'reporting.%' then 'view'
    when p_key like 'maverick.%' then 'yes'
    when p_key = 'communication.scope' then 'org'
    when p_key like '%.scope' then 'all'
    when p_key like 'items.%' then 'all'
  end;
$$;

create or replace function public.permission_setting_min(p_key text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_key like 'action.%' then 'no'
    when p_key like 'team.%' then 'no'
    when p_key like 'module:%' then 'hidden'
    when p_key like 'admin.%' then 'hidden'
    when p_key = 'applications.pdfs' then 'hidden'
    when p_key = 'agreements.send' then 'no'
    when p_key = 'phone.bulk' then 'no'
    when p_key = 'fields.highlights' then 'no'
    when p_key = 'equipment.add_providers' then 'no'
    when p_key like 'reporting.%' then 'hidden'
    when p_key like 'maverick.%' then 'no'
    when p_key = 'communication.scope' then 'own'
    when p_key like '%.scope' then 'own'
    when p_key = 'items.cases' then 'hidden'
    when p_key like 'items.%' then 'mine'
  end;
$$;

create or replace function public.user_permissions(u uuid)
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
          'notifications.scope', 'email.scope', 'phone.scope', 'phone.bulk', 'calendar.scope', 'chat.scope',
          'admin.users', 'admin.permissions', 'admin.presets', 'admin.numbers', 'admin.residuals',
          'admin.integrations', 'admin.automations', 'admin.recycle_bin',
          'communication.scope', 'items.cases', 'items.updates', 'items.notes',
          'applications.pdfs', 'agreements.send', 'fields.highlights', 'equipment.add_providers',
          'reporting.tab', 'reporting.acquiring', 'reporting.ach',
          'maverick.status', 'maverick.send', 'maverick.update', 'maverick.check', 'maverick.other_cases',
          'maverick.sync_case', 'maverick.unmatched_flag', 'maverick.resolve_unmatched', 'maverick.alerts', 'maverick.connection'
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

-- Admins on by default, everyone else off: one click reaches hundreds of people.
insert into permission_settings (owner_kind, owner_id, key, value)
select 'template', pt.id, 'phone.bulk',
       case when pt.user_type in ('super_admin', 'admin') then 'yes' else 'no' end
  from permission_templates pt
 where pt.user_type in ('super_admin', 'admin', 'underwriter', 'accounting', 'customer_service', 'sales_agent')
on conflict (owner_kind, owner_id, key) do nothing;

-- ── 2. Broadcasts ─────────────────────────────────────────────────────────
create table public.sms_broadcasts (
  id          uuid primary key default gen_random_uuid(),
  created_by  uuid references public.profiles(id) on delete set null,
  from_e164   text not null,
  body        text not null check (char_length(body) between 1 and 1600),
  total       integer not null check (total between 1 and 500),
  status      text not null default 'sending' check (status in ('sending', 'finished', 'stopped')),
  created_at  timestamptz not null default now(),
  finished_at timestamptz
);
create index sms_broadcasts_created_by_idx on public.sms_broadcasts (created_by, created_at desc);

create table public.sms_broadcast_recipients (
  id           uuid primary key default gen_random_uuid(),
  broadcast_id uuid not null references public.sms_broadcasts(id) on delete cascade,
  e164         text not null,
  status       text not null default 'queued'
               check (status in ('queued', 'sending', 'sent', 'skipped_opted_out', 'skipped_no_consent', 'failed', 'cancelled')),
  message_id   uuid references public.phone_messages(id) on delete set null,
  error        text,
  claimed_at   timestamptz,
  created_at   timestamptz not null default now(),
  unique (broadcast_id, e164)
);
create index sms_broadcast_recipients_queue_idx on public.sms_broadcast_recipients (created_at) where status = 'queued';
create index sms_broadcast_recipients_claimed_idx on public.sms_broadcast_recipients (claimed_at) where status = 'sending';

-- ── 3. Groups ─────────────────────────────────────────────────────────────
create table public.sms_groups (
  id                      uuid primary key default gen_random_uuid(),
  name                    text not null check (char_length(name) between 1 and 60),
  owner_id                uuid references public.profiles(id) on delete set null,
  from_e164               text not null,
  twilio_conversation_sid text unique,
  created_by              uuid references public.profiles(id) on delete set null,
  created_at              timestamptz not null default now(),
  closed_at               timestamptz
);
create index sms_groups_owner_idx on public.sms_groups (owner_id, created_at desc);

create table public.sms_group_members (
  id                     uuid primary key default gen_random_uuid(),
  group_id               uuid not null references public.sms_groups(id) on delete cascade,
  e164                   text not null,
  display_name           text,
  record_id              uuid references public.records(id) on delete set null,
  twilio_participant_sid text,
  added_at               timestamptz not null default now(),
  removed_at             timestamptz,
  removed_reason         text
);
create unique index sms_group_members_active_idx on public.sms_group_members (group_id, e164) where removed_at is null;

create table public.sms_group_messages (
  id                 uuid primary key default gen_random_uuid(),
  group_id           uuid not null references public.sms_groups(id) on delete cascade,
  direction          text not null check (direction in ('in', 'out')),
  author_e164        text,
  body               text,
  has_media          boolean not null default false,
  twilio_message_sid text unique,
  status             text not null check (status in ('queued', 'sent', 'failed', 'received')),
  created_by         uuid references public.profiles(id) on delete set null,
  sent_at            timestamptz not null default now()
);
create index sms_group_messages_group_idx on public.sms_group_messages (group_id, sent_at desc);

-- Twilio allows ten people in a group text, and the CRM line is one of them.
create or replace function public.sms_group_members_cap()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform 1 from sms_groups where id = new.group_id for update;
  if (select count(*) from sms_group_members where group_id = new.group_id and removed_at is null) >= 9 then
    raise exception 'A group text can have at most 9 members' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger sms_group_members_cap before insert on public.sms_group_members
  for each row execute function public.sms_group_members_cap();

-- ── 4. RLS: default deny, reads granted back, writes only through the service ──
alter table public.sms_broadcasts enable row level security;
alter table public.sms_broadcasts force row level security;
alter table public.sms_broadcast_recipients enable row level security;
alter table public.sms_broadcast_recipients force row level security;
alter table public.sms_groups enable row level security;
alter table public.sms_groups force row level security;
alter table public.sms_group_members enable row level security;
alter table public.sms_group_members force row level security;
alter table public.sms_group_messages enable row level security;
alter table public.sms_group_messages force row level security;

revoke all on public.sms_broadcasts, public.sms_broadcast_recipients, public.sms_groups,
              public.sms_group_members, public.sms_group_messages from public, anon, authenticated;
grant select on public.sms_broadcasts, public.sms_broadcast_recipients, public.sms_groups,
                public.sms_group_members, public.sms_group_messages to authenticated;
grant all on public.sms_broadcasts, public.sms_broadcast_recipients, public.sms_groups,
             public.sms_group_members, public.sms_group_messages to service_role;

create policy sms_broadcasts_select on public.sms_broadcasts for select to authenticated
  using (created_by = auth.uid() or auth_perm('phone.scope') = 'all');
create policy sms_broadcast_recipients_select on public.sms_broadcast_recipients for select to authenticated
  using (exists (select 1 from public.sms_broadcasts b where b.id = broadcast_id));
create policy sms_groups_select on public.sms_groups for select to authenticated
  using (owner_id = auth.uid() or auth_perm('phone.scope') = 'all');
create policy sms_group_members_select on public.sms_group_members for select to authenticated
  using (exists (select 1 from public.sms_groups g where g.id = group_id));
create policy sms_group_messages_select on public.sms_group_messages for select to authenticated
  using (exists (select 1 from public.sms_groups g where g.id = group_id));

-- ── 5. The broadcast queue ────────────────────────────────────────────────
-- The broadcast and its recipients arrive together, so the worker can never see
-- a broadcast that is still missing people and call it finished.
create or replace function public.sms_broadcast_create(
  p_created_by uuid,
  p_from       text,
  p_body       text,
  p_queued     text[],
  p_opted_out  text[],
  p_no_consent text[]
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into sms_broadcasts (created_by, from_e164, body, total)
  values (p_created_by, p_from, p_body,
          coalesce(cardinality(p_queued), 0) + coalesce(cardinality(p_opted_out), 0) + coalesce(cardinality(p_no_consent), 0))
  returning id into v_id;

  insert into sms_broadcast_recipients (broadcast_id, e164, status)
  select v_id, n, 'queued' from unnest(p_queued) n
  union all
  select v_id, n, 'skipped_opted_out' from unnest(p_opted_out) n
  union all
  select v_id, n, 'skipped_no_consent' from unnest(p_no_consent) n;

  return v_id;
end;
$$;

-- Hands out one number at a time and at most about one a second across every
-- worker, so an overlapping cron run cannot speed the sending up. A worker that
-- gets nothing asks sms_broadcast_pending whether to wait or go home.
create or replace function public.sms_broadcast_claim()
returns table (recipient_id uuid, broadcast_id uuid, e164 text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not pg_try_advisory_xact_lock(hashtext('sms_broadcast_claim')) then
    return;
  end if;
  if exists (select 1 from sms_broadcast_recipients r
              where r.claimed_at > now() - interval '900 milliseconds') then
    return;
  end if;
  return query
    update sms_broadcast_recipients r
       set status = 'sending', claimed_at = now()
     where r.id = (
       select q.id
         from sms_broadcast_recipients q
         join sms_broadcasts b on b.id = q.broadcast_id
        where q.status = 'queued' and b.status = 'sending'
        order by q.created_at, q.id
        limit 1
          for update of q skip locked
     )
    returning r.id, r.broadcast_id, r.e164;
end;
$$;

create or replace function public.sms_broadcast_pending()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from sms_broadcast_recipients q
                   join sms_broadcasts b on b.id = q.broadcast_id
                  where q.status = 'queued' and b.status = 'sending');
$$;

-- A worker that died mid-send may or may not have reached Twilio. Sending again
-- could text someone twice, so that row is reported failed, never retried.
create or replace function public.sms_broadcast_settle()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update sms_broadcast_recipients
     set status = 'failed',
         error = 'The send was interrupted. This text may or may not have gone out.'
   where status = 'sending' and claimed_at < now() - interval '10 minutes';

  update sms_broadcasts b
     set status = 'finished', finished_at = now()
   where b.status = 'sending'
     and not exists (select 1 from sms_broadcast_recipients r
                      where r.broadcast_id = b.id and r.status in ('queued', 'sending'));
end;
$$;

-- Runs as the caller, so RLS still decides which broadcasts can be counted.
create or replace function public.sms_broadcast_counts(p_ids uuid[])
returns table (broadcast_id uuid, status text, n integer)
language sql
stable
set search_path = public, pg_temp
as $$
  select r.broadcast_id, r.status, count(*)::integer
    from sms_broadcast_recipients r
   where r.broadcast_id = any (p_ids)
   group by 1, 2;
$$;

revoke all on function public.sms_broadcast_create(uuid, text, text, text[], text[], text[]) from public, anon, authenticated;
revoke all on function public.sms_broadcast_claim() from public, anon, authenticated;
revoke all on function public.sms_broadcast_pending() from public, anon, authenticated;
revoke all on function public.sms_broadcast_settle() from public, anon, authenticated;
revoke all on function public.sms_broadcast_counts(uuid[]) from public, anon;
grant execute on function public.sms_broadcast_create(uuid, text, text, text[], text[], text[]) to service_role;
grant execute on function public.sms_broadcast_claim() to service_role;
grant execute on function public.sms_broadcast_pending() to service_role;
grant execute on function public.sms_broadcast_settle() to service_role;
grant execute on function public.sms_broadcast_counts(uuid[]) to authenticated, service_role;
