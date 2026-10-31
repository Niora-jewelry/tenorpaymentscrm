-- =============================================================================
-- Automations (client spec of 30 Oct 2026): the tables.
--
-- An automation is a row; what it does is an immutable version, because a record
-- partway through a wait may finish on the old one. `automation_triggers` is the
-- one table the write paths read, and it holds rows only for automations that
-- are Test or On, so with nothing switched on every capture stops at one lookup.
--
-- Nothing here changes what an existing screen does.
-- =============================================================================

alter type activity_kind add value if not exists 'automation';

-- ── who did it ───────────────────────────────────────────────────────────────
-- Spec: "shown as done by Automation with the automation's name". No person did
-- it, and `profiles.id` must be a real sign-in, so an automation's entry has no
-- author and says so. The checks keep a person's entry from losing its author.
alter table updates alter column author_id drop not null;
alter table updates add column if not exists automation_id uuid;
alter table updates add column if not exists automation_name text;
alter table updates add constraint updates_author_or_automation check (author_id is not null or automation_name is not null);

alter table cases alter column issue_author drop not null;
alter table cases add column if not exists automation_id uuid;
alter table cases add column if not exists automation_name text;
alter table cases add constraint cases_author_or_automation check (issue_author is not null or automation_name is not null);

-- ── the automation ───────────────────────────────────────────────────────────
create table automations (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null check (char_length(btrim(name)) between 1 and 120),
  status              text not null default 'draft' check (status in ('draft', 'test', 'on', 'off')),
  test_record_id      uuid references records(id) on delete set null,
  current_version_id  uuid,
  -- Spec: "reacts only to events that happen after it's switched on".
  activated_at        timestamptz,
  -- Who may switch it off for one waiting record: these teams, narrowed to these users.
  stop_team_ids       uuid[] not null default '{}',
  stop_user_ids       uuid[] not null default '{}',
  created_by          uuid references profiles(id) on delete set null,
  updated_by          uuid references profiles(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  constraint automations_test_needs_a_record check (status <> 'test' or test_record_id is not null)
);
create index automations_live on automations (updated_at desc) where deleted_at is null;

create table automation_versions (
  id             uuid primary key default gen_random_uuid(),
  automation_id  uuid not null references automations(id) on delete cascade,
  number         int not null,
  steps          jsonb not null,
  created_by     uuid references profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  unique (automation_id, number)
);
alter table automations add constraint automations_current_version
  foreign key (current_version_id) references automation_versions(id) on delete set null;

alter table updates add constraint updates_automation_fk foreign key (automation_id) references automations(id) on delete set null;
alter table cases add constraint cases_automation_fk foreign key (automation_id) references automations(id) on delete set null;

-- What the write paths look at. Rebuilt by `automation_refresh_triggers`.
create table automation_triggers (
  automation_id  uuid not null references automations(id) on delete cascade,
  trigger_id     text not null,
  version_id     uuid not null references automation_versions(id) on delete cascade,
  kind           text not null,
  match          jsonb not null default '{}'::jsonb,
  only_record    uuid,
  active_from    timestamptz not null,
  primary key (automation_id, trigger_id)
);
create index automation_triggers_kind on automation_triggers (kind);

-- An event an automation is listening for, waiting to be started. `record_id`
-- has no foreign key: a capture can fire while a record is being purged, and
-- null means an email that could not be tied to one record.
create table automation_queue (
  id             uuid primary key default gen_random_uuid(),
  automation_id  uuid not null references automations(id) on delete cascade,
  version_id     uuid not null references automation_versions(id) on delete cascade,
  trigger_id     text not null,
  trigger_kind   text not null,
  record_id      uuid,
  module_id      uuid,
  actor_id       uuid,
  note           text,
  occurred_at    timestamptz not null default now(),
  dedupe_key     text not null,
  done_at        timestamptz,
  unique (automation_id, dedupe_key)
);
create index automation_queue_due on automation_queue (occurred_at) where done_at is null;

create table automation_runs (
  id               uuid primary key default gen_random_uuid(),
  automation_id    uuid not null references automations(id) on delete cascade,
  version_id       uuid not null references automation_versions(id),
  automation_name  text not null,
  record_id        uuid references records(id) on delete set null,
  record_label     text,
  trigger_id       text,
  trigger_kind     text,
  module_id        uuid,
  actor_id         uuid,
  status           text not null check (status in (
                     'running', 'waiting', 'sending',
                     'completed', 'skipped', 'failed',
                     'not_matched', 'switched_off', 'cancelled')),
  position         int not null default 0,
  resume_at        timestamptz,
  lease_until      timestamptz,
  reason           text,
  stopped_by       uuid references profiles(id) on delete set null,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  alerted_at       timestamptz,
  alert_email_at   timestamptz,
  alert_dismissed_at timestamptz
);
-- A second event on a record already partway through this automation does not
-- start it twice: two runs would send the merchant the same email twice.
create unique index automation_runs_one_active on automation_runs (automation_id, record_id)
  where status in ('running', 'waiting', 'sending');
create index automation_runs_due on automation_runs (status, resume_at) where status in ('running', 'waiting', 'sending');
create index automation_runs_by_automation on automation_runs (automation_id, started_at desc);
create index automation_runs_by_record on automation_runs (record_id) where status = 'waiting';
create index automation_runs_alerts on automation_runs (started_at desc) where alerted_at is not null and alert_dismissed_at is null;
create index automation_runs_alert_mail on automation_runs (alerted_at) where alerted_at is not null and alert_email_at is null;

create table automation_run_steps (
  id        uuid primary key default gen_random_uuid(),
  run_id    uuid not null references automation_runs(id) on delete cascade,
  position  int not null,
  step_id   text,
  step_type text not null,
  outcome   text not null check (outcome in ('done', 'waiting', 'skipped', 'failed')),
  detail    text not null,
  at        timestamptz not null default now()
);
create index automation_run_steps_run on automation_run_steps (run_id, at);

-- Spec: "each automation has its own rotation". The place is the last person's
-- sort key, not an index, so people joining or leaving a team fall into their
-- alphabetical place without anything being rebuilt.
create table automation_rotations (
  automation_id  uuid not null references automations(id) on delete cascade,
  step_id        text not null,
  last_key       text,
  updated_at     timestamptz not null default now(),
  primary key (automation_id, step_id)
);

-- Files an admin uploaded for a Send email step. `mail-outbox` empties itself
-- after each send, so these live apart and are copied in when one goes.
create table automation_files (
  id             uuid primary key default gen_random_uuid(),
  automation_id  uuid not null references automations(id) on delete cascade,
  name           text not null,
  size_bytes     bigint not null check (size_bytes <= 26214400),
  content_type   text not null default 'application/octet-stream',
  storage_path   text not null unique,
  uploaded_by    uuid references profiles(id) on delete set null,
  created_at     timestamptz not null default now()
);
create index automation_files_by_automation on automation_files (automation_id);

insert into storage.buckets (id, name, public, file_size_limit)
values ('automation-files', 'automation-files', false, 26214400)
on conflict (id) do nothing;

-- ── emails and records ───────────────────────────────────────────────────────
-- Spec: "emails are tied to a record through its main contact email and owner
-- emails". Kept from the record by a trigger (next migration).
create table record_contact_emails (
  record_id  uuid not null references records(id) on delete cascade,
  email      citext not null,
  source     text not null check (source in ('contact', 'owner')),
  primary key (record_id, email, source)
);
create index record_contact_emails_email on record_contact_emails (email);

-- The main record someone chose for a conversation on a shared address, so the
-- replies follow it.
create table mail_record_links (
  mailbox_id       uuid not null references mail_mailboxes(id) on delete cascade,
  conversation_id  text not null,
  record_id        uuid not null references records(id) on delete cascade,
  set_by           uuid references profiles(id) on delete set null,
  set_at           timestamptz not null default now(),
  primary key (mailbox_id, conversation_id)
);

alter table mail_outbox add column if not exists automation_run_id uuid references automation_runs(id) on delete set null;
alter table mail_outbox add column if not exists automation_step_id text;
alter table mail_outbox add column if not exists record_id uuid references records(id) on delete set null;
create index mail_outbox_by_internet_id on mail_outbox (internet_message_id) where internet_message_id is not null;
create index mail_outbox_by_run on mail_outbox (automation_run_id) where automation_run_id is not null;

-- ── notifications ────────────────────────────────────────────────────────────
alter table notifications add column if not exists automation_run_id uuid references automation_runs(id) on delete cascade;
alter table notifications drop constraint if exists notifications_source_kind_check;
alter table notifications add constraint notifications_source_kind_check check (
  source_kind in ('update', 'mention', 'case', 'call', 'voicemail', 'recording', 'sms',
                  'mention_update', 'mention_case_reply', 'mention_field', 'agreement',
                  'automation', 'automation_alert'));

-- ── RLS: read through the gate, on the service role ──────────────────────────
alter table automations enable row level security;
alter table automations force row level security;
alter table automation_versions enable row level security;
alter table automation_versions force row level security;
alter table automation_triggers enable row level security;
alter table automation_triggers force row level security;
alter table automation_queue enable row level security;
alter table automation_queue force row level security;
alter table automation_runs enable row level security;
alter table automation_runs force row level security;
alter table automation_run_steps enable row level security;
alter table automation_run_steps force row level security;
alter table automation_rotations enable row level security;
alter table automation_rotations force row level security;
alter table automation_files enable row level security;
alter table automation_files force row level security;
alter table record_contact_emails enable row level security;
alter table record_contact_emails force row level security;
alter table mail_record_links enable row level security;
alter table mail_record_links force row level security;

-- ── Admin module permission: Full edit, View only, Hidden ────────────────────
-- Spec. This one admin page has a View level; the others stay Hidden or Full.
create or replace function permission_setting_valid(p_key text, p_value text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_key ~ '^action\.(create|team|archive|modules|pipeline|pipeline_change|team_view_open|team_take)$' then p_value in ('yes', 'no')
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
