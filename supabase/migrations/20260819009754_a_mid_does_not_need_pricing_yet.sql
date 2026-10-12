begin;

-- ════════════════════════════════════════════════════════════════════════
-- "Could not reach the server": an MCC code blocked by the residuals engine
-- ════════════════════════════════════════════════════════════════════════
--
-- Reported by the client, with a screenshot of the MID field on a Contacts
-- record and a red box reading "Could not reach the server. Your change was
-- not saved - check your connection and try again." His connection was fine.
--
-- ── WHAT ACTUALLY HAPPENED ──────────────────────────────────────────────
-- Writing a MID fires `records_sync_residual_rates`, which calls
-- `residual_sync_rates_from_record`. That function opens a row in
-- `residual_merchant_rates` for the MID - and `risk_tier` on that table is
-- NOT NULL, with a trigger refusing anything that is not a real risk tier.
--
-- A record that has a MID but no Risk Level yet therefore produced:
--
--     23514  <NULL> is not a risk tier a merchant can be assigned.
--
-- raised inside an AFTER UPDATE trigger on `records`, which aborted the whole
-- transaction. The Server Action died, and the drawer reported the only thing
-- a thrown action looks like from the browser: a network failure.
--
-- Knowing a merchant's MID long before anyone prices them is the normal order
-- of work, so every unpriced record had an unusable MID field. Reproduced
-- against the live database before writing this.
--
-- ── WHAT IS NOT CHANGED, AND WHY ────────────────────────────────────────
-- Not the NOT NULL, and not `tg_residual_merchant_rates_real_tier`. Both
-- guard a money path: the tier decides `tapdash_share`, and the vendor-flat
-- pseudo-tier would book the entire net as TapDash's. The bug was never that
-- the guard fired - it was that this function asked it to open a row it had
-- no tier for.
--
-- The function now returns 0 in that case. A merchant with no pricing has no
-- rate row, which is a state the engine already reports honestly
-- (`no_merchant_rates`), and the row opens by itself when a Risk Level is
-- set, since that is one of the sixteen keys the trigger watches.

CREATE OR REPLACE FUNCTION public.residual_sync_rates_from_record(p_record_id uuid, p_at timestamp with time zone DEFAULT now())
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
   * ⚠️ NO RISK TIER MEANS NO RATE ROW — NOT A FAILED SAVE.
   *
   * `residual_merchant_rates.risk_tier` is NOT NULL and guarded further by
   * `tg_residual_merchant_rates_real_tier`, which refuses any value that is
   * not a real risk tier. Both are right: the tier decides `tapdash_share`,
   * and a merchant priced at the vendor-flat pseudo-tier would book the whole
   * net as TapDash's.
   *
   * But this function reached the INSERT below with a NULL tier whenever a
   * record was given a MID before anyone had set its Risk Level — and the
   * exception that followed did not stay inside the residuals module. It
   * propagated out of the AFTER UPDATE trigger on `records`, aborted the
   * user's transaction, and came back to the drawer as a 500. The client saw
   *
   *     "Could not reach the server. Your change was not saved —
   *      check your connection and try again."
   *
   * while typing an MCC code into a contact, and nothing was wrong with his
   * connection. Knowing a merchant's MID long before anyone prices them is
   * the normal order of work, so this was not an edge case: it blocked the
   * MID field outright for every unpriced record.
   *
   * A merchant with no pricing simply has no rate row yet. That state is
   * already modelled downstream — the engine reports `no_merchant_rates`
   * against such a MID rather than inventing a rate — so returning 0 here
   * tells the truth and leaves the CRM write alone. The row opens by itself
   * the moment a Risk Level is set, because that is one of the sixteen keys
   * `tg_records_sync_residual_rates` watches.
   *
   * Deliberately placed AFTER the edit-in-place branch above: an existing row
   * for this month already holds a valid tier, and `coalesce(v_tier,
   * risk_tier)` keeps it. Only opening a BRAND NEW row needs a tier of its
   * own, and only that case is refused here.
   */
  if coalesce(v_tier, v_existing.risk_tier) is null then
    return 0;
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
$function$;

commit;
