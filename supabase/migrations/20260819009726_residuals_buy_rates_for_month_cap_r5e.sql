-- Ported from Daniel Weissman's residuals branch, file
-- `20260904160000_residuals_buy_rates_for_month_cap_r5e.sql`.
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
-- Residuals R5e — residual_buy_rates_for_month returns the cap
-- ============================================================
--
-- A BUG IN 20260904140000, found by the integration suite within minutes.
--
-- That migration taught compute_residual_period to build its per-tier buy map
-- as {fee_item_key: {"rate": …, "cap": …}}, reading b.rate_cap from
-- residual_buy_rates_for_month. But that function's RETURNS TABLE never
-- carried rate_cap — the column was added to the residual_buy_rates TABLE, and
-- the reader in front of it was not widened to match.
--
-- So every call raised "column b.rate_cap does not exist", which meant the
-- engine raised for every period. The suite caught it as eighteen SKIPPED
-- tests rather than eighteen failures: the throw happened in a describe-level
-- beforeAll, and vitest reports the block as skipped. Worth remembering — a
-- sudden jump in SKIPPED counts is a setup that threw, not a test anyone chose
-- to skip.
--
-- WHY THIS WAS NOT CAUGHT BY THE PROBE. The cap evaluation was verified against
-- a hand-built jsonb passed straight to residual_eval_side, which proved
-- min(op x rate, cap) arithmetic correctly and proved nothing about where the
-- map comes from. The probe tested the half I wrote and skipped the half I
-- changed underneath it.
--
-- Idempotent: drop-if-exists then create.

begin;

drop function if exists public.residual_buy_rates_for_month(text, date);

create function public.residual_buy_rates_for_month(
  p_processor text,
  p_month     date
)
returns table (
  schedule_id                 uuid,
  risk_tier                   text,
  tapdash_share               numeric,
  fee_item_key                text,
  fee_item_label              text,
  rate_kind                   text,
  billed_directly_to_merchant boolean,
  rate                        numeric,
  rate_cap                    numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_processor text := upper(btrim(coalesce(p_processor, '')));
  v_month     date := date_trunc('month', p_month)::date;
  v_schedule  uuid;
begin
  if public.auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to read template buy rates.'
      using errcode = '42501';
  end if;

  -- p_month is truncated rather than rejected: callers pass a period's
  -- statement_month, which residual_periods already pins to the 1st, and a
  -- caller who passes mid-month means the month containing that day. NULL is
  -- rejected explicitly rather than falling through to the not-covered raise,
  -- which would report a missing schedule for a month nobody asked about.
  if v_month is null then
    raise exception 'residual_buy_rates_for_month: p_month is required.'
      using errcode = '22004';
  end if;

  -- Exactly one schedule can cover a month (the EXCLUDE guarantees it), so
  -- this cannot silently pick one of several.
  select s.id into v_schedule
    from public.residual_buy_rate_schedules s
   where s.deleted_at is null
     and s.processor = v_processor
     and s.effective_from <= v_month
     and (s.effective_to is null or s.effective_to > v_month);

  -- A MISSING RATE MUST NEVER READ AS A ZERO RATE. Returning zero rows here
  -- would let R5d compute a total buy rate of 0.00 for an uncovered month and
  -- book the entire income as margin. Raising is the only safe empty case.
  if v_schedule is null then
    raise exception
      'No buy-rate schedule covers % for processor %.', v_month, v_processor
      using errcode = 'P0002',
            hint = 'Check residual_buy_rate_coverage() for uncovered months.';
  end if;

  return query
    select bt.schedule_id,
           bt.risk_tier,
           bt.tapdash_share,
           br.fee_item_key,
           fi.label,
           fi.rate_kind,
           fi.billed_directly_to_merchant,
           br.rate,
           -- NULL for almost every rate. It travels WITH the rate rather than
           -- being fetched separately, so no caller can take one and miss the
           -- other — the same reason the cap lives on residual_buy_rates and
           -- not on residual_formula_terms.
           br.rate_cap
      from public.residual_buy_rate_tiers bt
      join public.residual_buy_rates br
        on br.schedule_id = bt.schedule_id
       and br.risk_tier   = bt.risk_tier
       and br.deleted_at is null
      join public.residual_fee_items fi
        on fi.fee_item_key = br.fee_item_key
       and fi.deleted_at is null
     where bt.schedule_id = v_schedule
       and bt.deleted_at is null
     order by bt.risk_tier, fi.sort_order;
end;
$$;

comment on function public.residual_buy_rates_for_month(text, date) is
  'The template buy rates in force for a month, one row per (tier, fee item), with each rate''s optional cap beside it. Raises rather than returning nothing when no schedule covers the month: a missing rate must never read as a zero rate. Inner-joins live fee items, so retiring a fee item removes it from every month''s grid at once.';

revoke all on function public.residual_buy_rates_for_month(text, date)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_buy_rates_for_month(text, date)
  to authenticated;

commit;
