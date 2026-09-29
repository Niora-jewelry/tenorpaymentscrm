-- Ported from Daniel Weissman's residuals branch, file
-- `20260830130000_residuals_bounded_import_errors_r5d1c.sql`.
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
-- Residuals R5d 1c — bound the rate-import rejection message
-- ============================================================
--
-- commit_residual_merchant_rates_import joined EVERY validation problem into
-- one RAISE. A file that has been through a CSV round trip and re-saved as
-- .xlsx carries a percent-scaled NUMBER in every volume cell — those pass the
-- parser by design and are caught here by the >= 0.10 guard — which is 4
-- columns x 33 merchants = 132 problems, each carrying the full ~250-character
-- explanation. That is a ~33,000-character exception travelling over the wire
-- to be rendered in a toast.
--
-- The browser-side twin of this bug was reported: uploading the wrong sheet
-- produced an error taller than the viewport, unscrollable, with the page's
-- own controls pushed off screen. This path reaches the same surface by a
-- different route and had never been seen rendered.
--
-- TWO CHANGES, BOTH ABOUT SHAPE, NEITHER ABOUT WHAT IS VALIDATED:
--
--   1. THE MESSAGE IS CAPPED at the first 20 problems, with the true total
--      always stated. Twenty is well past the point where an operator is
--      reading individual entries and is still enough to see the pattern —
--      and the count, which is the actionable part, never lies.
--
--   2. THE SUMMARY COMES FIRST and the separator is preserved. The client
--      splits on " | " to render the detail in a bounded scrollable list, so
--      the format is load-bearing: `<summary>: <p1> | <p2> | ...`.
--
-- WHAT IS NOT CHANGED: every row is still validated before any row is written,
-- and one bad row still rejects the whole file. Capping the MESSAGE is not
-- capping the CHECK — all 132 problems are still found, they are simply not
-- all recited.
--
-- Idempotent: create-or-replace only.

begin;

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
  v_shown     text[];
  v_total     int;
  v_inserted  int := 0;
  v_unchanged int := 0;
  v_closed    int := 0;
  v_standing  public.residual_merchant_rates%rowtype;
  v_seen      text[] := '{}';
  v_vol       numeric;
  v_key       text;
  -- See the header: past this many, nobody is reading individual entries.
  c_max_shown constant int := 20;
begin
  if auth.uid() is null
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
    --
    -- THE PER-PROBLEM TEXT IS NOW SHORT. The full explanation used to be
    -- repeated per offending cell, which is what made a wholly percent-scaled
    -- file a 33,000-character exception. It is stated once, in the summary
    -- raised below.
    foreach v_key in array array['amex_volume','vmd_volume','pin_debit_volume','amex_template_volume_fee'] loop
      v_vol := (v_elem->>v_key)::numeric;
      if v_vol is not null and v_vol >= 0.10 then
        v_errors := v_errors || format('MID %s: %s is %s', v_mid, v_key, v_vol);
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

  -- ---------- the bounded rejection ----------
  -- Summary first, then at most c_max_shown problems joined with " | ". The
  -- client splits on that separator to render them in a scrollable list, so
  -- the shape is part of the contract, not incidental formatting.
  if array_length(v_errors, 1) > 0 then
    v_total := array_length(v_errors, 1);
    v_shown := v_errors[1:least(v_total, c_max_shown)];

    raise exception 'Merchant rate import rejected (% problem(s)%): %',
      v_total,
      case when v_total > c_max_shown
           then format(', first %s shown', c_max_shown) else '' end,
      array_to_string(v_shown, ' | ')
      using errcode = '23514',
            hint = 'Nothing was written. A rate at or above 0.10 is almost certainly percent-scaled: volume rates are unscaled decimal fractions, 0.0385 for 3.85%. Fix the file and re-import.';
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
  'Atomic all-or-nothing import of the TapDash sell-side rate sheet. Validates every row first (MID, risk code via residual_risk_tiers.statement_code, percent-scale guard at >= 0.10, non-negative, no backdating, no duplicate MID) and writes nothing if any row fails. IDEMPOTENT ON RE-IMPORT: an identical file at the same effective date succeeds and writes nothing; the same date with any value CHANGED is still rejected 23514. The rejection message is BOUNDED — summary, then at most 20 problems joined with " | ", with the true total always stated — because a wholly percent-scaled file produced 132 problems and a ~33,000-character exception. Capping the message is not capping the check.';

revoke all on function public.commit_residual_merchant_rates_import(uuid, date, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.commit_residual_merchant_rates_import(uuid, date, jsonb)
  to authenticated;

commit;
