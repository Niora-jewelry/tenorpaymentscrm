-- ============================================================================
-- The Pricing tab feeds the residuals calculator.
--
-- Izzy's instruction, in his words:
--
--   "Pricing tab - used for calculator and editable
--    Pricing field in drawer which pulls from the pricing tab but can also be
--    edited in the drawer
--    Edits in both the drawer and pricing tab sync with each other
--    Only specific users will have access to this"
--
-- and, on what happens to months already calculated, Option A:
--
--   "the change applies from now on. May keeps its 0.15 and still shows the
--    same residual figures if you re-run it a year from now."
--
-- ── WHY THIS IS NOT A PLAIN MIRROR ──────────────────────────────────────────
-- `residual_merchant_rates` is EFFECTIVE-DATED. Daniel's reason, which is the
-- whole argument for Option A:
--
--   "Changing a rate opens a dated successor; it never edits history. That is
--    what makes a recomputed historical month reproduce its original answer."
--
-- `records.values` holds ONE current value with no history. A naive mirror
-- would overwrite the live rate row, and a residuals report signed off in May
-- would quietly produce different numbers when re-run in August. Nobody would
-- see it happen.
--
-- So a drawer edit does not overwrite. It opens a dated successor from the
-- first of the current month, closing the previous row on that date. Past
-- months keep the rates they were calculated with, exactly as Izzy asked.
--
-- ── THE MAPPING IS EXPLICIT, NOT DATA-DRIVEN ────────────────────────────────
-- Sixteen of our fifty Pricing fields correspond to a rate column. Writing the
-- map as a table and driving it with dynamic SQL was the first instinct and is
-- the wrong one here: the target columns are typed, fixed by a CHECK on
-- `residual_merchant_rates`, and cannot change without a migration anyway. A
-- data-driven map would buy flexibility the schema does not have, at the cost
-- of building UPDATE statements from strings in a money path.
--
-- The 34 fields NOT mapped are not omissions:
--   * six Daniel excluded with reasons (no rule reads them, or they are not
--     income) - td_amex_auth_fee, td_ebt_volume, td_gateway_auth_fee_mav,
--     td_terminal_auth_fee_mav, td_lease_payments_tapdash, td_monthly_fee;
--   * twenty-eight vtd_/ovmp_/one_time_charges fields are VENDOR costs, which
--     belong to the partner-residual stage that was never built. Nothing reads
--     them and nothing can.
--   * `monthly_fee_maverick` exists on the rate table with no field of ours.
--     It is legacy: it reconstructs months before Maverick stopped collecting
--     the merchant monthly fee, and no live rule reads it.
-- ============================================================================

-- ── The month a change takes effect ─────────────────────────────────────────
-- Always the first of a month, because `residual_merchant_rates` is dated by
-- month and its EXCLUDE constraint is built on that.
create or replace function public.residual_rate_effective_month(p_at timestamptz default now())
returns date
language sql
immutable
as $$
  select date_trunc('month', p_at)::date;
$$;

-- ── Our Pricing-tab risk level -> the engine's tier key ─────────────────────
-- `residual_risk_tiers.drawer_option` exists precisely for this join, and our
-- four choices match it character for character: "No risk", "Low risk",
-- "Moderate risk", "High risk". Resolved through the table rather than a CASE
-- so that renaming a choice is a data change in one place.
--
-- An unrecognised value returns NULL rather than guessing a tier. A wrong tier
-- silently changes the split percentage - 90% versus 70% of every line - which
-- is the most expensive possible thing to get quietly wrong here.
create or replace function public.residual_tier_from_pricing_choice(p_choice text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.tier_key
    from public.residual_risk_tiers t
   where t.deleted_at is null
     and t.is_risk_tier
     and lower(btrim(t.drawer_option)) = lower(btrim(coalesce(p_choice, '')))
   limit 1;
$$;

-- ============================================================================
-- records.values -> residual_merchant_rates
--
-- Reads the sixteen Pricing fields off a record and opens (or updates) the
-- rate row for the effective month.
--
-- Returns the number of rate rows written: 0 when the record has no MID, or
-- when nothing about the rates actually changed.
-- ============================================================================
create or replace function public.residual_sync_rates_from_record(
  p_record_id uuid,
  p_at        timestamptz default now()
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mid      text;
  v_month    date := public.residual_rate_effective_month(p_at);
  v_vals     jsonb;
  v_tier     text;
  v_existing record;
  v_actor    uuid := auth.uid();
begin
  /*
   * Every rate below is written as `nullif(btrim(...), '')::numeric`, so a
   * CLEARED field becomes NULL and not 0.00. Daniel's contract, and the
   * difference matters in a money path:
   *
   *   "A merchant with no AVS arrangement has no AVS rate, and NULL says that;
   *    0.000000 would assert a rate of zero, which is a different claim and
   *    one the engine would multiply by a count and book as real."
   */
  select regexp_replace(coalesce(r.values->>'mid',''),'[^0-9]','','g'), r.values
    into v_mid, v_vals
    from public.records r
   where r.id = p_record_id and r.deleted_at is null;

  -- No record, or no MID to key the rates on. Not an error: most records in
  -- this CRM are not merchants with a processor statement.
  if v_mid is null or v_mid = '' then
    return 0;
  end if;

  v_tier := public.residual_tier_from_pricing_choice(v_vals->>'pricing_risk_level');

  select * into v_existing
    from public.residual_merchant_rates
   where mid = v_mid
     and deleted_at is null
     and effective_from <= v_month
     and (effective_to is null or effective_to > v_month)
   limit 1;

  /*
   * Already a row covering this month, and it STARTS this month. It is the
   * current, still-open assertion, so it is edited in place — opening a
   * successor from the same date it already starts on would violate the
   * EXCLUDE constraint and, worse, would mean two rows claiming one month.
   */
  if v_existing.id is not null and v_existing.effective_from = v_month then
    update public.residual_merchant_rates set
      risk_tier                = coalesce(v_tier, risk_tier),
      vmd_auth_fee             = nullif(btrim(v_vals->>'td_vmd_auth_fee'), '')::numeric,
      pin_debit_auth_fee       = nullif(btrim(v_vals->>'td_pin_debit_auth_fee'), '')::numeric,
      avs_fee                  = nullif(btrim(v_vals->>'td_avs_fee'), '')::numeric,
      batch_fee                = nullif(btrim(v_vals->>'td_batch_fee'), '')::numeric,
      vmd_transaction_fee      = nullif(btrim(v_vals->>'td_vmd_transaction_fee'), '')::numeric,
      amex_volume              = nullif(btrim(v_vals->>'td_amex_volume'), '')::numeric,
      vmd_volume               = nullif(btrim(v_vals->>'td_vmd_volume'), '')::numeric,
      pin_debit_volume         = nullif(btrim(v_vals->>'td_pin_debit_volume'), '')::numeric,
      amex_template_volume_fee = nullif(btrim(v_vals->>'td_amex_template_volume_fee'), '')::numeric,
      gateway_provider_mav     = nullif(btrim(v_vals->>'td_gateway_provider_mav'), ''),
      gateway_monthly_mav      = nullif(btrim(v_vals->>'td_gateway_monthly_mav'), '')::numeric,
      terminal_provider_mav    = nullif(btrim(v_vals->>'td_terminal_provider_mav'), ''),
      terminal_monthly_mav     = nullif(btrim(v_vals->>'td_terminal_monthly_mav'), '')::numeric,
      monthly_fee_tapdash      = nullif(btrim(v_vals->>'td_monthly_fee_tapdash'), '')::numeric,
      chargeback_fee           = nullif(btrim(v_vals->>'td_chargeback_fee'), '')::numeric,
      updated_at               = now(),
      updated_by_id            = v_actor
    where id = v_existing.id;
    return 1;
  end if;

  /*
   * A row covering this month that started EARLIER is history the moment a
   * rate changes. Close it on the first of this month — half-open, so it still
   * covers every day up to but not including that date — and open a successor.
   *
   * This is Option A, and it is the whole reason this function is not an
   * UPDATE: a residuals report for a past month re-run next year reads the
   * closed row and reproduces its original answer.
   */
  if v_existing.id is not null then
    update public.residual_merchant_rates
       set effective_to = v_month, updated_at = now(), updated_by_id = v_actor
     where id = v_existing.id;
  end if;

  insert into public.residual_merchant_rates (
    mid, effective_from, effective_to, risk_tier,
    vmd_auth_fee, pin_debit_auth_fee, avs_fee, batch_fee, vmd_transaction_fee,
    amex_volume, vmd_volume, pin_debit_volume, amex_template_volume_fee,
    gateway_provider_mav, gateway_monthly_mav,
    terminal_provider_mav, terminal_monthly_mav,
    monthly_fee_tapdash, monthly_fee_maverick, chargeback_fee,
    notes, created_by_id, updated_by_id
  )
  values (
    v_mid, v_month, null, coalesce(v_tier, v_existing.risk_tier),
    nullif(btrim(v_vals->>'td_vmd_auth_fee'), '')::numeric,
    nullif(btrim(v_vals->>'td_pin_debit_auth_fee'), '')::numeric,
    nullif(btrim(v_vals->>'td_avs_fee'), '')::numeric,
    nullif(btrim(v_vals->>'td_batch_fee'), '')::numeric,
    nullif(btrim(v_vals->>'td_vmd_transaction_fee'), '')::numeric,
    nullif(btrim(v_vals->>'td_amex_volume'), '')::numeric,
    nullif(btrim(v_vals->>'td_vmd_volume'), '')::numeric,
    nullif(btrim(v_vals->>'td_pin_debit_volume'), '')::numeric,
    nullif(btrim(v_vals->>'td_amex_template_volume_fee'), '')::numeric,
    nullif(btrim(v_vals->>'td_gateway_provider_mav'), ''),
    nullif(btrim(v_vals->>'td_gateway_monthly_mav'), '')::numeric,
    nullif(btrim(v_vals->>'td_terminal_provider_mav'), ''),
    nullif(btrim(v_vals->>'td_terminal_monthly_mav'), '')::numeric,
    nullif(btrim(v_vals->>'td_monthly_fee_tapdash'), '')::numeric,
    -- Carried forward, never taken from the drawer: it has no field of ours
    -- and a successor that dropped it would silently lose the ability to
    -- reconstruct a pre-changeover month.
    v_existing.monthly_fee_maverick,
    nullif(btrim(v_vals->>'td_chargeback_fee'), '')::numeric,
    'Opened from the Pricing tab on ' || to_char(now(), 'DD Mon YYYY'),
    v_actor, v_actor
  );

  return 1;
end;
$$;

comment on function public.residual_sync_rates_from_record(uuid, timestamptz) is
  'Write a record''s Pricing-tab rates into residual_merchant_rates for the '
  'current month. Opens a DATED SUCCESSOR rather than overwriting, so a past '
  'month re-run later reproduces its original figures (Izzy, Option A).';

-- ============================================================================
-- The trigger — guards attach to the fact
-- ============================================================================
-- Daniel's principle, and the reason this is not called from the drawer's
-- save action: attaching it to the FACT (the values changed) rather than to a
-- caller covers the drawer, the importer, a manual correction and every future
-- write path, and cannot be forgotten by the author of the next one.
--
-- AFTER UPDATE OF values, so an edit to any other column does no work.
-- ============================================================================
create or replace function public.tg_records_sync_residual_rates()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_keys text[] := array[
    'pricing_risk_level',
    'td_vmd_auth_fee','td_pin_debit_auth_fee','td_avs_fee','td_batch_fee',
    'td_vmd_transaction_fee','td_amex_volume','td_vmd_volume','td_pin_debit_volume',
    'td_amex_template_volume_fee','td_gateway_provider_mav','td_gateway_monthly_mav',
    'td_terminal_provider_mav','td_terminal_monthly_mav','td_monthly_fee_tapdash',
    'td_chargeback_fee'
  ];
  v_changed boolean := false;
  v_key text;
begin
  -- Only the sixteen that map. A record whose notes changed must not open a
  -- dated rate successor — that would fill the history with rows asserting a
  -- rate change that never happened.
  foreach v_key in array v_keys loop
    if (old.values -> v_key) is distinct from (new.values -> v_key) then
      v_changed := true;
      exit;
    end if;
  end loop;

  -- A MID appearing or changing also needs a sync: the rates belong to the new
  -- MID from that moment.
  if regexp_replace(coalesce(old.values->>'mid',''),'[^0-9]','','g')
     is distinct from regexp_replace(coalesce(new.values->>'mid',''),'[^0-9]','','g') then
    v_changed := true;
  end if;

  if v_changed then
    perform public.residual_sync_rates_from_record(new.id);
  end if;

  return new;
end;
$$;

drop trigger if exists records_sync_residual_rates on public.records;
create trigger records_sync_residual_rates
  after update of values on public.records
  for each row
  when (new.deleted_at is null)
  execute function public.tg_records_sync_residual_rates();

revoke all on function public.tg_records_sync_residual_rates() from public, anon, authenticated;
revoke all on function public.residual_sync_rates_from_record(uuid, timestamptz) from public, anon;
grant execute on function public.residual_sync_rates_from_record(uuid, timestamptz) to authenticated, service_role;
revoke all on function public.residual_tier_from_pricing_choice(text) from public, anon;
grant execute on function public.residual_tier_from_pricing_choice(text) to authenticated, service_role;
