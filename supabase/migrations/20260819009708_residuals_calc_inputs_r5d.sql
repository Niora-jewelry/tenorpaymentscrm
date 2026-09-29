-- Ported from Daniel Weissman's residuals branch, file
-- `20260828120000_residuals_calc_inputs_r5d.sql`.
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
-- Residuals R5d Part 1 — calc inputs: the TapDash rate table,
--                        the formula registry, and the columns
--                        the engine will write
-- ============================================================
--
-- STRICTLY ADDITIVE to every existing table except residual_lines, which
-- gains ONE nullable column. Nothing is dropped, nothing is retyped, no
-- seeded rate is edited, no existing policy is narrowed. Two existing
-- behaviours are TIGHTENED by new triggers (calculation invalidation and the
-- reconciled-period write guard); both are described in section 9.
--
-- R5d PART 1 COMPUTES NOTHING. The engine is Part 2. This migration creates
-- the inputs it reads and the columns it writes, and seeds the registry so
-- that every rule can be reviewed against the calc sheet before any
-- arithmetic exists to be wrong.
--
-- MONEY RULE (R1b, unchanged): dollars numeric(14,2), rates numeric(14,6),
-- no float, every sum in SQL. R5c's one deliberate extension carries over —
-- a buy rate that denominates DOLLARS is still numeric(14,6), because
-- 0.02/auth and 0.025/batch are sub-cent quoted amounts that numeric(14,2)
-- destroys at write. Quoted amounts are 6dp; settled amounts are 2dp.
--
-- PERIOD RULE (R1b/R5c, unchanged): a statement month is a calendar date
-- pinned to the 1st, and every effective-dated range here uses that grain
-- with an EXCLUSIVE upper bound.
--
-- Idempotent: if-not-exists / not-exists guards throughout. Seeds are a
-- FLOOR, not a reset — a re-run inserts what is missing and UPDATES nothing,
-- so an admin's correction to a seeded rule survives.
--
-- ============================================================
-- WHAT THIS MIGRATION ASSUMES, AND WHERE IT IS CONTRADICTED
-- ============================================================
--
-- Rule #2 (Monthly Fee) is seeded per the binding decision: Maverick no
-- longer collects the merchant's monthly fee, AND the fee is being removed
-- from Maverick's template altogether — so there will be no Maverick buy rate
-- for it either. Both sides are therefore $0 (no terms), and the merchant's
-- monthly fee is Additional Income Directly to TapDash.
--
-- ONE CONSEQUENCE FOR A READER OF residual_buy_rates: the seeded 'monthly_fee'
-- rates (0 / 4 / 4 / 7) are now referenced by NO term, joining 'chargeback' as
-- reference data the live registry does not read. They are deliberately NOT
-- deleted — seeded rates are not edited here — and a predecessor registry
-- would read them again.
--
-- THE MAY 2026 SAMPLE ONLY PARTLY AGREES, AND A READER SHOULD KNOW BEFORE
-- TRUSTING A COMPUTED MAY. Of 21 Monthly Fee rows, 10 carry Agent Income of
-- 0 (the -4.00/-7.00/-7.50 nets the decision cites) but 11 carry NON-ZERO
-- Agent Income — 99.00 (x6), 50.00, 35.00, 30.00 and 9.95 (x2) — and each of
-- those reconciles as income minus expense (99 - 4 = 95, 30 - 7 = 23,
-- 9.95 - 4 = 5.95). Six merchants whose drawer snapshot shows a monthly fee
-- report income of 0 for it; five report the drawer's exact value. That is a
-- migration in progress, not a completed one.
--
-- Under this registry those 11 rows will compute Total Income 0.00 against a
-- stated net that assumes otherwise, and May 2026 will show 11 mismatches.
-- That is the correct behaviour for a registry that says the fee is no longer
-- collected; it is not a defect to be patched in the engine.
--
-- THE FIX, IF MAY MUST RECONCILE, IS ONE INSERT AND NO SCHEMA CHANGE: seed a
-- predecessor registry (effective_from '2000-01-01', effective_to = the
-- changeover month) whose rule #2 reads
--   income = one x merchant.monthly_fee_maverick
-- and move THIS registry's effective_from to the changeover month. That is
-- the entire reason residual_merchant_rates carries monthly_fee_maverick (see
-- section 1) and the entire reason the registry is effective-dated at all.
-- The changeover date is the one fact needed and is not in the workbook.

begin;

-- ============================================================
-- 1. residual_merchant_rates — the TapDash sell side, typed and dated
-- ============================================================
-- GRAIN: one row = one MID's TapDash-facing rates over one date range.
--
-- WHY A SECOND RATE TABLE AT ALL. The two sides of every rule read different
-- things and are owned by different parties. The Maverick template
-- (residual_buy_rates, R5c) is what TapDash PAYS, quoted by the processor,
-- varying by risk tier and identical across merchants in a tier. This table
-- is what the MERCHANT pays, negotiated per merchant, varying by nothing but
-- the merchant. Some columns exist only on one side — there is no template
-- "Amex Template Volume Fee" and no per-merchant "VMD BIN" — so a single
-- table would be half NULL by construction and would invite a rule to read a
-- buy rate as a sell rate, which is the one confusion that silently inverts a
-- margin.
--
-- WHY IT REPLACES THE DRAWER'S 25 SUBTAB-1 JSONB FIELDS. Three reasons, in
-- order of weight:
--
--   a) DATING. column_data holds ONE CURRENT VALUE per merchant with no
--      history. Recomputing March in September would read September's price.
--      The buy side is already dated (residual_buy_rate_schedules), so the
--      drift would be ONE-SIDED: costs reproducible, income silently moved,
--      and the result still plausible. A one-sided drift is worse than a
--      two-sided one because nothing looks wrong.
--
--   b) TYPING. A calc input that is jsonb text is a cast at every read.
--      numeric(14,6) here is the same argument R1b made for residual_lines
--      and R5c made for residual_merchant_vendor_costs.
--
--   c) IT IS FREE TODAY. Measured before writing this: ZERO merchants have
--      any subtab-1 pricing populated (2 live lead_gen_threads, 0 with
--      risk_level or any rate key). There is nothing to migrate and no
--      dual-write window. This is the cheapest this change will ever be.
--
-- MODELLED ON residual_merchant_vendor_costs (R5c section 6) DELIBERATELY:
-- same MID namespace and normalization, same half-open dating on the 1st,
-- same EXCLUDE, same RLS. The two tables are the sell side and the cost side
-- of one merchant and should be shaped alike; a reader who has understood one
-- has understood the other.
--
-- MID IS THE STATEMENT MID, normalized digits-only per R3 — NOT the mutable
-- record MID that R5b adjudicates. Same argument as R5c section 6: an
-- immutable key cannot orphan when a merchant record changes, and the join
-- from residual_lines is a plain equality on one side only. The uncovered
-- case is identical too — a merchant RE-BOARDING onto a new MID leaves its
-- rates behind on the old one — and is surfaced the same way, by a coverage
-- report rather than a constraint (section 3).
--
-- EVERY RATE IS NULLABLE WITH NO DEFAULT. A merchant with no AVS arrangement
-- has no AVS rate, and NULL says that; 0.000000 would assert a rate of zero,
-- which is a different claim and one the engine would multiply by a count and
-- book as real. Part 2's contract: a term whose merchant rate is NULL must
-- fail loud for that line, never contribute zero. This mirrors R5c's
-- "a missing rate must never read as a zero rate".
--
-- risk_tier IS NOT NULL AND IS AN FK, not the drawer's option string. The
-- drawer stores 'Moderate risk'; the rate grid is headed 'Medium Risk'; the
-- workbook's merchant data says 2. residual_risk_tiers already owns that
-- three-way map, so this column stores the canonical tier_key and the
-- vocabulary mismatch stops being a per-read string comparison. NOT NULL
-- because a rate row without a tier cannot resolve a single buy rate, which
-- makes it useless rather than partial.
create table if not exists public.residual_merchant_rates (
  id                        uuid primary key default gen_random_uuid(),

  mid                       text not null
                              check (mid = regexp_replace(mid, '[^0-9]', '', 'g')
                                     and length(mid) between 1 and 32),

  effective_from            date not null
                              check (extract(day from effective_from) = 1),
  effective_to              date
                              check (effective_to is null
                                     or extract(day from effective_to) = 1),

  -- The canonical tier. FK target is residual_risk_tiers.tier_key, which R5c
  -- gave a PLAIN (not partial) unique index precisely so it could be
  -- referenced.
  risk_tier                 text not null
                              references public.residual_risk_tiers(tier_key),

  -- ---------- per-item amounts (dollars per transaction/batch) ----------
  vmd_auth_fee              numeric(14,6),  -- rules #1, #20
  pin_debit_auth_fee        numeric(14,6),  -- rule #5
  avs_fee                   numeric(14,6),  -- rule #8
  batch_fee                 numeric(14,6),  -- rule #3
  vmd_transaction_fee       numeric(14,6),  -- rules #7, #13 (4th term)

  -- ---------- volume rates ----------
  -- UNSCALED DECIMAL FRACTIONS (0.0385 = 3.85%), matching the convention R2
  -- pinned for the drawer's percentage type and R5c repeated for
  -- rewards_volume_cost. The engine multiplies by volume directly; only a
  -- formatter ever scales. Storing 3.85 here would be a 100x error that
  -- every downstream number would carry silently.
  amex_volume               numeric(14,6),  -- rules #7, #13
  vmd_volume                numeric(14,6),  -- rules #7, #13
  pin_debit_volume          numeric(14,6),  -- rules #7, #13
  amex_template_volume_fee  numeric(14,6),  -- rule #12

  -- ---------- flat monthlies billed THROUGH Maverick ----------
  -- The provider names annotate the amounts beside them and are read by no
  -- rule. They earn their place the way residual_merchant_vendor_costs'
  -- provider columns do: an amount with no counterparty is unreviewable in a
  -- UI, and a name cannot be multiplied by anything, so it carries none of
  -- the risk an unread RATE would.
  gateway_provider_mav      text,
  gateway_monthly_mav       numeric(14,6),  -- rule #16
  terminal_provider_mav     text,
  terminal_monthly_mav      numeric(14,6),  -- rule #14

  -- ---------- billed DIRECTLY by TapDash ----------
  -- Rule #2's Additional Income term. Sits OUTSIDE the tier split by design:
  -- Maverick is not party to a fee TapDash bills the merchant itself, so it
  -- is added after the multiplication, never inside it.
  monthly_fee_tapdash       numeric(14,6),

  -- ---------- legacy, retained for recompute only ----------
  -- The processor-side monthly fee. READ BY NO RULE IN THE LIVE REGISTRY,
  -- and that is the enforcement: the decision that Maverick no longer
  -- collects it is expressed by nothing referencing it, not by a comment.
  --
  -- It is retained rather than dropped for exactly one reason, and it is not
  -- sentiment: 11 of 21 Monthly Fee rows in the May 2026 sample carry
  -- non-zero Agent Income, so a predecessor registry covering pre-changeover
  -- months NEEDS this column to reconcile them. Omitting it would make
  -- recomputing any pre-changeover month a schema migration, which defeats
  -- the point of dating the registry. See the header.
  monthly_fee_maverick      numeric(14,6),

  -- ---------- no rule yet, buy-side counterpart already seeded ----------
  -- residual_buy_rates carries a 'chargeback' fee item at 10/15/20/25 across
  -- the four tiers, and R2 seeded a drawer field for the merchant-facing
  -- side, but no calc-sheet rule references either and no 'Chargeback' fee
  -- item name appears in the 197-row sample. The buy side existing without
  -- the sell side is the asymmetry worth closing: when the rule appears it
  -- should be a dated registry INSERT, not a migration. A column nothing
  -- reads is cheap; a schema change on the day a rule is needed is not.
  chargeback_fee            numeric(14,6),

  notes                     text,

  created_at                timestamptz not null default now(),
  created_by_id             uuid references auth.users(id),
  updated_at                timestamptz not null default now(),
  updated_by_id             uuid references auth.users(id),
  deleted_at                timestamptz,
  deleted_by_id             uuid references auth.users(id),

  constraint residual_merchant_rates_range_ordered
    check (effective_to is null or effective_to > effective_from)
);

-- Overlapping rate versions for one MID are a wrong-money bug, not a config
-- annoyance. EXCLUDE is enforced by the index and is the only race-free form:
-- a BEFORE trigger that SELECTs for a conflict lets two concurrent inserts
-- both commit. Scoped to live rows so a soft-deleted version does not block
-- its replacement over the same months. (R5c's argument, unchanged.)
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'residual_merchant_rates_no_overlap'
  ) then
    alter table public.residual_merchant_rates
      add constraint residual_merchant_rates_no_overlap
      exclude using gist (
        mid                                     with =,
        daterange(effective_from, effective_to) with &&
      ) where (deleted_at is null);
  end if;
end$$;

create index if not exists residual_merchant_rates_lookup
  on public.residual_merchant_rates (mid, effective_from desc)
  where deleted_at is null;

drop trigger if exists residual_merchant_rates_set_updated_at
  on public.residual_merchant_rates;
create trigger residual_merchant_rates_set_updated_at
  before update on public.residual_merchant_rates
  for each row execute function public.tg_set_updated_at();

alter table public.residual_merchant_rates enable row level security;

drop policy if exists "residual_merchant_rates_select"
  on public.residual_merchant_rates;
create policy "residual_merchant_rates_select"
  on public.residual_merchant_rates
  for select to authenticated
  using (public.auth_is_admin() and deleted_at is null);

drop policy if exists "residual_merchant_rates_insert"
  on public.residual_merchant_rates;
create policy "residual_merchant_rates_insert"
  on public.residual_merchant_rates
  for insert to authenticated
  with check (public.auth_is_admin());

drop policy if exists "residual_merchant_rates_update"
  on public.residual_merchant_rates;
create policy "residual_merchant_rates_update"
  on public.residual_merchant_rates
  for update to authenticated
  using (public.auth_is_admin() and deleted_at is null)
  with check (public.auth_is_admin());

comment on table public.residual_merchant_rates is
  'The Pricing tab''s merchant rate fields as typed, effective-dated columns rather than free-text fields on the Pricing tab. This is the SELL side — what the merchant pays TapDash — and is the calc engine''s income input. The BUY side is residual_buy_rates (per risk tier, per processor). Columns exist on one side or the other, never both.';
comment on column public.residual_merchant_rates.mid is
  'The STATEMENT MID (residual_lines.mid''s namespace), normalized digits-only per R3 — NOT the mutable record MID R5b adjudicates. Join as regexp_replace(l.mid,''[^0-9]'','''',''g'') = mid. Re-boarding onto a new MID is the one uncovered case and is surfaced by residual_merchant_rate_coverage().';
comment on column public.residual_merchant_rates.risk_tier is
  'Canonical residual_risk_tiers.tier_key, NOT the Pricing tab''s option string. Resolving the tier here rather than from the Pricing tab is what makes a merchant''s tier for month M a dated fact instead of a current one.';
comment on column public.residual_merchant_rates.amex_volume is
  'Unscaled decimal fraction (0.0385 = 3.85%), matching the R2 drawer percentage convention. Same for vmd_volume, pin_debit_volume and amex_template_volume_fee. Only a formatter ever scales.';
comment on column public.residual_merchant_rates.monthly_fee_maverick is
  'LEGACY processor-side monthly fee. Read by NO rule in the live registry — that is the enforcement of "Maverick no longer collects it". Retained solely so a dated PREDECESSOR registry can reconcile pre-changeover months, where 11 of 21 May 2026 rows carry non-zero Agent Income. Its justification is unchanged by Q24a: that predecessor would re-seed this income term, the monthly_fee_combined fee item (7.50 low tier) and the two conditional combine terms together, as one pre-changeover picture. Do not wire it into the live registry.';
comment on column public.residual_merchant_rates.chargeback_fee is
  'No rule reads this yet. Its buy-side counterpart (residual_buy_rates.chargeback, 10/15/20/25) is already seeded, so the column exists to make a future Chargeback rule a dated registry INSERT rather than a schema migration.';

-- ============================================================
-- 2. residual_merchant_rates_for_month — the ONE lookup, fail-loud
-- ============================================================
-- MODELLED ON residual_buy_rates_for_month (R5c section 9a) INCLUDING ITS
-- FAILURE MODE, which is the important half.
--
-- A MISSING MERCHANT RATE MUST NEVER READ AS A ZERO RATE. Returning an empty
-- row here would let Part 2 compute Total Income 0.00 for a merchant whose
-- rates simply were not entered, subtract a real buy rate, and book the
-- entire cost as a loss — a number that looks like an answer. Raising is the
-- only safe empty case, and it is the SAME safety argument R5c made for an
-- uncovered buy-rate month.
--
-- THIS IS THE "MERCHANT'S RATE IS UNDEFINED" CASE the investigation named.
-- It is not an edge case today: 21 MIDs carry fee lines and none has a rate
-- row, so on current data every single line raises. That is correct. The
-- period is not computable until the rates are entered, and a coverage
-- report (section 3) is how an operator finds out which MIDs are missing
-- without running the engine into a raise.
--
-- SECURITY DEFINER with an explicit RAISE gate, following R5c's reasoning:
-- the function's joins must not depend on the caller's role, because a gated
-- table under a SECURITY INVOKER function would return zero rows to a
-- non-admin and an empty rate set is indistinguishable from a genuinely
-- missing one. The gate is written `is null or not in (...)` — the R5b idiom
-- — because auth_role() returns NULL on a service-role connection and a bare
-- `not in` against NULL evaluates to NULL, which an IF treats as false and
-- would let the call through unauthenticated. This fails closed.
create or replace function public.residual_merchant_rates_for_month(
  p_mid   text,
  p_month date
)
returns table (
  mid                       text,
  risk_tier                 text,
  effective_from            date,
  effective_to              date,
  vmd_auth_fee              numeric(14,6),
  pin_debit_auth_fee        numeric(14,6),
  avs_fee                   numeric(14,6),
  batch_fee                 numeric(14,6),
  vmd_transaction_fee       numeric(14,6),
  amex_volume               numeric(14,6),
  vmd_volume                numeric(14,6),
  pin_debit_volume          numeric(14,6),
  amex_template_volume_fee  numeric(14,6),
  gateway_monthly_mav       numeric(14,6),
  terminal_monthly_mav      numeric(14,6),
  monthly_fee_tapdash       numeric(14,6),
  monthly_fee_maverick      numeric(14,6),
  chargeback_fee            numeric(14,6)
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_mid   text := regexp_replace(coalesce(p_mid, ''), '[^0-9]', '', 'g');
  v_month date := date_trunc('month', p_month)::date;
begin
  if public.auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to read merchant rates.'
      using errcode = '42501';
  end if;

  if v_month is null then
    raise exception 'residual_merchant_rates_for_month: p_month is required.'
      using errcode = '22004';
  end if;

  -- Normalizing to '' rather than rejecting NULL keeps the raise below the
  -- single failure path: a caller passing a blank MID gets "no rates for
  -- MID" rather than a different error for the same operator mistake.
  if v_mid = '' then
    raise exception 'residual_merchant_rates_for_month: p_mid must contain digits.'
      using errcode = '22004';
  end if;

  -- THIS FUNCTION RETURNS THE SELL SIDE ONLY, and deliberately does NOT
  -- return tapdash_share. The share lives on residual_buy_rate_tiers, which is
  -- per SCHEDULE and therefore per PROCESSOR, and this table has no processor
  -- — a merchant's negotiated rates are not a processor's. Joining it in here
  -- would have meant either taking a processor argument this side of the
  -- ledger has no use for, or joining schedules without a processor filter and
  -- silently returning TWO rows per merchant the day a second processor's
  -- schedule covers the same month.
  --
  -- The engine reads the tier HERE and the share from
  -- residual_buy_rates_for_month(processor, month), joining on risk_tier.
  -- One tier value still flows into one share lookup, so the tier remains
  -- resolved from exactly one row; each function simply stays on one side.
  return query
    select r.mid,
           r.risk_tier,
           r.effective_from,
           r.effective_to,
           r.vmd_auth_fee,
           r.pin_debit_auth_fee,
           r.avs_fee,
           r.batch_fee,
           r.vmd_transaction_fee,
           r.amex_volume,
           r.vmd_volume,
           r.pin_debit_volume,
           r.amex_template_volume_fee,
           r.gateway_monthly_mav,
           r.terminal_monthly_mav,
           r.monthly_fee_tapdash,
           r.monthly_fee_maverick,
           r.chargeback_fee
      from public.residual_merchant_rates r
     where r.deleted_at is null
       and r.mid = v_mid
       and r.effective_from <= v_month
       and (r.effective_to is null or r.effective_to > v_month);

  if not found then
    raise exception 'No merchant rates cover % for MID %.', v_month, v_mid
      using errcode = 'P0002',
            hint = 'Enter rates in residual_merchant_rates, or check residual_merchant_rate_coverage().';
  end if;
end;
$$;

comment on function public.residual_merchant_rates_for_month(text, date) is
  'The ONE implementation of "which TapDash sell-side rates were in effect for MID M in month T". Raises rather than returning an empty set, because a missing merchant rate must never read as a zero rate — the same safety rule as residual_buy_rates_for_month. Returns the SELL side only: tapdash_share is per-processor and comes from residual_buy_rates_for_month, joined on the risk_tier returned here.';

revoke all on function public.residual_merchant_rates_for_month(text, date)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_merchant_rates_for_month(text, date)
  to authenticated;

-- ============================================================
-- 3. residual_merchant_rate_coverage — the checkable invariant
-- ============================================================
-- Coverage cannot be a constraint: it is a property of a whole set of MIDs
-- against a whole set of ranges, and there is no moment at which a
-- half-entered set is invalid. So it is made CHECKABLE, in the spirit of
-- R5c's residual_buy_rate_coverage and residual_reference_coverage.
--
-- BOTH DIRECTIONS, ONE RESULT SET, for the same reason R5c gave: reporting
-- only "MIDs with no rates" would make a re-boarding look like one finding
-- instead of the matched pair it is.
--   has_rates = false      -> a MID being billed with no rates entered. The
--                             engine will raise on every one of its lines.
--   in_statements = false  -> rates for a MID this period never carried: a
--                             typo, a stale row left by a re-boarding, or a
--                             merchant boarded ahead of its first statement.
create or replace function public.residual_merchant_rate_coverage(
  p_period_id uuid
)
returns table (
  mid            text,
  in_statements  boolean,
  has_rates      boolean,
  risk_tier      text,
  line_rows      integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_month date;
begin
  if public.auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to read merchant rate coverage.'
      using errcode = '42501';
  end if;

  select p.statement_month into v_month
    from public.residual_periods p
   where p.id = p_period_id
     and p.deleted_at is null;

  -- A bad period id RAISES rather than returning nothing: an id that names no
  -- live period is a caller error, and reporting it as "nothing to see" would
  -- hide a bug in the caller. (R5c's rule.)
  if v_month is null then
    raise exception 'No live residual period with id %.', p_period_id
      using errcode = 'P0002';
  end if;

  return query
    with statement_mids as (
      select regexp_replace(l.mid, '[^0-9]', '', 'g') as m,
             count(*)::integer                        as n
        from public.residual_lines l
       where l.period_id = p_period_id
         and l.deleted_at is null
       group by 1
    ),
    rate_mids as (
      select r.mid as m, r.risk_tier
        from public.residual_merchant_rates r
       where r.deleted_at is null
         and r.effective_from <= v_month
         and (r.effective_to is null or r.effective_to > v_month)
    )
    select coalesce(sm.m, rm.m)          as mid,
           sm.m is not null              as in_statements,
           rm.m is not null              as has_rates,
           rm.risk_tier,
           coalesce(sm.n, 0)::integer    as line_rows
      from statement_mids sm
      full outer join rate_mids rm on rm.m = sm.m
     order by 2 desc, 3, 1;
end;
$$;

comment on function public.residual_merchant_rate_coverage(uuid) is
  'Which MIDs in a period have TapDash sell-side rates in effect for its month, and which rate rows point at MIDs the period never carried. The checkable form of an invariant no constraint can express. Read this before running the engine: every MID with has_rates = false will raise.';

revoke all on function public.residual_merchant_rate_coverage(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_merchant_rate_coverage(uuid)
  to authenticated;

-- ============================================================
-- 4. residual_formula_registries — the registry, effective-dated
-- ============================================================
-- GRAIN: one row = one processor's complete rule set over one date range.
--
-- WHY DATED. The spec calls formula rules non-negotiable for dating and rule
-- #2 has ALREADY changed once (Maverick stopped collecting the monthly fee).
-- A registry that cannot be dated cannot recompute a month that predates its
-- own change, and "recompute a closed month" is exactly what an auditor asks
-- for. Keyed and EXCLUDEd identically to residual_buy_rate_schedules so the
-- two dated vocabularies behave the same way and a reader learns one shape.
--
-- WHY PER PROCESSOR. The 20 rules reconcile MAVERICK's fee report. A second
-- processor's report has different fee item names and different rules; it
-- gets its own registry, not extra rows in this one.
create table if not exists public.residual_formula_registries (
  id             uuid primary key default gen_random_uuid(),

  processor      text not null
                   check (processor = upper(btrim(processor))
                          and length(processor) between 1 and 100),

  label          text not null
                   check (length(btrim(label)) between 1 and 120),

  effective_from date not null
                   check (extract(day from effective_from) = 1),
  effective_to   date
                   check (effective_to is null
                          or extract(day from effective_to) = 1),

  notes          text,

  created_at     timestamptz not null default now(),
  created_by_id  uuid references auth.users(id),
  updated_at     timestamptz not null default now(),
  updated_by_id  uuid references auth.users(id),
  deleted_at     timestamptz,
  deleted_by_id  uuid references auth.users(id),

  constraint residual_formula_registries_range_ordered
    check (effective_to is null or effective_to > effective_from)
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'residual_formula_registries_no_overlap'
  ) then
    alter table public.residual_formula_registries
      add constraint residual_formula_registries_no_overlap
      exclude using gist (
        processor                               with =,
        daterange(effective_from, effective_to) with &&
      ) where (deleted_at is null);
  end if;
end$$;

create index if not exists residual_formula_registries_lookup
  on public.residual_formula_registries (processor, effective_from desc)
  where deleted_at is null;

drop trigger if exists residual_formula_registries_set_updated_at
  on public.residual_formula_registries;
create trigger residual_formula_registries_set_updated_at
  before update on public.residual_formula_registries
  for each row execute function public.tg_set_updated_at();

alter table public.residual_formula_registries enable row level security;

drop policy if exists "residual_formula_registries_select"
  on public.residual_formula_registries;
create policy "residual_formula_registries_select"
  on public.residual_formula_registries
  for select to authenticated
  using (public.auth_is_admin() and deleted_at is null);

drop policy if exists "residual_formula_registries_insert"
  on public.residual_formula_registries;
create policy "residual_formula_registries_insert"
  on public.residual_formula_registries
  for insert to authenticated
  with check (public.auth_is_admin());

drop policy if exists "residual_formula_registries_update"
  on public.residual_formula_registries;
create policy "residual_formula_registries_update"
  on public.residual_formula_registries
  for update to authenticated
  using (public.auth_is_admin() and deleted_at is null)
  with check (public.auth_is_admin());

comment on table public.residual_formula_registries is
  'One processor''s complete formula rule set over one date range. The in-database form of the calc sheet''s "Tab - Processor Monthly Reconci" formula columns. Dated because rule #2 has already changed once and a closed month must stay recomputable under the rules that applied to it.';

-- ============================================================
-- 5. residual_formula_rules — one rule per fee item name
-- ============================================================
-- MATCHED ON EXACT FEE ITEM NAME, AND ON NOTHING ELSE.
--
-- "Card Brand Fees V/MC/D/PP" (#11) and "Card Brand Fees" (#17) are distinct
-- fee items with distinct rules that differ only by suffix, so any prefix,
-- LIKE or category match collapses them into a silent wrong rate.
--
-- THERE IS DELIBERATELY NO FEE-CATEGORY FALLBACK, and the brief asked whether
-- one is wanted. It is not, for two reasons:
--
--   a) IT IS NOT WELL-DEFINED. A category maps to MANY rules, not one —
--      'MISC Fixed Fees' alone covers eight rules with five different shapes
--      (#2, #4, #6, #14, #15, #16, #18, #19). "Fall back to the category"
--      has no single answer to fall back TO, so it would resolve to whichever
--      row sorted first: an arbitrary rule applied to real money.
--
--   b) THE ALTERNATIVE IS BETTER. The name set measured closed — 20 distinct
--      names in the 197-row sample, 20 rules, exact correspondence both ways.
--      An unrecognised name is therefore NEWS, and the safe response to news
--      is to stop. Part 2's contract: an unmatched fee_item_name raises and
--      names the offending value. A fallback would convert that signal into a
--      number.
--
-- fee_category IS STORED ANYWAY, as the calc sheet records it, but purely as
-- a cross-check: if an incoming line's category disagrees with its rule's
-- recorded category, the processor has renamed or recategorised something and
-- a human should look. That is a DETECTOR, the opposite of a fallback.
create table if not exists public.residual_formula_rules (
  id             uuid primary key default gen_random_uuid(),

  registry_id    uuid not null
                   references public.residual_formula_registries(id),

  -- EXACT text from the fee report / calc sheet, spaces and slashes included.
  fee_item_name  text not null
                   check (length(btrim(fee_item_name)) between 1 and 120),

  -- Informational + rename detector. NOT a match key. See above.
  fee_category   text,

  -- ---------- many-to-one grouping ----------
  -- NULL for the 18 rules that compute per line. Non-NULL binds a set of fee
  -- items whose value is computed ONCE and reconciled against the SUM of the
  -- members' stated nets — the iPOS pair (#14/#15), whose calc-sheet note
  -- reads "Fee item report breaks it out by two line items but the
  -- calculation is only done once".
  --
  -- The ANCHOR is the member carrying the terms; the others carry none. This
  -- is not an arbitrary choice of row: the calc sheet puts the formula on
  -- iPOS Spin Fee and leaves iPOSPays Terminal's income cell EMPTY (not
  -- "$0"), so the anchor is recorded fact, not an allocation we invented.
  group_key      text
                   check (group_key is null
                          or group_key ~ '^[a-z][a-z0-9_]{0,40}$'),
  is_group_anchor boolean not null default false,

  -- TRUE where the calc sheet says "For the moment $0" — an admitted unknown
  -- that happens to be written as zero. Per the binding decision these
  -- COMPUTE as 0.00, but a computed 0.00 that came from an unknown and one
  -- that came from a decision must remain distinguishable, or the day the
  -- real rate arrives nobody can find the rows it should have applied to.
  is_provisional boolean not null default false,

  sort_order     integer not null,
  notes          text,

  created_at     timestamptz not null default now(),
  created_by_id  uuid references auth.users(id),
  updated_at     timestamptz not null default now(),
  updated_by_id  uuid references auth.users(id),
  deleted_at     timestamptz,
  deleted_by_id  uuid references auth.users(id),

  -- An anchor without a group is a contradiction; a group member that is not
  -- the anchor is fine and expected.
  constraint residual_formula_rules_anchor_needs_group
    check (not is_group_anchor or group_key is not null)
);

-- One live rule per (registry, fee item name). Partial so a retired rule does
-- not block its replacement within the same registry version.
create unique index if not exists residual_formula_rules_name_unique
  on public.residual_formula_rules (registry_id, fee_item_name)
  where deleted_at is null;

-- EXACTLY ONE ANCHOR PER GROUP PER REGISTRY. Two anchors would compute the
-- group's value twice and double-count it into the merchant total; zero
-- anchors would compute it never and silently drop it. Neither is detectable
-- downstream, so it is made unrepresentable here.
create unique index if not exists residual_formula_rules_one_anchor_per_group
  on public.residual_formula_rules (registry_id, group_key)
  where deleted_at is null and is_group_anchor;

create index if not exists residual_formula_rules_registry
  on public.residual_formula_rules (registry_id, sort_order)
  where deleted_at is null;

drop trigger if exists residual_formula_rules_set_updated_at
  on public.residual_formula_rules;
create trigger residual_formula_rules_set_updated_at
  before update on public.residual_formula_rules
  for each row execute function public.tg_set_updated_at();

alter table public.residual_formula_rules enable row level security;

drop policy if exists "residual_formula_rules_select"
  on public.residual_formula_rules;
create policy "residual_formula_rules_select"
  on public.residual_formula_rules
  for select to authenticated
  using (public.auth_is_admin() and deleted_at is null);

drop policy if exists "residual_formula_rules_insert"
  on public.residual_formula_rules;
create policy "residual_formula_rules_insert"
  on public.residual_formula_rules
  for insert to authenticated
  with check (public.auth_is_admin());

drop policy if exists "residual_formula_rules_update"
  on public.residual_formula_rules;
create policy "residual_formula_rules_update"
  on public.residual_formula_rules
  for update to authenticated
  using (public.auth_is_admin() and deleted_at is null)
  with check (public.auth_is_admin());

comment on table public.residual_formula_rules is
  'One rule per EXACT fee item name within a dated registry. There is deliberately no fee-category fallback: a category maps to many rules, so a fallback has no single answer and would apply an arbitrary rule to real money. An unmatched name must raise.';
comment on column public.residual_formula_rules.group_key is
  'Non-NULL binds fee items whose value is computed once and reconciled against the SUM of the members'' stated nets (the iPOS pair). The computed value lives on residual_line_groups, never on a member line.';
comment on column public.residual_formula_rules.is_provisional is
  'The calc sheet''s "For the moment $0" — an admitted unknown, not a decided zero. Computes as 0.00 but stays findable, so the rows a real rate should have applied to can be identified the day it arrives.';

-- ============================================================
-- 6. residual_formula_terms — the interpreted vocabulary
-- ============================================================
-- A SIDE'S VALUE IS THE SUM OF ITS ACTIVE TERMS. A term is
--
--     term_sign x <operand> x <rate>
--
-- and a side with NO terms is $0.00. That last sentence removes an entire
-- opcode: the calc sheet's "Always $0" — 19 of 20 Additional Income cells,
-- both sides of #6/#18/#19, and one side of six other rules — needs no
-- representation at all, because the absence of terms already means it. An
-- explicit ZERO opcode would have been a second way to say the same thing,
-- and two ways to say one thing is how they come to disagree.
--
-- THE VOCABULARY, derived from the ten shapes the investigation found:
--
--   side          income | buy_rate | additional_income
--                 Three, not two, because Additional Income Directly to
--                 TapDash sits OUTSIDE the tier split and cannot be folded
--                 into income without being multiplied by the share.
--
--   operand       one              -> no multiplier (flat monthly amounts)
--                 line_item_count  -> THIS line's residual_lines.item_count
--                 volume_amex|vmd|debit|ebt
--                                  -> residual_merchant_volumes bucket for
--                                     this (period, mid)
--
--   rate_source   merchant    -> a residual_merchant_rates column (rate_ref)
--                 template    -> a residual_buy_rates fee_item_key (rate_ref),
--                                resolved at the merchant's tier for the month
--                 literal     -> rate_literal, a bare number
--                 net_revenue -> THIS line's stated net_revenue
--
--   term_sign     +1 | -1
--
--   applies_when  always | sibling_absent | sibling_present
--                 with sibling_fee_item_name naming the row to look for in
--                 the same (period, mid).
--
--                 USED BY EXACTLY ONE RULE (#7) AS OF THIS MIGRATION. It was
--                 designed against TWO cases — #7's income suppression and
--                 #2's monthly+online buy-rate combine — and it lives on the
--                 TERM rather than the rule BECAUSE of the second one, where
--                 only one of two buy terms was conditional. Q24a then removed
--                 the combine (see section 10a), so that justifying case is
--                 gone.
--
--                 THE SHAPE IS KEPT AND IS STILL RIGHT: #7 genuinely needs a
--                 per-term condition, and 'sibling_present' remains reachable
--                 for a predecessor registry that re-seeds the combine. But a
--                 future reader should know the design is no longer
--                 load-bearing in two places, so "it must be on the term
--                 because #2 needs it" is no longer an argument available
--                 here — only #7 is.
--
-- HOW EACH AWKWARD SHAPE FALLS OUT OF THAT, without a special case:
--
--   MIRROR (#9,#10,#11,#17). One term: one x net_revenue, term_sign = -1.
--   The calc sheet says "Buy Rate = Net Revenue" and taking that literally
--   inverts the sign — 0 - (-375.32) = +375.32 for a cost. Storing the
--   negation makes Total Income - Total Buy Rate reproduce Net Revenue on all
--   40 mirror rows in the sample. The sign lives in DATA here, not in an
--   engine branch, so the correction is visible to a reviewer reading the
--   registry rather than buried in Part 2.
--
--   CROSS-ROW CONDITIONAL (#7). Its four income terms carry
--   applies_when = sibling_absent, sibling = 'Cash Disc/Surcharge Program'.
--   This is a within-partition EXISTENCE test, never a dependency on another
--   row's computed value, so the whole registry stays evaluable in one pass
--   with a PARTITION BY (period_id, mid) window. It fires on 9 of 21 MIDs in
--   the sample — common, not exotic.
--
--   MONTHLY + ONLINE COMBINE (#2) — REMOVED, AND WORTH KNOWING WHY.
--   It was modelled as the SAME shape as #7 with opposite polarity:
--       term A: one x template.monthly_fee           when sibling_PRESENT
--       term B: one x template.monthly_fee_combined  when sibling_ABSENT
--   and it was VERIFIED 4-for-4 in the May 2026 sample — every MID lacking a
--   Monthly Online Access Fee row carried a Monthly Fee buy rate of exactly
--   7.50 (low tier), and every MID having one carried 4.00, 5.00 or 7.00.
--   Note it was never "add the online rate to the monthly rate": 7.50 against
--   a monthly + online of 4.00 + 6.50 = 10.50, so the combined figure is its
--   own rate, not a sum.
--
--   Q24a removed it because monthly fees are being taken off Maverick's
--   template altogether. The combine existed ONLY to pick the right BUY rate,
--   and with no Maverick monthly buy rate to pick it has no forward-looking
--   purpose. It describes HISTORICAL months only — which need a predecessor
--   registry regardless (Q22, parked).
--
--   IF THAT PREDECESSOR IS EVER SEEDED, THE COMBINE BELONGS IN IT, together
--   with the monthly_fee_combined fee item (7.50 at low tier) and the
--   merchant.monthly_fee_maverick income term. All three are pieces of the
--   same pre-changeover picture and should be re-seeded as one, not
--   reconstructed separately from this comment.
--
--   MANY-TO-ONE (#14/#15). Terms live on the anchor; the other member has
--   none. The group's computed value goes to residual_line_groups (section 8).
--
--   BILLED-DIRECTLY ITEMS (#6 PCI, #18 Website Monitoring, #19 IRS). No terms
--   on any side, so the seeded template rates for pci_fee (5.00),
--   website_monitoring_fee (15.00) and irs_annual_fee (1.95) are never
--   REFERENCED. That is stronger than reading the flag at runtime: an
--   unreferenced rate cannot leak into a total by any code path, whereas a
--   runtime flag check is one forgotten branch away from booking ~$5 per
--   merchant per month of phantom PCI cost. The flag is made load-bearing as
--   a CONSTRAINT instead (section 7), which is the same intent enforced
--   earlier and harder.
--
--   THE TWO $0.02 LITERALS (#5, #20). Kept as literals rather than seeded as
--   a fee item, and the brief asked for the argument. The workbook says
--   "ALWAYS $0.02" — it explicitly does NOT vary by risk tier, while
--   residual_buy_rates is keyed (schedule, risk_tier, fee_item_key) and would
--   force the same number to be seeded four times, maintaining the fiction
--   that it varies and creating four places for three of them to drift. And
--   dating is not lost by keeping it a literal: THIS REGISTRY IS ITSELF
--   DATED, so a change from $0.02 is a new registry version, which is the
--   honest description of what such a change is. A tier-invariant constant
--   belongs where its invariance is visible.
--
--   COMPOSITE (#7, #13). Four terms mixing merchant-month VOLUMES with THIS
--   LINE's own item_count. Legal at the line grain and intended: the count in
--   #7 is the BIN row's count and in #13 the Cash Disc row's, which are
--   different numbers (489 vs 544 on the one MID carrying both). Nothing
--   averages or shares them.
create table if not exists public.residual_formula_terms (
  id                     uuid primary key default gen_random_uuid(),

  rule_id                uuid not null
                           references public.residual_formula_rules(id),

  side                   text not null
                           check (side in ('income','buy_rate','additional_income')),

  operand                text not null
                           check (operand in (
                             'one',
                             'line_item_count',
                             'volume_amex',
                             'volume_vmd',
                             'volume_debit',
                             'volume_ebt'
                           )),

  rate_source            text not null
                           check (rate_source in (
                             'merchant','template','literal','net_revenue'
                           )),

  -- A residual_merchant_rates COLUMN NAME when rate_source = 'merchant';
  -- a residual_fee_items.fee_item_key when rate_source = 'template'.
  rate_ref               text,

  rate_literal           numeric(14,6),

  term_sign              smallint not null default 1
                           check (term_sign in (-1, 1)),

  applies_when           text not null default 'always'
                           check (applies_when in (
                             'always','sibling_absent','sibling_present'
                           )),

  sibling_fee_item_name  text,

  term_order             integer not null,
  notes                  text,

  created_at             timestamptz not null default now(),
  created_by_id          uuid references auth.users(id),
  updated_at             timestamptz not null default now(),
  updated_by_id          uuid references auth.users(id),
  deleted_at             timestamptz,
  deleted_by_id          uuid references auth.users(id),

  -- EXACTLY ONE SOURCE OF THE RATE. Without this a term could carry both a
  -- reference and a literal, and the engine would have to pick — a silent
  -- wrong rate rather than a rejected row.
  constraint residual_formula_terms_rate_shape
    check (
      (rate_source = 'merchant'    and rate_ref is not null and rate_literal is null)
      or (rate_source = 'template' and rate_ref is not null and rate_literal is null)
      or (rate_source = 'literal'  and rate_ref is null     and rate_literal is not null)
      or (rate_source = 'net_revenue' and rate_ref is null  and rate_literal is null)
    ),

  -- MERCHANT COLUMN ALLOWLIST. Spelled out rather than left to a trigger
  -- because the legal set IS the column list of residual_merchant_rates, and
  -- adding to it is necessarily a schema change — the same argument R4a made
  -- for residual_column_mappings.target_column being a CHECK. A typo'd
  -- rate_ref would otherwise resolve to NULL at runtime and, without the
  -- fail-loud contract, to zero.
  --
  -- NOTE monthly_fee_maverick IS ALLOWED HERE BUT REFERENCED BY NO SEEDED
  -- TERM. That is deliberate: it is the column a dated PREDECESSOR registry
  -- needs to reconcile pre-changeover months.
  constraint residual_formula_terms_merchant_ref_known
    check (
      rate_source <> 'merchant'
      or rate_ref in (
        'vmd_auth_fee','pin_debit_auth_fee','avs_fee','batch_fee',
        'vmd_transaction_fee','amex_volume','vmd_volume','pin_debit_volume',
        'amex_template_volume_fee','gateway_monthly_mav','terminal_monthly_mav',
        'monthly_fee_tapdash','monthly_fee_maverick','chargeback_fee'
      )
    ),

  -- A conditional term MUST name its sibling, and an unconditional one must
  -- not carry a dangling name that reads as if it were still in force.
  constraint residual_formula_terms_sibling_shape
    check (
      (applies_when = 'always'  and sibling_fee_item_name is null)
      or (applies_when <> 'always' and sibling_fee_item_name is not null)
    )
);

create index if not exists residual_formula_terms_rule
  on public.residual_formula_terms (rule_id, side, term_order)
  where deleted_at is null;

drop trigger if exists residual_formula_terms_set_updated_at
  on public.residual_formula_terms;
create trigger residual_formula_terms_set_updated_at
  before update on public.residual_formula_terms
  for each row execute function public.tg_set_updated_at();

alter table public.residual_formula_terms enable row level security;

drop policy if exists "residual_formula_terms_select"
  on public.residual_formula_terms;
create policy "residual_formula_terms_select"
  on public.residual_formula_terms
  for select to authenticated
  using (public.auth_is_admin() and deleted_at is null);

drop policy if exists "residual_formula_terms_insert"
  on public.residual_formula_terms;
create policy "residual_formula_terms_insert"
  on public.residual_formula_terms
  for insert to authenticated
  with check (public.auth_is_admin());

drop policy if exists "residual_formula_terms_update"
  on public.residual_formula_terms;
create policy "residual_formula_terms_update"
  on public.residual_formula_terms
  for update to authenticated
  using (public.auth_is_admin() and deleted_at is null)
  with check (public.auth_is_admin());

comment on table public.residual_formula_terms is
  'A side''s value is the sum of its active terms: term_sign x operand x rate. A side with NO terms is $0.00, which is how the calc sheet''s "Always $0" is represented — by absence, so there is only one way to say it. The mirror rules'' sign correction lives here as data (term_sign = -1), visible to a reviewer rather than buried in engine code.';

-- ============================================================
-- 7. tg_residual_formula_terms_validate — the cross-table guard
-- ============================================================
-- Two things a CHECK cannot see, because both look at another table.
--
--   a) A 'template' rate_ref must name a LIVE residual_fee_items row. A
--      typo'd key resolves to no rate at all, and the whole point of the
--      fail-loud contract is that "no rate" stops the calculation — but it
--      stops it at RUN time, on real money, potentially months later. Here it
--      stops at SEED time, which is free.
--
--   b) A term must NEVER reference a fee item flagged
--      billed_directly_to_merchant. PCI Fee, Website Monitoring Fee and IRS
--      Annual Fee carry real seeded rates (5.00 / 15.00 / 1.95) but the
--      merchant pays them directly, so TapDash neither earns nor pays them
--      and both sides are $0. The brief asked that the engine read the FLAG
--      and never the rate. This enforces the same intent one stage earlier
--      and absolutely: a term that would read such a rate cannot be stored,
--      so no engine branch has to remember not to. A runtime check is one
--      forgotten condition away from booking phantom cost; a constraint is
--      not.
create or replace function public.tg_residual_formula_terms_validate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_billed boolean;
begin
  if new.rate_source <> 'template' then
    return new;
  end if;

  select fi.billed_directly_to_merchant into v_billed
    from public.residual_fee_items fi
   where fi.fee_item_key = new.rate_ref
     and fi.deleted_at is null;

  if v_billed is null then
    raise exception
      'residual_formula_terms: template rate_ref % names no live residual_fee_items row.',
      new.rate_ref
      using errcode = '23503';
  end if;

  if v_billed then
    raise exception
      'residual_formula_terms: fee item % is billed directly to the merchant; neither side may reference its rate.',
      new.rate_ref
      using errcode = '23514',
            hint = 'Billed-directly items compute as $0 on both sides. Give the rule no terms.';
  end if;

  return new;
end;
$$;

revoke all on function public.tg_residual_formula_terms_validate()
  from public, anon, authenticated, service_role;

drop trigger if exists residual_formula_terms_validate
  on public.residual_formula_terms;
create trigger residual_formula_terms_validate
  before insert or update on public.residual_formula_terms
  for each row execute function public.tg_residual_formula_terms_validate();

-- ============================================================
-- 8. Part C — the sixth column, and where a group's value lives
-- ============================================================
--
-- 8a. THE SIXTH COLUMN.
-- The chain has SIX values and residual_lines had five columns:
--   Total Income
--   Total Buy Rate
--   pre-split net  = income - buy rate      <- reconciles vs Net Revenue
--   TapDash Net    = pre-split x share      <- what TapDash banks
--   Additional Income Directly to TapDash
--   Net Income     = TapDash Net + Additional
--
-- The calc sheet's column S is LABELLED "TapDash Net (after split)" but its
-- formula, verbatim on all 20 rows, is "Total Income - Total Buy Rate" with
-- no share multiplication anywhere on the tab. The schema faithfully
-- reproduced the mislabel. Per Q17 the share DOES apply, per line, so the two
-- values are distinct — they differ by 10-30% at shares of 0.9/0.8/0.7 — and
-- the pre-split figure is the one that reconciles against the processor.
-- Storing only the post-split value would make every reconciliation failure
-- unexplainable, so pre-split gets its own column and the existing column
-- finally means what it says.
alter table public.residual_lines
  add column if not exists tapdash_net_before_split numeric(14,2);

comment on column public.residual_lines.tapdash_net_before_split is
  'Total Income - Total Buy Rate, BEFORE the tier share. This is the value that reconciles against the processor''s stated net_revenue. tapdash_net_after_split is this multiplied by residual_buy_rate_tiers.tapdash_share and is what TapDash banks; the two differ by 10-30% and cannot share a column.';

comment on column public.residual_lines.tapdash_net_after_split is
  'tapdash_net_before_split x the merchant''s tier share for the month. Rounded to 2dp PER LINE (Q17): a merchant total is SUM() of stored line values plus SUM() of that merchant''s residual_line_groups rows. Per-line and per-merchant rounding are NOT interchangeable — measured, they differ by a penny on 3 of 12 sample merchants.';

-- 8b. WHERE A GROUP'S COMPUTED VALUE LIVES.
-- The iPOS pair computes once and reconciles against two report rows. No
-- per-line column can hold that:
--   * splitting the value across both members invents an allocation the
--     source does not specify;
--   * putting it on one member makes the other look like an unexplained
--     -10.00 sitting next to a stated net that nothing accounts for.
-- So it lives at its own grain. Members contribute 0.00 to the line-level
-- sums and the group row carries the real figures, which keeps NULL meaning
-- "not computed" rather than becoming a third state.
--
-- CONSEQUENCE OF Q17 WORTH STATING PLAINLY: a merchant's month is
--     SUM(residual_lines) + SUM(residual_line_groups)
-- not SUM(residual_lines) alone. Every report and every reconciliation must
-- include the second term or grouped merchants silently under-report.
create table if not exists public.residual_line_groups (
  id                        uuid primary key default gen_random_uuid(),

  period_id                 uuid not null references public.residual_periods(id),
  mid                       text not null,
  group_key                 text not null
                              check (group_key ~ '^[a-z][a-z0-9_]{0,40}$'),

  -- The same six values as a line, at group grain.
  total_income              numeric(14,2),
  total_buy_rate            numeric(14,2),
  tapdash_net_before_split  numeric(14,2),
  tapdash_net_after_split   numeric(14,2),
  additional_income_direct  numeric(14,2),
  net_income                numeric(14,2),

  -- The reconciliation target: SUM of the member lines' STATED net_revenue.
  -- Stored rather than derived because it is the evidence for a reconciled
  -- or mismatched verdict at the moment the verdict was reached, and the
  -- member set can change under a re-import.
  stated_net_revenue        numeric(14,2),

  member_line_count         integer,

  created_at                timestamptz not null default now(),
  created_by_id             uuid references auth.users(id),
  updated_at                timestamptz not null default now(),
  updated_by_id             uuid references auth.users(id),
  deleted_at                timestamptz,
  deleted_by_id             uuid references auth.users(id)
);

create unique index if not exists residual_line_groups_unique
  on public.residual_line_groups (period_id, mid, group_key)
  where deleted_at is null;

create index if not exists residual_line_groups_period
  on public.residual_line_groups (period_id, mid)
  where deleted_at is null;

drop trigger if exists residual_line_groups_set_updated_at
  on public.residual_line_groups;
create trigger residual_line_groups_set_updated_at
  before update on public.residual_line_groups
  for each row execute function public.tg_set_updated_at();

alter table public.residual_line_groups enable row level security;

drop policy if exists "residual_line_groups_select"
  on public.residual_line_groups;
create policy "residual_line_groups_select"
  on public.residual_line_groups
  for select to authenticated
  using (public.auth_is_admin() and deleted_at is null);

drop policy if exists "residual_line_groups_insert"
  on public.residual_line_groups;
create policy "residual_line_groups_insert"
  on public.residual_line_groups
  for insert to authenticated
  with check (public.auth_is_admin());

drop policy if exists "residual_line_groups_update"
  on public.residual_line_groups;
create policy "residual_line_groups_update"
  on public.residual_line_groups
  for update to authenticated
  using (public.auth_is_admin() and deleted_at is null)
  with check (public.auth_is_admin());

comment on table public.residual_line_groups is
  'Computed values for many-to-one rules: computed ONCE, reconciled against the SUM of the member lines'' stated net_revenue. Member lines get 0.00 in their engine columns so NULL keeps meaning "not computed". A merchant''s month is SUM(residual_lines) + SUM(residual_line_groups) — reports that omit the second term silently under-report grouped merchants.';

-- ============================================================
-- 9. Part C — recompute safety
-- ============================================================
--
-- 9a. WHAT calculation_version MEANS, AND WHO WRITES IT.
-- R1b created it as scaffolding with one documented meaning: NULL = never
-- computed, which is what distinguishes an uncomputed NULL derived column
-- from one computed to nothing. R5d Part 1 fixes the rest of the contract
-- without implementing it:
--
--   * It is a MONOTONIC COUNTER per period, not a schema version. Each
--     successful full-period compute sets it to coalesce(previous, 0) + 1.
--   * It is written by the Part 2 engine RPC and by NOTHING ELSE — not by
--     imports, not by the app, not by hand. It is the engine's assertion
--     that every live line and group in the period was computed by one run.
--   * NULL means "no such assertion stands", covering both never-computed
--     and invalidated-since. Those two are not usefully different to a
--     reader: in both cases the stored outputs cannot be trusted.
--   * It is written LAST, after every line and group in the period. A
--     partial compute must leave it NULL rather than claim a run happened.
comment on column public.residual_periods.calculation_version is
  'Monotonic per-period counter, incremented by the Part 2 engine RPC on a successful FULL-period compute and written last. NULL = no standing assertion that the stored outputs are current (never computed, or invalidated since). Written by the engine only — never by an import, the app, or by hand.';

-- 9b. CLOSING THE R4a HOLE.
-- The supersede sweep in commit_residual_excel_import soft-deletes every line
-- from a prior import and inserts fresh rows with NULL engine columns, and it
-- does NOT touch residual_periods. So after any re-import the period still
-- claimed "computed" while every live line had NULL outputs — exactly the
-- ambiguity calculation_version exists to prevent, inverted. This is a LIVE
-- hole in shipped R4a/R5b code today; R5d only makes it visible by being the
-- first thing to write a non-NULL version.
--
-- FIXED WITH A TRIGGER ON residual_lines RATHER THAN BY PATCHING THE TWO
-- IMPORT RPCs, deliberately. Patching would mean CREATE OR REPLACE of two
-- large functions last rewritten in R5b, reproducing bodies unrelated to this
-- change, and it would close the hole for exactly the two callers that exist
-- today. Attaching invalidation to the FACT (the lines changed) instead of to
-- a caller covers the supersede sweep, manual line entry, the PDF path, and
-- every future import route, and it cannot be forgotten by the author of the
-- next one.
--
-- RECURSION IS AVOIDED BY SCOPE, NOT BY A FLAG. The trigger fires only when
-- the STATED columns or row lifecycle change. The engine writes ONLY the
-- engine columns, so its own writes cannot trip the invalidation it is about
-- to satisfy. This is why the WHEN clause enumerates columns rather than
-- firing on any UPDATE.
create or replace function public.tg_residual_lines_invalidate_calculation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period uuid := coalesce(new.period_id, old.period_id);
begin
  -- Guarded so a 197-row bulk insert performs ONE write to the period rather
  -- than 197 updates of the same row. After the first, this is an index probe
  -- and nothing more.
  update public.residual_periods p
     set calculation_version = null,
         status = case when p.status in ('ready','reconciled','mismatch')
                       then 'open' else p.status end
   where p.id = v_period
     and (p.calculation_version is not null
          or p.status in ('ready','reconciled','mismatch'));

  return null;
end;
$$;

revoke all on function public.tg_residual_lines_invalidate_calculation()
  from public, anon, authenticated, service_role;

drop trigger if exists residual_lines_invalidate_calculation_ins
  on public.residual_lines;
create trigger residual_lines_invalidate_calculation_ins
  after insert on public.residual_lines
  for each row execute function public.tg_residual_lines_invalidate_calculation();

drop trigger if exists residual_lines_invalidate_calculation_del
  on public.residual_lines;
create trigger residual_lines_invalidate_calculation_del
  after delete on public.residual_lines
  for each row execute function public.tg_residual_lines_invalidate_calculation();

-- The column list IS the definition of "the statement changed". Engine
-- columns are deliberately absent: tapdash_net_after_split moving is the
-- engine doing its job, not the inputs shifting under it.
drop trigger if exists residual_lines_invalidate_calculation_upd
  on public.residual_lines;
create trigger residual_lines_invalidate_calculation_upd
  after update of
    period_id, mid, merchant_name, fee_category, fee_item_name,
    item_count, amount, buy_rate_per_item,
    agent_income, agent_expense, net_revenue, deleted_at
  on public.residual_lines
  for each row execute function public.tg_residual_lines_invalidate_calculation();

-- 9c. THE WRITE GUARD — A RECONCILED PERIOD IS FROZEN.
-- "Closed" was previously a label with nothing behind it: no trigger, no RLS
-- predicate and no application check referenced status, so an UPDATE to the
-- engine columns of a 'reconciled' period succeeded exactly as on an open
-- one. A reconciled month is a month somebody has signed off; silently
-- recomputing it changes a number an auditor has already seen.
--
-- Q25 EXTENDS THE GUARD TO THE STATEMENT DATA ITSELF, not just the computed
-- columns. Without that extension there was a hole big enough to drive an
-- import through: a re-import into a reconciled period INSERTs lines, which
-- 9b's invalidation trigger then answers by setting the period back to
-- 'open'. The sign-off was undone as a side effect of a routine upload, with
-- nobody told. Freezing the outputs while leaving the inputs writable
-- protects the wrong half.
--
-- THE GUARDED SET IS EXACTLY 9b's SET, PLUS THE ENGINE COLUMNS, and the
-- symmetry is the point rather than a coincidence: THE CHANGES THAT
-- INVALIDATE A CALCULATION ARE PRECISELY THE CHANGES A RECONCILED PERIOD
-- FORBIDS. If a future column is added to one list it belongs in the other.
--
-- WHERE THIS LIVES: A TRIGGER, NOT A CHECK INSIDE THE TWO COMMIT RPCs — the
-- SAME answer as 9b, for the same reason, and the brief asked whether the two
-- cases differ. They do not.
--
--   * Attaching to the FACT covers every route: both import RPCs, manual line
--     entry, any future importer. Manual entry matters here in a way it did
--     not for invalidation — hand-inserting a line into a signed-off month is
--     exactly as much a violation as re-importing one, and an RPC-only check
--     would police the two loud routes and ignore the quiet one.
--
--   * THE "WORSE ERROR FROM DEEP INSIDE A BULK INSERT" CONCERN DOES NOT
--     MATERIALISE HERE, and it is worth saying why rather than asserting it.
--     Every line in one import shares one period_id, so a BEFORE INSERT
--     trigger raises on the FIRST row, not the 197th — there is no long
--     partial insert to unwind. The commit RPCs are atomic, so the supersede
--     sweep and the import's period_id update roll back with it and no
--     half-state survives. And the error raised is OURS, naming the period
--     and telling the operator to reopen it, rather than a bare constraint
--     code. An early check in the RPC would produce a near-identical message
--     at a marginally earlier instant, in exchange for CREATE OR REPLACE of
--     two large functions last rewritten in R5b and coverage of two callers
--     instead of all of them. That trade is worse.
--
-- THE GUARD BLOCKS THE WRITE, NOT THE RECOMPUTE. Moving a period out of
-- 'reconciled' stays an explicit admin act, and after that both the engine
-- and a re-import run normally. Reopening is a decision somebody makes, not a
-- side effect of running a job.
--
-- NOTE THIS CANNOT DEADLOCK OR RACE WITH 9b. 9b is an AFTER trigger and only
-- ever moves a period AWAY from 'reconciled'; this is a BEFORE trigger on the
-- same events. BEFORE runs first, so on a reconciled period the statement is
-- rejected and 9b never fires — the guard wins, which is the required
-- ordering. On any other status the guard passes and 9b invalidates as before.
create or replace function public.tg_residual_guard_reconciled_period()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period uuid := coalesce(new.period_id, old.period_id);
  v_status text;
  v_month  date;
begin
  select p.status, p.statement_month into v_status, v_month
    from public.residual_periods p
   where p.id = v_period
     and p.deleted_at is null;

  if v_status = 'reconciled' then
    raise exception
      'Statement month % (period %) is reconciled and cannot be modified.',
      to_char(v_month, 'YYYY-MM'), v_period
      using errcode = '42501',
            hint = 'Reopen the period first — set residual_periods.status to ''open'' for this period — then re-run the import or the calculation.';
  end if;

  -- DELETE must return OLD or the row is not deleted.
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.tg_residual_guard_reconciled_period()
  from public, anon, authenticated, service_role;

-- The computed columns.
drop trigger if exists residual_lines_guard_reconciled
  on public.residual_lines;
create trigger residual_lines_guard_reconciled
  before update of
    total_income, total_buy_rate, tapdash_net_before_split,
    tapdash_net_after_split, additional_income_direct, net_income
  on public.residual_lines
  for each row execute function public.tg_residual_guard_reconciled_period();

-- The statement data. This is the half Q25 adds, and the INSERT trigger is
-- the one that stops a re-import.
drop trigger if exists residual_lines_guard_reconciled_ins
  on public.residual_lines;
create trigger residual_lines_guard_reconciled_ins
  before insert on public.residual_lines
  for each row execute function public.tg_residual_guard_reconciled_period();

drop trigger if exists residual_lines_guard_reconciled_del
  on public.residual_lines;
create trigger residual_lines_guard_reconciled_del
  before delete on public.residual_lines
  for each row execute function public.tg_residual_guard_reconciled_period();

-- Column list identical to 9b's, deliberately. Note deleted_at is included,
-- so the supersede sweep's soft-delete is blocked too — a re-import that
-- could not insert its new lines must not be able to retire the old ones
-- either.
drop trigger if exists residual_lines_guard_reconciled_upd
  on public.residual_lines;
create trigger residual_lines_guard_reconciled_upd
  before update of
    period_id, mid, merchant_name, fee_category, fee_item_name,
    item_count, amount, buy_rate_per_item,
    agent_income, agent_expense, net_revenue, deleted_at
  on public.residual_lines
  for each row execute function public.tg_residual_guard_reconciled_period();

drop trigger if exists residual_line_groups_guard_reconciled
  on public.residual_line_groups;
create trigger residual_line_groups_guard_reconciled
  before insert or update or delete on public.residual_line_groups
  for each row execute function public.tg_residual_guard_reconciled_period();

-- 9d. source = 'manual' LINES DURING A RECOMPUTE — THE DECISION.
-- They are computed IDENTICALLY to every other line, and the engine must
-- include them.
--
-- The reasoning is that 'manual' describes the PROVENANCE OF THE STATEMENT
-- DATA, not of the result. R4a's residual_lines_provenance_consistent defines
-- a manual line as one with no import file behind it — a hand-entered
-- statement line — and its fee_item_name resolves against the registry like
-- any other. Nothing about typing a line in by hand makes its margin a
-- different kind of number.
--
-- THE ASYMMETRY THAT MAKES THIS LOAD-BEARING: the R4a supersede sweep
-- deliberately SPARES manual lines, so they persist across re-imports. An
-- engine that skipped them would therefore drop a hand-entered correction out
-- of the totals on the first re-import and never mention it.
--
-- A hand-entered RESULT that the engine must not overwrite is a different
-- feature — an override column plus a reason — and is deliberately NOT in
-- R5d. Silently treating 'manual' as "do not touch" would ship that feature
-- by accident, with no way to express why a line was overridden.

-- ============================================================
-- 10. Seeds
-- ============================================================

-- ---------- 10a. DELIBERATELY EMPTY — the combine, and why it is not here --
-- An earlier draft of this migration seeded a 'monthly_fee_combined' fee item
-- and a low-tier rate of 7.50 for it, to support rule #2's monthly+online
-- combine. Q24a removed both. This section is kept as a header rather than
-- deleted outright so that the removal is a recorded decision instead of a
-- gap between 10b and the section numbering.
--
-- WHAT WAS REMOVED, AND WHAT IT WAS WORTH:
--   * fee item     monthly_fee_combined ('Monthly Fee (combined with Online
--                  Access)', rate_kind 'amount', not billed directly)
--   * buy rate     7.50 at the LOW tier of the MAVERICK schedule
--   * two terms    on rule #2's buy_rate side, conditional on the presence or
--                  absence of a 'Monthly Online Access Fee' row
--
-- IT WAS NOT WRONG — it was verified 4-for-4 against the May 2026 sample. It
-- was removed because monthly fees are being taken off Maverick's template
-- altogether, so there is no Maverick monthly buy rate left for the combine
-- to select between. It describes historical months only.
--
-- Historical months need a PREDECESSOR REGISTRY regardless (Q22, parked). If
-- one is ever seeded, all three pieces belong in it together: this fee item
-- and its 7.50, the two conditional buy terms, and rule #2's pre-changeover
-- income term reading merchant.monthly_fee_maverick. They are one
-- pre-changeover picture and should be re-seeded as one.
--
-- NOTHING IS DELETED FROM residual_buy_rates BY THIS MIGRATION. The seeded
-- 'monthly_fee' rates stay exactly as R5c wrote them; they are simply
-- unreferenced now.

-- ---------- 10b. the registry ----------
-- effective_from matches the buy-rate schedule's 2000-01-01 so that every
-- month currently loadable resolves to exactly one registry. See the header
-- for what to do if May 2026 must reconcile under the PREVIOUS rule #2.
insert into public.residual_formula_registries
  (processor, label, effective_from, effective_to, notes)
select 'MAVERICK',
       'Maverick Processor Monthly Reconciliation (calc sheet, as transcribed)',
       date '2000-01-01',
       null,
       'The 20 rules of "Tab - Processor Monthly Reconci". Rule #2 reflects the binding decision that Maverick no longer collects the merchant monthly fee. 11 of 21 May 2026 rows carry non-zero Agent Income and will NOT reconcile under this registry; if they must, insert a predecessor registry reading merchant.monthly_fee_maverick and move this effective_from forward.'
where not exists (
  select 1 from public.residual_formula_registries r
  where r.processor = 'MAVERICK' and r.deleted_at is null
);

-- ---------- 10c. the twenty rules ----------
insert into public.residual_formula_rules
  (registry_id, fee_item_name, fee_category, group_key, is_group_anchor,
   is_provisional, sort_order, notes)
select r.id, v.fee_item_name, v.fee_category, v.group_key, v.is_anchor,
       v.is_provisional, v.sort_order, v.notes
from public.residual_formula_registries r
cross join (values
  ('Authorization Fee IP/SSL',     'Authorization Trxns', null,             false, false,  10,
   'Calc sheet note: "Must always confirm risk level when multiplying buy rate."'),
  ('Monthly Fee',                  'MISC Fixed Fees',     null,             false, false,  20,
   'REVISED (Q24a): Maverick no longer collects this AND it is being removed from Maverick''s template, so BOTH sides are $0 (no terms) and the only value is Additional Income = merchant.monthly_fee_tapdash. The monthly+online COMBINE was removed with it: it existed only to select the right Maverick buy rate, and there is no longer one to select. The combine was verified 4-for-4 in the May 2026 sample at 7.50 (low tier) and applies to historical months only, which need a predecessor registry regardless (Q22, parked) — if that is ever seeded, the combine, the monthly_fee_combined fee item and the monthly_fee_maverick income term belong in it together. NOTE: 11 of 21 May 2026 rows carry non-zero Agent Income and will not reconcile under this rule; that is expected, not a defect.'),
  ('Merchant Deposit Transaction', 'Data Capture Trxns',  null,             false, false,  30, null),
  ('Monthly Online Access Fee',    'MISC Fixed Fees',     null,             false, false,  40, null),
  ('PIN Debit Auth Fee',           'Debit Network',       null,             false, false,  50,
   'Buy rate is the workbook literal $0.02 — explicitly tier-invariant ("ALWAYS").'),
  ('PCI Program',                  'MISC Fixed Fees',     null,             false, false,  60,
   'Billed directly to the merchant: $0 both sides. The seeded pci_fee rate of 5.00 is reference only and is referenced by no term.'),
  ('BIN Sponsorship Fees',         'Discount',            null,             false, false,  70,
   'Income is suppressed entirely when the same (period, mid) carries a Cash Disc/Surcharge Program row — 9 of 21 sample MIDs. Buy side multiplies TWO volumes by the SAME vmd_bin rate; that is not a transcription error.'),
  ('AVS Fee',                      'Authorization Other', null,             false, false,  80, null),
  ('Interchange',                  'Interchange',         null,             false, false,  90,
   'Mirror. Two sample rows have POSITIVE net revenue, giving a legitimately negative buy rate (a rebate) — do not constrain the buy rate non-negative.'),
  ('Amex Pass Thru Fees (Non OB)', 'Card Brand Fees',     null,             false, false, 100, 'Mirror.'),
  ('Card Brand Fees V/MC/D/PP',    'Card Brand Fees',     null,             false, false, 110,
   'Mirror. DISTINCT from "Card Brand Fees" — the names differ only by suffix and must never be prefix-matched.'),
  ('Amex OptBlue Fee',             'Card Brand Fees',     null,             false, false, 120,
   'Buy side verified exactly on 9 sample rows: amex volume x template amex_optblue at the merchant tier.'),
  ('Cash Disc/Surcharge Program',  'Individual Plan',     null,             false, false, 130,
   'Same four income terms as BIN Sponsorship but UNCONDITIONAL. Buy side $0.'),
  ('iPOS Spin Fee',                'MISC Fixed Fees',     'ipos_terminal',  true,  true,  140,
   'GROUP ANCHOR. Calc sheet: "report breaks it out by two line items but the calculation is only done once". Buy side is the sheet''s "For the moment $0" — provisional.'),
  ('iPOSPays Terminal',            'MISC Fixed Fees',     'ipos_terminal',  false, true,  150,
   'Group member, NO terms. The calc sheet leaves its income cell EMPTY (not "$0"); its value is the anchor''s and lives on residual_line_groups.'),
  ('Accept Blue Monthly',          'MISC Fixed Fees',     null,             false, true,  160,
   'Buy side is the sheet''s "For the moment $0" — provisional.'),
  ('Card Brand Fees',              'Card Brand Fees',     null,             false, false, 170,
   'Mirror. DISTINCT from "Card Brand Fees V/MC/D/PP".'),
  ('Website Monitoring Fee',       'MISC Fixed Fees',     null,             false, false, 180,
   'Billed directly to the merchant: $0 both sides. Seeded rate 15.00 is reference only.'),
  ('IRS Annual Fee',               'MISC Fixed Fees',     null,             false, false, 190,
   'Billed directly to the merchant: $0 both sides. Seeded rate 1.95 is reference only.'),
  ('EBT Authorization Fee',        'EBT',                 null,             false, false, 200,
   'Reads the VMD auth rate deliberately, not an EBT-specific field, and the buy side is the $0.02 literal. Confirmed intentional.')
) as v(fee_item_name, fee_category, group_key, is_anchor, is_provisional, sort_order, notes)
where r.processor = 'MAVERICK'
  and r.deleted_at is null
  and not exists (
    select 1 from public.residual_formula_rules fr
     where fr.registry_id = r.id
       and fr.fee_item_name = v.fee_item_name
       and fr.deleted_at is null
  );

-- ---------- 10d. the terms ----------
-- 30 terms across 20 rules. Rules #6, #15, #18 and #19 appear nowhere below,
-- because a side with no terms IS $0.00.
--
-- RULE #2 APPEARS EXACTLY ONCE, on the additional_income side. Both its
-- income and its buy_rate sides are absent, which is the representation of
-- "$0.00 on both sides" — the Q24a outcome. It is the only rule in the
-- registry whose sole term is on additional_income.
insert into public.residual_formula_terms
  (rule_id, side, operand, rate_source, rate_ref, rate_literal,
   term_sign, applies_when, sibling_fee_item_name, term_order, notes)
select fr.id, v.side, v.operand, v.rate_source, v.rate_ref, v.rate_literal,
       v.term_sign, v.applies_when, v.sibling, v.term_order, v.notes
from public.residual_formula_rules fr
join public.residual_formula_registries reg
  on reg.id = fr.registry_id
 and reg.processor = 'MAVERICK'
 and reg.deleted_at is null
join (values
  -- #1 Authorization Fee IP/SSL
  ('Authorization Fee IP/SSL','income',  'line_item_count','merchant','vmd_auth_fee',      null::numeric,1::smallint,'always',        null::text, 1, null::text),
  ('Authorization Fee IP/SSL','buy_rate','line_item_count','template','vmd_auth_fee',      null,          1,          'always',        null,       1, null),

  -- #2 Monthly Fee — BOTH income and buy_rate deliberately absent ($0 each).
  -- Q24a: Maverick neither collects the fee nor quotes a buy rate for it, so
  -- the whole rule is one Additional Income term.
  ('Monthly Fee','additional_income','one','merchant','monthly_fee_tapdash', null, 1, 'always', null, 1,
   'Outside the tier split by design: Maverick is not party to a fee TapDash bills the merchant directly.'),

  -- #3 Merchant Deposit Transaction
  ('Merchant Deposit Transaction','income',  'line_item_count','merchant','batch_fee', null, 1, 'always', null, 1, null),
  ('Merchant Deposit Transaction','buy_rate','line_item_count','template','batch_fee', null, 1, 'always', null, 1, null),

  -- #4 Monthly Online Access Fee — income absent ($0)
  ('Monthly Online Access Fee','buy_rate','one','template','monthly_online_access_fee', null, 1, 'always', null, 1, null),

  -- #5 PIN Debit Auth Fee
  ('PIN Debit Auth Fee','income',  'line_item_count','merchant','pin_debit_auth_fee', null, 1, 'always', null, 1, null),
  ('PIN Debit Auth Fee','buy_rate','line_item_count','literal', null,                 0.020000, 1, 'always', null, 1,
   'Workbook literal: "Count x ALWAYS $0.02". Tier-invariant, so it is not a fee item.'),

  -- #7 BIN Sponsorship Fees
  ('BIN Sponsorship Fees','income','volume_amex',    'merchant','amex_volume',         null, 1, 'sibling_absent','Cash Disc/Surcharge Program', 1, null),
  ('BIN Sponsorship Fees','income','volume_vmd',     'merchant','vmd_volume',          null, 1, 'sibling_absent','Cash Disc/Surcharge Program', 2, null),
  ('BIN Sponsorship Fees','income','volume_debit',   'merchant','pin_debit_volume',    null, 1, 'sibling_absent','Cash Disc/Surcharge Program', 3, null),
  ('BIN Sponsorship Fees','income','line_item_count','merchant','vmd_transaction_fee', null, 1, 'sibling_absent','Cash Disc/Surcharge Program', 4,
   'THIS line''s own count, mixed with merchant-month volumes. Intended: #13 uses its own different count.'),
  ('BIN Sponsorship Fees','buy_rate','volume_vmd',  'template','vmd_bin', null, 1, 'always', null, 1, null),
  ('BIN Sponsorship Fees','buy_rate','volume_debit','template','vmd_bin', null, 1, 'always', null, 2,
   'Same vmd_bin rate against a DIFFERENT volume. Not a transcription error.'),

  -- #8 AVS Fee
  ('AVS Fee','income',  'line_item_count','merchant','avs_fee', null, 1, 'always', null, 1, null),
  ('AVS Fee','buy_rate','line_item_count','template','avs_fee', null, 1, 'always', null, 1, null),

  -- #9/#10/#11/#17 mirrors — income absent ($0)
  ('Interchange','buy_rate','one','net_revenue',null,null,-1,'always',null,1,
   'Mirror: buy rate = -net_revenue. The sheet says "= Net Revenue", which inverts the sign of a cost; the negation is what makes income - buy reproduce net revenue.'),
  ('Amex Pass Thru Fees (Non OB)','buy_rate','one','net_revenue',null,null,-1,'always',null,1,'Mirror.'),
  ('Card Brand Fees V/MC/D/PP',   'buy_rate','one','net_revenue',null,null,-1,'always',null,1,'Mirror.'),
  ('Card Brand Fees',             'buy_rate','one','net_revenue',null,null,-1,'always',null,1,'Mirror.'),

  -- #12 Amex OptBlue Fee
  ('Amex OptBlue Fee','income',  'volume_amex','merchant','amex_template_volume_fee', null, 1, 'always', null, 1, null),
  ('Amex OptBlue Fee','buy_rate','volume_amex','template','amex_optblue',             null, 1, 'always', null, 1, null),

  -- #13 Cash Disc/Surcharge Program — buy side absent ($0)
  ('Cash Disc/Surcharge Program','income','volume_amex',    'merchant','amex_volume',         null, 1, 'always', null, 1, null),
  ('Cash Disc/Surcharge Program','income','volume_vmd',     'merchant','vmd_volume',          null, 1, 'always', null, 2, null),
  ('Cash Disc/Surcharge Program','income','volume_debit',   'merchant','pin_debit_volume',    null, 1, 'always', null, 3, null),
  ('Cash Disc/Surcharge Program','income','line_item_count','merchant','vmd_transaction_fee', null, 1, 'always', null, 4, null),

  -- #14 iPOS Spin Fee (group anchor) — buy side absent (provisional $0)
  ('iPOS Spin Fee','income','one','merchant','terminal_monthly_mav', null, 1, 'always', null, 1,
   'The group''s only terms. Its computed value lands on residual_line_groups, not on this line.'),

  -- #16 Accept Blue Monthly — buy side absent (provisional $0)
  ('Accept Blue Monthly','income','one','merchant','gateway_monthly_mav', null, 1, 'always', null, 1, null),

  -- #20 EBT Authorization Fee
  ('EBT Authorization Fee','income',  'line_item_count','merchant','vmd_auth_fee', null,     1, 'always', null, 1,
   'Reads the VMD auth rate, not an EBT field. Confirmed intentional.'),
  ('EBT Authorization Fee','buy_rate','line_item_count','literal', null,           0.020000, 1, 'always', null, 1,
   'Workbook literal: "Count x ALWAYS $0.02".')
) as v(fee_item_name, side, operand, rate_source, rate_ref, rate_literal,
       term_sign, applies_when, sibling, term_order, notes)
  on v.fee_item_name = fr.fee_item_name
where fr.deleted_at is null
  and not exists (
    select 1 from public.residual_formula_terms ft
     where ft.rule_id = fr.id
       and ft.side = v.side
       and ft.term_order = v.term_order
       and ft.deleted_at is null
  );

commit;
