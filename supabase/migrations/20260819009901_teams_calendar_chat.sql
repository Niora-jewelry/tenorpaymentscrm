-- Microsoft Teams: the Calendar and Chat modules (client spec, 2 Nov 2026).
--
-- Microsoft is the source of truth: events and chats are read from Graph as they
-- are asked for, and "Microsoft's version wins" holds because there is no second
-- copy to reconcile. What lives here is only what Microsoft has no place for:
--   * the last loaded data, so a broken connection or a Microsoft outage still shows
--     something, marked out of date;
--   * the sidebar counts, so a page load never waits on Microsoft;
--   * favourites, teammates' calendars added to the list, and channel read marks.
--
-- Every table is server-only: no browser role can touch it. The server reaches them
-- with the service role after lib/msteams/access.ts has decided who may see what.

-- ── permission: Own only / All users, set up the same way as Email ──────────
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
          'notifications.scope', 'email.scope', 'phone.scope', 'calendar.scope', 'chat.scope',
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

insert into permission_settings (owner_kind, owner_id, key, value)
select 'template', pt.id, k.key, case when pt.user_type in ('super_admin', 'admin') then 'all' else 'own' end
  from permission_templates pt
 cross join (values ('calendar.scope'), ('chat.scope')) as k(key)
on conflict (owner_kind, owner_id, key) do nothing;

-- ── an Admin or Super admin can hide their own, one switch each ─────────────
alter table mail_user_settings
  add column if not exists hide_my_calendar boolean not null default false,
  add column if not exists hide_my_chat boolean not null default false;

create or replace function set_my_teams_privacy(p_calendar boolean, p_chat boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  insert into mail_user_settings (user_id, hide_my_calendar, hide_my_chat)
  values (auth.uid(), p_calendar, p_chat)
  on conflict (user_id) do update
    set hide_my_calendar = excluded.hide_my_calendar, hide_my_chat = excluded.hide_my_chat, updated_at = now();
end;
$$;
revoke all on function set_my_teams_privacy(boolean, boolean) from public, anon;
grant execute on function set_my_teams_privacy(boolean, boolean) to authenticated;

-- ── the last loaded data ────────────────────────────────────────────────────
create table if not exists teams_snapshots (
  id           uuid primary key default gen_random_uuid(),
  identity_id  uuid not null references mail_identities(id) on delete cascade,
  kind         text not null check (char_length(kind) <= 40),
  key          text not null check (char_length(key) <= 500),
  data         jsonb not null,
  fetched_at   timestamptz not null default now(),
  unique (identity_id, kind, key)
);
create index if not exists teams_snapshots_old on teams_snapshots (fetched_at);
alter table teams_snapshots enable row level security;
alter table teams_snapshots force row level security;
revoke all on teams_snapshots from public, anon, authenticated;

-- ── the two sidebar numbers ─────────────────────────────────────────────────
create table if not exists teams_counts (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null unique references profiles(id) on delete cascade,
  calendar_unanswered int not null default 0 check (calendar_unanswered >= 0),
  chat_unread         int not null default 0 check (chat_unread >= 0),
  refreshed_at        timestamptz not null default now()
);
alter table teams_counts enable row level security;
alter table teams_counts force row level security;
revoke all on teams_counts from public, anon, authenticated;

-- ── Microsoft has no API for these ──────────────────────────────────────────
create table if not exists teams_favorites (
  id           uuid primary key default gen_random_uuid(),
  identity_id  uuid not null references mail_identities(id) on delete cascade,
  chat_key     text not null check (char_length(chat_key) <= 500),
  created_at   timestamptz not null default now(),
  unique (identity_id, chat_key)
);
alter table teams_favorites enable row level security;
alter table teams_favorites force row level security;
revoke all on teams_favorites from public, anon, authenticated;

create table if not exists teams_added_calendars (
  id           uuid primary key default gen_random_uuid(),
  identity_id  uuid not null references mail_identities(id) on delete cascade,
  address      citext not null,
  name         text not null default '',
  created_at   timestamptz not null default now(),
  unique (identity_id, address)
);
alter table teams_added_calendars enable row level security;
alter table teams_added_calendars force row level security;
revoke all on teams_added_calendars from public, anon, authenticated;

-- Graph keeps no read state for channels, so this does.
create table if not exists teams_channel_reads (
  id           uuid primary key default gen_random_uuid(),
  identity_id  uuid not null references mail_identities(id) on delete cascade,
  channel_key  text not null check (char_length(channel_key) <= 500),
  read_at      timestamptz not null default now(),
  unique (identity_id, channel_key)
);
alter table teams_channel_reads enable row level security;
alter table teams_channel_reads force row level security;
revoke all on teams_channel_reads from public, anon, authenticated;

-- ── "Waiting for admin approval" ────────────────────────────────────────────
-- A sign-in Microsoft refused gives us no account to hang this on, so it hangs on
-- the person. Connecting successfully clears it.
create table if not exists teams_pending_approvals (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null unique references profiles(id) on delete cascade,
  requested_at  timestamptz not null default now()
);
alter table teams_pending_approvals enable row level security;
alter table teams_pending_approvals force row level security;
revoke all on teams_pending_approvals from public, anon, authenticated;

-- ── disconnecting removes the account's calendar and chat from the CRM ──────
-- Identities are soft-deleted, so the foreign keys above would never fire for it.
create or replace function teams_forget_identity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from teams_snapshots where identity_id = new.id;
  delete from teams_favorites where identity_id = new.id;
  delete from teams_added_calendars where identity_id = new.id;
  delete from teams_channel_reads where identity_id = new.id;
  delete from teams_counts where user_id = new.user_id;
  return new;
end;
$$;
revoke all on function teams_forget_identity() from public, anon, authenticated;

drop trigger if exists mail_identities_forget_teams on mail_identities;
create trigger mail_identities_forget_teams
  after update of deleted_at on mail_identities
  for each row
  when (old.deleted_at is null and new.deleted_at is not null)
  execute function teams_forget_identity();
