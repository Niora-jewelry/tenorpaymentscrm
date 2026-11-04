-- Maverick integration (Maverick Integration — Feature Spec, 3 Nov 2026).
--
-- Built now, with the API wired in once Maverick's documentation is in (client,
-- 4 Nov 2026: "Build now, plug API later"). Everything here is processor-neutral
-- ("Maverick only for now. It is built so other processors can be added later"):
-- each table carries a `processor` column, and the code reaches Maverick through
-- one adapter (lib/processors/vendor).
--
-- Every table is server-only: no browser role can read or write it. The server
-- reads after lib/processors/access.ts has checked the viewer's permissions, so a
-- hidden item is never sent to the browser.

-- ── 1. Permissions: two sets (spec, Permissions) ─────────────────────────────
-- Set 1, Reporting (presented as TapDash's own): Hidden / View, the tab and its
--   Acquiring and ACH sub-items separately.
-- Set 2, the Maverick group: Yes / No each.

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
    when p_key like 'reporting.%' then 'hidden'
    when p_key like 'maverick.%' then 'no'
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
          'action.create', 'action.team', 'action.archive', 'action.modules', 'action.pipeline', 'action.pipeline_change',
          'action.team_view_open', 'action.team_take', 'action.mark_files_required', 'action.awaiting_client',
          'notifications.scope', 'email.scope', 'phone.scope', 'calendar.scope', 'chat.scope',
          'admin.users', 'admin.permissions', 'admin.presets', 'admin.numbers', 'admin.residuals',
          'admin.integrations', 'admin.automations', 'admin.recycle_bin',
          'communication.scope', 'items.cases', 'items.updates', 'items.notes',
          'applications.pdfs', 'agreements.send',
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

-- Defaults per user type, from the spec's two tables. Reconciler and Accounting
-- are set the same (this CRM has one type for both: accounting). The super admin
-- has everything regardless. Other cases: Admin included (open question, the
-- spec's proposed default is yes).
insert into permission_settings (owner_kind, owner_id, key, value)
select 'template', pt.id, d.key,
       case pt.user_type
         when 'super_admin'      then d.super_admin
         when 'admin'            then d.admin
         when 'underwriter'      then d.underwriter
         when 'accounting'       then d.accounting
         when 'customer_service' then d.customer_service
         when 'sales_agent'      then d.sales_agent
       end
  from permission_templates pt
 cross join (values
   --  key                          super   admin   underw  acctg   cust    sales
   ('reporting.tab',               'view', 'view', 'view', 'view', 'view', 'view'),
   ('reporting.acquiring',         'view', 'view', 'view', 'view', 'view', 'view'),
   ('reporting.ach',               'view', 'view', 'view', 'view', 'view', 'view'),
   ('maverick.status',             'yes',  'yes',  'yes',  'yes',  'yes',  'no'),
   ('maverick.send',               'yes',  'yes',  'yes',  'no',   'no',   'no'),
   ('maverick.update',             'yes',  'yes',  'yes',  'no',   'no',   'no'),
   ('maverick.check',              'yes',  'yes',  'yes',  'no',   'no',   'no'),
   ('maverick.other_cases',        'yes',  'yes',  'yes',  'yes',  'yes',  'no'),
   ('maverick.sync_case',          'yes',  'yes',  'yes',  'yes',  'yes',  'no'),
   ('maverick.unmatched_flag',     'yes',  'yes',  'yes',  'no',   'no',   'no'),
   ('maverick.resolve_unmatched',  'yes',  'yes',  'no',   'no',   'no',   'no'),
   ('maverick.alerts',             'yes',  'yes',  'no',   'no',   'no',   'no'),
   ('maverick.connection',         'yes',  'no',   'no',   'no',   'no',   'no')
 ) as d(key, super_admin, admin, underwriter, accounting, customer_service, sales_agent)
 where pt.user_type in ('super_admin', 'admin', 'underwriter', 'accounting', 'customer_service', 'sales_agent')
on conflict (owner_kind, owner_id, key) do nothing;

-- ── 2. The Reporting tab, by flag ────────────────────────────────────────────
-- Spec: "in the Contacts module only". Which module carries it is this seed row
-- in module_tab_order, configuration like any other tab; no code names it.
alter table tabs add column if not exists shows_reporting boolean not null default false;
comment on column tabs.shows_reporting is 'This tab carries Reporting (processor data, full screen). A flag, so no code names the tab.';

do $$
declare v_tab uuid;
begin
  if not exists (select 1 from tabs where key = 'reporting') then
    insert into tabs (key, label, kind, is_system, accepts_fields, position, shows_reporting)
    values ('reporting', 'Reporting', 'custom', false, false, (select coalesce(max(position), 0) + 10 from tabs), true)
    returning id into v_tab;
    insert into module_tab_order (module_id, tab_id, position)
    select m.id, v_tab, coalesce((select max(o.position) from module_tab_order o where o.module_id = m.id), 0) + 10
      from modules m
     where m.slug = 'contacts'
    on conflict do nothing;
  end if;
end $$;

-- ── 3. Processor data ────────────────────────────────────────────────────────
-- Merchants on the processor's side, matched to a record by MID. No record = the
-- unmatched flag (spec, Matching).
create table if not exists processor_merchants (
  id            uuid primary key default gen_random_uuid(),
  processor     text not null default 'maverick' check (processor ~ '^[a-z][a-z_]{1,30}$'),
  external_id   text not null,
  mid           text,
  name          text,
  record_id     uuid references records(id) on delete set null,
  matched_by    uuid references profiles(id) on delete set null,
  matched_at    timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  -- When this merchant's history was first pulled (spec: the first sync goes back two weeks).
  backfilled_at timestamptz,
  unique (processor, external_id)
);
create index if not exists processor_merchants_record on processor_merchants (record_id);
create index if not exists processor_merchants_mid on processor_merchants (processor, mid);

-- The last successful sync per data type, and any current error (spec, Sync status).
create table if not exists processor_sync_state (
  id              uuid primary key default gen_random_uuid(),
  processor       text not null,
  data_type       text not null check (data_type in ('merchants', 'transactions', 'batches', 'payouts', 'ach', 'statements', 'tickets', 'application_status')),
  last_success_at timestamptz,
  last_attempt_at timestamptz,
  last_error      text check (last_error is null or char_length(last_error) <= 500),
  unique (processor, data_type)
);

create table if not exists processor_sync_runs (
  id          uuid primary key default gen_random_uuid(),
  processor   text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  outcome     text check (outcome in ('ok', 'partial', 'failed', 'skipped')),
  -- Per data type: { ok, added, error }. Never a card number or credential.
  summary     jsonb not null default '{}'::jsonb,
  -- One run per processor per New York day, whichever cron fires first.
  run_day     date not null default (now() at time zone 'America/New_York')::date,
  unique (processor, run_day)
);

-- Reporting › Acquiring transactions. Card numbers: last four only, never stored in full.
create table if not exists processor_transactions (
  id               uuid primary key default gen_random_uuid(),
  processor        text not null,
  merchant_id      uuid not null references processor_merchants(id) on delete cascade,
  record_id        uuid references records(id) on delete cascade,
  external_id      text not null,
  card_type        text,
  card_brand       text,
  card_last4       text check (card_last4 is null or card_last4 ~ '^[0-9]{4}$'),
  amount           numeric(14, 2),
  terminal_id      text,
  transaction_type text,
  message_type     text,
  payment_type     text,
  authorized_at    timestamptz,
  response_code    text,
  status           text,
  synced_at        timestamptz not null default now(),
  unique (processor, external_id)
);
create index if not exists processor_transactions_record on processor_transactions (record_id, authorized_at desc);

create table if not exists processor_batches (
  id           uuid primary key default gen_random_uuid(),
  processor    text not null,
  merchant_id  uuid not null references processor_merchants(id) on delete cascade,
  record_id    uuid references records(id) on delete cascade,
  external_id  text not null,
  batch_date   date,
  amount       numeric(14, 2),
  sales        numeric(14, 2),
  credits      numeric(14, 2),
  batch_count  integer,
  synced_at    timestamptz not null default now(),
  unique (processor, external_id)
);
create index if not exists processor_batches_record on processor_batches (record_id, batch_date desc);

create table if not exists processor_payouts (
  id                 uuid primary key default gen_random_uuid(),
  processor          text not null,
  merchant_id        uuid not null references processor_merchants(id) on delete cascade,
  record_id          uuid references records(id) on delete cascade,
  external_id        text not null,
  payout_date        date,
  deposit_amount     numeric(14, 2),
  chargeback_count   integer,
  chargeback_amount  numeric(14, 2),
  non_settled_amount numeric(14, 2),
  fee_amount         numeric(14, 2),
  reserve_amount     numeric(14, 2),
  released_amount    numeric(14, 2),
  synced_at          timestamptz not null default now(),
  unique (processor, external_id)
);
create index if not exists processor_payouts_record on processor_payouts (record_id, payout_date desc);

create table if not exists processor_ach_transactions (
  id               uuid primary key default gen_random_uuid(),
  processor        text not null,
  merchant_id      uuid not null references processor_merchants(id) on delete cascade,
  record_id        uuid references records(id) on delete cascade,
  external_id      text not null,
  transaction_type text,
  amount           numeric(14, 2),
  contact_name     text,
  memo             text,
  status           text,
  transaction_date date,
  created_on       timestamptz,
  synced_at        timestamptz not null default now(),
  unique (processor, external_id)
);
create index if not exists processor_ach_record on processor_ach_transactions (record_id, transaction_date desc);

-- Other cases: the processor's support tickets, read-only, each linked one-to-one
-- to a regular case.
create table if not exists processor_tickets (
  id            uuid primary key default gen_random_uuid(),
  processor     text not null,
  merchant_id   uuid references processor_merchants(id) on delete set null,
  record_id     uuid references records(id) on delete cascade,
  external_id   text not null,
  mid           text,
  title         text,
  status        text,
  -- The left-hand panel of the processor's ticket screen: [{ label, value }] in its order.
  details       jsonb not null default '[]'::jsonb,
  opened_at     timestamptz,
  changed_at    timestamptz,
  synced_at     timestamptz not null default now(),
  case_id       uuid unique references cases(id) on delete set null,
  linked_by     uuid references profiles(id) on delete set null,
  linked_at     timestamptz,
  unique (processor, external_id)
);
create index if not exists processor_tickets_record on processor_tickets (record_id) where case_id is null;

-- The merchant's application on the processor's side.
create table if not exists processor_applications (
  id             uuid primary key default gen_random_uuid(),
  processor      text not null,
  record_id      uuid not null references records(id) on delete cascade,
  external_id    text,
  status         text,
  status_at      timestamptz,
  last_action    text check (last_action in ('create', 'update')),
  last_sent_at   timestamptz,
  last_sent_by   uuid references profiles(id) on delete set null,
  last_error     text check (last_error is null or char_length(last_error) <= 1000),
  last_error_at  timestamptz,
  unique (processor, record_id)
);

-- A statement for a month that already holds one waits here for a person to
-- choose keep or replace (spec, Statements).
create table if not exists processor_statement_choices (
  id           uuid primary key default gen_random_uuid(),
  processor    text not null,
  record_id    uuid not null references records(id) on delete cascade,
  month        date not null check (extract(day from month) = 1),
  external_id  text not null,
  storage_path text not null,
  name         text not null,
  created_at   timestamptz not null default now(),
  decided_by   uuid references profiles(id) on delete set null,
  decided_at   timestamptz,
  decision     text check (decision in ('keep', 'replace')),
  unique (processor, external_id)
);

do $$
declare t text;
begin
  foreach t in array array['processor_merchants', 'processor_sync_state', 'processor_sync_runs', 'processor_transactions',
                           'processor_batches', 'processor_payouts', 'processor_ach_transactions', 'processor_tickets',
                           'processor_applications', 'processor_statement_choices']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('revoke all on %I from public, anon, authenticated', t);
  end loop;
end $$;

-- ── 4. Logging and notifications ─────────────────────────────────────────────
alter type activity_kind add value if not exists 'processor';

alter table notifications drop constraint if exists notifications_source_kind_check;
alter table notifications add constraint notifications_source_kind_check check (source_kind = any (array[
  'update', 'mention', 'case', 'call', 'voicemail', 'recording', 'sms', 'mention_update', 'mention_case_reply',
  'mention_field', 'agreement', 'automation', 'automation_alert', 'proposal', 'processor'
]));

/*
 * The record's history and its Updates tab, together (spec, Logging: "Every Send
 * to Maverick and Update Maverick is logged … in the record's Updates tab").
 * The Updates post needs an author: the person, else the record's creator, else
 * the first active admin, as agreement_log does.
 */
create or replace function processor_log(p_record uuid, p_actor uuid, p_source text, p_summary text, p_update_body text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_auth uuid;
begin
  insert into record_activity (record_id, actor_id, kind, summary, source)
  values (p_record, p_actor, 'processor', left(p_summary, 500), left(p_source, 80));
  if p_update_body is not null then
    v_auth := coalesce(
      (select id from profiles where id = p_actor and deleted_at is null),
      (select r.creator_user_id from records r join profiles p on p.id = r.creator_user_id where r.id = p_record and p.deleted_at is null),
      (select p.id from profiles p join roles r on r.id = p.role_id where r.is_admin and p.deleted_at is null and p.status = 'active' order by p.created_at limit 1));
    if v_auth is not null then
      insert into updates (record_id, author_id, body) values (p_record, v_auth, left(p_update_body, 4000));
    end if;
  end if;
end $$;

/* Sync-failure alerts: everyone active holding "Receive Maverick sync-failure alerts". */
create or replace function processor_alert(p_body text, p_preview text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare n int := 0; r uuid;
begin
  for r in
    select p.id from profiles p
     where p.deleted_at is null and p.status = 'active' and user_perm(p.id, 'maverick.alerts') = 'yes'
  loop
    insert into notifications (recipient_id, actor_id, body, record_id, source_kind, preview)
    values (r, null, left(p_body, 500), null, 'processor', left(p_preview, 500));
    n := n + 1;
  end loop;
  return n;
end $$;

/*
 * A status read from the processor. When it changed: the history and Updates
 * entry, and the automation trigger "Maverick application status changes".
 * The processor, not a person, makes this change, so it is the spec's one
 * exception to "only people start automations"; no chaining still holds
 * (automation_fire refuses inside a run).
 */
create or replace function processor_set_application_status(p_processor text, p_record uuid, p_external_id text, p_status text, p_label text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_old text;
begin
  select status into v_old from processor_applications where processor = p_processor and record_id = p_record for update;
  if found and v_old is not distinct from p_status then return false; end if;
  insert into processor_applications (processor, record_id, external_id, status, status_at)
  values (p_processor, p_record, p_external_id, p_status, now())
  on conflict (processor, record_id) do update
    set status = excluded.status, status_at = excluded.status_at,
        external_id = coalesce(processor_applications.external_id, excluded.external_id);
  perform processor_log(p_record, null, initcap(p_processor),
    format('Application status changed: %s → %s', coalesce(v_old, '(none)'), coalesce(p_label, p_status)),
    format('%s application status changed from %s to %s.', initcap(p_processor), coalesce(v_old, '(none)'), coalesce(p_label, p_status)));
  perform automation_fire('processor_status', p_record, null, jsonb_build_object('value', p_status), null, now(),
                          -- A status can come back later (A → B → A), so the time is part of the key.
                          'pstatus:' || p_processor || ':' || coalesce(p_status, '') || ':' || (extract(epoch from now()) * 1000)::bigint);
  return true;
end $$;

/* One ticket ↔ one case. Logged on the record, and on the case's thread as its reply. */
create or replace function processor_link_ticket(p_ticket uuid, p_case uuid, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare t processor_tickets%rowtype; c cases%rowtype;
begin
  select * into t from processor_tickets where id = p_ticket for update;
  if not found then raise exception 'That ticket no longer exists.' using errcode = 'P0002'; end if;
  if t.case_id is not null then raise exception 'That ticket is already linked to a case.' using errcode = '23505'; end if;
  select * into c from cases where id = p_case and deleted_at is null for update;
  if not found then raise exception 'That case no longer exists.' using errcode = 'P0002'; end if;
  if c.record_id is distinct from t.record_id then raise exception 'That case is on another record.' using errcode = '22023'; end if;
  if exists (select 1 from processor_tickets where case_id = p_case) then raise exception 'That case is already linked to another ticket.' using errcode = '23505'; end if;
  update processor_tickets set case_id = p_case, linked_by = p_actor, linked_at = now() where id = p_ticket;
  perform processor_log(t.record_id, p_actor, initcap(t.processor),
    format('Other case %s linked to case #%s', coalesce(t.external_id, ''), c.number),
    null);
end $$;

-- A merchant matched (or unmatched) by hand. Logged on the record.
create or replace function processor_match_merchant(p_merchant uuid, p_record uuid, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare m processor_merchants%rowtype;
begin
  select * into m from processor_merchants where id = p_merchant for update;
  if not found then raise exception 'That merchant no longer exists.' using errcode = 'P0002'; end if;
  update processor_merchants set record_id = p_record, matched_by = p_actor, matched_at = now() where id = p_merchant;
  update processor_transactions set record_id = p_record where merchant_id = p_merchant;
  update processor_batches set record_id = p_record where merchant_id = p_merchant;
  update processor_payouts set record_id = p_record where merchant_id = p_merchant;
  update processor_ach_transactions set record_id = p_record where merchant_id = p_merchant;
  update processor_tickets set record_id = p_record where merchant_id = p_merchant and case_id is null;
  if p_record is not null then
    perform processor_log(p_record, p_actor, initcap(m.processor), format('Matched to %s merchant %s (MID %s)', initcap(m.processor), coalesce(m.name, m.external_id), coalesce(m.mid, 'none')), null);
  end if;
  if m.record_id is not null and m.record_id is distinct from p_record then
    perform processor_log(m.record_id, p_actor, initcap(m.processor), format('Unmatched from %s merchant %s', initcap(m.processor), coalesce(m.name, m.external_id)), null);
  end if;
end $$;

do $$
declare f text;
begin
  foreach f in array array['processor_log(uuid,uuid,text,text,text)', 'processor_alert(text,text)',
                           'processor_set_application_status(text,uuid,text,text,text)', 'processor_link_ticket(uuid,uuid,uuid)',
                           'processor_match_merchant(uuid,uuid,uuid)']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- ── 5. The automation trigger "Maverick application status changes" ─────────
create or replace function public.automation_trigger_match(t jsonb)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select case t ->> 'type'
    when 'status'           then jsonb_build_object('value', t -> 'value')
    when 'stage'            then jsonb_build_object('pipeline', t -> 'pipelineId', 'step', t -> 'stepId')
    when 'team_assigned'    then jsonb_build_object('team', t -> 'teamId')
    when 'team_removed'     then jsonb_build_object('team', t -> 'teamId')
    when 'module_assigned'  then jsonb_build_object('module', t -> 'moduleId')
    when 'module_removed'   then jsonb_build_object('module', t -> 'moduleId')
    when 'field'            then jsonb_build_object('field', t -> 'field')
                                 || case when nullif(t ->> 'value', '') is null then '{}'::jsonb else jsonb_build_object('value', t -> 'value') end
    when 'file_uploaded'    then jsonb_build_object('rows', t -> 'rows', 'frequency', t -> 'frequency')
    when 'ticket_email'     then jsonb_build_object('mailbox', t -> 'mailboxId')
    when 'processor_status' then case when nullif(t ->> 'value', '') is null then '{}'::jsonb else jsonb_build_object('value', t -> 'value') end
    else '{}'::jsonb
  end;
$$;
