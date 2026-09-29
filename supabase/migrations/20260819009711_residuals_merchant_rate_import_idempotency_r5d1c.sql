-- Ported from Daniel Weissman's residuals branch, file
-- `20260829140000_residuals_merchant_rate_import_idempotency_r5d1c.sql`.
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
-- Residuals R5d 1c — same-date re-import idempotency
-- ============================================================
--
-- CORRECTS A FALSE CLAIM IN 20260829120000 AND THE BEHAVIOUR BEHIND IT.
--
-- That migration's section 6 header states:
--
--     "Idempotency comes from the value comparison in section 6c instead:
--      importing the same file twice at the same date writes nothing the
--      second time, because nothing changed."
--
-- It did not. Measured after apply: re-importing an identical file at the
-- same effective date raised
--
--     23514  "MID 201100230235: already has a version starting 2026-01-01;
--             cannot import at 2026-01-01"
--
-- because the backdating check in 6a runs during validation and rejects the
-- file before the unchanged-comparison in 6c is ever reached. Idempotency by
-- value only worked when re-importing at a LATER date.
--
-- WHY THAT IS WORTH FIXING RATHER THAN DOCUMENTING. Nothing unsafe happened —
-- no rows were written and the error was clear — but a retry after a timeout,
-- or a double-click, is an ordinary operator action. An import button that
-- errors on a harmless repeat teaches people that errors from it are normal,
-- which is exactly when a real one gets clicked past.
--
-- WHAT IS TRUE AFTER THIS MIGRATION:
--
--   * Re-importing an IDENTICAL file at the SAME date succeeds and writes
--     nothing: every merchant is counted 'unchanged'.
--   * Re-importing at the same date with ANY value CHANGED is still rejected
--     with 23514 naming the MID. Backdating onto a different value must not
--     become a silent overwrite — that is the failure this fix must not
--     introduce.
--   * Re-importing at a LATER date behaves as before: unchanged merchants get
--     no new version, changed ones get a dated successor.
--
-- ============================================================
-- ONE COMPARISON, TWO CALL SITES
-- ============================================================
--
-- The fix makes the unchanged-comparison run in BOTH passes: in 6a to decide
-- whether a same-date re-import is a no-op or a conflict, and in 6c to decide
-- whether to write. Two hand-maintained copies of a seventeen-field
-- IS NOT DISTINCT FROM chain is exactly the length at which one drifts by a
-- line and nobody notices — and the specific failure would be nasty: if 6a
-- decided "unchanged" and 6c decided "changed", the write loop would hit a
-- backdating conflict inside a transaction that had already passed
-- validation.
--
-- So the comparison is extracted into ONE function called from both, the same
-- discipline R5a applied to residual_derive_plan_rollup and R5b to
-- residual_reconcile_mid_links. The two passes cannot disagree because they
-- evaluate the same code over the same inputs: v_standing is re-selected
-- identically in both (and no loop iteration can change another MID's
-- standing row — the duplicate-MID check guarantees one row per MID), v_elem
-- is the same jsonb element, and v_tier is resolved the same way.
--
-- Idempotent: create-or-replace only. No table, policy or seed is touched.

begin;

-- ============================================================
-- 1. residual_merchant_rate_unchanged — the ONE comparison
-- ============================================================
-- Takes the standing row as a composite and the incoming jsonb element, and
-- answers the single question both passes need: would writing this row change
-- anything?
--
-- A NULL / absent standing row is NOT "unchanged". Accessing a field of a
-- NULL composite yields NULL, so the leading `p_standing.id is not null`
-- both guards the call and short-circuits the whole chain to false — there is
-- nothing for the incoming row to be unchanged FROM, and a merchant's first
-- version must always be written.
--
-- IS NOT DISTINCT FROM THROUGHOUT, so NULL = NULL counts as equal. A plain =
-- would treat two identical "no arrangement" states as different and write a
-- spurious version on every re-import, which is the bug this whole mechanism
-- exists to avoid.
--
-- THE TEXT COLUMNS ARE NORMALISED THE SAME WAY THE INSERT NORMALISES THEM
-- (nullif(btrim(...), '')), so a provider arriving as an empty string
-- compares equal to a stored NULL instead of looking like a change.
--
-- risk_tier is passed in already resolved rather than re-derived here: the
-- caller has resolved it through residual_risk_tiers.statement_code and has
-- already raised if it did not resolve. Re-resolving inside would be a second
-- lookup that could, in principle, disagree with the one the caller validated.
create or replace function public.residual_merchant_rate_unchanged(
  p_standing  public.residual_merchant_rates,
  p_incoming  jsonb,
  p_risk_tier text
)
returns boolean
language sql
immutable
as $$
  select p_standing.id is not null
     and p_standing.risk_tier                is not distinct from p_risk_tier
     and p_standing.vmd_auth_fee             is not distinct from (p_incoming->>'vmd_auth_fee')::numeric(14,6)
     and p_standing.pin_debit_auth_fee       is not distinct from (p_incoming->>'pin_debit_auth_fee')::numeric(14,6)
     and p_standing.avs_fee                  is not distinct from (p_incoming->>'avs_fee')::numeric(14,6)
     and p_standing.batch_fee                is not distinct from (p_incoming->>'batch_fee')::numeric(14,6)
     and p_standing.vmd_transaction_fee      is not distinct from (p_incoming->>'vmd_transaction_fee')::numeric(14,6)
     and p_standing.amex_volume              is not distinct from (p_incoming->>'amex_volume')::numeric(14,6)
     and p_standing.vmd_volume               is not distinct from (p_incoming->>'vmd_volume')::numeric(14,6)
     and p_standing.pin_debit_volume         is not distinct from (p_incoming->>'pin_debit_volume')::numeric(14,6)
     and p_standing.amex_template_volume_fee is not distinct from (p_incoming->>'amex_template_volume_fee')::numeric(14,6)
     and p_standing.gateway_monthly_mav      is not distinct from (p_incoming->>'gateway_monthly_mav')::numeric(14,6)
     and p_standing.terminal_monthly_mav     is not distinct from (p_incoming->>'terminal_monthly_mav')::numeric(14,6)
     and p_standing.monthly_fee_tapdash      is not distinct from (p_incoming->>'monthly_fee_tapdash')::numeric(14,6)
     and p_standing.monthly_fee_maverick     is not distinct from (p_incoming->>'monthly_fee_maverick')::numeric(14,6)
     and p_standing.chargeback_fee           is not distinct from (p_incoming->>'chargeback_fee')::numeric(14,6)
     and p_standing.gateway_provider_mav     is not distinct from nullif(btrim(coalesce(p_incoming->>'gateway_provider_mav','')),'')
     and p_standing.terminal_provider_mav    is not distinct from nullif(btrim(coalesce(p_incoming->>'terminal_provider_mav','')),'');
$$;

comment on function public.residual_merchant_rate_unchanged(public.residual_merchant_rates, jsonb, text) is
  'The ONE unchanged-comparison for merchant rate imports, called from both the validation pass and the write pass of commit_residual_merchant_rates_import so the two cannot disagree. Seventeen fields compared with IS NOT DISTINCT FROM so NULL = NULL is equal. A null/absent standing row returns false — a first version is never "unchanged".';

revoke all on function public.residual_merchant_rate_unchanged(public.residual_merchant_rates, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_merchant_rate_unchanged(public.residual_merchant_rates, jsonb, text)
  to authenticated;

-- ============================================================
-- 2. commit_residual_merchant_rates_import — replaced
-- ============================================================
-- Unchanged from 20260829120000 except:
--   * 6a's backdating check now exempts an exact-date, exact-value re-import
--   * 6c's inline seventeen-field chain is replaced by the shared function
--
-- Everything else — the admin gate, the all-or-nothing ordering, the
-- percent-scale guard at >= 0.10, the duplicate-MID check the backdating
-- check depends on — is carried over verbatim.
create or replace function public.commit_residual_merchant_rates_import(
  p_import_id      uuid,
  p_effective_from date,
  p_rows           jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor     uuid := auth.uid();
  v_from      date := p_effective_from;
  v_elem      jsonb;
  v_mid       text;
  v_tier      text;
  v_errors    text[] := '{}';
  v_inserted  int := 0;
  v_unchanged int := 0;
  v_closed    int := 0;
  v_standing  public.residual_merchant_rates%rowtype;
  v_seen      text[] := '{}';
  v_vol       numeric;
  v_key       text;
begin
  if public.auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to import merchant rates.'
      using errcode = '42501';
  end if;

  if v_from is null or extract(day from v_from) <> 1 then
    raise exception 'commit_residual_merchant_rates_import: p_effective_from must be the 1st of a month.'
      using errcode = '22007';
  end if;

  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'commit_residual_merchant_rates_import: p_rows must be a non-empty array.'
      using errcode = '22004';
  end if;

  -- ---------- 6a. validate every row before writing any ----------
  for v_elem in select * from jsonb_array_elements(p_rows) loop
    v_mid := regexp_replace(coalesce(v_elem->>'mid', ''), '[^0-9]', '', 'g');

    if v_mid = '' then
      v_errors := v_errors || format('row with merchant "%s": no digits in MID',
                                     coalesce(v_elem->>'merchant_name', '?'));
      continue;
    end if;

    -- A MID twice in one file is an ambiguity, not a merge: the two rows
    -- would fight over one dated version and the last one would silently win.
    --
    -- THE BACKDATING CHECK BELOW DEPENDS ON THIS ONE. It validates each row
    -- against the PRE-WRITE state of residual_merchant_rates, which is only
    -- sound while no two rows in the file touch the same MID — otherwise the
    -- second row for a MID would be checked against a standing version that
    -- the first row is about to close, and a genuine conflict could pass
    -- validation and then fail (or worse, silently succeed) in the write loop.
    -- IF THIS CHECK IS EVER RELAXED — to "merge duplicates", say, or to take
    -- the last row wins — the backdating check must be reworked in the same
    -- change to simulate the file's own writes.
    if v_mid = any(v_seen) then
      v_errors := v_errors || format('MID %s appears more than once in the file', v_mid);
      continue;
    end if;
    v_seen := v_seen || v_mid;

    -- RISK TIER RESOLVES THROUGH residual_risk_tiers.statement_code, never a
    -- hardcoded 1/2/3 map. That table exists to own this vocabulary and R5c
    -- seeded it; a second copy of the mapping here is how the two drift.
    select t.tier_key into v_tier
      from public.residual_risk_tiers t
     where t.statement_code = (v_elem->>'risk_code')::int
       and t.deleted_at is null;

    if v_tier is null then
      v_errors := v_errors || format('MID %s: risk code %s matches no live risk tier',
                                     v_mid, coalesce(v_elem->>'risk_code', 'NULL'));
    end if;

    -- PERCENT-SCALE GUARD. Threshold 0.10, derived from the data: real volume
    -- rates span [0.001, 0.047619] and the same values percent-scaled span
    -- [0.1, 4.7619], two disjoint populations with a 2.10x gap. 0.10 sits at
    -- the scaled floor (hence >=, so a scale error is caught even on the
    -- smallest rate) while leaving 2.10x headroom above the largest real rate.
    -- Scored against all 104 observed values: 0 false rejections, 0 missed
    -- scale errors. It REJECTS rather than dividing by 100 — auto-scaling
    -- would make a wrong file load cleanly and half-correct a mixed one.
    foreach v_key in array array['amex_volume','vmd_volume','pin_debit_volume','amex_template_volume_fee'] loop
      v_vol := (v_elem->>v_key)::numeric;
      if v_vol is not null and v_vol >= 0.10 then
        v_errors := v_errors || format(
          'MID %s: %s is %s. Volume rates are unscaled decimal fractions (0.0385 = 3.85%%) and the largest rate observed in the source sheet is 0.047619 (4.7619%%). A value at or above 0.10 is almost certainly percent-scaled — 100x too large. It is rejected, not rescaled: fix it at source.',
          v_mid, v_key, v_vol);
      end if;
    end loop;

    foreach v_key in array array[
      'vmd_auth_fee','pin_debit_auth_fee','avs_fee','batch_fee','vmd_transaction_fee',
      'amex_volume','vmd_volume','pin_debit_volume','amex_template_volume_fee',
      'gateway_monthly_mav','terminal_monthly_mav',
      'monthly_fee_tapdash','monthly_fee_maverick','chargeback_fee'
    ] loop
      v_vol := (v_elem->>v_key)::numeric;
      if v_vol is not null and v_vol < 0 then
        v_errors := v_errors || format('MID %s: %s is negative (%s)', v_mid, v_key, v_vol);
      end if;
    end loop;

    -- Backdating check.
    --
    -- ASSUMES AT MOST ONE ROW PER MID IN THE FILE, which the duplicate-MID
    -- check above enforces. This reads the PRE-WRITE state — nothing has been
    -- written yet, by design — so it is only correct while no earlier row in
    -- the same file could have changed this MID's standing version. That
    -- property comes entirely from the duplicate check; it is not implied by
    -- anything here.
    select * into v_standing
      from public.residual_merchant_rates r
     where r.deleted_at is null
       and r.mid = v_mid
       and (r.effective_to is null or r.effective_to > v_from)
     order by r.effective_from
     limit 1;

    if v_standing.id is not null and v_standing.effective_from >= v_from then
      -- THE EXEMPTION: an exact-date, exact-value re-import is a no-op, not a
      -- conflict. Same date AND nothing changed means the file is simply
      -- being read again — a retry, or a double-click — and 6c will count it
      -- 'unchanged' and write nothing.
      --
      -- NARROW BY CONSTRUCTION, and the narrowness is the safety property:
      --   * effective_from = v_from (not >=), so a standing version starting
      --     LATER than the import date is still a genuine backdating attempt
      --     and still an error, even if its values happen to match.
      --   * residual_merchant_rate_unchanged() must be true, so backdating
      --     onto a DIFFERENT value at an existing effective_from remains
      --     23514. That must never become a silent overwrite.
      --
      -- 6c evaluates the SAME function over the SAME inputs, so a row exempted
      -- here is guaranteed to be counted unchanged there rather than reaching
      -- the write path and hitting the conflict this pass just waived.
      if not (v_standing.effective_from = v_from
              and public.residual_merchant_rate_unchanged(v_standing, v_elem, v_tier)) then
        v_errors := v_errors || format(
          'MID %s: already has a version starting %s; cannot import at %s',
          v_mid, v_standing.effective_from, v_from);
      end if;
    end if;
  end loop;

  if array_length(v_errors, 1) > 0 then
    raise exception 'Merchant rate import rejected (% problem(s)): %',
      array_length(v_errors, 1), array_to_string(v_errors, ' | ')
      using errcode = '23514',
            hint = 'Nothing was written. Fix the file and re-import.';
  end if;

  -- ---------- 6b/6c. write ----------
  for v_elem in select * from jsonb_array_elements(p_rows) loop
    v_mid := regexp_replace(v_elem->>'mid', '[^0-9]', '', 'g');

    select t.tier_key into v_tier
      from public.residual_risk_tiers t
     where t.statement_code = (v_elem->>'risk_code')::int
       and t.deleted_at is null;

    -- RE-SELECTING v_standing HERE IS SAFE, and reads like a re-entrancy
    -- hazard without being one: earlier iterations of this loop may have
    -- closed a standing row, but only ever for a DIFFERENT MID (the
    -- duplicate-MID check guarantees one row per MID), so no iteration can
    -- observe state that an earlier one changed for its own merchant. The
    -- re-select therefore returns exactly what 6a saw for this MID — which is
    -- also what makes the shared comparison below provably agree with 6a's.
    select * into v_standing
      from public.residual_merchant_rates r
     where r.deleted_at is null
       and r.mid = v_mid
       and (r.effective_to is null or r.effective_to > v_from)
     order by r.effective_from
     limit 1;

    -- 6c. UNCHANGED -> NO NEW ROW. Same function 6a used.
    if public.residual_merchant_rate_unchanged(v_standing, v_elem, v_tier) then
      v_unchanged := v_unchanged + 1;
      continue;
    end if;

    -- Close then insert. Forced order: the EXCLUDE is not deferrable.
    if v_standing.id is not null then
      update public.residual_merchant_rates
         set effective_to = v_from, updated_by_id = v_actor
       where id = v_standing.id;
      v_closed := v_closed + 1;
    end if;

    insert into public.residual_merchant_rates (
      mid, effective_from, effective_to, risk_tier,
      vmd_auth_fee, pin_debit_auth_fee, avs_fee, batch_fee, vmd_transaction_fee,
      amex_volume, vmd_volume, pin_debit_volume, amex_template_volume_fee,
      gateway_provider_mav, gateway_monthly_mav,
      terminal_provider_mav, terminal_monthly_mav,
      monthly_fee_tapdash, monthly_fee_maverick, chargeback_fee,
      notes, created_by_id, updated_by_id
    ) values (
      v_mid, v_from, null, v_tier,
      (v_elem->>'vmd_auth_fee')::numeric(14,6),
      (v_elem->>'pin_debit_auth_fee')::numeric(14,6),
      (v_elem->>'avs_fee')::numeric(14,6),
      (v_elem->>'batch_fee')::numeric(14,6),
      (v_elem->>'vmd_transaction_fee')::numeric(14,6),
      (v_elem->>'amex_volume')::numeric(14,6),
      (v_elem->>'vmd_volume')::numeric(14,6),
      (v_elem->>'pin_debit_volume')::numeric(14,6),
      (v_elem->>'amex_template_volume_fee')::numeric(14,6),
      nullif(btrim(coalesce(v_elem->>'gateway_provider_mav','')),''),
      (v_elem->>'gateway_monthly_mav')::numeric(14,6),
      nullif(btrim(coalesce(v_elem->>'terminal_provider_mav','')),''),
      (v_elem->>'terminal_monthly_mav')::numeric(14,6),
      (v_elem->>'monthly_fee_tapdash')::numeric(14,6),
      (v_elem->>'monthly_fee_maverick')::numeric(14,6),
      (v_elem->>'chargeback_fee')::numeric(14,6),
      nullif(btrim(coalesce(v_elem->>'notes','')),''),
      v_actor, v_actor
    );
    v_inserted := v_inserted + 1;
  end loop;

  update public.residual_imports
     set status = 'completed',
         processed_at = now(),
         row_count = jsonb_array_length(p_rows),
         updated_by_id = v_actor
   where id = p_import_id;

  return jsonb_build_object(
    'effective_from', v_from,
    'rows_read',      jsonb_array_length(p_rows),
    'inserted',       v_inserted,
    'unchanged',      v_unchanged,
    'closed',         v_closed
  );
end;
$$;

comment on function public.commit_residual_merchant_rates_import(uuid, date, jsonb) is
  'Atomic all-or-nothing import of the TapDash sell-side rate sheet. Validates every row first (MID, risk code via residual_risk_tiers.statement_code, percent-scale guard at >= 0.10, non-negative, no backdating, no duplicate MID) and writes nothing if any row fails. IDEMPOTENT ON RE-IMPORT: an identical file at the same effective date succeeds and writes nothing (every merchant counted unchanged); the same date with any value CHANGED is still rejected 23514. Unchanged merchants never get a new version — the fact that a file re-confirmed them lives on the residual_imports row. The unchanged-comparison is residual_merchant_rate_unchanged(), called from both passes so they cannot disagree.';

revoke all on function public.commit_residual_merchant_rates_import(uuid, date, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.commit_residual_merchant_rates_import(uuid, date, jsonb)
  to authenticated;

commit;
