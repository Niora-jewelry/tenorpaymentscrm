-- Residuals workspace: the data the Lovable-style Residuals page reads.
--
-- 1. residual_ach_lines          one row per merchant per fee category, from Maverick's ACH fee item report
-- 2. residual_acceptblue_lines   one row per merchant, from Accept.blue's monthly residual report
-- 3. residual_ach_name_matches   the ACH tab's name → MID matches, remembered month to month (ACH spec)
-- 4. The Buy Rate Template rows the Nov 3 specs list that were not yet in the database:
--      11 card rows on the existing MAVERICK schedule (EBT auth, gateway and terminal items), and
--      a MAVERICK_ACH schedule with the ACH section (No Risk uses Low Risk, so it has no no_program tier).
--
-- Same access rule as residual_lines: admins with the Residuals page; writes go through the service role.

-- ── 1. ACH report lines ────────────────────────────────────────────────────
create table if not exists public.residual_ach_lines (
  id            uuid primary key default gen_random_uuid(),
  period_id     uuid not null references public.residual_periods(id),
  merchant_name text not null,
  dba_id        text,
  ach_id        text,
  fee_category  text not null,
  item_count    numeric not null default 0,
  buyrate       numeric,
  income        numeric not null default 0,
  expense       numeric not null default 0,
  net           numeric not null default 0,
  source_file   text,
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index if not exists residual_ach_lines_period on public.residual_ach_lines (period_id) where deleted_at is null;

-- ── 2. Accept.blue report lines ────────────────────────────────────────────
create table if not exists public.residual_acceptblue_lines (
  id                          uuid primary key default gen_random_uuid(),
  period_id                   uuid not null references public.residual_periods(id),
  name                        text not null,
  -- As text, full digits. Null when the report has none (ERTCFunding LLC).
  mid                         text check (mid is null or mid ~ '^[0-9]+$'),
  report_month                text,
  setup_fee_iso               numeric,  -- null: the report had no Setup Fee ISO column
  monthly_gateway_fee_iso     numeric not null default 0,
  transaction_fee_iso         numeric not null default 0,
  transaction_count           numeric not null default 0,
  payment_pages_iso           numeric not null default 0,
  card_updater_monthly_iso    numeric not null default 0,
  card_updater_per_update_iso numeric not null default 0,
  daf_transaction_fee_iso     numeric not null default 0,
  iso_total                   numeric not null default 0,
  other_columns               jsonb not null default '{}'::jsonb,
  source_file                 text,
  created_at                  timestamptz not null default now(),
  deleted_at                  timestamptz
);
create index if not exists residual_acceptblue_lines_period on public.residual_acceptblue_lines (period_id) where deleted_at is null;

-- ── 3. ACH name → MID matches ──────────────────────────────────────────────
create table if not exists public.residual_ach_name_matches (
  merchant_name text primary key,
  mid           text not null check (mid ~ '^[0-9]+$'),
  matched_by    text not null default 'manual' check (matched_by in ('manual', 'auto_name')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['residual_ach_lines', 'residual_acceptblue_lines', 'residual_ach_name_matches'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (auth_admin_page(''residuals''))', t || '_select', t);
  end loop;
end $$;

-- ── 4a. Card template rows missing from the MAVERICK schedule ──────────────
insert into public.residual_fee_items (fee_item_key, label, rate_kind, billed_directly_to_merchant, sort_order, notes) values
  ('ebt_auth_fee',              'EBT Auth Fee',              'amount', false, 120, 'Acquiring spec, Buy Rate Template'),
  ('accept_blue_monthly',       'Accept Blue Monthly',       'amount', false, 130, 'Acquiring spec, Buy Rate Template (gateway group)'),
  ('accept_blue_setup',         'Accept Blue Setup',         'amount', false, 140, 'Acquiring spec, Buy Rate Template'),
  ('accept_blue_per_item',      'Accept.blue Per Item',      'amount', false, 150, 'Acquiring spec, Buy Rate Template'),
  ('usa_epay_gold',             'USA ePay Gold',             'amount', false, 160, 'Acquiring spec, Buy Rate Template (gateway group)'),
  ('usa_epay_silver',           'USA ePay Silver',           'amount', false, 170, 'Acquiring spec, Buy Rate Template (gateway group)'),
  ('ipos_spin_fee_monthly',     'iPOS Spin Fee Monthly',     'amount', false, 180, 'Acquiring spec, Buy Rate Template (terminal group)'),
  ('ipospays_terminal_monthly', 'iPOSPays Terminal Monthly', 'amount', false, 190, 'Acquiring spec, Buy Rate Template (terminal group)'),
  ('nuvolinq_10mb_data',        'NuvoLinQ 10MB Data',        'amount', false, 200, 'Acquiring spec, Buy Rate Template (terminal group)'),
  ('valor_portal_access',       'Valor Portal Access',       'amount', false, 210, 'Acquiring spec, Buy Rate Template (terminal group)'),
  ('valor_terminal_add_ons',    'Valor Terminal Add-Ons',    'amount', false, 220, 'Acquiring spec, Buy Rate Template (terminal group)')
on conflict (fee_item_key) do nothing;

insert into public.residual_buy_rates (schedule_id, risk_tier, fee_item_key, rate)
select s.id, t.tier, v.key, v.rate
  from public.residual_buy_rate_schedules s
 cross join (values ('no_program'), ('low'), ('medium'), ('high')) t(tier)
 cross join (values
   ('ebt_auth_fee', 0.02), ('accept_blue_monthly', 10.00), ('accept_blue_setup', 49.99), ('accept_blue_per_item', 0.05),
   ('usa_epay_gold', 20.00), ('usa_epay_silver', 15.00), ('ipos_spin_fee_monthly', 4.00), ('ipospays_terminal_monthly', 10.00),
   ('nuvolinq_10mb_data', 5.00), ('valor_portal_access', 4.95), ('valor_terminal_add_ons', 10.00)
 ) v(key, rate)
 where s.processor = 'MAVERICK' and s.deleted_at is null and s.effective_to is null
   and not exists (select 1 from public.residual_buy_rates b
                    where b.schedule_id = s.id and b.risk_tier = t.tier and b.fee_item_key = v.key and b.deleted_at is null);

-- ── 4b. The Maverick ACH section ───────────────────────────────────────────
insert into public.residual_fee_items (fee_item_key, label, rate_kind, billed_directly_to_merchant, sort_order, notes) values
  ('ach_transaction',            'Transaction',            'amount', false, 500, 'ACH spec, Buy Rate Template'),
  ('ach_return',                 'ACH Return',             'amount', false, 510, 'ACH spec, Buy Rate Template'),
  ('ach_monthly',                'Monthly',                'amount', false, 520, 'ACH spec, Buy Rate Template'),
  ('ach_odfi_sponsorship',       'ODFI Sponsorship',       'rate',   false, 530, 'ACH spec, Buy Rate Template'),
  ('ach_debit_unauthorized_fee', 'Debit Unauthorized Fee', 'amount', false, 540, 'ACH spec, Buy Rate Template'),
  ('ach_noc',                    'NOC',                    'amount', false, 550, 'ACH spec, Buy Rate Template')
on conflict (fee_item_key) do nothing;

insert into public.residual_buy_rate_schedules (processor, label, effective_from, notes)
select 'MAVERICK_ACH', 'Maverick ACH Template Buy Rates (spec)', date '2000-01-01',
       'Maverick ACH Reconciliation Tab spec, Nov 3 2026. No Risk merchants use the Low Risk column.'
 where not exists (select 1 from public.residual_buy_rate_schedules where processor = 'MAVERICK_ACH' and deleted_at is null);

-- ACH Percentage: High Risk is 90% on purpose (ACH spec); the card Percentage row is separate.
insert into public.residual_buy_rate_tiers (schedule_id, risk_tier, tapdash_share)
select s.id, v.tier, v.share
  from public.residual_buy_rate_schedules s
 cross join (values ('low', 0.90), ('medium', 0.80), ('high', 0.90)) v(tier, share)
 where s.processor = 'MAVERICK_ACH' and s.deleted_at is null
   and not exists (select 1 from public.residual_buy_rate_tiers x where x.schedule_id = s.id and x.risk_tier = v.tier and x.deleted_at is null);

insert into public.residual_buy_rates (schedule_id, risk_tier, fee_item_key, rate)
select s.id, v.tier, v.key, v.rate
  from public.residual_buy_rate_schedules s
 cross join (values
   ('low', 'ach_transaction', 0.10), ('medium', 'ach_transaction', 0.15), ('high', 'ach_transaction', 0.25),
   ('low', 'ach_return', 0.75), ('medium', 'ach_return', 0.75), ('high', 'ach_return', 0.75),
   ('low', 'ach_monthly', 7.50), ('medium', 'ach_monthly', 7.50), ('high', 'ach_monthly', 7.50),
   ('low', 'ach_odfi_sponsorship', 0), ('medium', 'ach_odfi_sponsorship', 0), ('high', 'ach_odfi_sponsorship', 0.0015),
   ('low', 'ach_debit_unauthorized_fee', 5.00), ('medium', 'ach_debit_unauthorized_fee', 5.00), ('high', 'ach_debit_unauthorized_fee', 5.00),
   ('low', 'ach_noc', 0), ('medium', 'ach_noc', 0), ('high', 'ach_noc', 0)
 ) v(tier, key, rate)
 where s.processor = 'MAVERICK_ACH' and s.deleted_at is null
   and not exists (select 1 from public.residual_buy_rates b
                    where b.schedule_id = s.id and b.risk_tier = v.tier and b.fee_item_key = v.key and b.deleted_at is null);
