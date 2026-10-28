-- =============================================================================
-- Prepopulated Application (spec, 27 Oct 2026) — the data behind it.
--
--   applications          one per "Send Application": APP-000123, a secure
--                         link token (only its HMAC is searchable; a sealed
--                         copy lets "Resend" send the same link), who sent it,
--                         when, status, the merchant's autosaved answers.
--   application_changes   every returned answer, one row per CRM target:
--                         filled automatically, waiting for review, accepted
--                         or kept. The review screen IS this table.
--   application_files     returned PDFs. They hold SSNs: the bytes are
--                         encrypted by the app before upload to a bucket no
--                         browser can read; opening one is a permission
--                         (applications.pdfs).
--   application_settings  the link lifetime (30 days unless changed) and the
--                         editable email template.
--
-- Field history gains a `source` ("Application APP-000123, online"). Every
-- value an application writes goes through application_write_values, which
-- writes the value, its history row and the decision in ONE transaction.
--
-- Everything here is default-deny: authenticated users may READ what belongs
-- to records they can open; every write goes through the server.
-- =============================================================================

-- ── who may open a returned application PDF (they contain SSNs) ─────────────
create or replace function permission_setting_valid(p_key text, p_value text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_key ~ '^action\.(create|team|archive|modules|pipeline)$' then p_value in ('yes', 'no')
    when p_key ~ '^module:[0-9a-f-]{36}$'                          then p_value in ('hidden', 'mine', 'all')
    when p_key in ('notifications.scope', 'email.scope', 'phone.scope') then p_value in ('own', 'all')
    when p_key ~ '^admin\.(users|permissions|presets|numbers|residuals|integrations|automations|recycle_bin)$'
                                                                    then p_value in ('hidden', 'full')
    when p_key = 'communication.scope'                              then p_value in ('own', 'org')
    when p_key = 'items.cases'                                      then p_value in ('hidden', 'mine', 'all')
    when p_key in ('items.updates', 'items.notes')                  then p_value in ('mine', 'all')
    when p_key = 'applications.pdfs'                                then p_value in ('hidden', 'full')
    else false
  end;
$$;

create or replace function permission_setting_max(p_key text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_key like 'action.%' then 'yes'
    when p_key like 'module:%' then 'all'
    when p_key like 'admin.%' then 'full'
    when p_key = 'applications.pdfs' then 'full'
    when p_key = 'communication.scope' then 'org'
    when p_key like '%.scope' then 'all'
    when p_key like 'items.%' then 'all'
  end;
$$;

create or replace function permission_setting_min(p_key text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_key like 'action.%' then 'no'
    when p_key like 'module:%' then 'hidden'
    when p_key like 'admin.%' then 'hidden'
    when p_key = 'applications.pdfs' then 'hidden'
    when p_key = 'communication.scope' then 'own'
    when p_key like '%.scope' then 'own'
    when p_key = 'items.cases' then 'hidden'
    when p_key like 'items.%' then 'mine'
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
          'action.create', 'action.team', 'action.archive', 'action.modules', 'action.pipeline',
          'notifications.scope', 'email.scope', 'phone.scope',
          'admin.users', 'admin.permissions', 'admin.presets', 'admin.numbers', 'admin.residuals',
          'admin.integrations', 'admin.automations', 'admin.recycle_bin',
          'communication.scope', 'items.cases', 'items.updates', 'items.notes',
          'applications.pdfs'
        ]) as k
    ),
    'modules', (select coalesce(jsonb_object_agg(m.id::text, user_module_scope(u, m.id)), '{}'::jsonb) from modules m)
  );
$$;

-- The spec's example: Super admin (always), Admin, Underwriter.
insert into permission_settings (owner_kind, owner_id, key, value)
select 'template', pt.id, 'applications.pdfs',
       case when pt.user_type in ('admin', 'underwriter') then 'full' else 'hidden' end
  from permission_templates pt
 where pt.user_type is not null and pt.user_type <> 'super_admin'
on conflict (owner_kind, owner_id, key) do nothing;

-- ── field history: where a value came from ──────────────────────────────────
alter table record_activity add column if not exists source text;
comment on column record_activity.source is
  'Where a value came from when it was not typed in the CRM, e.g. "Application APP-000123, online". Null for an ordinary edit.';

-- ── settings ────────────────────────────────────────────────────────────────
create table if not exists application_settings (
  singleton        boolean primary key default true check (singleton),
  link_expiry_days int not null default 30 check (link_expiry_days between 1 and 365),
  email_subject    text not null default 'Your {{company}} merchant application',
  email_body       text not null default
    'Hi {{contact_name}},' || chr(10) || chr(10) ||
    'Here is your merchant application. We have filled in what we already know, so it should only take a few minutes.' || chr(10) || chr(10) ||
    'Complete it online: {{link}}' || chr(10) || chr(10) ||
    'Or fill in the attached PDF on your computer and send it back to us.' || chr(10) || chr(10) ||
    'The link is valid until {{expires}}.' || chr(10) || chr(10) ||
    'Thank you,' || chr(10) || '{{sender_name}}',
  updated_by       uuid references profiles(id) on delete set null,
  updated_at       timestamptz not null default now()
);
insert into application_settings (singleton) values (true) on conflict do nothing;
alter table application_settings enable row level security;
alter table application_settings force row level security;
revoke all on application_settings from anon, authenticated;
grant select on application_settings to authenticated;
drop policy if exists application_settings_select on application_settings;
create policy application_settings_select on application_settings for select to authenticated using (true);

-- ── applications ────────────────────────────────────────────────────────────
create sequence if not exists application_number_seq start 1;

do $$ begin
  create type application_status as enum
    ('sent', 'opened', 'submitted', 'pdf_uploaded', 'reviewed', 'expired', 'voided');
exception when duplicate_object then null; end $$;

create table if not exists applications (
  id             uuid primary key default gen_random_uuid(),
  number         bigint not null unique default nextval('application_number_seq'),
  record_id      uuid not null references records(id) on delete cascade,
  token_hash     bytea not null unique,
  token_sealed   bytea not null,
  token_iv       bytea not null,
  status         application_status not null default 'sent',
  recipient      text not null,
  cc             text[] not null default '{}',
  subject        text not null,
  sent_by        uuid references profiles(id) on delete set null,
  sent_at        timestamptz not null default now(),
  last_sent_at   timestamptz not null default now(),
  send_count     int not null default 1,
  expires_at     timestamptz not null,
  opened_at      timestamptz,
  submitted_at   timestamptz,
  returned_via   text check (returned_via in ('online', 'pdf')),
  reviewed_at    timestamptz,
  voided_at      timestamptz,
  voided_by      uuid references profiles(id) on delete set null,
  -- The merchant's online answers as they type ("save and finish later").
  -- SSNs are never in here: they are sealed separately by the app.
  draft          jsonb not null default '{}'::jsonb,
  draft_sealed   bytea,
  draft_iv       bytea,
  draft_saved_at timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists applications_record on applications (record_id, sent_at desc);
comment on column applications.token_hash is
  'HMAC-SHA256 of the link token (OTP_PEPPER). The URL carries the token; the database can only match it.';
comment on column applications.token_sealed is
  'The link token, AES-256-GCM sealed by the app, so Resend can send the SAME link. Never readable by a browser.';

create or replace function application_label(p_number bigint)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$ select 'APP-' || lpad(p_number::text, 6, '0'); $$;

alter table applications enable row level security;
alter table applications force row level security;
revoke all on applications from anon, authenticated;
-- Not the token, the sealed copies or the draft: those columns are for the server.
grant select (id, number, record_id, status, recipient, cc, subject, sent_by, sent_at, last_sent_at,
              send_count, expires_at, opened_at, submitted_at, returned_via, reviewed_at,
              voided_at, voided_by, draft_saved_at, created_at)
  on applications to authenticated;
drop policy if exists applications_select on applications;
create policy applications_select on applications for select to authenticated
  using (record_visible(record_id) and tab_visible(record_id, 'application'));

-- ── returned answers, one row per CRM target ────────────────────────────────
create table if not exists application_changes (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  record_id      uuid not null references records(id) on delete cascade,
  -- What it writes: a field key, a repeat-group member ("owner_ownership.1.first")
  -- or a field's notes ("notes:bankruptcy").
  target         text not null,
  field_key      text not null,
  question       text not null,
  crm_value      jsonb,
  answer_value   jsonb not null,
  answer_display text not null,
  crm_display    text,
  via            text not null check (via in ('online', 'pdf', 'manual')),
  status         text not null check (status in ('applied', 'pending', 'accepted', 'kept')),
  decided_by     uuid references profiles(id) on delete set null,
  decided_at     timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists application_changes_app on application_changes (application_id, status);
alter table application_changes enable row level security;
alter table application_changes force row level security;
revoke all on application_changes from anon, authenticated;
grant select on application_changes to authenticated;
drop policy if exists application_changes_select on application_changes;
-- A field the person may not see is not shown in review either.
create policy application_changes_select on application_changes for select to authenticated
  using (record_visible(record_id) and tab_visible(record_id, 'application')
         and record_field_grant(record_id, field_key) <> 'hidden');

-- ── returned PDFs (encrypted bytes; metadata readable) ──────────────────────
create table if not exists application_files (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid references applications(id) on delete set null,
  record_id      uuid not null references records(id) on delete cascade,
  storage_path   text not null unique,
  name           text not null,
  size_bytes     int not null check (size_bytes between 1 and 26214400),
  iv             bytea not null,
  readable       boolean not null,
  fields_found   int not null default 0,
  uploaded_by    uuid references profiles(id) on delete set null,
  uploaded_via   text not null check (uploaded_via in ('crm', 'merchant')),
  uploaded_at    timestamptz not null default now()
);
create index if not exists application_files_record on application_files (record_id, uploaded_at desc);
alter table application_files enable row level security;
alter table application_files force row level security;
revoke all on application_files from anon, authenticated;
grant select (id, application_id, record_id, name, size_bytes, readable, fields_found, uploaded_by, uploaded_via, uploaded_at)
  on application_files to authenticated;
drop policy if exists application_files_select on application_files;
create policy application_files_select on application_files for select to authenticated
  using (record_visible(record_id) and tab_visible(record_id, 'application'));

-- A private bucket with NO policies for browsers: only the server (service
-- role) reads or writes it, after its own permission check.
insert into storage.buckets (id, name, public, file_size_limit)
values ('application-pdfs', 'application-pdfs', false, 26214400)
on conflict (id) do nothing;

-- ── the one writer of values that come from an application ─────────────────
-- p_values: { field_key: full new value }   (repeat groups as whole arrays)
-- p_notes:  [ { field_key, body } ]          (a details box → that field's notes)
-- p_changes: application_changes ids this write settles, and their new status.
-- Value, history row (with source), notes and decisions: one transaction.
create or replace function application_write_values(
  p_application uuid,
  p_values      jsonb,
  p_notes       jsonb,
  p_change_ids  uuid[],
  p_status      text,
  p_actor       uuid,
  p_via         text,
  p_expected_updated_at timestamptz
)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a        record;
  v_old    jsonb;
  v_at     timestamptz;
  v_source text;
  v_bad    text;
  n        jsonb;
begin
  select ap.id, ap.number, ap.record_id, ap.sent_by into a from applications ap where ap.id = p_application;
  if a.id is null then raise exception 'That application no longer exists.'; end if;
  if p_status not in ('applied', 'accepted', 'kept') then raise exception 'bad status'; end if;
  if p_via not in ('online', 'pdf', 'manual') then raise exception 'bad source'; end if;
  v_source := 'Application ' || application_label(a.number) || ', ' || case p_via when 'manual' then 'entered from PDF' else p_via end;

  p_values := coalesce(p_values, '{}'::jsonb);
  select k into v_bad from jsonb_object_keys(p_values) k
   where k = 'deal_name' or is_pipeline_status_key(k)
      or not exists (select 1 from fields f where f.key = k and f.archived_at is null and f.type not in ('auto', 'grid'))
   limit 1;
  if v_bad is not null then raise exception 'An application cannot write %.', v_bad; end if;

  select r.values into v_old from records r where r.id = a.record_id and r.deleted_at is null for update;
  if v_old is null then raise exception 'not found'; end if;

  if p_values <> '{}'::jsonb then
    update records
       set values = values || p_values, updated_at = now()
     where id = a.record_id
       and (p_expected_updated_at is null or records.updated_at = p_expected_updated_at)
    returning updated_at into v_at;
    if v_at is null then
      raise exception 'The record changed while this was being applied. Reload and try again.' using errcode = '40001';
    end if;

    insert into record_activity (record_id, actor_id, kind, field_key, summary, from_value, to_value, source)
    select a.record_id, p_actor, 'field', k,
           coalesce((select f.label from fields f where f.key = k), k) || ' set from ' || application_label(a.number),
           v_old -> k #>> '{}', p_values -> k #>> '{}', v_source
      from jsonb_object_keys(p_values) k
     where (v_old -> k) is distinct from (p_values -> k);
  else
    select updated_at into v_at from records where id = a.record_id;
  end if;

  for n in select * from jsonb_array_elements(coalesce(p_notes, '[]'::jsonb)) loop
    insert into notes (record_id, scope_kind, scope_id, author_id, body)
    values (a.record_id, 'field', n ->> 'field_key',
            coalesce(p_actor, a.sent_by, (select creator_user_id from records where id = a.record_id)),
            (n ->> 'body') || chr(10) || '— ' || v_source);
  end loop;

  if p_change_ids is not null and cardinality(p_change_ids) > 0 then
    update application_changes
       set status = p_status, decided_by = p_actor, decided_at = now()
     where application_id = p_application and id = any (p_change_ids);
  end if;

  return v_at;
end;
$$;
revoke execute on function application_write_values(uuid, jsonb, jsonb, uuid[], text, uuid, text, timestamptz) from public, anon, authenticated;
