-- Ported from Daniel Weissman's residuals branch, file
-- `20260904120000_residuals_vendor_tier_vocabulary_r5e.sql`.
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
-- Residuals R5e — making a vendor rate card expressible at all
-- ============================================================
--
-- THE SCHEMA QUESTION, ARGUED RATHER THAN ASSUMED.
--
-- Accept.Blue, Tuzo, Richard and Paya are vendors TapDash PAYS. Maverick is a
-- processor that pays TapDash a fraction of the net. Those are opposite
-- directions of money, and the buy-rate tables were built for the second one:
-- residual_buy_rate_tiers.tapdash_share is NOT NULL, and
-- residual_buy_rates carries a composite FK to (schedule_id, risk_tier), so a
-- rate cannot exist without a tier row, and a tier row cannot exist without a
-- share. A vendor has no share. Something has to give.
--
-- WHAT WAS CONSIDERED, AND WHY EACH WAS REJECTED
--
--   1. A SEPARATE TABLE PAIR for vendor cards, with no share column at all.
--      The cleanest answer to "make it impossible to mistake a vendor's share
--      for a residual split" — there would be no share to mistake. Rejected
--      because the vendor cards must resolve through
--      residual_buy_rates_for_month, which is the one dated lookup the module
--      has and the one the engine calls. A second mechanism is a second thing
--      to keep dated correctly, and the first divergence between them would be
--      silent.
--
--   2. MAKING tapdash_share NULLABLE. Rejected: it weakens a NOT NULL that
--      currently guarantees every Maverick tier has a share, for the sake of
--      five rows. Worse, NULL propagates — the engine computes
--      round(before * share, 2), so a NULL share yields a NULL net, which
--      reads as "not computed" and is indistinguishable from a real failure.
--
--   3. REUSING 'no_program'. Rejected: it is a real risk tier with a real
--      0.9 share, and vendor rates would land in the same bucket as merchant
--      ones.
--
-- WHAT IS DONE INSTEAD: a single non-risk tier, 'vendor_flat', with
-- tapdash_share = 1.000000.
--
--   * 1.0 IS THE ARITHMETIC IDENTITY in the only place a share is ever used.
--     If a vendor schedule somehow reached the chain it would scale nothing —
--     the safe failure mode, unlike 0.0 (silently zeroes) or NULL (silently
--     un-computes).
--   * It is NOT a claim that TapDash keeps 100% of anything. It is the absence
--     of a split, and is_risk_tier = false is what says so structurally rather
--     than by convention.
--
-- THE BLOCKER THE REQUEST COULD NOT HAVE KNOWN ABOUT.
--
-- The instruction was to add the tier to residual_risk_tiers "with a NULL
-- statement_code — that column is already nullable for exactly the tier that
-- has no integer". statement_code is indeed nullable. But drawer_option is
-- NOT NULL, UNIQUE, and CHECKed for length: every row in that table must be a
-- pickable option on a merchant record. That is what the table IS — the risk
-- vocabulary the drawer offered, pinned option-for-option by the R5c suite.
--
-- Inventing a drawer_option for 'vendor_flat' would put a fake risk level in
-- the merchant dropdown's vocabulary, which is the same category error one
-- level up from the one this migration exists to avoid.
--
-- So drawer_option becomes NULLABLE, paired to a new is_risk_tier flag by a
-- CHECK: a real risk tier must still have one, a non-risk tier must not. The
-- invariant that mattered is preserved exactly and is now enforced rather than
-- implied — and the R5c count-equality test keeps its meaning by scoping to
-- is_risk_tier.
--
-- AND THE TIER IS MADE UNASSIGNABLE TO A MERCHANT. residual_merchant_rates
-- .risk_tier is an FK to this table, so without a guard 'vendor_flat' would
-- become a selectable risk level for a merchant the moment it exists.
--
-- Idempotent throughout.

begin;

-- ============================================================
-- 1. is_risk_tier, and drawer_option paired to it
-- ============================================================
alter table public.residual_risk_tiers
  add column if not exists is_risk_tier boolean not null default true;

comment on column public.residual_risk_tiers.is_risk_tier is
  'True for the four real risk levels — the ones a merchant can be assigned and the ones the drawer offered. False for grouping keys that exist only so a non-residual schedule can hang rates off the buy-rate tables, which today means vendor_flat. A false row has no drawer_option, no statement_code, and cannot be assigned to a merchant.';

alter table public.residual_risk_tiers
  alter column drawer_option drop not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'residual_risk_tiers_drawer_option_iff_risk'
       and conrelid = 'public.residual_risk_tiers'::regclass
  ) then
    -- The NOT NULL that was just dropped, restored as a PAIRED rule. A real
    -- risk tier must still have a drawer option; a non-risk tier must not have
    -- one, so nobody can quietly give vendor_flat a merchant-facing label.
    alter table public.residual_risk_tiers
      add constraint residual_risk_tiers_drawer_option_iff_risk
      check ((drawer_option is not null) = is_risk_tier);
  end if;
end$$;

-- statement_code is a Maverick statement's integer for a risk level. A
-- non-risk tier has none, and this makes that structural rather than habitual.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'residual_risk_tiers_statement_code_risk_only'
       and conrelid = 'public.residual_risk_tiers'::regclass
  ) then
    alter table public.residual_risk_tiers
      add constraint residual_risk_tiers_statement_code_risk_only
      check (is_risk_tier or statement_code is null);
  end if;
end$$;

-- ============================================================
-- 2. The vendor_flat tier
-- ============================================================
insert into public.residual_risk_tiers
  (tier_key, drawer_option, statement_code, label, sort_order, is_risk_tier)
select 'vendor_flat', null, null,
       'Vendor flat rate (no residual split)', 900, false
 where not exists (
   select 1 from public.residual_risk_tiers where tier_key = 'vendor_flat'
 );

-- ============================================================
-- 3. A merchant can never be assigned it
-- ============================================================
-- residual_merchant_rates.risk_tier is a plain FK to this table, so without
-- this guard 'vendor_flat' is selectable for a merchant the moment it exists —
-- and a merchant priced at "vendor flat" would take tapdash_share 1.0 and book
-- the entire net as TapDash's.
create or replace function public.tg_residual_merchant_rates_real_tier()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.residual_risk_tiers t
     where t.tier_key = new.risk_tier
       and t.deleted_at is null
       and t.is_risk_tier
  ) then
    raise exception
      '% is not a risk tier a merchant can be assigned.', new.risk_tier
      using errcode = '23514',
            hint = 'Non-risk tiers exist only so vendor rate cards can hang rates off the buy-rate tables.';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_residual_merchant_rates_real_tier()
  from public, anon, authenticated, service_role;

drop trigger if exists residual_merchant_rates_real_tier
  on public.residual_merchant_rates;
create trigger residual_merchant_rates_real_tier
  before insert or update of risk_tier
  on public.residual_merchant_rates
  for each row execute function public.tg_residual_merchant_rates_real_tier();

-- ============================================================
-- 4. Prove the end state
-- ============================================================
do $$
declare n_risk int; n_vendor int;
begin
  select count(*) into n_risk
    from public.residual_risk_tiers where deleted_at is null and is_risk_tier;
  if n_risk <> 4 then
    raise exception 'Expected exactly 4 real risk tiers, found %.', n_risk;
  end if;

  select count(*) into n_vendor
    from public.residual_risk_tiers
   where deleted_at is null and not is_risk_tier and tier_key = 'vendor_flat';
  if n_vendor <> 1 then
    raise exception 'vendor_flat is missing or duplicated (found %).', n_vendor;
  end if;

  if exists (
    select 1 from public.residual_risk_tiers
     where deleted_at is null and is_risk_tier and drawer_option is null
  ) then
    raise exception 'A real risk tier lost its drawer_option.';
  end if;

  raise notice 'vendor_flat added; 4 real risk tiers intact, each still carrying a drawer option.';
end$$;

commit;
