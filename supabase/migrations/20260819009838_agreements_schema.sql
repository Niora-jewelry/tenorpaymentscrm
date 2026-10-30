-- =============================================================================
-- Agreements: a merchant agreement filled from the CRM, sent for e-signature
-- (SignWell), tracked by webhook, and filed back on the record signed.
-- Client spec "CRM Auto-Agreement Send", 27 Oct 2026, with the 30 Oct rulings.
--
-- Shape mirrors the Prepopulated Application (9827): a kind is a config row,
-- the panel hangs off a tab by flag, files are sealed in a private bucket,
-- the secrets (vendor ids, the sealed snapshot) are withheld from
-- `authenticated` by column grants, and every table is RLS-forced.
--
-- Also here: the CRM fields the agreement needs that did not exist (spec §7),
-- the "Send agreement" permission key, and the Agreements tab.
-- =============================================================================

-- ── CRM fields the agreement prints (spec §7) ────────────────────────────────
do $$
declare
  v_contact   uuid := (select id from tabs where key = 'contact');
  v_pricing   uuid := (select id from tabs where key = 'pricing');
  v_td        uuid := (select s.id from subtabs s where s.tab_id = v_pricing and s.key = 'td_merchant');
  v_overview  uuid := (select id from tabs where key = 'overview');
  v_pm        uuid := (select id from fields where key = 'pricing_model');
  r           record;
begin
  -- Business phone and Business email, first on the Contact tab; backfilled
  -- from the first contact where the record has one.
  if not exists (select 1 from fields where key = 'business_phone') then
    insert into fields (key, label, type, tab_id, subtab_id, position, hint, sync_enabled)
    values ('business_phone', 'Business phone', 'phone', v_contact, null,
            (select coalesce(min(position), 0) - 20 from fields where tab_id = v_contact and subtab_id is null), 'The number printed on agreements.', false);
  end if;
  if not exists (select 1 from fields where key = 'business_email') then
    insert into fields (key, label, type, tab_id, subtab_id, position, hint, sync_enabled)
    values ('business_email', 'Business email', 'email', v_contact, null,
            (select coalesce(min(position), 0) - 10 from fields where tab_id = v_contact and subtab_id is null), 'The address printed on agreements.', false);
  end if;
  for r in
    select id, values -> 'contact' -> 0 ->> 'phone' as phone, values -> 'contact' -> 0 ->> 'email' as email
      from records where jsonb_typeof(values -> 'contact') = 'array'
  loop
    if r.phone is not null and r.phone <> '' and not (exists (select 1 from records x where x.id = r.id and x.values ? 'business_phone')) then
      update records set values = jsonb_set(values, '{business_phone}', to_jsonb(r.phone)) where id = r.id;
    end if;
    if r.email is not null and r.email <> '' and not (exists (select 1 from records x where x.id = r.id and x.values ? 'business_email')) then
      update records set values = jsonb_set(values, '{business_email}', to_jsonb(r.email)) where id = r.id;
    end if;
  end loop;

  -- Owners: address and date of birth; Private: driver's licence.
  update fields
     set repeat_schema = (
       select jsonb_agg(m) from jsonb_array_elements(repeat_schema) m
     ) || case when not (repeat_schema::text like '%"address"%') then '[{"key":"address","label":"Address","type":"address","width":320,"sync":false,"sensitive":false}]'::jsonb else '[]'::jsonb end
       || case when not (repeat_schema::text like '%"dob"%') then '[{"key":"dob","label":"Date of birth","type":"date","width":150,"sync":false,"sensitive":false}]'::jsonb else '[]'::jsonb end
   where key = 'owner_ownership';
  update fields
     set repeat_schema = (
       select jsonb_agg(m) from jsonb_array_elements(repeat_schema) m
     ) || case when not (repeat_schema::text like '%"dl_number"%') then '[{"key":"dl_number","label":"Driver''s license number","type":"text","width":180,"sync":false,"sensitive":true}]'::jsonb else '[]'::jsonb end
       || case when not (repeat_schema::text like '%"dl_expiry"%') then '[{"key":"dl_expiry","label":"Driver''s license expiry","type":"date","width":150,"sync":false,"sensitive":false}]'::jsonb else '[]'::jsonb end
   where key = 'owner_private';

  -- Pricing: PCI fee and EBT auth fee on Processor-TD Merchant Pricing.
  if not exists (select 1 from fields where key = 'td_pci_fee') then
    insert into fields (key, label, type, tab_id, subtab_id, position, section)
    values ('td_pci_fee', 'PCI Fee', 'currency', v_pricing, v_td, (select coalesce(max(position), 0) + 10 from fields where subtab_id = v_td), 'Acquirer/ACH merchant pricing');
  end if;
  if not exists (select 1 from fields where key = 'td_ebt_auth_fee') then
    insert into fields (key, label, type, tab_id, subtab_id, position, section)
    values ('td_ebt_auth_fee', 'EBT Auth Fee', 'currency', v_pricing, v_td, (select coalesce(max(position), 0) + 10 from fields where subtab_id = v_td), 'Acquirer/ACH merchant pricing');
  end if;

  -- Pricing model: IC+ · Flat Rate · Surcharge · Dual Pricing.
  if v_pm is not null then
    update field_choices set value = 'Flat Rate' where field_id = v_pm and key = 'fr';
    update field_choices set value = 'Dual Pricing' where field_id = v_pm and key = 'dp';
    if not exists (select 1 from field_choices where field_id = v_pm and key = 'surcharge') then
      insert into field_choices (field_id, module_id, key, value, position)
      values (v_pm, null, 'surcharge', 'Surcharge', (select coalesce(max(position), 0) + 10 from field_choices where field_id = v_pm));
    end if;
  end if;

  -- Customer profile → Customer location; recurring gets notes.
  update fields set label = 'Customer location' where key = 'customer_profile' and label = 'Customer profile';
  update fields set notes_enabled = true where key = 'recurring_subscription';
  update fields set hint = 'The processor the merchant uses today, or "No".' where key = 'prior_processor';
end $$;

-- ── The Agreements tab, by flag ───────────────────────────────────────────────
alter table tabs add column if not exists shows_agreements boolean not null default false;
comment on column tabs.shows_agreements is 'This tab carries the Agreements panel (e-signature). A flag, so no code names the tab.';

do $$
declare v_tab uuid;
begin
  if not exists (select 1 from tabs where key = 'agreements') then
    insert into tabs (key, label, kind, is_system, accepts_fields, position, shows_agreements)
    values ('agreements', 'Agreements', 'custom', false, false,
            (select coalesce(max(position), 0) + 10 from tabs), true)
    returning id into v_tab;
    -- On every display module, right after the Application tab.
    insert into module_tab_order (module_id, tab_id, position)
    select o.module_id, v_tab, o.position + 1
      from module_tab_order o join tabs t on t.id = o.tab_id
     where t.key = 'application'
    on conflict do nothing;
  end if;
end $$;

create or replace function agreements_tab_key()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select key::text from tabs where shows_agreements order by position limit 1;
$$;
grant execute on function agreements_tab_key() to authenticated;

-- ── Kinds and settings ────────────────────────────────────────────────────────
create table if not exists agreement_kinds (
  key            text primary key,
  label          text not null,
  template_file  text not null,
  position       int not null default 0,
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);
insert into agreement_kinds (key, label, template_file, position)
values ('maverick_merchant', 'Maverick merchant agreement', 'Maverick_Merchant_Agreement_v1.8.pdf', 0)
on conflict (key) do nothing;
alter table agreement_kinds enable row level security;
alter table agreement_kinds force row level security;
revoke all on agreement_kinds from anon, authenticated;
grant select on agreement_kinds to authenticated;
drop policy if exists agreement_kinds_read on agreement_kinds;
create policy agreement_kinds_read on agreement_kinds for select to authenticated using (true);

create table if not exists agreement_settings (
  singleton        boolean primary key default true check (singleton),
  expires_days     int not null default 30 check (expires_days between 1 and 365),
  reminders        boolean not null default true,
  requester_name   text not null default 'TapDash',
  requester_email  text,
  email_subject    text not null default 'Your merchant agreement — {{merchant}}',
  email_message    text not null default E'Hi {{signer_name}},\n\nPlease review and sign the merchant agreement for {{merchant}}. Every detail has been filled in from your application; you only need to sign and date where marked.\n\nThe link is valid until {{expires}}.\n\nThanks,\n{{sender_name}}',
  updated_by       uuid references profiles(id) on delete set null,
  updated_at       timestamptz not null default now()
);
insert into agreement_settings (singleton) values (true) on conflict do nothing;
alter table agreement_settings enable row level security;
alter table agreement_settings force row level security;
revoke all on agreement_settings from anon, authenticated;
grant select on agreement_settings to authenticated;
drop policy if exists agreement_settings_read on agreement_settings;
create policy agreement_settings_read on agreement_settings for select to authenticated using (true);

-- ── Agreements ────────────────────────────────────────────────────────────────
do $$ begin
  create type agreement_status as enum ('sending', 'sent', 'viewed', 'partially_signed', 'completed', 'declined', 'expired', 'voided');
exception when duplicate_object then null; end $$;
do $$ begin
  create type agreement_signer_status as enum ('sent', 'viewed', 'signed', 'declined', 'bounced');
exception when duplicate_object then null; end $$;

create sequence if not exists agreement_number_seq start 1;

create table if not exists agreements (
  id                  uuid primary key default gen_random_uuid(),
  number              bigint not null unique default nextval('agreement_number_seq'),
  record_id           uuid not null references records(id) on delete cascade,
  kind                text not null references agreement_kinds(key),
  status              agreement_status not null default 'sending',
  vendor              text not null default 'signwell',
  vendor_document_id  text unique,
  test_mode           boolean not null default false,
  sent_by             uuid references profiles(id) on delete set null,
  sent_at             timestamptz not null default now(),
  expires_at          timestamptz not null,
  last_event_at       timestamptz,
  completed_at        timestamptz,
  declined_at         timestamptz,
  decline_reason      text,
  expired_at          timestamptz,
  voided_at           timestamptz,
  voided_by           uuid references profiles(id) on delete set null,
  subject             text not null,
  message             text not null,
  requester_name      text not null,
  -- every value printed, sealed (AES-256-GCM, AAD 'agreement-snapshot:<id>')
  snapshot_sealed     bytea not null,
  snapshot_iv         bytea not null,
  used_field_keys     text[] not null default '{}',
  signer_count        int not null check (signer_count between 1 and 4),
  download_status     text not null default 'none' check (download_status in ('none', 'pending', 'stored', 'failed')),
  download_attempts   int not null default 0,
  next_attempt_at     timestamptz,
  download_note       text,
  created_at          timestamptz not null default now()
);
create index if not exists agreements_record on agreements (record_id, sent_at desc);
-- One open agreement per record (spec §5 / §9), where it cannot race.
create unique index if not exists agreements_one_open on agreements (record_id)
  where status in ('sending', 'sent', 'viewed', 'partially_signed');
create index if not exists agreements_download_due on agreements (next_attempt_at) where download_status = 'pending';

create table if not exists agreement_signers (
  id                  uuid primary key default gen_random_uuid(),
  agreement_id        uuid not null references agreements(id) on delete cascade,
  record_id           uuid not null references records(id) on delete cascade,
  slot                int not null check (slot between 1 and 4),
  owner_index         int not null,
  name                text not null,
  email               text not null,
  ownership_pct       numeric(6,2),
  vendor_recipient_id text,
  status              agreement_signer_status not null default 'sent',
  viewed_at           timestamptz,
  signed_at           timestamptz,
  declined_at         timestamptz,
  decline_reason      text,
  bounced_at          timestamptz,
  resent_at           timestamptz,
  unique (agreement_id, slot)
);
create index if not exists agreement_signers_agreement on agreement_signers (agreement_id);

-- The vendor's events, raw: the idempotency ledger. Server-only.
create table if not exists agreement_events (
  id                  uuid primary key default gen_random_uuid(),
  agreement_id        uuid not null references agreements(id) on delete cascade,
  vendor              text not null,
  vendor_document_id  text not null,
  event_type          text not null,
  event_time          timestamptz not null,
  event_hash          text,
  dedupe_key          text not null unique,
  signer_email        text,
  source              text not null check (source in ('webhook', 'fetch', 'housekeeping', 'user')),
  applied             boolean not null default false,
  received_at         timestamptz not null default now()
);

create table if not exists agreement_files (
  id            uuid primary key default gen_random_uuid(),
  agreement_id  uuid not null references agreements(id) on delete cascade,
  record_id     uuid not null references records(id) on delete cascade,
  kind          text not null check (kind in ('sent_copy', 'completed')),
  storage_path  text not null unique,
  name          text not null,
  size_bytes    int not null check (size_bytes between 1 and 52428800),
  iv            bytea not null,
  created_at    timestamptz not null default now(),
  unique (agreement_id, kind)
);
insert into storage.buckets (id, name, public, file_size_limit)
values ('agreement-pdfs', 'agreement-pdfs', false, 52428800)
on conflict (id) do nothing;

-- RLS: visible with the record and its Agreements tab; the secrets withheld.
alter table agreements enable row level security;
alter table agreements force row level security;
revoke all on agreements from anon, authenticated;
grant select (id, number, record_id, kind, status, vendor, test_mode, sent_by, sent_at, expires_at, last_event_at,
              completed_at, declined_at, decline_reason, expired_at, voided_at, voided_by, subject, requester_name,
              used_field_keys, signer_count, download_status, download_attempts, created_at)
  on agreements to authenticated;
drop policy if exists agreements_read on agreements;
create policy agreements_read on agreements for select to authenticated
  using (record_visible(record_id) and tab_visible(record_id, agreements_tab_key()));

alter table agreement_signers enable row level security;
alter table agreement_signers force row level security;
revoke all on agreement_signers from anon, authenticated;
grant select (id, agreement_id, record_id, slot, name, email, ownership_pct, status, viewed_at, signed_at, declined_at, decline_reason, bounced_at, resent_at)
  on agreement_signers to authenticated;
drop policy if exists agreement_signers_read on agreement_signers;
create policy agreement_signers_read on agreement_signers for select to authenticated
  using (record_visible(record_id) and tab_visible(record_id, agreements_tab_key()));

alter table agreement_events enable row level security;
alter table agreement_events force row level security;
revoke all on agreement_events from anon, authenticated;

alter table agreement_files enable row level security;
alter table agreement_files force row level security;
revoke all on agreement_files from anon, authenticated;
grant select (id, agreement_id, record_id, kind, name, size_bytes, created_at) on agreement_files to authenticated;
drop policy if exists agreement_files_read on agreement_files;
create policy agreement_files_read on agreement_files for select to authenticated
  using (record_visible(record_id) and tab_visible(record_id, agreements_tab_key()));

-- ── Notifications and activity ────────────────────────────────────────────────
alter table notifications add column if not exists agreement_id uuid references agreements(id) on delete cascade;
alter table notifications drop constraint if exists notifications_source_kind_check;
alter table notifications add constraint notifications_source_kind_check check (
  source_kind in ('update', 'mention', 'case', 'call', 'voicemail', 'recording', 'sms',
                  'mention_update', 'mention_case_reply', 'mention_field', 'agreement'));
create index if not exists notifications_by_agreement on notifications (agreement_id) where agreement_id is not null;

alter type activity_kind add value if not exists 'agreement';

-- ── The "Send agreement" permission ───────────────────────────────────────────
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
    when p_key = 'agreements.send'                                  then p_value in ('yes', 'no')
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
    when p_key = 'agreements.send' then 'yes'
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
    when p_key = 'agreements.send' then 'no'
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
          'applications.pdfs', 'agreements.send'
        ]) as k
    ),
    'modules', (select coalesce(jsonb_object_agg(m.id::text, user_module_scope(u, m.id)), '{}'::jsonb) from modules m)
  );
$$;

-- Spec §2: on by default for Sales agent, Underwriter, Customer service, Admin (Super admin always).
insert into permission_settings (owner_kind, owner_id, key, value)
select 'template', pt.id, 'agreements.send',
       case when pt.user_type in ('admin', 'underwriter', 'sales_agent', 'customer_service') then 'yes' else 'no' end
  from permission_templates pt
 where pt.user_type is not null and pt.user_type <> 'super_admin'
on conflict (owner_kind, owner_id, key) do nothing;
