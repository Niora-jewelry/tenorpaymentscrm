-- Ported from Daniel Weissman's residuals branch, file
-- `20260904130000_residuals_vendor_rate_cards_r5e.sql`.
--
-- Mechanical changes only: their role vocabulary
-- (auth_role() in ('admin','super_admin')) becomes our auth_is_admin(),
-- and their service-role test (auth_role() is null) becomes
-- auth.uid() is null. Nothing else in this file was altered.
--
-- The reasoning in the comments below is his and is kept verbatim:
-- it explains why the schema is shaped this way, and rewriting it in
-- my own words would lose the parts I have not yet had to understand.
-- ---------------------------------------------------------------------

-- ============================================================
-- Residuals R5e — the four vendor rate cards
-- ============================================================
--
-- Source: "Tab - Template Buy Rates", the vendor blocks to the right of the
-- Maverick grid. Transcribed values, verified from the file by the person who
-- supplied them.
--
-- WHY A VENDOR CARD BELONGS IN THE TEMPLATE AT ALL, rather than only
-- per-merchant. R5c already stores per-merchant vendor costs in
-- residual_merchant_vendor_costs (gateway_provider, gateway_monthly_fee,
-- gateway_auth_fee, and so on). The workbook's merchant rows carry Accept.blue
-- at Gateway Monthly 15 and Gateway Auth 0.05 — matching this card exactly. So
-- the per-merchant rows DERIVE from the card, and without the card there is
-- nothing to derive from: no way to tell a merchant on standard Accept.Blue
-- pricing from one that negotiated something, and no way to reprice the
-- standard without touching every merchant row. The card is the canonical
-- version a merchant row deviates from.
--
-- DEJA VOO IS NOT IMPORTED, AND THAT IS A RECORDED DECISION RATHER THAN AN
-- OVERSIGHT. The sheet has a Deja Voo header and a "Fee item" column label and
-- NO ROWS beneath them. There is nothing to transcribe. An empty card would
-- assert that Deja Voo charges nothing, which is a different claim from "we do
-- not have their rates" — the same distinction the merchant rate editor draws
-- between 0 and NULL. When the rates arrive, add a card.
--
-- COLUMNS 26-28 OF THAT SHEET ARE NOT IMPORTED EITHER: partner names, splits
-- and email addresses. Partners already live in residual_partners, and no
-- email address appears in this migration, its comments, or the spec.
--
-- ============================================================
-- Q28 = A. PAYA IS TWO SCHEDULES, NOT TWO TIERS
-- ============================================================
--
-- Paya's card has two columns, PPD/CCD/TEL and WEB. Those are ACH entry
-- classes — how an authorization was obtained — not risk levels. Modelling
-- them as pseudo-tiers would make the system capable of saying a merchant is
-- "WEB risk", which is not a thing, and would put an entry class in the same
-- column that decides a merchant's residual split.
--
-- So: PAYA_ACH_PPD and PAYA_ACH_WEB, two schedules, each with the same single
-- vendor_flat tier.
--
-- WHICH ENTRY CLASS APPLIES IS A PER-LINE FACT NOTHING CURRENTLY CARRIES.
-- residual_lines has no entry-class column, and the Maverick fee report does
-- not supply one. So NO RULE CAN READ THESE RATES YET, and none should be
-- written until a line can say which column it falls under. Seeding them now
-- is storing a price, not enabling a calculation.
--
-- ============================================================
-- Q30 = A. CARD UPDATER SEEDS AS FEE ITEMS WITH NO RATE
-- ============================================================
--
-- Accept.Blue's card lists "Card updater monthly" and "Card updater per
-- update" with no values. They are seeded as fee items and given NO rate rows,
-- so a lookup finds nothing and the caller must raise rather than guess. This
-- is the pattern monthly_fee_combined's missing tiers already established: an
-- absent cell is not a zero, and the engine reports missing_template_rate for
-- it rather than treating the item as free.
--
-- ============================================================
-- Q29 = B. THE $25 CAP, AND WHAT GRAIN IT IS
-- ============================================================
--
-- Accept.Blue charges 5.00 per payment page, "capped at $25".
--
-- WHERE THE CAP LIVES: on residual_buy_rates, beside the rate. The cap is
-- Accept.Blue's pricing fact, not an opinion held by whichever rule reads it.
-- On the term, two rules reading the same rate could disagree about the cap and
-- one could omit it entirely — and the one that omitted it would compute a
-- larger cost with no indication anything was missing. On the rate, every
-- reader gets it because there is only one of it.
--
-- WHAT GRAIN THE CAP IS, STATED PLAINLY BECAUSE IT IS NOT THE ENGINE'S.
--
-- "Capped at $25" on a monthly per-page charge reads as PER MERCHANT PER
-- MONTH: a merchant with seven pages pays 25, not 35.
--
-- The engine has no such grain. residual_eval_side evaluates ONE side of ONE
-- rule for ONE line, and can see only that line's item_count and the merchant's
-- monthly volumes. It cannot see the merchant's other lines, so it cannot cap
-- a total across them. 20260904140000 implements min(operand * rate, cap) at
-- the point of evaluation, which is PER TERM, WITHIN ONE LINE.
--
-- Those two grains COINCIDE only while at most one line per merchant-month
-- carries the capped fee item. They diverge the moment a merchant has two, and
-- the per-line cap would then allow 2 x 25 = 50 against a true cap of 25 —
-- understating the cost, which overstates the margin.
--
-- WHAT A TRUE PER-MERCHANT-MONTH CAP WOULD TAKE: a second pass in
-- compute_residual_period, after every line for a merchant has been evaluated,
-- that sums the capped item's contributions across that merchant's lines and
-- reduces them to the cap. That is a new phase with a new question attached —
-- WHICH line absorbs the reduction, since the cap applies to a total that no
-- single line owns. That question has no answer in the source data, which is
-- why it is not being invented here.
--
-- NOTHING READS THESE RATES TODAY, so the divergence is currently theoretical.
-- It stops being theoretical the day an Accept.Blue registry exists.
--
-- Idempotent throughout.

begin;

-- ============================================================
-- 1. residual_buy_rates gains a cap
-- ============================================================
-- DOLLARS, numeric(14,2), not a rate. A cap is a money ceiling on a computed
-- amount, so it carries the money precision rather than the rate precision.
alter table public.residual_buy_rates
  add column if not exists rate_cap numeric(14,2);

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'residual_buy_rates_rate_cap_nonneg'
       and conrelid = 'public.residual_buy_rates'::regclass
  ) then
    alter table public.residual_buy_rates
      add constraint residual_buy_rates_rate_cap_nonneg
      check (rate_cap is null or rate_cap >= 0);
  end if;
end$$;

comment on column public.residual_buy_rates.rate_cap is
  'Optional money ceiling on this rate''s contribution, in dollars. NULL means uncapped, which is almost every rate. It lives here rather than on residual_formula_terms because a cap is the vendor''s pricing fact, not an opinion of whichever rule reads the rate — on the term, two rules could disagree and one could omit it. APPLIED PER TERM WITHIN ONE LINE by residual_eval_side, which equals the source''s per-merchant-month meaning only while at most one line per merchant-month carries the item; see the migration header for what a true per-merchant-month cap would take.';

-- ============================================================
-- 2. The vendor fee items
-- ============================================================
-- billed_directly_to_merchant is FALSE for all of them: these are TapDash's
-- costs to a vendor, not something Maverick bills a merchant. The flag governs
-- whether a formula term may reference the item, and nothing about these should
-- be unreferenceable in principle — they are unreferenceable in practice
-- because no vendor registry exists.
insert into public.residual_fee_items
  (fee_item_key, label, rate_kind, billed_directly_to_merchant, sort_order, notes)
select v.fee_item_key, v.label, v.rate_kind, false, v.sort_order, v.notes
  from (values
    ('vendor_monthly_fee',            'Vendor Monthly Fee',              'amount', 1000,
     'Accept.Blue 15.00, Tuzo 5.00, Richard 95.00.'),
    ('vendor_auth_fee',               'Vendor Auth Fee',                 'amount', 1010,
     'Accept.Blue 0.05.'),
    ('vendor_payment_page',           'Vendor Payment Page (per page)',  'amount', 1020,
     'Accept.Blue 5.00 per page, capped at 25.00 — see residual_buy_rates.rate_cap.'),
    ('vendor_card_updater_monthly',   'Vendor Card Updater (monthly)',   'amount', 1030,
     'Accept.Blue lists the item with NO value. Seeded without a rate on purpose (Q30=A).'),
    ('vendor_card_updater_per_update','Vendor Card Updater (per update)','amount', 1040,
     'Accept.Blue lists the item with NO value. Seeded without a rate on purpose (Q30=A).'),
    ('vendor_volume_fee',             'Vendor Volume Fee',               'rate',   1050,
     'Tuzo 0.001 of volume.'),
    ('vendor_transaction_fee',        'Vendor Transaction Fee',          'amount', 1060,
     'Paya ACH: 0.15 PPD/CCD/TEL, 0.20 WEB.'),
    ('vendor_returned_item_fee',      'Vendor Returned Item Fee',        'amount', 1070,
     'Paya ACH: 2.00 both entry classes.'),
    ('vendor_batch_fee',              'Vendor Batch Fee',                'amount', 1080,
     'Paya ACH: 0.15 both entry classes.'),
    ('vendor_monthly_service_fee',    'Vendor Monthly Service Fee',      'amount', 1090,
     'Paya ACH: 10.00 both entry classes.'),
    ('vendor_high_value_transaction', 'Vendor Transaction over $25,000', 'amount', 1100,
     'Paya ACH: 0.20 both entry classes. The threshold is part of the item, not a cap.')
  ) as v(fee_item_key, label, rate_kind, sort_order, notes)
 where not exists (
   select 1 from public.residual_fee_items f where f.fee_item_key = v.fee_item_key
 );

-- ============================================================
-- 3. The five schedules
-- ============================================================
-- effective_from 2000-01-01 matches the Maverick schedule: the card is the
-- standing arrangement and the workbook gives no start date, so claiming one
-- would be inventing a fact. A dated successor is how it changes.
insert into public.residual_buy_rate_schedules
  (processor, label, effective_from, effective_to, notes)
select v.vendor, v.label, date '2000-01-01', null, v.notes
  from (values
    ('ACCEPT_BLUE',   'Accept.Blue vendor rate card (as supplied)',
     'TapDash pays this vendor. residual_merchant_vendor_costs rows for Accept.blue derive from this card.'),
    ('TUZO',          'Tuzo vendor rate card (as supplied)',            null),
    ('RICHARD',       'Richard vendor rate card (as supplied)',         null),
    ('PAYA_ACH_PPD',  'Paya ACH vendor rate card — PPD/CCD/TEL',
     'ACH entry class, not a risk tier. No rule can read this yet: residual_lines carries no entry class.'),
    ('PAYA_ACH_WEB',  'Paya ACH vendor rate card — WEB',
     'ACH entry class, not a risk tier. No rule can read this yet: residual_lines carries no entry class.')
  ) as v(vendor, label, notes)
 where not exists (
   select 1 from public.residual_buy_rate_schedules s
    where s.processor = v.vendor and s.deleted_at is null
 );

-- ============================================================
-- 4. One vendor_flat tier per schedule
-- ============================================================
-- share 1.000000 is the arithmetic identity, not a claim that TapDash keeps
-- everything. See 20260904120000 for the argument.
insert into public.residual_buy_rate_tiers (schedule_id, risk_tier, tapdash_share)
select s.id, 'vendor_flat', 1.000000
  from public.residual_buy_rate_schedules s
 where s.deleted_at is null
   and s.processor in ('ACCEPT_BLUE','TUZO','RICHARD','PAYA_ACH_PPD','PAYA_ACH_WEB')
   and not exists (
     select 1 from public.residual_buy_rate_tiers t
      where t.schedule_id = s.id and t.risk_tier = 'vendor_flat' and t.deleted_at is null
   );

-- ============================================================
-- 5. The rates
-- ============================================================
insert into public.residual_buy_rates
  (schedule_id, risk_tier, fee_item_key, rate, rate_cap)
select s.id, 'vendor_flat', v.fee_item_key, v.rate, v.rate_cap
  from (values
    -- ACCEPT.BLUE. Card updater monthly and per-update are DELIBERATELY absent
    -- (Q30=A): the sheet lists the items with no value, and an absent rate
    -- makes a lookup raise instead of guessing zero.
    ('ACCEPT_BLUE',  'vendor_monthly_fee',             15.000000, null::numeric(14,2)),
    ('ACCEPT_BLUE',  'vendor_auth_fee',                 0.050000, null),
    ('ACCEPT_BLUE',  'vendor_payment_page',             5.000000, 25.00),

    -- TUZO
    ('TUZO',         'vendor_volume_fee',               0.001000, null),
    ('TUZO',         'vendor_monthly_fee',              5.000000, null),

    -- RICHARD
    ('RICHARD',      'vendor_monthly_fee',             95.000000, null),

    -- PAYA ACH — PPD/CCD/TEL
    ('PAYA_ACH_PPD', 'vendor_transaction_fee',          0.150000, null),
    ('PAYA_ACH_PPD', 'vendor_returned_item_fee',        2.000000, null),
    ('PAYA_ACH_PPD', 'vendor_batch_fee',                0.150000, null),
    ('PAYA_ACH_PPD', 'vendor_monthly_service_fee',     10.000000, null),
    ('PAYA_ACH_PPD', 'vendor_high_value_transaction',   0.200000, null),

    -- PAYA ACH — WEB. Only the transaction fee differs (0.20 vs 0.15); the
    -- other four are identical, and are stored per schedule rather than shared
    -- because a schedule states its WHOLE card.
    ('PAYA_ACH_WEB', 'vendor_transaction_fee',          0.200000, null),
    ('PAYA_ACH_WEB', 'vendor_returned_item_fee',        2.000000, null),
    ('PAYA_ACH_WEB', 'vendor_batch_fee',                0.150000, null),
    ('PAYA_ACH_WEB', 'vendor_monthly_service_fee',     10.000000, null),
    ('PAYA_ACH_WEB', 'vendor_high_value_transaction',   0.200000, null)
  ) as v(vendor, fee_item_key, rate, rate_cap)
  join public.residual_buy_rate_schedules s
    on s.processor = v.vendor and s.deleted_at is null
 where not exists (
   select 1 from public.residual_buy_rates b
    where b.schedule_id = s.id and b.risk_tier = 'vendor_flat'
      and b.fee_item_key = v.fee_item_key and b.deleted_at is null
 );

-- ============================================================
-- 6. Prove it, and prove Maverick is untouched
-- ============================================================
do $$
declare
  n_sched int; n_rates int; n_mav_rates int; n_mav_tiers int; n_cap int; n_updater int;
begin
  select count(*) into n_sched
    from public.residual_buy_rate_schedules
   where deleted_at is null
     and processor in ('ACCEPT_BLUE','TUZO','RICHARD','PAYA_ACH_PPD','PAYA_ACH_WEB');
  if n_sched <> 5 then
    raise exception 'Expected 5 vendor schedules, found %.', n_sched;
  end if;

  select count(*) into n_rates
    from public.residual_buy_rates b
    join public.residual_buy_rate_schedules s on s.id = b.schedule_id
   where b.deleted_at is null and s.deleted_at is null
     and s.processor in ('ACCEPT_BLUE','TUZO','RICHARD','PAYA_ACH_PPD','PAYA_ACH_WEB');
  if n_rates <> 16 then
    raise exception 'Expected 16 vendor rates, found %.', n_rates;
  end if;

  -- The card updater items exist and carry NO rate. Both halves matter.
  select count(*) into n_updater
    from public.residual_fee_items
   where deleted_at is null
     and fee_item_key in ('vendor_card_updater_monthly','vendor_card_updater_per_update');
  if n_updater <> 2 then
    raise exception 'Expected both card-updater fee items, found %.', n_updater;
  end if;
  if exists (
    select 1 from public.residual_buy_rates
     where deleted_at is null
       and fee_item_key in ('vendor_card_updater_monthly','vendor_card_updater_per_update')
  ) then
    raise exception 'A card-updater item has a rate; it must have none (Q30=A).';
  end if;

  select count(*) into n_cap
    from public.residual_buy_rates where deleted_at is null and rate_cap is not null;
  if n_cap <> 1 then
    raise exception 'Expected exactly one capped rate, found %.', n_cap;
  end if;

  -- MAVERICK UNTOUCHED: 4 tiers, 44 rates, and no cap anywhere in its grid.
  select count(*) into n_mav_tiers
    from public.residual_buy_rate_tiers t
    join public.residual_buy_rate_schedules s on s.id = t.schedule_id
   where t.deleted_at is null and s.deleted_at is null and s.processor = 'MAVERICK';
  if n_mav_tiers <> 4 then
    raise exception 'Maverick tier count moved: %.', n_mav_tiers;
  end if;

  select count(*) into n_mav_rates
    from public.residual_buy_rates b
    join public.residual_buy_rate_schedules s on s.id = b.schedule_id
   where b.deleted_at is null and s.deleted_at is null and s.processor = 'MAVERICK';
  if n_mav_rates <> 44 then
    raise exception 'Maverick rate count moved: % (expected 44).', n_mav_rates;
  end if;

  raise notice '5 vendor schedules, 16 rates, 1 cap. Maverick intact at 4 tiers / 44 rates.';
end$$;

commit;
