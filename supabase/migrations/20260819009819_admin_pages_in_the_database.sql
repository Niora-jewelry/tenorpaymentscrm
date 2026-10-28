-- =============================================================================
-- Permissions spec — "Admin pages: Each page is set separately. Full access
-- means the user can do anything on that page."
--
-- The database functions and policies behind those pages asked one question —
-- auth_is_admin(), "is this a Super admin" — so an Admin (Full access to every
-- page but the Recycle bin, and not a Super admin) could open a page whose
-- every action then refused them. Each now asks for its own page:
--   Users            soft_delete_user, restore_user, purge_user,
--                    reassign_user_records, count_user_records; the login
--                    history (auth_audit_log)
--   Recycle bin      restore_* and purge_record
--   Residuals admin  every residual_* function and table
--   Phone numbers    the IVR tables
--   Permissions      delete_permission_template
--   Presets          add_statement_year
-- Generated from the live definitions with only that call changed.
-- Super admin still passes every one (auth_admin_page checks it first).
-- =============================================================================

create or replace function auth_admin_page(p_page text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth_is_admin() or auth_perm('admin.' || p_page) = 'full';
$$;
revoke execute on function auth_admin_page(text) from public, anon;
grant execute on function auth_admin_page(text) to authenticated;

-- add_statement_year → presets
CREATE OR REPLACE FUNCTION public.add_statement_year(p_year integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_added int;
  v_max   int;
begin
  if not auth_admin_page('presets') then
    raise exception 'Admin only' using errcode = '42501';
  end if;

  -- A sane window rather than an unbounded int: a typo of 20233 would insert
  -- twelve rows nobody can reach and which cannot be removed.
  if p_year < 2024 or p_year > 2100 then
    raise exception 'Year must be between 2024 and 2100' using errcode = '23514';
  end if;

  select coalesce(max(year), 2024) into v_max from statement_periods;

  -- Append-only means forward-only: the grid must stay contiguous, because the
  -- year selector walks it and a hole would read as data loss.
  if p_year <= v_max then
    return 0;   -- already covered; a repeated click is a no-op, not an error
  end if;
  if p_year > v_max + 1 then
    raise exception 'Add % first — the month grid has to stay contiguous', v_max + 1
      using errcode = '23514';
  end if;

  insert into statement_periods (year, month)
  select p_year, m from generate_series(1, 12) m
  on conflict do nothing;

  get diagnostics v_added = row_count;
  return v_added;
end;
$function$;

-- commit_residual_excel_import → residuals
CREATE OR REPLACE FUNCTION public.commit_residual_excel_import(p_import_id uuid, p_period_id uuid, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor       uuid := auth.uid();
  v_processor   text;
  v_source_type text;
  v_status      text;
  v_inserted    integer;
  v_swept       integer;
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to commit a residual import.'
      using errcode = '42501';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array.'
      using errcode = '22023';
  end if;

  select ri.processor, ri.source_type, ri.status
    into v_processor, v_source_type, v_status
    from public.residual_imports ri
   where ri.id = p_import_id
     and ri.deleted_at is null
   for update;

  if not found then
    raise exception 'Residual import % not found.', p_import_id
      using errcode = '22023';
  end if;

  if v_status <> 'processing' then
    raise exception 'Residual import % is in status %, expected processing.',
      p_import_id, v_status
      using errcode = '22023';
  end if;

  if v_source_type <> 'excel' then
    raise exception 'Residual import % has source_type %, expected excel.',
      p_import_id, v_source_type
      using errcode = '22023';
  end if;

  if v_processor is null or p_period_id is null then
    raise exception 'Residual import % needs both a processor and a period.',
      p_import_id
      using errcode = '22023';
  end if;

  update public.residual_imports
     set period_id = p_period_id
   where id = p_import_id;

  -- ---------- supersede sweep ----------
  update public.residual_lines rl
     set deleted_at    = now(),
         deleted_by_id = v_actor
    from public.residual_imports ri
   where rl.import_id = ri.id
     and rl.deleted_at is null
     and rl.import_id <> p_import_id
     and ri.period_id = p_period_id
     and ri.source_type = v_source_type
     and ri.processor = v_processor;

  get diagnostics v_swept = row_count;

  -- ---------- insert ----------
  insert into public.residual_lines (
    period_id,
    import_id,
    mid,
    merchant_name,
    fee_category,
    fee_item_name,
    item_count,
    amount,
    buy_rate_per_item,
    agent_income,
    agent_expense,
    net_revenue,
    root_agent,
    agent_owner,
    agent,
    branch,
    source,
    created_by_id,
    updated_by_id
  )
  select
    p_period_id,
    p_import_id,
    r.mid,
    r.merchant_name,
    r.fee_category,
    r.fee_item_name,
    r.item_count,
    r.amount,
    r.buy_rate_per_item,
    r.agent_income,
    r.agent_expense,
    r.net_revenue,
    r.root_agent,
    r.agent_owner,
    r.agent,
    r.branch,
    'excel',
    v_actor,
    v_actor
  from jsonb_to_recordset(p_rows) as r(
    mid                text,
    merchant_name      text,
    fee_category       text,
    fee_item_name      text,
    item_count         numeric(14,4),
    amount             numeric(14,2),
    buy_rate_per_item  numeric(14,6),
    agent_income       numeric(14,2),
    agent_expense      numeric(14,2),
    net_revenue        numeric(14,2),
    root_agent         text,
    agent_owner        text,
    agent              text,
    branch             text
  )
  where r.mid is not null
    and btrim(r.mid) <> '';

  get diagnostics v_inserted = row_count;

  update public.residual_imports
     set status        = 'completed',
         row_count     = v_inserted,
         processed_at  = now(),
         error_message = null,
         updated_by_id = v_actor
   where id = p_import_id;

  return jsonb_build_object('inserted', v_inserted, 'swept', v_swept);
end;
$function$;

-- commit_residual_merchant_rates_import → residuals
CREATE OR REPLACE FUNCTION public.commit_residual_merchant_rates_import(p_import_id uuid, p_effective_from date, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
     or not public.auth_admin_page('residuals') then
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
$function$;

-- commit_residual_pdf_import → residuals
CREATE OR REPLACE FUNCTION public.commit_residual_pdf_import(p_import_id uuid, p_period_id uuid, p_merchant jsonb, p_plan_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor        uuid := auth.uid();
  v_processor    text;
  v_source_type  text;
  v_status       text;
  v_mid          text;
  v_merchant_nm  text;
  v_stated_total numeric(14,2);
  v_stated_count integer;
  v_rollup       jsonb;
  v_reconciled   boolean;
  v_inserted     integer;
  v_swept        integer;
  v_plan_ins     integer;
  v_plan_swept   integer;
begin
  -- Auth gate FIRST. Definer bypasses RLS, so this is the only guard.
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to commit a residual import.'
      using errcode = '42501';
  end if;

  if p_plan_rows is null or jsonb_typeof(p_plan_rows) <> 'array' then
    raise exception 'p_plan_rows must be a JSON array.'
      using errcode = '22023';
  end if;

  if p_merchant is null or jsonb_typeof(p_merchant) <> 'object' then
    raise exception 'p_merchant must be a JSON object.'
      using errcode = '22023';
  end if;

  -- ---------- merchant identity ----------
  -- Re-normalized here with the R3 digits-only expression rather than trusted
  -- from the caller. Pinned character-for-character to
  -- records_mid_unique, find_live_thread_by_mid and
  -- find_live_threads_by_mid_suffix; the TypeScript twin is
  -- normalizeMidForStorage(). All five change together or not at all.
  v_mid := regexp_replace(coalesce(p_merchant->>'mid', ''), '[^0-9]', '', 'g');
  if v_mid = '' then
    raise exception 'p_merchant.mid has no digits.'
      using errcode = '22023';
  end if;

  v_merchant_nm  := nullif(btrim(coalesce(p_merchant->>'merchant_name', '')), '');
  v_stated_count := nullif(p_merchant->>'stated_item_count', '')::integer;

  -- stated_total is REQUIRED. interpretStatement already refuses a statement
  -- with no '**' totals row ("Refusing to import a statement that can't be
  -- reconciled"); enforcing it here too means that guarantee survives any
  -- caller, not just the one we ship.
  v_stated_total := nullif(p_merchant->>'stated_total', '')::numeric(14,2);
  if v_stated_total is null then
    raise exception 'p_merchant.stated_total is required (the statement''s ''**'' row).'
      using errcode = '22023';
  end if;

  -- ---------- import row: lock and guard ----------
  select ri.processor, ri.source_type, ri.status
    into v_processor, v_source_type, v_status
    from public.residual_imports ri
   where ri.id = p_import_id
     and ri.deleted_at is null
   for update;

  if not found then
    raise exception 'Residual import % not found.', p_import_id
      using errcode = '22023';
  end if;

  if v_status <> 'processing' then
    raise exception 'Residual import % is in status %, expected processing.',
      p_import_id, v_status
      using errcode = '22023';
  end if;

  if v_source_type <> 'pdf' then
    raise exception 'Residual import % has source_type %, expected pdf.',
      p_import_id, v_source_type
      using errcode = '22023';
  end if;

  if v_processor is null or p_period_id is null then
    raise exception 'Residual import % needs both a processor and a period.',
      p_import_id
      using errcode = '22023';
  end if;

  -- Pin the resolved period in the SAME transaction as the rows, so the import
  -- and its data can never disagree about which month they belong to. Also
  -- arms the idempotency index, which keys on period_id.
  -- Pins the MID too, for the same reason and in the same breath: a statement
  -- is one merchant's artifact, and residual_imports_statement_unique keys on
  -- it. Set here rather than trusted from the caller so the keyed value is the
  -- one that was actually read out of the document.
  update public.residual_imports
     set period_id = p_period_id,
         mid       = v_mid
   where id = p_import_id;

  -- ---------- derive, before writing anything ----------
  -- The identical call previewResidualPdfAction made on the identical input.
  v_rollup     := public.residual_derive_plan_rollup(p_plan_rows, v_stated_total);
  v_reconciled := (v_rollup->>'reconciled')::boolean;

  if (v_rollup->>'plan_row_count')::integer = 0 then
    raise exception 'p_plan_rows contains no usable plan rows.'
      using errcode = '22023';
  end if;

  -- VETO POINT. To restore R4b's abort-on-mismatch behaviour, uncomment:
  --
  --   if not v_reconciled then
  --     raise exception 'Statement does not reconcile: derived % vs stated %.',
  --       v_rollup->>'derived_total', v_rollup->>'stated_total'
  --       using errcode = '22023';
  --   end if;
  --
  -- Everything below already handles the unreconciled case correctly, so this
  -- is genuinely a one-block change in either direction.

  -- ---------- supersede sweep ----------
  -- Soft-delete every live row for THIS MERCHANT belonging to a DIFFERENT
  -- import that shares this import's (processor, period_id, source_type).
  --
  -- The `mid` predicate is load-bearing. Without it the sweep clears every
  -- merchant in the month, which was correct while a month could hold only one
  -- completed PDF import and is silent data loss now that it holds one per
  -- merchant. It pairs with residual_imports_statement_unique; neither is safe
  -- without the other, so they went in together.
  --
  -- Why not keyed on status: residual_imports carries a partial unique on that
  -- triple WHERE status='completed' AND deleted_at IS NULL, so a second
  -- completed import for the same triple cannot exist and a status-keyed sweep
  -- would be dead code. The real re-import path is soft-delete-the-import then
  -- re-upload, and soft-deleting an import does NOT cascade to its rows —
  -- which would double-count. Hence "different import, same triple".
  --
  -- Manual rows are never swept: the provenance CHECK on both tables
  -- guarantees source='manual' implies import_id IS NULL, so the join excludes
  -- them outright.
  --
  -- ORDER IS FREE. There is no FK between residual_plan_volumes and
  -- residual_merchant_volumes — they are siblings keyed on (period, mid), not
  -- parent and child. Plan rows are swept first only for readability.
  --
  -- Both sweeps must precede their inserts: both uniques are PARTIAL and so
  -- cannot serve as an ON CONFLICT target (the R4b reasoning).

  update public.residual_plan_volumes pv
     set deleted_at    = now(),
         deleted_by_id = v_actor
    from public.residual_imports ri
   where pv.import_id = ri.id
     and pv.deleted_at is null
     and pv.import_id <> p_import_id
     and pv.mid = v_mid
     and ri.period_id = p_period_id
     and ri.source_type = v_source_type
     and ri.processor = v_processor;

  get diagnostics v_plan_swept = row_count;

  update public.residual_merchant_volumes rv
     set deleted_at    = now(),
         deleted_by_id = v_actor
    from public.residual_imports ri
   where rv.import_id = ri.id
     and rv.deleted_at is null
     and rv.import_id <> p_import_id
     and rv.mid = v_mid
     and ri.period_id = p_period_id
     and ri.source_type = v_source_type
     and ri.processor = v_processor;

  get diagnostics v_swept = row_count;

  -- ---------- insert the plan-row detail ----------
  -- volume_bucket is resolved by the SAME left join residual_derive_plan_rollup
  -- used, against the same live map rows, inside the same transaction — so the
  -- stored bucket and the derived totals cannot disagree.
  insert into public.residual_plan_volumes (
    period_id, import_id, mid, plan_code, volume_bucket,
    amount, item_count, credit_amount, credit_count,
    source, created_by_id, updated_by_id
  )
  select
    p_period_id,
    p_import_id,
    v_mid,
    upper(btrim(r.plan_code)),
    b.volume_bucket,
    r.amount,
    r.item_count,
    r.credit_amount,
    r.credit_count,
    'pdf',
    v_actor,
    v_actor
  from jsonb_to_recordset(p_plan_rows) as r(
    plan_code     text,
    amount        numeric(14,2),
    item_count    integer,
    credit_amount numeric(14,2),
    credit_count  integer
  )
  left join public.residual_plan_code_buckets b
    on b.plan_code = upper(btrim(r.plan_code))
   and b.deleted_at is null
  where btrim(coalesce(r.plan_code, '')) <> ''
    and r.amount is not null;

  get diagnostics v_plan_ins = row_count;

  -- ---------- insert the rolled-up merchant row ----------
  -- The four dollar buckets and the four counts are written ONLY when the
  -- statement reconciled. Otherwise NULL — not partial, not zero. See the
  -- BEHAVIOUR CHANGE note above.
  insert into public.residual_merchant_volumes (
    period_id, import_id, mid, merchant_name,
    amex_volume, vmd_volume, debit_volume, ebt_volume,
    amex_item_count, vmd_item_count, debit_item_count, ebt_item_count,
     amex_credits, vmd_credits, debit_credits, ebt_credits,
    stated_total, stated_item_count, reconciled, unmapped_volume,
    source, created_by_id, updated_by_id
  )
  values (
    p_period_id,
    p_import_id,
    v_mid,
    v_merchant_nm,

    case when v_reconciled then (v_rollup#>>'{buckets,amex_volume}')::numeric(14,2)  end,
    case when v_reconciled then (v_rollup#>>'{buckets,vmd_volume}')::numeric(14,2)   end,
    case when v_reconciled then (v_rollup#>>'{buckets,debit_volume}')::numeric(14,2) end,
    case when v_reconciled then (v_rollup#>>'{buckets,ebt_volume}')::numeric(14,2)   end,

    case when v_reconciled then (v_rollup#>>'{counts,amex_item_count}')::integer  end,
    case when v_reconciled then (v_rollup#>>'{counts,vmd_item_count}')::integer   end,
    case when v_reconciled then (v_rollup#>>'{counts,debit_item_count}')::integer end,
    case when v_reconciled then (v_rollup#>>'{counts,ebt_item_count}')::integer   end,

    -- Gated on v_reconciled for the same reason the volumes are: an
    -- unreconciled statement's buckets are withheld, and a credit figure
    -- without the volume it belongs to is not a fact worth keeping.
    case when v_reconciled then (v_rollup#>>'{credits,amex_credits}')::numeric(14,2)  end,
    case when v_reconciled then (v_rollup#>>'{credits,vmd_credits}')::numeric(14,2)   end,
    case when v_reconciled then (v_rollup#>>'{credits,debit_credits}')::numeric(14,2) end,
    case when v_reconciled then (v_rollup#>>'{credits,ebt_credits}')::numeric(14,2)   end,

    v_stated_total,
    v_stated_count,
    v_reconciled,
    (v_rollup->>'unmapped_volume')::numeric(14,2),

    'pdf',
    v_actor,
    v_actor
  );

  get diagnostics v_inserted = row_count;

  -- ---------- close the import ----------
  -- Arms residual_imports_statement_unique. A live completed import already
  -- holding this (processor, period, mid) makes THIS statement raise 23505 and
  -- rolls the whole function back — no rows inserted, no sweep applied. Re-
  -- importing one merchant's statement therefore still has to soft-delete the
  -- earlier import first; what changed is that the OTHER merchants' imports no
  -- longer collide with it.
  update public.residual_imports
     set status        = 'completed',
         row_count     = v_inserted,
         processed_at  = now(),
         error_message = null,
         updated_by_id = v_actor
   where id = p_import_id;

  -- "inserted" and "swept" keep their R4b meanings (merchant-volume rows) so
  -- readCommitCounts in actions.ts needs no change. Everything else is added.
  return jsonb_build_object(
    'inserted',          v_inserted,
    'swept',             v_swept,
    'plan_rows_inserted', v_plan_ins,
    'plan_rows_swept',    v_plan_swept,
    'reconciled',         v_reconciled,
    'derived_total',      v_rollup->>'derived_total',
    'stated_total',       v_rollup->>'stated_total',
    'unmapped_volume',    v_rollup->>'unmapped_volume',
    'unmapped_codes',     v_rollup->'unmapped_codes_with_volume',
    'has_counts',         (v_rollup->>'has_counts')::boolean
  );
end;
$function$;

-- compute_residual_period → residuals
CREATE OR REPLACE FUNCTION public.compute_residual_period(p_period_id uuid, p_processor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor      uuid := auth.uid();
  v_processor  text := upper(btrim(coalesce(p_processor, '')));
  v_month      date;
  v_status     text;
  v_version    int;
  v_registry   uuid;
  v_reg_label  text;
  v_buy_by_tier jsonb;

  v_mid        text;
  v_rates      jsonb;
  v_tier       text;
  v_share      numeric;
  v_buy        jsonb;
  v_vol        jsonb;
  v_siblings   text[];
  v_line       record;
  v_rule       record;
  v_grp        record;

  v_inc        numeric; v_inc_f text; v_inc_r text; v_inc_rr text;
  v_buyv       numeric; v_buy_f text; v_buy_r text; v_buy_rr text;
  v_add        numeric; v_add_f text; v_add_r text; v_add_rr text;
  v_before     numeric; v_after numeric;

  n_merch_ok   int := 0; n_merch_fail int := 0;
  n_line_ok    int := 0; n_line_fail  int := 0;
  n_groups     int := 0;
  -- R6a additions.
  v_clean      boolean;
  v_failures   jsonb;
  v_summary    jsonb;
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to run the residual calculation.'
      using errcode = '42501';
  end if;

  select p.statement_month, p.status, coalesce(p.calculation_version, 0)
    into v_month, v_status, v_version
    from public.residual_periods p
   where p.id = p_period_id and p.deleted_at is null;

  if v_month is null then
    raise exception 'No live residual period with id %.', p_period_id
      using errcode = 'P0002';
  end if;

  if v_status = 'reconciled' then
    raise exception
      'Statement month % is reconciled; reopen it before recomputing.',
      to_char(v_month, 'YYYY-MM')
      using errcode = '42501',
            hint = 'Set residual_periods.status to ''open'' for this period first.';
  end if;

  select g.id, g.label into v_registry, v_reg_label
    from public.residual_formula_registries g
   where g.processor = v_processor and g.deleted_at is null
     and g.effective_from <= v_month
     and (g.effective_to is null or g.effective_to > v_month);

  if v_registry is null then
    raise exception 'No % formula registry covers %.', v_processor, v_month
      using errcode = '22023';
  end if;

  -- Buy rates, once per run. 'rates' now carries {rate, cap} per fee item so a
  -- cap cannot be separated from the rate it bounds.
  select jsonb_object_agg(t.risk_tier, t.obj)
    into v_buy_by_tier
    from (
      select b.risk_tier,
             jsonb_build_object(
               'share', min(b.tapdash_share),
               'rates', jsonb_object_agg(
                          b.fee_item_key,
                          jsonb_build_object('rate', b.rate, 'cap', b.rate_cap))) as obj
        from public.residual_buy_rates_for_month(v_processor, v_month) b
       group by b.risk_tier
    ) t;

  v_version := v_version + 1;

  delete from public.residual_calc_failures where period_id = p_period_id;

  for v_mid in
    select distinct regexp_replace(l.mid, '[^0-9]', '', 'g')
      from public.residual_lines l
     where l.period_id = p_period_id and l.deleted_at is null
     order by 1
  loop
    v_rates := null;

    if v_mid = '' then
      n_merch_fail := n_merch_fail + 1;
      insert into public.residual_calc_failures
        (period_id, calculation_version, mid, scope, reason_code, detail, created_by_id)
      select p_period_id, v_version, '', 'merchant', 'unusable_mid',
             format('%s line(s) carry a MID with no digits in it (%s). They cannot be attributed to any merchant.',
                    count(*), string_agg(distinct format('%L', l.mid), ', ')),
             v_actor
        from public.residual_lines l
       where l.period_id = p_period_id and l.deleted_at is null
         and regexp_replace(l.mid, '[^0-9]', '', 'g') = '';

      update public.residual_lines
         set total_income = null, total_buy_rate = null,
             tapdash_net_before_split = null, tapdash_net_after_split = null,
             additional_income_direct = null, net_income = null,
             updated_by_id = v_actor
       where period_id = p_period_id and deleted_at is null
         and regexp_replace(mid, '[^0-9]', '', 'g') = '';
      continue;
    end if;

    begin
      select to_jsonb(r) into v_rates
        from public.residual_merchant_rates_for_month(v_mid, v_month) r;
    exception
      when sqlstate 'P0002' then
        v_rates := null;
      when others then
        raise;
    end;

    if v_rates is null then
      n_merch_fail := n_merch_fail + 1;
      insert into public.residual_calc_failures
        (period_id, calculation_version, mid, scope, reason_code, detail, created_by_id)
      values (p_period_id, v_version, v_mid, 'merchant', 'no_merchant_rates',
              format('No rate version in effect for %s. Every line for this merchant is skipped until rates are entered.',
                     to_char(v_month, 'YYYY-MM')),
              v_actor);

      update public.residual_lines
         set total_income = null, total_buy_rate = null,
             tapdash_net_before_split = null, tapdash_net_after_split = null,
             additional_income_direct = null, net_income = null,
             updated_by_id = v_actor
       where period_id = p_period_id and deleted_at is null
         and regexp_replace(mid, '[^0-9]', '', 'g') = v_mid;
      continue;
    end if;

    v_tier := v_rates ->> 'risk_tier';

    v_share := (v_buy_by_tier -> v_tier ->> 'share')::numeric;
    v_buy   :=  v_buy_by_tier -> v_tier -> 'rates';

    if v_share is null then
      n_merch_fail := n_merch_fail + 1;
      insert into public.residual_calc_failures
        (period_id, calculation_version, mid, scope, reason_code, detail, created_by_id)
      values (p_period_id, v_version, v_mid, 'merchant', 'missing_template_rate',
              format('The buy-rate schedule for %s has no tier "%s".',
                     to_char(v_month, 'YYYY-MM'), v_tier), v_actor);
      continue;
    end if;

    select to_jsonb(v) into v_vol
      from public.residual_merchant_volumes v
     where v.period_id = p_period_id and v.deleted_at is null
       and regexp_replace(v.mid, '[^0-9]', '', 'g') = v_mid
     limit 1;

    select array_agg(distinct l.fee_item_name)
      into v_siblings
      from public.residual_lines l
     where l.period_id = p_period_id and l.deleted_at is null
       and regexp_replace(l.mid, '[^0-9]', '', 'g') = v_mid;

    n_merch_ok := n_merch_ok + 1;

    for v_line in
      select l.* from public.residual_lines l
       where l.period_id = p_period_id and l.deleted_at is null
         and regexp_replace(l.mid, '[^0-9]', '', 'g') = v_mid
       order by l.id
    loop
      select r.* into v_rule
        from public.residual_formula_rules r
       where r.registry_id = v_registry and r.deleted_at is null
         and r.fee_item_name = v_line.fee_item_name;

      if v_rule.id is null then
        n_line_fail := n_line_fail + 1;
        insert into public.residual_calc_failures
          (period_id, calculation_version, mid, line_id, fee_item_name, scope, reason_code, detail, created_by_id)
        values (p_period_id, v_version, v_mid, v_line.id, v_line.fee_item_name,
                'line', 'unknown_fee_item',
                format('No rule for fee item "%s" in registry "%s".',
                       v_line.fee_item_name, v_reg_label), v_actor);
        update public.residual_lines set
          total_income=null, total_buy_rate=null, tapdash_net_before_split=null,
          tapdash_net_after_split=null, additional_income_direct=null, net_income=null,
          updated_by_id=v_actor
         where id = v_line.id;
        continue;
      end if;

      if v_rule.group_key is not null then
        update public.residual_lines set
          total_income=0, total_buy_rate=0, tapdash_net_before_split=0,
          tapdash_net_after_split=0, additional_income_direct=0, net_income=0,
          updated_by_id=v_actor
         where id = v_line.id;
        n_line_ok := n_line_ok + 1;
        continue;
      end if;

      select o_value, o_failure, o_reason, o_rate_ref
        into v_inc, v_inc_f, v_inc_r, v_inc_rr
        from public.residual_eval_side(v_rule.id,'income',
             v_line.item_count, v_line.net_revenue, v_rates, v_buy, v_vol, v_siblings);
      select o_value, o_failure, o_reason, o_rate_ref
        into v_buyv, v_buy_f, v_buy_r, v_buy_rr
        from public.residual_eval_side(v_rule.id,'buy_rate',
             v_line.item_count, v_line.net_revenue, v_rates, v_buy, v_vol, v_siblings);
      select o_value, o_failure, o_reason, o_rate_ref
        into v_add, v_add_f, v_add_r, v_add_rr
        from public.residual_eval_side(v_rule.id,'additional_income',
             v_line.item_count, v_line.net_revenue, v_rates, v_buy, v_vol, v_siblings);

      if v_inc_f is not null or v_buy_f is not null or v_add_f is not null then
        n_line_fail := n_line_fail + 1;
        insert into public.residual_calc_failures
          (period_id, calculation_version, mid, line_id, fee_item_name, scope,
           reason_code, detail, rate_ref, created_by_id)
        values (p_period_id, v_version, v_mid, v_line.id, v_line.fee_item_name, 'line',
                coalesce(v_inc_r, v_buy_r, v_add_r),
                format('%s: %s', v_line.fee_item_name,
                       coalesce(v_inc_f, v_buy_f, v_add_f)),
                case when v_inc_f is not null then v_inc_rr
                     when v_buy_f is not null then v_buy_rr
                     else v_add_rr end,
                v_actor);
        update public.residual_lines set
          total_income=null, total_buy_rate=null, tapdash_net_before_split=null,
          tapdash_net_after_split=null, additional_income_direct=null, net_income=null,
          updated_by_id=v_actor
         where id = v_line.id;
        continue;
      end if;

      v_inc    := round(v_inc,  2);
      v_buyv   := round(v_buyv, 2);
      v_add    := round(v_add,  2);
      v_before := v_inc - v_buyv;
      v_after  := round(v_before * v_share, 2);

      update public.residual_lines set
        total_income             = v_inc,
        total_buy_rate           = v_buyv,
        tapdash_net_before_split = v_before,
        tapdash_net_after_split  = v_after,
        additional_income_direct = v_add,
        net_income               = v_after + v_add,
        updated_by_id            = v_actor
       where id = v_line.id;

      n_line_ok := n_line_ok + 1;
    end loop;

    for v_grp in
      select distinct r.group_key
        from public.residual_lines l
        join public.residual_formula_rules r
          on r.registry_id = v_registry and r.deleted_at is null
         and r.fee_item_name = l.fee_item_name
       where l.period_id = p_period_id and l.deleted_at is null
         and regexp_replace(l.mid,'[^0-9]','','g') = v_mid
         and r.group_key is not null
    loop
      declare
        v_anchor   record;
        v_stated   numeric;
        v_members  int;
      begin
        select r.* into v_anchor
          from public.residual_formula_rules r
         where r.registry_id = v_registry and r.deleted_at is null
           and r.group_key = v_grp.group_key and r.is_group_anchor;

        select coalesce(sum(l.net_revenue),0), count(*)
          into v_stated, v_members
          from public.residual_lines l
          join public.residual_formula_rules r
            on r.registry_id = v_registry and r.deleted_at is null
           and r.fee_item_name = l.fee_item_name
         where l.period_id = p_period_id and l.deleted_at is null
           and regexp_replace(l.mid,'[^0-9]','','g') = v_mid
           and r.group_key = v_grp.group_key;

        select o_value, o_failure, o_reason, o_rate_ref
          into v_inc, v_inc_f, v_inc_r, v_inc_rr
          from public.residual_eval_side(v_anchor.id,'income', null, null, v_rates, v_buy, v_vol, v_siblings);
        select o_value, o_failure, o_reason, o_rate_ref
          into v_buyv, v_buy_f, v_buy_r, v_buy_rr
          from public.residual_eval_side(v_anchor.id,'buy_rate', null, null, v_rates, v_buy, v_vol, v_siblings);
        select o_value, o_failure, o_reason, o_rate_ref
          into v_add, v_add_f, v_add_r, v_add_rr
          from public.residual_eval_side(v_anchor.id,'additional_income', null, null, v_rates, v_buy, v_vol, v_siblings);

        if v_inc_f is not null or v_buy_f is not null or v_add_f is not null then
          insert into public.residual_calc_failures
            (period_id, calculation_version, mid, group_key, fee_item_name, scope,
             reason_code, detail, rate_ref, created_by_id)
          values (p_period_id, v_version, v_mid, v_grp.group_key, v_anchor.fee_item_name, 'group',
                  coalesce(v_inc_r, v_buy_r, v_add_r),
                  format('group %s: %s', v_grp.group_key,
                         coalesce(v_inc_f, v_buy_f, v_add_f)),
                  case when v_inc_f is not null then v_inc_rr
                       when v_buy_f is not null then v_buy_rr
                       else v_add_rr end,
                  v_actor);
          delete from public.residual_line_groups
           where period_id = p_period_id and mid = v_mid and group_key = v_grp.group_key;
        else
          v_inc    := round(v_inc,2);
          v_buyv   := round(v_buyv,2);
          v_add    := round(v_add,2);
          v_before := v_inc - v_buyv;
          v_after  := round(v_before * v_share, 2);

          insert into public.residual_line_groups
            (period_id, mid, group_key, total_income, total_buy_rate,
             tapdash_net_before_split, tapdash_net_after_split,
             additional_income_direct, net_income, stated_net_revenue,
             member_line_count, created_by_id, updated_by_id)
          values (p_period_id, v_mid, v_grp.group_key, v_inc, v_buyv,
                  v_before, v_after, v_add, v_after + v_add, v_stated,
                  v_members, v_actor, v_actor)
          on conflict (period_id, mid, group_key) where deleted_at is null
          do update set
            total_income=excluded.total_income, total_buy_rate=excluded.total_buy_rate,
            tapdash_net_before_split=excluded.tapdash_net_before_split,
            tapdash_net_after_split=excluded.tapdash_net_after_split,
            additional_income_direct=excluded.additional_income_direct,
            net_income=excluded.net_income, stated_net_revenue=excluded.stated_net_revenue,
            member_line_count=excluded.member_line_count, updated_by_id=v_actor;
          n_groups := n_groups + 1;
        end if;
      end;
    end loop;
  end loop;

  -- ---------- stamp ----------
  -- STATUS IS NO LONGER WRITTEN HERE. R6a made the progress states derived
  -- (residual_period_state) and narrowed the stored column to a sign-off flag.
  -- The three values this block used to write — 'ready', 'awaiting_volumes',
  -- and the 'open' that stood in for a "computed with gaps" the vocabulary
  -- lacked — are all derived now, and the gap that forced that overload is said
  -- at MERCHANT grain instead, where it can name which merchants are gappy.
  --
  -- calculation_version IS STILL STAMPED ONLY ON A CLEAN RUN, unchanged and
  -- still load-bearing: residual_merchant_rate_is_locked treats a non-null
  -- version as a dependency, so stamping a gappy run would lock every merchant
  -- it touched — including the ones whose failure is a rate nobody has entered
  -- yet, which is exactly the merchant an operator needs to be able to edit.
  v_clean := not exists (
    select 1 from public.residual_calc_failures where period_id = p_period_id);

  update public.residual_periods
     set calculation_version = case when v_clean then v_version else null end,
         updated_by_id = v_actor
   where id = p_period_id;

  v_failures := coalesce((
    select jsonb_object_agg(reason_code, n)
      from (select reason_code, count(*) n
              from public.residual_calc_failures
             where period_id = p_period_id group by 1) x), '{}'::jsonb);

  v_summary := jsonb_build_object(
    'period_id',           p_period_id,
    'statement_month',     to_char(v_month, 'YYYY-MM-DD'),
    'processor',           v_processor,
    'calculation_version', v_version,
    'stamped',             v_clean,
    'registry',            v_reg_label,
    'merchants_computed',  n_merch_ok,
    'merchants_failed',    n_merch_fail,
    'lines_computed',      n_line_ok,
    'lines_failed',        n_line_fail,
    'groups_computed',     n_groups,
    'failures_by_reason',  v_failures
  );

  -- gap #16: the summary this function has always built and thrown away.
  -- version_attempted + stamped together record the run that computed a version
  -- and then disclaimed it — a fact that until now was visible only as an
  -- unexplained asymmetry between residual_calc_failures.calculation_version
  -- and residual_periods.calculation_version.
  insert into public.residual_calc_runs
    (period_id, version_attempted, stamped, processor, registry_id,
     registry_label, status_written, merchants_computed, merchants_failed,
     lines_computed, lines_failed, groups_computed, failures_by_reason,
     summary, ran_by_id)
  values
    (p_period_id, v_version, v_clean, v_processor, v_registry,
     v_reg_label, 'open', n_merch_ok, n_merch_fail,
     n_line_ok, n_line_fail, n_groups, v_failures,
     v_summary, v_actor);

  -- Retirement point 1 of 3 (see residual_retire_resolved_acks). The outputs
  -- have just moved, so this is exactly when an acknowledgment can stop
  -- describing its row. Idempotent, so a re-run costs nothing.
  perform public.residual_retire_resolved_acks(p_period_id, v_processor);

  return v_summary;
end;
$function$;

-- count_user_records → users
CREATE OR REPLACE FUNCTION public.count_user_records(p_user uuid)
 RETURNS bigint
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if not auth_admin_page('users') then
    -- Refuses rather than returning zero. This number is the input to a
    -- destructive decision (reassign-then-delete), so a wrong one is worse
    -- than an error.
    raise exception 'Admins only.' using errcode = '42501';
  end if;

  -- Body unchanged. Note it counts records the user is a TEAM MEMBER of, not
  -- ones they created — that is what the reassignment flow is about, and it
  -- was verified against the original before this function was replaced.
  return (
    select count(*)
      from records r
     where r.deleted_at is null
       and r.values -> 'team_members_assigned' @> to_jsonb(p_user::text)
  );
end;
$function$;

-- delete_permission_template → permissions
CREATE OR REPLACE FUNCTION public.delete_permission_template(p_template_id uuid, p_move_to uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_moved integer := 0;
  v_users integer;
begin
  if not auth_admin_page('permissions') then
    raise exception 'Admin only' using errcode = '42501';
  end if;

  -- Lock the template so nobody is attached to it between the count and the delete.
  perform 1 from permission_templates where id = p_template_id for update;
  if not found then
    raise exception 'That template no longer exists — reload the page.' using errcode = 'P0002';
  end if;

  select count(*) into v_users from user_templates where template_id = p_template_id;

  if v_users > 0 then
    if p_move_to is null then
      raise exception 'Pick a template to move its % user% to.', v_users, case when v_users = 1 then '' else 's' end
        using errcode = '22023';
    end if;
    if p_move_to = p_template_id then
      raise exception 'Pick a different template to move them to.' using errcode = '22023';
    end if;
    perform 1 from permission_templates where id = p_move_to for share;
    if not found then
      raise exception 'The template to move them to no longer exists — reload the page.' using errcode = 'P0002';
    end if;

    update user_templates set template_id = p_move_to where template_id = p_template_id;
    get diagnostics v_moved = row_count;
  end if;

  delete from permission_templates where id = p_template_id;
  return v_moved;
end;
$function$;

-- purge_record → recycle_bin
CREATE OR REPLACE FUNCTION public.purge_record(rec uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if not auth_admin_page('recycle_bin') then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if not exists (select 1 from records where id = rec and deleted_at is not null) then
    raise exception 'Only an already-deleted (Recycle Bin) record may be purged'
      using errcode = '23514';
  end if;

  -- Every other child table still cascades from `records` normally; only
  -- record_activity is exempt (no FK at all, see above), so it survives this
  -- delete as an orphaned trail rather than blocking it.
  delete from records where id = rec;
end;
$function$;

-- purge_user → users
CREATE OR REPLACE FUNCTION public.purge_user(p_user uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_email   text;
  v_left    bigint;
  v_stub    text;
begin
  if not auth_admin_page('users') then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if p_user = auth.uid() then
    raise exception 'You cannot delete your own account' using errcode = '23514';
  end if;

  select email into v_email from profiles where id = p_user and deleted_at is not null;
  if v_email is null then
    raise exception 'Soft delete this user first — permanent removal is only available from the Recycle Bin'
      using errcode = '23514';
  end if;

  v_left := count_user_records(p_user);
  if v_left > 0 then
    raise exception 'Reassign this user''s % record(s) before deleting them', v_left
      using errcode = '23514';
  end if;

  delete from user_grants              where user_id  = p_user;
  delete from user_templates           where user_id  = p_user;
  delete from user_filters             where user_id  = p_user;
  delete from user_column_order        where user_id  = p_user;
  delete from user_field_order         where user_id  = p_user;
  delete from record_visibility_grants where owner_id = p_user or viewer_id = p_user;
  delete from case_managers            where user_id  = p_user;
  delete from record_team_members      where user_id  = p_user;
  delete from update_mentions          where user_id  = p_user;
  delete from case_reply_mentions      where user_id  = p_user;
  delete from notification_mutes       where user_id  = p_user;
  delete from notifications            where recipient_id = p_user;

  insert into auth_audit_log (actor_id, event_type, email_attempted, metadata)
  values (auth.uid(), 'user_purged', v_email, jsonb_build_object('user_id', p_user));

  begin
    delete from auth.users where id = p_user;
    return 'deleted';
  exception
    when foreign_key_violation then
      null;
  end;

  v_stub := 'deleted-' || replace(p_user::text, '-', '') || '@removed.invalid';

  update profiles
     set email               = v_stub,
         full_name           = null,
         status              = 'suspended',
         sessions_valid_from = now(),
         last_login_at       = null,
         last_seen_at        = null,
         deleted_at          = now()
   where id = p_user;

  delete from auth.identities      where user_id = p_user;
  delete from auth.mfa_factors     where user_id = p_user;
  delete from auth.one_time_tokens where user_id = p_user;
  delete from auth.sessions        where user_id = p_user;
  delete from auth.refresh_tokens  where user_id = p_user::text;

  update auth.users
     set encrypted_password     = null,
         email                  = v_stub,
         email_change           = '',
         email_change_token_new = '',
         recovery_token         = '',
         confirmation_token     = '',
         banned_until           = now() + interval '1000 years'
   where id = p_user;

  return 'anonymised';
end;
$function$;

-- reassign_user_records → users
CREATE OR REPLACE FUNCTION public.reassign_user_records(p_from uuid, p_to uuid)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_rec   record;
  v_next  jsonb;
  v_count bigint := 0;
begin
  if not auth_admin_page('users') then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if p_from = p_to then
    raise exception 'Choose a different person to reassign to' using errcode = '23514';
  end if;
  if not exists (select 1 from profiles where id = p_to and status = 'active' and deleted_at is null) then
    raise exception 'That person is not an active user' using errcode = '23503';
  end if;

  for v_rec in
    select id, deal_name, values -> 'team_members_assigned' as team
      from records
     where deleted_at is null
       and values -> 'team_members_assigned' @> to_jsonb(p_from::text)
  loop
    -- Remove the departing user, add the replacement, and keep the result
    -- distinct so a record that already had both does not end up with a
    -- duplicate id in its team.
    -- The set-returning call sits in FROM, not WHERE: Postgres rejects an SRF
    -- in a WHERE clause outright (0A000), and expanding it once in FROM is
    -- also the only form that evaluates the array a single time.
    select coalesce(jsonb_agg(distinct s.x), '[]'::jsonb) into v_next
      from (
        select t.x
          from jsonb_array_elements_text(v_rec.team) as t(x)
         where t.x <> p_from::text
        union
        select p_to::text
      ) s(x);

    update records
       set values = jsonb_set(values, '{team_members_assigned}', v_next, true),
           updated_at = now()
     where id = v_rec.id;

    insert into record_activity (record_id, actor_id, kind, field_key, summary, from_value, to_value)
    values (v_rec.id, auth.uid(), 'field', 'team_members_assigned',
            'Team member reassigned during offboarding',
            v_rec.team #>> '{}', v_next #>> '{}');

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;

-- residual_acknowledge_verdict → residuals
CREATE OR REPLACE FUNCTION public.residual_acknowledge_verdict(p_scope text, p_scope_id uuid, p_step smallint, p_reason text, p_processor text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor   uuid := auth.uid();
  v_period  uuid;
  v_status  text;
  v_month   date;
  v_ver     integer;
  v_row     record;
  v_id      uuid;
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to acknowledge a residual verdict.'
      using errcode = '42501';
  end if;

  if v_actor is null then
    raise exception 'An acknowledgment requires an identified actor.'
      using errcode = '42501',
            hint = 'This function cannot be called on a service-role connection.';
  end if;

  if p_scope not in ('line','group') then
    raise exception 'residual_acknowledge_verdict: p_scope must be line or group.'
      using errcode = '22023';
  end if;

  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'An acknowledgment requires a reason.'
      using errcode = '22004',
            hint = 'The reason is what makes the forgiveness auditable; it is not optional.';
  end if;

  -- Resolve the target's period from the target itself, so a caller cannot
  -- file an ack against the wrong month.
  if p_scope = 'line' then
    select l.period_id into v_period
      from public.residual_lines l
     where l.id = p_scope_id and l.deleted_at is null;
  else
    select g.period_id into v_period
      from public.residual_line_groups g
     where g.id = p_scope_id and g.deleted_at is null;
  end if;

  if v_period is null then
    raise exception 'No live % with id %.', p_scope, p_scope_id
      using errcode = 'P0002';
  end if;

  select p.status, p.statement_month, p.calculation_version
    into v_status, v_month, v_ver
    from public.residual_periods p
   where p.id = v_period;

  -- Pre-check for a friendly message. The INSERT trigger would refuse anyway;
  -- this names the act rather than the table.
  if v_status = 'reconciled' then
    raise exception
      'Statement month % is signed off. A new acknowledgment requires reopening it first.',
      to_char(v_month, 'YYYY-MM')
      using errcode = '42501',
            hint = 'residual_reopen_period(period_id, reason).';
  end if;

  select w.verdict, w.delta, w.tolerance_applied
    into v_row
    from public.residual_verdicts(v_period, null, p_processor) w
   where w.scope_id = p_scope_id and w.step = p_step;

  if not found then
    raise exception
      'Step % has no verdict on this % — the comparison could not be made.',
      p_step, p_scope
      using errcode = 'P0002',
            hint = 'An uncomputed line, an unmapped fee item, or a merchant with no volume row. There is nothing to acknowledge.';
  end if;

  if v_row.verdict <> 'mismatch' then
    raise exception 'Step % on this % is %, not a mismatch.',
      p_step, p_scope, v_row.verdict
      using errcode = '22023',
            hint = 'Only a mismatch can be acknowledged.';
  end if;

  insert into public.residual_verdict_acknowledgments
    (period_id, scope, line_id, group_id, step,
     delta_acknowledged, tolerance_applied, calculation_version,
     reason, created_by_id)
  values
    (v_period, p_scope,
     case when p_scope = 'line'  then p_scope_id end,
     case when p_scope = 'group' then p_scope_id end,
     p_step,
     v_row.delta, v_row.tolerance_applied, v_ver,
     btrim(p_reason), v_actor)
  returning id into v_id;

  return v_id;
end;
$function$;

-- residual_buy_rate_coverage → residuals
CREATE OR REPLACE FUNCTION public.residual_buy_rate_coverage(p_processor text)
 RETURNS TABLE(statement_month date, schedule_id uuid, covered boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_processor text := upper(btrim(coalesce(p_processor, '')));
  v_periods   integer;
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to read buy-rate coverage.'
      using errcode = '42501';
  end if;

  select count(*) into v_periods
    from public.residual_periods p
   where p.deleted_at is null;

  -- Nothing to check is not the same as nothing wrong. See the note above.
  if v_periods = 0 then
    return query select null::date, null::uuid, false;
    return;
  end if;

  -- The LEFT JOIN cannot multiply rows: the EXCLUDE constraint makes at most
  -- one live schedule match any given month.
  return query
    select p.statement_month,
           s.id,
           (s.id is not null)
      from public.residual_periods p
      left join public.residual_buy_rate_schedules s
        on s.deleted_at is null
       and s.processor = v_processor
       and s.effective_from <= p.statement_month
       and (s.effective_to is null or s.effective_to > p.statement_month)
     where p.deleted_at is null
     order by p.statement_month;
end;
$function$;

-- residual_buy_rate_processors → residuals
CREATE OR REPLACE FUNCTION public.residual_buy_rate_processors()
 RETURNS TABLE(processor text, schedule_count integer, is_residual_split boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to read buy-rate schedules.'
      using errcode = '42501';
  end if;

  return query
  select s.processor,
         count(distinct s.id)::int as schedule_count,
         -- TRUE when this payer's schedules are priced across REAL risk tiers.
         -- bool_or over the tier rows, so a schedule with no tiers at all reads
         -- false rather than NULL — an unpriced schedule is not a residual
         -- split either.
         coalesce(bool_or(rt.is_risk_tier), false) as is_residual_split
    from public.residual_buy_rate_schedules s
    left join public.residual_buy_rate_tiers t
      on t.schedule_id = s.id and t.deleted_at is null
    left join public.residual_risk_tiers rt
      on rt.tier_key = t.risk_tier and rt.deleted_at is null
   where s.deleted_at is null
   group by s.processor
   order by (coalesce(bool_or(rt.is_risk_tier), false)) desc, s.processor;
end;
$function$;

-- residual_buy_rate_schedules_list → residuals
CREATE OR REPLACE FUNCTION public.residual_buy_rate_schedules_list(p_processor text, p_month date DEFAULT NULL::date)
 RETURNS TABLE(id uuid, label text, effective_from date, effective_to date, notes text, is_in_effect boolean, is_locked boolean, tier_count integer, cell_count integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- AN EXPLICIT RAISE, NOT A WHERE CLAUSE. Folding the gate into the query
  -- would return zero rows to an unauthorized caller, and zero schedules is a
  -- state this processor can genuinely be in — the screen would say "no
  -- schedule has ever been loaded" to someone who simply lacks the role. The
  -- gate is written as `is null or not in` so it fails closed on a
  -- service-role connection, where auth.uid() and therefore auth_role() are
  -- NULL.
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to read buy-rate schedules.'
      using errcode = '42501';
  end if;

  return query
  select s.id,
         s.label,
         s.effective_from,
         s.effective_to,
         s.notes,
         (p_month is not null
            and s.effective_from <= p_month
            and (s.effective_to is null or s.effective_to > p_month)) as is_in_effect,
         public.residual_buy_rate_schedule_is_locked(
           s.processor, s.effective_from, s.effective_to) as is_locked,
         (select count(*)::int from public.residual_buy_rate_tiers t
           where t.schedule_id = s.id and t.deleted_at is null) as tier_count,
         (select count(*)::int from public.residual_buy_rates b
           where b.schedule_id = s.id and b.deleted_at is null) as cell_count
    from public.residual_buy_rate_schedules s
   where s.deleted_at is null
     and s.processor = upper(btrim(coalesce(p_processor, '')))
   order by s.effective_from desc;
end;
$function$;

-- residual_buy_rates_for_month → residuals
CREATE OR REPLACE FUNCTION public.residual_buy_rates_for_month(p_processor text, p_month date)
 RETURNS TABLE(schedule_id uuid, risk_tier text, tapdash_share numeric, fee_item_key text, fee_item_label text, rate_kind text, billed_directly_to_merchant boolean, rate numeric, rate_cap numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_processor text := upper(btrim(coalesce(p_processor, '')));
  v_month     date := date_trunc('month', p_month)::date;
  v_schedule  uuid;
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
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
$function$;

-- residual_confirm_mid_link → residuals
CREATE OR REPLACE FUNCTION public.residual_confirm_mid_link(p_mid text, p_period_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_mid   text := regexp_replace(coalesce(p_mid,''),'[^0-9]','','g');
  v_n     integer;
  v_total integer := 0;
begin
  if not auth_admin_page('residuals') then
    raise exception 'Not authorized to confirm a residual link.' using errcode = '42501';
  end if;

  -- Only a row that HAS a link can be vouched for. The table's CHECK forbids
  -- a confirmed row with no record_id, so this filter is what keeps the write
  -- legal rather than merely sensible.
  update public.residual_lines rl set thread_confirmed_by_id = v_actor
   where rl.deleted_at is null and rl.record_id is not null
     and rl.thread_match in ('exact','suffix','manual')
     and regexp_replace(coalesce(rl.mid,''),'[^0-9]','','g') = v_mid
     and (p_period_id is null or rl.period_id = p_period_id);
  get diagnostics v_n = row_count; v_total := v_total + v_n;

  update public.residual_merchant_volumes rv set thread_confirmed_by_id = v_actor
   where rv.deleted_at is null and rv.record_id is not null
     and rv.thread_match in ('exact','suffix','manual')
     and regexp_replace(coalesce(rv.mid,''),'[^0-9]','','g') = v_mid
     and (p_period_id is null or rv.period_id = p_period_id);
  get diagnostics v_n = row_count; v_total := v_total + v_n;

  update public.residual_plan_volumes pv set thread_confirmed_by_id = v_actor
   where pv.deleted_at is null and pv.record_id is not null
     and pv.thread_match in ('exact','suffix','manual')
     and regexp_replace(coalesce(pv.mid,''),'[^0-9]','','g') = v_mid
     and (p_period_id is null or pv.period_id = p_period_id);
  get diagnostics v_n = row_count; v_total := v_total + v_n;

  return jsonb_build_object('mid', v_mid, 'rows_confirmed', v_total);
end;
$function$;

-- residual_formula_registry_for_month → residuals
CREATE OR REPLACE FUNCTION public.residual_formula_registry_for_month(p_processor text, p_month date)
 RETURNS TABLE(id uuid, label text, effective_from date, effective_to date)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to read the formula registry.'
      using errcode = '42501';
  end if;

  -- Zero rows is a real answer — this payer has no rules for that month — and
  -- is not an error. The EXCLUDE on the registry table means at most one can
  -- match, so this cannot silently pick one of several.
  return query
  select g.id, g.label, g.effective_from, g.effective_to
    from public.residual_formula_registries g
   where g.deleted_at is null
     and g.processor = upper(btrim(coalesce(p_processor, '')))
     and g.effective_from <= p_month
     and (g.effective_to is null or g.effective_to > p_month);
end;
$function$;

-- residual_grid_rows → residuals
CREATE OR REPLACE FUNCTION public.residual_grid_rows(p_period_id uuid, p_mid text DEFAULT NULL::text, p_processor text DEFAULT NULL::text)
 RETURNS TABLE(scope text, row_id uuid, mid text, merchant_name text, fee_category text, fee_item_name text, group_key text, is_group_member boolean, is_group_anchor boolean, item_count text, amount text, buy_rate_per_item text, agent_income text, agent_expense text, net_revenue text, total_income text, total_buy_rate text, tapdash_net_before_split text, tapdash_net_after_split text, additional_income_direct text, net_income text, is_computed boolean, volume_buckets text[], verdicts jsonb, source text, sort_order integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_registry uuid;
  v_mid      text := nullif(regexp_replace(coalesce(p_mid, ''), '[^0-9]', '', 'g'), '');
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to read the residual grid.'
      using errcode = '42501';
  end if;

  select c.registry_id into v_registry
    from public.residual_period_context(p_period_id, p_processor) c;

  return query
  with
  -- ONE evaluation of the verdict layer, folded to one object per subject.
  -- jsonb_object_agg over an empty group cannot happen here (the group only
  -- exists because a row was returned), but the LEFT JOIN below can miss
  -- entirely, which is what coalesce('{}') covers.
  v as (
    select w.scope_id,
           jsonb_object_agg(
             w.step::text,
             jsonb_build_object(
               'verdict',    w.verdict,
               'delta',      w.delta::text,
               'left',       w.left_value::text,
               'right',      w.right_value::text,
               'tolerance',  w.tolerance_applied::text,
               'ack_id',     w.ack_id,
               'suppressed', w.suppressed
             )
           ) as obj
      from public.residual_verdicts(p_period_id, p_mid, p_processor) w
     group by w.scope_id
  ),
  -- The registry's shape, once.
  rules as (
    select ru.fee_item_name as fin, ru.group_key as gkey,
           ru.is_group_anchor as anchor, ru.sort_order as so
      from public.residual_formula_rules ru
     where ru.registry_id = v_registry and ru.deleted_at is null
  ),
  -- Which buckets a row's Amount is compared against, for the chip the grid
  -- puts in the Amount cell. NULL means the row carries no volume.
  maps as (
    select ru.fee_item_name as fin,
           array_agg(distinct m.volume_bucket order by m.volume_bucket) as bks
      from public.residual_volume_row_mappings m
      join public.residual_formula_rules ru on ru.id = m.rule_id
     where m.deleted_at is null and ru.deleted_at is null
       and ru.registry_id = v_registry
     group by ru.fee_item_name
  )
  select 'line'::text,
         l.id,
         l.mid,
         l.merchant_name,
         l.fee_category,
         l.fee_item_name,
         r.gkey,
         (r.gkey is not null),
         coalesce(r.anchor, false),
         l.item_count::text,
         l.amount::text,
         l.buy_rate_per_item::text,
         l.agent_income::text,
         l.agent_expense::text,
         l.net_revenue::text,
         l.total_income::text,
         l.total_buy_rate::text,
         l.tapdash_net_before_split::text,
         l.tapdash_net_after_split::text,
         l.additional_income_direct::text,
         l.net_income::text,
         (l.net_income is not null),
         mp.bks,
         coalesce(v.obj, '{}'::jsonb),
         l.source,
         -- An unmatched fee item sorts last rather than vanishing: it is the
         -- row that most needs looking at, and the engine has already refused
         -- to price it.
         coalesce(r.so, 999999)
    from public.residual_lines l
    left join rules r  on r.fin = l.fee_item_name
    left join maps  mp on mp.fin = l.fee_item_name
    left join v        on v.scope_id = l.id
   where l.period_id = p_period_id
     and l.deleted_at is null
     and (v_mid is null or l.mid = v_mid)

  union all

  -- The group summary row. fee_item_name is NULL because a group is not a fee
  -- item; the grid renders its group_key. It sorts with its ANCHOR so it lands
  -- directly beneath the members it summarises.
  select 'group'::text,
         g.id,
         g.mid,
         null,
         null,
         null,
         g.group_key,
         false,
         false,
         null,
         null,
         null,
         null,
         null,
         g.stated_net_revenue::text,
         g.total_income::text,
         g.total_buy_rate::text,
         g.tapdash_net_before_split::text,
         g.tapdash_net_after_split::text,
         g.additional_income_direct::text,
         g.net_income::text,
         (g.net_income is not null),
         null,
         coalesce(v.obj, '{}'::jsonb),
         'engine'::text,
         coalesce((select max(r2.so) from rules r2 where r2.gkey = g.group_key), 999998)
    from public.residual_line_groups g
    left join v on v.scope_id = g.id
   where g.period_id = p_period_id
     and g.deleted_at is null
     and (v_mid is null or g.mid = v_mid)

   order by 3, 26, 6 nulls last;
end;
$function$;

-- residual_insert_manual_line → residuals
CREATE OR REPLACE FUNCTION public.residual_insert_manual_line(p_period_id uuid, p_values jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor   uuid := auth.uid();
  v_allowed text[] := array[
    'mid','merchant_name','fee_category','fee_item_name',
    'item_count','amount','buy_rate_per_item',
    'agent_income','agent_expense','net_revenue'
  ];
  v_unknown text[];
  v_mid     text;
  v_id      uuid;
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to add a residual line.'
      using errcode = '42501';
  end if;

  if v_actor is null then
    raise exception 'Adding a line by hand requires an identified actor.'
      using errcode = '42501',
            hint = 'This function cannot be called on a service-role connection.';
  end if;

  select array_agg(k) into v_unknown
    from jsonb_object_keys(coalesce(p_values, '{}'::jsonb)) k
   where k <> all(v_allowed);

  if v_unknown is not null then
    raise exception
      'residual_insert_manual_line: % is not a settable column.',
      array_to_string(v_unknown, ', ')
      using errcode = '22023',
            hint = 'Only statement data can be entered by hand. The engine''s six computed columns are never writable.';
  end if;

  v_mid := regexp_replace(coalesce(p_values->>'mid', ''), '[^0-9]', '', 'g');
  if v_mid = '' then
    raise exception 'A line needs a MID.'
      using errcode = '22004';
  end if;

  insert into public.residual_lines
    (period_id, import_id, mid, merchant_name, fee_category, fee_item_name,
     item_count, amount, buy_rate_per_item,
     agent_income, agent_expense, net_revenue,
     source, created_by_id, updated_by_id)
  values
    (p_period_id, null, v_mid,
     p_values->>'merchant_name',
     p_values->>'fee_category',
     p_values->>'fee_item_name',
     (p_values->>'item_count')::numeric,
     (p_values->>'amount')::numeric,
     (p_values->>'buy_rate_per_item')::numeric,
     (p_values->>'agent_income')::numeric,
     (p_values->>'agent_expense')::numeric,
     (p_values->>'net_revenue')::numeric,
     'manual', v_actor, v_actor)
  returning id into v_id;

  return v_id;
end;
$function$;

-- residual_link_mid_to_record → residuals
CREATE OR REPLACE FUNCTION public.residual_link_mid_to_record(p_mid text, p_record_id uuid, p_period_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor   uuid := auth.uid();
  v_mid     text := regexp_replace(coalesce(p_mid,''),'[^0-9]','','g');
  v_lines   integer;
  v_volumes integer;
  v_plans   integer;
begin
  if not auth_admin_page('residuals') then
    raise exception 'Not authorized to link a residual MID.' using errcode = '42501';
  end if;

  if v_mid = '' then
    raise exception 'p_mid has no digits.' using errcode = '22023';
  end if;

  if not exists (select 1 from public.records r where r.id = p_record_id and r.deleted_at is null) then
    raise exception 'Merchant record % is not a live record.', p_record_id using errcode = '22023';
  end if;

  update public.residual_lines rl
     set record_id = p_record_id, thread_match = 'manual',
         thread_matched_at = now(), thread_confirmed_by_id = v_actor
   where rl.deleted_at is null
     and regexp_replace(coalesce(rl.mid,''),'[^0-9]','','g') = v_mid
     and (p_period_id is null or rl.period_id = p_period_id);
  get diagnostics v_lines = row_count;

  update public.residual_merchant_volumes rv
     set record_id = p_record_id, thread_match = 'manual',
         thread_matched_at = now(), thread_confirmed_by_id = v_actor
   where rv.deleted_at is null
     and regexp_replace(coalesce(rv.mid,''),'[^0-9]','','g') = v_mid
     and (p_period_id is null or rv.period_id = p_period_id);
  get diagnostics v_volumes = row_count;

  update public.residual_plan_volumes pv
     set record_id = p_record_id, thread_match = 'manual',
         thread_matched_at = now(), thread_confirmed_by_id = v_actor
   where pv.deleted_at is null
     and regexp_replace(coalesce(pv.mid,''),'[^0-9]','','g') = v_mid
     and (p_period_id is null or pv.period_id = p_period_id);
  get diagnostics v_plans = row_count;

  return jsonb_build_object(
    'mid', v_mid, 'record_id', p_record_id,
    'lines_linked', v_lines, 'volumes_linked', v_volumes, 'plans_linked', v_plans
  );
end;
$function$;

-- residual_link_worklist → residuals
CREATE OR REPLACE FUNCTION public.residual_link_worklist(p_period_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(mid text, line_rows integer, volume_rows integer, plan_rows integer, match_kind text, candidate_count integer, candidates jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
begin
  if not auth_admin_page('residuals') then
    raise exception 'Not authorized to read the residual link worklist.'
      using errcode = '42501';
  end if;

  return query
  with unlinked as (
    select regexp_replace(coalesce(rl.mid,''),'[^0-9]','','g') as n_mid,
           1 as l, 0 as v, 0 as p
      from public.residual_lines rl
     where rl.deleted_at is null
       and rl.record_id is null
       and (p_period_id is null or rl.period_id = p_period_id)
    union all
    select regexp_replace(coalesce(rv.mid,''),'[^0-9]','','g'), 0, 1, 0
      from public.residual_merchant_volumes rv
     where rv.deleted_at is null
       and rv.record_id is null
       and (p_period_id is null or rv.period_id = p_period_id)
    union all
    select regexp_replace(coalesce(pv.mid,''),'[^0-9]','','g'), 0, 0, 1
      from public.residual_plan_volumes pv
     where pv.deleted_at is null
       and pv.record_id is null
       and (p_period_id is null or pv.period_id = p_period_id)
  ),
  grouped as (
    select u.n_mid,
           sum(u.l)::integer as l,
           sum(u.v)::integer as v,
           sum(u.p)::integer as p
      from unlinked u
     where u.n_mid <> ''
     group by u.n_mid
  )
  select
    g.n_mid,
    g.l,
    g.v,
    g.p,
    x.match_kind,
    x.candidate_count,
    coalesce((
      select jsonb_agg(jsonb_build_object(
               'record_id', c.record_id,
               'mid',       c.mid,
               'deal_name', c.deal_name))
        from public.find_live_records_by_mid_suffix(g.n_mid) c
    ), '[]'::jsonb)
  from grouped g
  cross join lateral public.residual_resolve_mid(g.n_mid) x
  order by (g.l + g.v + g.p) desc, g.n_mid;
end;
$function$;

-- residual_merchant_directory → residuals
CREATE OR REPLACE FUNCTION public.residual_merchant_directory(p_period_id uuid)
 RETURNS TABLE(mid text, merchant_name text, name_variants text[], record_id uuid, thread_match text, line_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to read the residual merchant directory.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.residual_periods p
     where p.id = p_period_id and p.deleted_at is null
  ) then
    raise exception 'No live residual period with id %.', p_period_id
      using errcode = 'P0002';
  end if;

  return query
    with per_name as (
      select l.mid                                as m,
             nullif(btrim(l.merchant_name), '')    as nm,
             count(*)                              as n
        from public.residual_lines l
       where l.period_id = p_period_id
         and l.deleted_at is null
       group by l.mid, nullif(btrim(l.merchant_name), '')
    ),
    totals as (
      -- `sum()` over bigint returns numeric, and the declared column is
      -- bigint — without the cast Postgres refuses the whole function with
      -- "structure of query does not match function result type".
      select m, sum(n)::bigint as lines
        from per_name
       group by m
    ),
    -- The most frequent non-null name, and the tie broken alphabetically so
    -- the label does not change between two identical reads.
    label as (
      select distinct on (m) m, nm
        from per_name
       where nm is not null
       order by m, n desc, nm
    ),
    variants as (
      select m, array_agg(distinct nm order by nm) as names
        from per_name
       where nm is not null
       group by m
      having count(distinct nm) > 1
    ),
    -- The link, taken from the lines themselves. One MID's lines all carry the
    -- same record_id — the linking RPCs set them together — so max() here is
    -- a reduction over equal values rather than a choice between different
    -- ones, unlike the name above.
    linked as (
      select l.mid as m,
             max(l.record_id::text)::uuid as rec,
             max(l.thread_match)          as tm
        from public.residual_lines l
       where l.period_id = p_period_id
         and l.deleted_at is null
       group by l.mid
    )
    select t.m,
           lb.nm,
           coalesce(v.names, '{}'::text[]),
           lk.rec,
           lk.tm,
           t.lines
      from totals t
      left join label    lb on lb.m = t.m
      left join variants v  on v.m  = t.m
      left join linked   lk on lk.m = t.m
     order by t.m;
end;
$function$;

-- residual_merchant_rate_coverage → residuals
CREATE OR REPLACE FUNCTION public.residual_merchant_rate_coverage(p_period_id uuid)
 RETURNS TABLE(mid text, in_statements boolean, has_rates boolean, risk_tier text, line_rows integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_month date;
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
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
$function$;

-- residual_merchant_rate_editor → residuals
CREATE OR REPLACE FUNCTION public.residual_merchant_rate_editor(p_mid text, p_period_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_mid      text := regexp_replace(coalesce(p_mid, ''), '[^0-9]', '', 'g');
  v_period   record;
  v_standing public.residual_merchant_rates%rowtype;
  v_locked   boolean := false;
  v_versions int := 0;
  v_lines    int := 0;
  v_merchfail jsonb;
  v_fields   jsonb;
  v_month    date;
  v_vendor   jsonb := '{}'::jsonb;
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to read merchant rates.'
      using errcode = '42501';
  end if;

  if v_mid = '' then
    raise exception 'residual_merchant_rate_editor: p_mid must contain digits.'
      using errcode = '22004';
  end if;

  select p.id, p.statement_month, p.status, p.calculation_version
    into v_period
    from public.residual_periods p
   where p.deleted_at is null
     and (p_period_id is null or p.id = p_period_id)
   order by p.statement_month desc
   limit 1;

  select * into v_standing
    from public.residual_merchant_rates r
   where r.mid = v_mid and r.deleted_at is null and r.effective_to is null;

  if v_standing.id is not null then
    v_locked := public.residual_merchant_rate_is_locked(
      v_standing.mid, v_standing.effective_from, v_standing.effective_to);
  end if;

  select count(*)::int into v_versions
    from public.residual_merchant_rates r
   where r.mid = v_mid and r.deleted_at is null;

  if v_period.id is not null then
    select count(*)::int into v_lines
      from public.residual_lines l
     where l.period_id = v_period.id and l.deleted_at is null
       and regexp_replace(l.mid, '[^0-9]', '', 'g') = v_mid;

    select to_jsonb(f) - 'id' - 'created_by_id' into v_merchfail
      from public.residual_calc_failures f
     where f.period_id = v_period.id and f.mid = v_mid and f.scope = 'merchant'
     limit 1;

    select jsonb_object_agg(g.rate_ref, g.obj) into v_fields
      from (
        select f.rate_ref,
               jsonb_build_object(
                 'n',           count(*)::int,
                 'reason_code', min(f.reason_code),
                 'detail',      min(f.detail),
                 'fee_items',   jsonb_agg(distinct f.fee_item_name)
               ) as obj
          from public.residual_calc_failures f
         where f.period_id = v_period.id
           and f.mid = v_mid
           and f.rate_ref is not null
           and f.reason_code = 'missing_merchant_rate'
         group by f.rate_ref
      ) g;
  end if;

  -- ---- the vendor cards this merchant's typed providers resolve to ----
  v_month := coalesce(v_period.statement_month, date_trunc('month', current_date)::date);

  if v_standing.id is not null then
    select jsonb_object_agg(role, obj) into v_vendor
      from (
        select r.role,
               jsonb_build_object(
                 'typed',    r.typed,
                 'resolved', public.residual_vendor_provider_key(r.typed),
                 'matched',  (select max(c.matched_processor)
                                from public.residual_vendor_card_lookup(r.typed, v_month) c),
                 -- slot -> rate, only for items that fill one AND are priced.
                 'slots',    coalesce((
                                select jsonb_object_agg(c.vendor_cost_slot, c.rate)
                                  from public.residual_vendor_card_lookup(r.typed, v_month) c
                                 where c.vendor_cost_slot is not null and c.rate is not null), '{}'::jsonb),
                 -- the rest, named, so the screen can say they exist.
                 'unslotted', coalesce((
                                select jsonb_agg(c.fee_item_label order by c.fee_item_label)
                                  from public.residual_vendor_card_lookup(r.typed, v_month) c
                                 where c.vendor_cost_slot is null), '[]'::jsonb)
               ) as obj
          from (values
                 ('gateway',  v_standing.gateway_provider_mav),
                 ('terminal', v_standing.terminal_provider_mav)
               ) as r(role, typed)
         where r.typed is not null
      ) r;
  end if;

  return jsonb_build_object(
    'mid', v_mid,
    'period', case when v_period.id is null then null else jsonb_build_object(
        'id', v_period.id,
        'statement_month', to_char(v_period.statement_month, 'YYYY-MM-DD'),
        'status', v_period.status,
        'calculation_version', v_period.calculation_version) end,
    'line_count', v_lines,
    'version_count', v_versions,
    'standing', case when v_standing.id is null then null
                     else (to_jsonb(v_standing)
                           - 'created_by_id' - 'updated_by_id'
                           - 'deleted_at' - 'deleted_by_id') end,
    'is_locked', v_locked,
    'merchant_failure', v_merchfail,
    'field_failures', coalesce(v_fields, '{}'::jsonb),
    'vendor', coalesce(v_vendor, '{}'::jsonb),
    -- Every provider with a card in force, for suggestion only. The field stays
    -- free text: UsaEpay, IposPays and Valor have no card and must remain
    -- typeable.
    'vendor_providers', coalesce((
      select jsonb_agg(s.processor order by s.processor)
        from public.residual_buy_rate_schedules s
        join public.residual_buy_rate_tiers t
          on t.schedule_id = s.id and t.deleted_at is null
        join public.residual_risk_tiers rt
          on rt.tier_key = t.risk_tier and rt.deleted_at is null and rt.is_risk_tier = false
       where s.deleted_at is null
         and s.effective_from <= v_month
         and (s.effective_to is null or s.effective_to > v_month)), '[]'::jsonb)
  );
end;
$function$;

-- residual_merchant_rate_versions → residuals
CREATE OR REPLACE FUNCTION public.residual_merchant_rate_versions(p_mid text)
 RETURNS TABLE(id uuid, effective_from date, effective_to date, is_standing boolean, is_locked boolean, risk_tier text, vmd_auth_fee numeric, pin_debit_auth_fee numeric, avs_fee numeric, batch_fee numeric, vmd_transaction_fee numeric, amex_volume numeric, vmd_volume numeric, pin_debit_volume numeric, amex_template_volume_fee numeric, gateway_provider_mav text, gateway_monthly_mav numeric, terminal_provider_mav text, terminal_monthly_mav numeric, monthly_fee_tapdash numeric, monthly_fee_maverick numeric, chargeback_fee numeric, notes text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_mid text := regexp_replace(coalesce(p_mid, ''), '[^0-9]', '', 'g');
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to read merchant rates.'
      using errcode = '42501';
  end if;

  return query
    select r.id, r.effective_from, r.effective_to,
           r.effective_to is null,
           public.residual_merchant_rate_is_locked(r.mid, r.effective_from, r.effective_to),
           r.risk_tier,
           r.vmd_auth_fee, r.pin_debit_auth_fee, r.avs_fee, r.batch_fee,
           r.vmd_transaction_fee, r.amex_volume, r.vmd_volume,
           r.pin_debit_volume, r.amex_template_volume_fee,
           r.gateway_provider_mav, r.gateway_monthly_mav,
           r.terminal_provider_mav, r.terminal_monthly_mav,
           r.monthly_fee_tapdash, r.monthly_fee_maverick, r.chargeback_fee,
           r.notes, r.created_at
      from public.residual_merchant_rates r
     where r.deleted_at is null
       and r.mid = v_mid
     order by r.effective_from desc;
end;
$function$;

-- residual_merchant_rates_for_month → residuals
CREATE OR REPLACE FUNCTION public.residual_merchant_rates_for_month(p_mid text, p_month date)
 RETURNS TABLE(mid text, risk_tier text, effective_from date, effective_to date, vmd_auth_fee numeric, pin_debit_auth_fee numeric, avs_fee numeric, batch_fee numeric, vmd_transaction_fee numeric, amex_volume numeric, vmd_volume numeric, pin_debit_volume numeric, amex_template_volume_fee numeric, gateway_monthly_mav numeric, terminal_monthly_mav numeric, monthly_fee_tapdash numeric, monthly_fee_maverick numeric, chargeback_fee numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_mid   text := regexp_replace(coalesce(p_mid, ''), '[^0-9]', '', 'g');
  v_month date := date_trunc('month', p_month)::date;
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
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
$function$;

-- residual_merchant_states → residuals
CREATE OR REPLACE FUNCTION public.residual_merchant_states(p_period_id uuid, p_processor text DEFAULT NULL::text)
 RETURNS TABLE(mid text, state text, blocked_count bigint, skipped_whole bigint, blocked_lines bigint, awaiting_reason text, mismatch_count bigint, suppressed_count bigint, line_count bigint, uncomputed_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_signed boolean;
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to read residual merchant states.'
      using errcode = '42501';
  end if;

  select (p.status = 'reconciled') into v_signed
    from public.residual_periods p
   where p.id = p_period_id and p.deleted_at is null;

  if v_signed is null then
    raise exception 'No live residual period with id %.', p_period_id
      using errcode = 'P0002';
  end if;

  return query
  with mids as (
    select distinct l.mid as m
      from public.residual_lines l
     where l.period_id = p_period_id and l.deleted_at is null
  ),
  counts as (
    select l.mid as m,
           count(*) as n_lines,
           count(*) filter (where l.net_income is null) as n_uncomputed
      from public.residual_lines l
     where l.period_id = p_period_id and l.deleted_at is null
     group by l.mid
  ),
  fails as (
    select f.mid as m,
           count(*) filter (where f.reason_code <> 'no_volumes')                        as n_blocked,
           count(*) filter (where f.reason_code <> 'no_volumes' and f.scope =  'merchant') as n_whole,
           count(*) filter (where f.reason_code <> 'no_volumes' and f.scope <> 'merchant') as n_lineblk,
           count(*) filter (where f.reason_code =  'no_volumes')                        as n_novol
      from public.residual_calc_failures f
     where f.period_id = p_period_id
     group by f.mid
  ),
  volgap as (
    select l.mid as m,
           bool_or(v.mid is null) as no_row,
           bool_or(v.mid is not null and (
             case m2.volume_bucket
               when 'amex_volume'  then v.amex_volume
               when 'vmd_volume'   then v.vmd_volume
               when 'debit_volume' then v.debit_volume
               when 'ebt_volume'   then v.ebt_volume
             end is null)) as null_bucket
      from public.residual_lines l
      join public.residual_formula_rules ru
        on ru.fee_item_name = l.fee_item_name and ru.deleted_at is null
      join public.residual_volume_row_mappings m2
        on m2.rule_id = ru.id and m2.deleted_at is null
      left join public.residual_merchant_volumes v
        on v.period_id = p_period_id and v.mid = l.mid and v.deleted_at is null
     where l.period_id = p_period_id and l.deleted_at is null
     group by l.mid
  ),
  verd as (
    select w.mid as m,
           count(*) filter (where w.verdict = 'mismatch' and not w.suppressed) as n_mismatch,
           count(*) filter (where w.verdict = 'mismatch' and     w.suppressed) as n_suppressed
      from public.residual_verdicts(p_period_id, null, p_processor) w
     group by w.mid
  ),
  resolved as (
    select mids.m,
           case
             when coalesce(f.n_blocked, 0) > 0                            then 'blocked'
             when coalesce(f.n_novol, 0) > 0
               or coalesce(vg.no_row, false)
               or coalesce(vg.null_bucket, false)                         then 'awaiting_volumes'
             when coalesce(vd.n_mismatch, 0) > 0                          then 'mismatch'
             when v_signed                                                then 'reconciled'
             else                                                              'ready'
           end as st,
           coalesce(f.n_blocked, 0)  as n_blocked,
           coalesce(f.n_whole, 0)    as n_whole,
           coalesce(f.n_lineblk, 0)  as n_lineblk,
           coalesce(f.n_novol, 0)    as n_novol,
           coalesce(vg.no_row, false)      as no_row,
           coalesce(vg.null_bucket, false) as null_bucket,
           coalesce(vd.n_mismatch, 0)   as n_mismatch,
           coalesce(vd.n_suppressed, 0) as n_suppressed,
           coalesce(c.n_lines, 0)       as n_lines,
           coalesce(c.n_uncomputed, 0)  as n_uncomputed
      from mids
      left join counts c  on c.m  = mids.m
      left join fails  f  on f.m  = mids.m
      left join volgap vg on vg.m = mids.m
      left join verd   vd on vd.m = mids.m
  )
  select r.m,
         r.st,
         r.n_blocked,
         r.n_whole,
         r.n_lineblk,
         -- GATED ON THE RESOLVED STATE. This is fix 1: the reason explains the
         -- state this row is actually in, or it is NULL.
         case when r.st <> 'awaiting_volumes' then null
              when r.n_novol > 0    then 'engine recorded no_volumes'
              when r.no_row         then 'a mapped row has no volume row for this merchant-month'
              when r.null_bucket    then 'a needed volume bucket is NULL on the statement row'
              else null
         end,
         r.n_mismatch,
         r.n_suppressed,
         r.n_lines,
         r.n_uncomputed
    from resolved r
   order by r.st, r.m;
end;
$function$;

-- residual_merchant_vendor_costs_editor → residuals
CREATE OR REPLACE FUNCTION public.residual_merchant_vendor_costs_editor(p_mid text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_mid       text := regexp_replace(coalesce(p_mid, ''), '[^0-9]', '', 'g');
  v_standing  public.residual_merchant_vendor_costs%rowtype;
  v_versions  int := 0;
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to read merchant vendor costs.'
      using errcode = '42501';
  end if;

  if v_mid = '' then
    raise exception 'residual_merchant_vendor_costs_editor: p_mid must contain digits.'
      using errcode = '22004';
  end if;

  -- The STANDING row is the open-ended one. The EXCLUDE makes it unique per
  -- MID, so this is a lookup rather than a choice.
  select * into v_standing
    from public.residual_merchant_vendor_costs c
   where c.mid = v_mid and c.deleted_at is null and c.effective_to is null;

  select count(*)::int into v_versions
    from public.residual_merchant_vendor_costs c
   where c.mid = v_mid and c.deleted_at is null;

  return jsonb_build_object(
    'mid', v_mid,
    'version_count', v_versions,
    'standing', case when v_standing.id is null then null
                     else (to_jsonb(v_standing)
                           - 'created_by_id' - 'updated_by_id'
                           - 'deleted_at' - 'deleted_by_id') end,
    -- THE VENDOR CARDS, SO THE FORM CAN COMPARE RATHER THAN ASSUME.
    -- Every vendor card in force today, as {processor: {fee_item_key: rate}}.
    -- The screen uses it to prefill on provider selection AND to say, per
    -- field, whether the merchant's value still matches the card. That
    -- comparison is DERIVED at read time, never stored — the module's rule for
    -- staleness, and the reason a merchant row cannot quietly drift into
    -- looking negotiated when the card moved underneath it.
    'vendor_cards', coalesce((
      select jsonb_object_agg(x.processor, x.rates)
        from (
          select s.processor,
                 jsonb_object_agg(b.fee_item_key, b.rate) as rates
            from public.residual_buy_rate_schedules s
            join public.residual_buy_rate_tiers t
              on t.schedule_id = s.id and t.deleted_at is null
            join public.residual_risk_tiers rt
              on rt.tier_key = t.risk_tier and rt.deleted_at is null
             and rt.is_risk_tier = false
            join public.residual_buy_rates b
              on b.schedule_id = s.id and b.risk_tier = t.risk_tier
             and b.deleted_at is null and b.rate is not null
           where s.deleted_at is null and s.effective_to is null
           group by s.processor
        ) x), '{}'::jsonb)
  );
end;
$function$;

-- residual_merchant_volume_row → residuals
CREATE OR REPLACE FUNCTION public.residual_merchant_volume_row(p_period_id uuid, p_mid text DEFAULT NULL::text)
 RETURNS TABLE(mid text, has_row boolean, merchant_name text, amex_volume text, vmd_volume text, debit_volume text, ebt_volume text, amex_item_count integer, vmd_item_count integer, debit_item_count integer, ebt_item_count integer, any_bucket_null boolean, source text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_mid text := nullif(regexp_replace(coalesce(p_mid, ''), '[^0-9]', '', 'g'), '');
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to read residual merchant volumes.'
      using errcode = '42501';
  end if;

  -- Driven from the LINES, not from the volume table, so a merchant the month
  -- carries but the statement never covered still returns a row — with
  -- has_row = false. Driving it the other way would return nothing for exactly
  -- the merchant whose missing statement is the thing worth seeing.
  return query
  with mids as (
    select distinct l.mid as m
      from public.residual_lines l
     where l.period_id = p_period_id
       and l.deleted_at is null
       and (v_mid is null or l.mid = v_mid)
  )
  select mids.m,
         (vv.id is not null),
         vv.merchant_name,
         vv.amex_volume::text,
         vv.vmd_volume::text,
         vv.debit_volume::text,
         vv.ebt_volume::text,
         vv.amex_item_count,
         vv.vmd_item_count,
         vv.debit_item_count,
         vv.ebt_item_count,
         (vv.id is not null
          and (vv.amex_volume is null or vv.vmd_volume is null
               or vv.debit_volume is null or vv.ebt_volume is null)),
         vv.source
    from mids
    left join public.residual_merchant_volumes vv
      on vv.period_id = p_period_id and vv.mid = mids.m and vv.deleted_at is null
   order by 1;
end;
$function$;

-- residual_period_context → residuals
CREATE OR REPLACE FUNCTION public.residual_period_context(p_period_id uuid, p_processor text DEFAULT NULL::text)
 RETURNS TABLE(processor text, registry_id uuid, statement_month date)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_month    date;
  v_proc     text;
  v_registry uuid;
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to read residual period context.'
      using errcode = '42501';
  end if;

  select p.statement_month into v_month
    from public.residual_periods p
   where p.id = p_period_id and p.deleted_at is null;

  if v_month is null then
    raise exception 'No live residual period with id %.', p_period_id
      using errcode = 'P0002';
  end if;

  -- Explicit when given; otherwise derived from the period's imports, where
  -- exactly one distinct value is required.
  v_proc := upper(btrim(coalesce(p_processor, '')));
  if v_proc = '' then
    select upper(btrim(i.processor)) into v_proc
      from public.residual_imports i
     where i.period_id = p_period_id
       and i.deleted_at is null
       and i.processor is not null
       and btrim(i.processor) <> ''
     group by upper(btrim(i.processor));

    if not found then
      raise exception
        'Period % names no processor, so no registry or tolerance set applies.',
        to_char(v_month, 'YYYY-MM')
        using errcode = 'P0002',
              hint = 'Import the fee report first, or pass p_processor explicitly.';
    end if;

    if (select count(distinct upper(btrim(i.processor)))
          from public.residual_imports i
         where i.period_id = p_period_id and i.deleted_at is null
           and i.processor is not null and btrim(i.processor) <> '') > 1 then
      raise exception
        'Period % names more than one processor; verdicts are derived per processor.',
        to_char(v_month, 'YYYY-MM')
        using errcode = '22023',
              hint = 'Pass p_processor explicitly, or split the period.';
    end if;
  end if;

  select r.id into v_registry
    from public.residual_formula_registries r
   where r.deleted_at is null
     and r.processor = v_proc
     and r.effective_from <= v_month
     and (r.effective_to is null or r.effective_to > v_month)
   limit 1;

  if v_registry is null then
    raise exception 'No formula registry covers % for processor %.',
      to_char(v_month, 'YYYY-MM'), v_proc
      using errcode = 'P0002';
  end if;

  return query select v_proc, v_registry, v_month;
end;
$function$;

-- residual_period_history → residuals
CREATE OR REPLACE FUNCTION public.residual_period_history(p_period_id uuid, p_limit integer DEFAULT 200)
 RETURNS TABLE(kind text, occurred_at timestamp with time zone, actor_id uuid, detail jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to read residual period history.'
      using errcode = '42501';
  end if;

  return query
  with events as (
    select 'calc_run'::text as k, r.ran_at as at, r.ran_by_id as actor,
           jsonb_build_object(
             'version_attempted', r.version_attempted,
             'stamped',           r.stamped,
             'processor',         r.processor,
             'registry',          r.registry_label,
             'lines_computed',    r.lines_computed,
             'lines_failed',      r.lines_failed,
             'merchants_computed', r.merchants_computed,
             'merchants_failed',  r.merchants_failed,
             'failures_by_reason', r.failures_by_reason
           ) as d
      from public.residual_calc_runs r
     where r.period_id = p_period_id

    union all

    select 'status_transition', s.created_at, s.actor_id,
           jsonb_build_object('from', s.from_status, 'to', s.to_status,
                              'source', s.source, 'note', s.note)
      from public.residual_period_status_log s
     where s.period_id = p_period_id

    union all

    select 'acknowledgment', a.created_at, a.created_by_id,
           jsonb_build_object('event', 'created', 'ack_id', a.id,
                              'scope', a.scope, 'step', a.step,
                              'delta', a.delta_acknowledged::text,
                              'tolerance', a.tolerance_applied::text,
                              'reason', a.reason)
      from public.residual_verdict_acknowledgments a
     where a.period_id = p_period_id and a.deleted_at is null

    union all

    select 'acknowledgment', a.retired_at, a.retired_by_id,
           jsonb_build_object('event', 'retired', 'ack_id', a.id,
                              'scope', a.scope, 'step', a.step,
                              'delta', a.delta_acknowledged::text,
                              'retired_reason', a.retired_reason,
                              'note', a.retired_note)
      from public.residual_verdict_acknowledgments a
     where a.period_id = p_period_id and a.deleted_at is null
       and a.retired_at is not null

    union all

    select 'manual_edit', g.created_at, g.actor_id,
           jsonb_build_object('table', g.table_name, 'record_id', g.record_id,
                              'action', g.action::text,
                              'changed_fields', to_jsonb(g.changed_fields),
                              'before', g.before_data, 'after', g.after_data)
      from public.residual_audit_log g
     where g.table_name in ('residual_lines', 'residual_merchant_volumes')
       and (
         -- The payload carries it (R6b writers), or the row still exists.
         (case when g.after_data->>'period_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
               then (g.after_data->>'period_id')::uuid end) = p_period_id
         or exists (select 1 from public.residual_lines l
                     where l.id = g.record_id and l.period_id = p_period_id)
         or exists (select 1 from public.residual_merchant_volumes vv
                     where vv.id = g.record_id and vv.period_id = p_period_id)
       )
  )
  select e.k, e.at, e.actor, e.d
    from events e
   order by e.at desc
   limit greatest(coalesce(p_limit, 200), 1);
end;
$function$;

-- residual_period_state → residuals
CREATE OR REPLACE FUNCTION public.residual_period_state(p_period_id uuid, p_processor text DEFAULT NULL::text)
 RETURNS TABLE(derived_status text, stored_status text, merchant_count bigint, blocked bigint, awaiting_volumes bigint, mismatch bigint, ready bigint, reconciled bigint, signable boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_stored text;
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to read residual period state.'
      using errcode = '42501';
  end if;

  select p.status into v_stored
    from public.residual_periods p
   where p.id = p_period_id and p.deleted_at is null;

  if v_stored is null then
    raise exception 'No live residual period with id %.', p_period_id
      using errcode = 'P0002';
  end if;

  return query
  with s as (
    select * from public.residual_merchant_states(p_period_id, p_processor)
  ),
  agg as (
    select count(*)                                          as n,
           count(*) filter (where s.state = 'blocked')          as n_blocked,
           count(*) filter (where s.state = 'awaiting_volumes') as n_await,
           count(*) filter (where s.state = 'mismatch')         as n_mismatch,
           count(*) filter (where s.state = 'ready')            as n_ready,
           count(*) filter (where s.state = 'reconciled')       as n_recon
      from s
  )
  select case
           when agg.n = 0            then 'open'
           when agg.n_blocked  > 0   then 'open'
           when agg.n_await    > 0   then 'awaiting_volumes'
           when agg.n_mismatch > 0   then 'mismatch'
           when v_stored = 'reconciled' then 'reconciled'
           else                           'ready'
         end,
         v_stored,
         agg.n, agg.n_blocked, agg.n_await, agg.n_mismatch, agg.n_ready, agg.n_recon,
         -- SIGNABLE: at least one merchant, and every one of them clean. The
         -- "at least one" clause is not pedantry — without it an empty period
         -- is vacuously signable, and signing an empty month freezes it against
         -- the import that was about to arrive.
         (agg.n > 0 and agg.n = agg.n_ready + agg.n_recon)
    from agg;
end;
$function$;

-- residual_preview_merchant_rates_import → residuals
CREATE OR REPLACE FUNCTION public.residual_preview_merchant_rates_import(p_effective_from date, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_res    jsonb;
  v_locked jsonb;
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to preview a merchant rate import.'
      using errcode = '42501';
  end if;

  -- Which merchants in this file would have a LOCKED standing version closed
  -- by the import. Computed BEFORE the dry run, on committed state, so it
  -- reports what an operator would be doing rather than what the discarded
  -- subtransaction did.
  --
  -- Closing a locked version is LEGAL — that is how a used merchant is
  -- repriced, and the guard trigger deliberately leaves effective_to alone.
  -- It is surfaced because it is consequential, not because it is forbidden:
  -- superseding a version that a signed-off month depends on changes what
  -- future recomputes of LATER months will read.
  select coalesce(jsonb_agg(jsonb_build_object(
           'mid', r.mid,
           'effective_from', r.effective_from,
           'effective_to', r.effective_to)), '[]'::jsonb)
    into v_locked
    from public.residual_merchant_rates r
   where r.deleted_at is null
     and r.mid in (
       select regexp_replace(coalesce(e->>'mid',''), '[^0-9]', '', 'g')
         from jsonb_array_elements(p_rows) e
     )
     and (r.effective_to is null or r.effective_to > p_effective_from)
     and public.residual_merchant_rate_is_locked(r.mid, r.effective_from, r.effective_to);

  -- ---------- the dry run ----------
  begin
    v_res := public.commit_residual_merchant_rates_import(
      null::uuid, p_effective_from, p_rows);

    -- Discard the writes. v_res survives: plpgsql variables are not rolled
    -- back with the subtransaction.
    raise exception 'residual_preview_rollback'
      using errcode = 'ZZ001';
  exception
    when sqlstate 'ZZ001' then
      null;  -- expected; the rows are gone and v_res is intact
    -- Anything else is a genuine validation failure and belongs to the
    -- caller, with its own errcode, message and hint preserved.
  end;

  return v_res || jsonb_build_object('locked_versions', v_locked, 'dry_run', true);
end;
$function$;

-- residual_preview_mid_link → residuals
CREATE OR REPLACE FUNCTION public.residual_preview_mid_link(p_mid text, p_period_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_mid text := regexp_replace(coalesce(p_mid,''),'[^0-9]','','g');
  v_l   integer;
  v_v   integer;
  v_p   integer;
  v_res record;
begin
  if not auth_admin_page('residuals') then
    raise exception 'Not authorized to preview a residual link.'
      using errcode = '42501';
  end if;

  if v_mid = '' then
    raise exception 'p_mid has no digits.' using errcode = '22023';
  end if;

  select count(*)::integer into v_l from public.residual_lines rl
   where rl.deleted_at is null
     and regexp_replace(coalesce(rl.mid,''),'[^0-9]','','g') = v_mid
     and (p_period_id is null or rl.period_id = p_period_id);

  select count(*)::integer into v_v from public.residual_merchant_volumes rv
   where rv.deleted_at is null
     and regexp_replace(coalesce(rv.mid,''),'[^0-9]','','g') = v_mid
     and (p_period_id is null or rv.period_id = p_period_id);

  select count(*)::integer into v_p from public.residual_plan_volumes pv
   where pv.deleted_at is null
     and regexp_replace(coalesce(pv.mid,''),'[^0-9]','','g') = v_mid
     and (p_period_id is null or pv.period_id = p_period_id);

  select * into v_res from public.residual_resolve_mid(v_mid);

  return jsonb_build_object(
    'mid',             v_mid,
    'lines',           v_l,
    'volumes',         v_v,
    'plans',           v_p,
    'match_kind',      v_res.match_kind,
    'record_id',       v_res.record_id,
    'candidate_count', v_res.candidate_count
  );
end;
$function$;

-- residual_reference_coverage → residuals
CREATE OR REPLACE FUNCTION public.residual_reference_coverage(p_period_id uuid)
 RETURNS TABLE(mid text, in_statements boolean, has_vendor_costs boolean, has_partner boolean, merchant_record_id uuid, merchant_match text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_month date;
  v_mids  text[];
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to read residual reference coverage.'
      using errcode = '42501';
  end if;

  select p.statement_month into v_month
    from public.residual_periods p
   where p.id = p_period_id
     and p.deleted_at is null;

  if v_month is null then
    raise exception 'No live residual period with id %.', p_period_id
      using errcode = 'P0002';
  end if;

  -- Collected into an ARRAY rather than a temp table on purpose: this function
  -- is STABLE, and PostgreSQL rejects an INSERT (temp table or not) inside a
  -- non-volatile function. Aggregating once into a variable also keeps the
  -- three-way UNION written exactly once — a second copy for a row count would
  -- be a predicate that can drift out of step with the one that produces the
  -- rows, which is the failure this file avoids everywhere else.
  select coalesce(array_agg(distinct m.mid), '{}'::text[])
    into v_mids
    from (
      select regexp_replace(l.mid, '[^0-9]', '', 'g') as mid
        from public.residual_lines l
       where l.period_id = p_period_id
         and l.deleted_at is null
      union
      select v.mid
        from public.residual_merchant_vendor_costs v
       where v.deleted_at is null
         and v.effective_from <= v_month
         and (v.effective_to is null or v.effective_to > v_month)
      union
      select mp.mid
        from public.residual_mid_partners mp
       where mp.deleted_at is null
         and mp.effective_from <= v_month
         and (mp.effective_to is null or mp.effective_to > v_month)
    ) m
   where m.mid <> '';

  -- Nothing to check is not the same as nothing wrong — the 9b rule.
  if cardinality(v_mids) = 0 then
    return query select null::text, false, false, false, null::uuid, null::text;
    return;
  end if;

  return query
    select a.mid,
           exists (
             select 1 from public.residual_lines l
              where l.period_id = p_period_id
                and l.deleted_at is null
                and regexp_replace(l.mid, '[^0-9]', '', 'g') = a.mid
           ),
           exists (
             select 1 from public.residual_merchant_vendor_costs v
              where v.deleted_at is null
                and v.mid = a.mid
                and v.effective_from <= v_month
                and (v.effective_to is null or v.effective_to > v_month)
           ),
           exists (
             select 1 from public.residual_mid_partners mp
              where mp.deleted_at is null
                and mp.mid = a.mid
                and mp.effective_from <= v_month
                and (mp.effective_to is null or mp.effective_to > v_month)
           ),
           r.record_id,
           r.match_kind
      from unnest(v_mids) as a(mid)
      left join lateral public.residual_resolve_mid(a.mid) r on true
     order by a.mid;
end;
$function$;

-- residual_reopen_period → residuals
CREATE OR REPLACE FUNCTION public.residual_reopen_period(p_period_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor  uuid := auth.uid();
  v_status text;
  v_month  date;
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to reopen a residual period.'
      using errcode = '42501';
  end if;

  if v_actor is null then
    raise exception 'Reopening a period requires an identified actor.'
      using errcode = '42501';
  end if;

  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Reopening a signed-off month requires a reason.'
      using errcode = '22004';
  end if;

  select p.status, p.statement_month into v_status, v_month
    from public.residual_periods p
   where p.id = p_period_id and p.deleted_at is null;

  if v_month is null then
    raise exception 'No live residual period with id %.', p_period_id
      using errcode = 'P0002';
  end if;

  if v_status <> 'reconciled' then
    raise exception 'Statement month % is not signed off.',
      to_char(v_month, 'YYYY-MM')
      using errcode = '22023';
  end if;

  perform set_config('residuals.status_transition',
                     p_period_id::text || ':open', true);
  perform set_config('residuals.status_source', 'reopen', true);
  perform set_config('residuals.status_note', btrim(p_reason), true);

  update public.residual_periods
     set status = 'open',
         updated_by_id = v_actor
   where id = p_period_id;

  perform set_config('residuals.status_transition', '', true);
  perform set_config('residuals.status_source', '', true);
  perform set_config('residuals.status_note', '', true);

  return jsonb_build_object(
    'period_id',       p_period_id,
    'statement_month', to_char(v_month, 'YYYY-MM-DD'),
    'status',          'open',
    'acks_kept',       (select count(*)
                          from public.residual_verdict_acknowledgments a
                         where a.period_id = p_period_id
                           and a.retired_at is null
                           and a.deleted_at is null)
  );
end;
$function$;

-- residual_retire_resolved_acks → residuals
CREATE OR REPLACE FUNCTION public.residual_retire_resolved_acks(p_period_id uuid, p_processor text DEFAULT NULL::text)
 RETURNS TABLE(resolved integer, superseded integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_status text;
  v_res    int := 0;
  v_sup    int := 0;
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to retire residual acknowledgments.'
      using errcode = '42501';
  end if;

  select p.status into v_status
    from public.residual_periods p
   where p.id = p_period_id and p.deleted_at is null;

  if v_status is null then
    raise exception 'No live residual period with id %.', p_period_id
      using errcode = 'P0002';
  end if;

  -- A signed month's verdicts are constant, so there is nothing to retire. Not
  -- an error — a caller sweeping every period should not have to special-case
  -- the signed ones.
  if v_status = 'reconciled' then
    return query select 0, 0;
    return;
  end if;

  -- ONE STATEMENT, ONE SNAPSHOT, AND NO TEMP TABLE.
  --
  -- Both reasons are decided from a single evaluation of residual_verdicts.
  -- Two statements — one per reason — could see two different states if
  -- anything moved between them and would retire as 'resolved' an ack the
  -- second pass considered 'superseded', or retire nothing twice.
  --
  -- The obvious way to share one evaluation is a temp table, and it is
  -- deliberately not used: this function is SECURITY DEFINER with
  -- search_path = public, and pg_temp is searched ahead of an explicit
  -- search_path whether or not it is listed. An unqualified reference to a
  -- temp table inside a definer function is the classic shadowing hazard, and
  -- a CTE has the same sharing property with none of it.
  with v as (
    select w.scope_id, w.step, w.verdict, w.delta, w.tolerance_applied as tol
      from public.residual_verdicts(p_period_id, null, p_processor) w
  ),
  tgt as (
    select a.id,
           case
             -- resolved: no verdict row at all (the line was recomputed to
             -- NULL, soft-deleted, or its fee item stopped being comparable),
             -- or one that no longer fails.
             when not exists (
               select 1 from v
                where v.scope_id = coalesce(a.line_id, a.group_id)
                  and v.step = a.step
                  and v.verdict = 'mismatch')
             then 'resolved'
             -- superseded: still failing, but not at the delta forgiven.
             when exists (
               select 1 from v
                where v.scope_id = coalesce(a.line_id, a.group_id)
                  and v.step = a.step
                  and v.verdict = 'mismatch'
                  and abs(v.delta - a.delta_acknowledged) > v.tol)
             then 'superseded'
           end as why
      from public.residual_verdict_acknowledgments a
     where a.period_id = p_period_id
       and a.retired_at is null
       and a.deleted_at is null
  ),
  upd as (
    update public.residual_verdict_acknowledgments a
       set retired_at     = now(),
           retired_reason = tgt.why
      from tgt
     where a.id = tgt.id
       and tgt.why is not null
    returning tgt.why as why
  )
  select coalesce(count(*) filter (where upd.why = 'resolved'), 0)::int,
         coalesce(count(*) filter (where upd.why = 'superseded'), 0)::int
    into v_res, v_sup
    from upd;

  return query select v_res, v_sup;
end;
$function$;

-- residual_sign_off_period → residuals
CREATE OR REPLACE FUNCTION public.residual_sign_off_period(p_period_id uuid, p_note text DEFAULT NULL::text, p_processor text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor  uuid := auth.uid();
  v_status text;
  v_month  date;
  v_state  record;
  v_ret    record;
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to sign off a residual period.'
      using errcode = '42501';
  end if;

  if v_actor is null then
    raise exception 'Signing off a period requires an identified actor.'
      using errcode = '42501',
            hint = 'This function cannot be called on a service-role connection.';
  end if;

  select p.status, p.statement_month into v_status, v_month
    from public.residual_periods p
   where p.id = p_period_id and p.deleted_at is null;

  if v_month is null then
    raise exception 'No live residual period with id %.', p_period_id
      using errcode = 'P0002';
  end if;

  if v_status = 'reconciled' then
    raise exception 'Statement month % is already signed off.',
      to_char(v_month, 'YYYY-MM')
      using errcode = '22023';
  end if;

  -- STEP 1: retire what the arithmetic has overtaken, BEFORE judging
  -- signability. Running it after would let a month be signed while carrying an
  -- ack that had stopped describing its row — the ack would suppress a mismatch
  -- it no longer matched, and the suppression would then be frozen in.
  select * into v_ret
    from public.residual_retire_resolved_acks(p_period_id, p_processor);

  -- STEP 2: every merchant must be clean, and there must be at least one.
  select * into v_state
    from public.residual_period_state(p_period_id, p_processor);

  if not v_state.signable then
    raise exception
      'Statement month % is not signable: % merchant(s) — % blocked, % awaiting volumes, % with unacknowledged mismatches.',
      to_char(v_month, 'YYYY-MM'), v_state.merchant_count,
      v_state.blocked, v_state.awaiting_volumes, v_state.mismatch
      using errcode = '22023',
            hint = 'Read residual_merchant_states(period_id) for the per-merchant detail. Every mismatch must pass or be acknowledged.';
  end if;

  -- STEP 3: the transition, tokened so the guard admits exactly this one.
  perform set_config('residuals.status_transition',
                     p_period_id::text || ':reconciled', true);
  perform set_config('residuals.status_source', 'signoff', true);
  perform set_config('residuals.status_note', coalesce(btrim(p_note), ''), true);

  update public.residual_periods
     set status = 'reconciled',
         updated_by_id = v_actor
   where id = p_period_id;

  perform set_config('residuals.status_transition', '', true);
  perform set_config('residuals.status_source', '', true);
  perform set_config('residuals.status_note', '', true);

  return jsonb_build_object(
    'period_id',        p_period_id,
    'statement_month',  to_char(v_month, 'YYYY-MM-DD'),
    'status',           'reconciled',
    'merchants',        v_state.merchant_count,
    'acks_retired',     jsonb_build_object('resolved',   v_ret.resolved,
                                           'superseded', v_ret.superseded)
  );
end;
$function$;

-- residual_standing_merchant_rates → residuals
CREATE OR REPLACE FUNCTION public.residual_standing_merchant_rates(p_mids text[])
 RETURNS TABLE(mid text, id uuid, effective_from date, risk_tier text, monthly_fee_tapdash numeric, is_locked boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- The R5b idiom, and it fails closed: auth_role() returns NULL on a
  -- service-role connection (auth.uid() is NULL), and a bare `not in` against
  -- NULL evaluates to NULL, which an IF treats as false and would let the call
  -- through unauthenticated.
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to read merchant rates.'
      using errcode = '42501';
  end if;

  -- An empty or NULL list is a caller asking about nothing, not an error:
  -- the editor renders no merchants when the coverage list is empty.
  if p_mids is null or array_length(p_mids, 1) is null then
    return;
  end if;

  return query
    select r.mid,
           r.id,
           r.effective_from,
           r.risk_tier,
           r.monthly_fee_tapdash,
           public.residual_merchant_rate_is_locked(
             r.mid, r.effective_from, r.effective_to)
      from public.residual_merchant_rates r
     where r.deleted_at is null
       and r.effective_to is null                -- == is_standing
       and r.mid = any (
             select regexp_replace(m, '[^0-9]', '', 'g')
               from unnest(p_mids) m
           )
     order by r.mid;
end;
$function$;

-- residual_supersede_buy_rate_schedule → residuals
CREATE OR REPLACE FUNCTION public.residual_supersede_buy_rate_schedule(p_processor text, p_effective_from date, p_label text, p_tiers jsonb, p_cells jsonb, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_proc     text := upper(btrim(coalesce(p_processor, '')));
  v_from     date := p_effective_from;
  v_actor    uuid := auth.uid();
  v_standing public.residual_buy_rate_schedules%rowtype;
  v_new_id   uuid;
  v_closed   uuid;
  v_tiers    int := 0;
  v_cells    int := 0;
  v_bad      text;
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to change buy-rate schedules.'
      using errcode = '42501';
  end if;

  if v_proc = '' then
    raise exception 'residual_supersede_buy_rate_schedule: p_processor is required.'
      using errcode = '22004';
  end if;

  if v_from is null or extract(day from v_from) <> 1 then
    raise exception 'residual_supersede_buy_rate_schedule: p_effective_from must be the 1st of a month.'
      using errcode = '22007';
  end if;

  if length(btrim(coalesce(p_label, ''))) = 0 then
    raise exception 'residual_supersede_buy_rate_schedule: a label is required.'
      using errcode = '22004';
  end if;

  if p_tiers is null or jsonb_typeof(p_tiers) <> 'object'
     or (select count(*) from jsonb_object_keys(p_tiers)) = 0 then
    raise exception 'residual_supersede_buy_rate_schedule: p_tiers must be a non-empty object of tier_key -> tapdash_share.'
      using errcode = '22004';
  end if;

  if p_cells is null or jsonb_typeof(p_cells) <> 'array' then
    raise exception 'residual_supersede_buy_rate_schedule: p_cells must be an array of {risk_tier, fee_item_key, rate}.'
      using errcode = '22004';
  end if;

  select string_agg(k, ', ') into v_bad
    from jsonb_object_keys(p_tiers) k
   where not exists (
     select 1 from public.residual_risk_tiers t
      where t.tier_key = k and t.deleted_at is null);
  if v_bad is not null then
    raise exception 'Unknown risk tier(s): %.', v_bad using errcode = '23503';
  end if;

  select string_agg(distinct c.risk_tier, ', ') into v_bad
    from jsonb_to_recordset(p_cells) as c(risk_tier text, fee_item_key text, rate numeric)
   where not (p_tiers ? c.risk_tier);
  if v_bad is not null then
    raise exception
      'p_cells names tier(s) the schedule does not define: %. Every tier carrying a rate must appear in p_tiers with its tapdash_share.',
      v_bad using errcode = '23503';
  end if;

  select string_agg(distinct c.fee_item_key, ', ') into v_bad
    from jsonb_to_recordset(p_cells) as c(risk_tier text, fee_item_key text, rate numeric)
   where not exists (
     select 1 from public.residual_fee_items f
      where f.fee_item_key = c.fee_item_key and f.deleted_at is null);
  if v_bad is not null then
    raise exception 'Unknown fee item(s): %.', v_bad using errcode = '23503';
  end if;

  select * into v_standing
    from public.residual_buy_rate_schedules s
   where s.deleted_at is null
     and s.processor = v_proc
     and (s.effective_to is null or s.effective_to > v_from)
   order by s.effective_from
   limit 1;

  if v_standing.id is not null and v_standing.effective_from >= v_from then
    raise exception
      '% already has a buy-rate schedule starting % (on or after %). Backdating is not supported here.',
      v_proc, v_standing.effective_from, v_from
      using errcode = '22007',
            hint = 'Pick a later effective month.';
  end if;

  if v_standing.id is not null then
    update public.residual_buy_rate_schedules
       set effective_to = v_from,
           updated_by_id = v_actor
     where id = v_standing.id;
    v_closed := v_standing.id;
  end if;

  insert into public.residual_buy_rate_schedules
    (processor, label, effective_from, effective_to, notes, created_by_id, updated_by_id)
  values (v_proc, btrim(p_label), v_from, null, p_notes, v_actor, v_actor)
  returning id into v_new_id;

  insert into public.residual_buy_rate_tiers
    (schedule_id, risk_tier, tapdash_share, created_by_id, updated_by_id)
  select v_new_id, k, (p_tiers ->> k)::numeric, v_actor, v_actor
    from jsonb_object_keys(p_tiers) k;
  get diagnostics v_tiers = row_count;

  -- EVERY CELL IS STORED, NULL RATE INCLUDED. See the header: a NULL rate now
  -- means "on the card, unpriced", which is a claim worth carrying forward.
  insert into public.residual_buy_rates
    (schedule_id, risk_tier, fee_item_key, rate, created_by_id, updated_by_id)
  select v_new_id, c.risk_tier, c.fee_item_key, c.rate, v_actor, v_actor
    from jsonb_to_recordset(p_cells)
      as c(risk_tier text, fee_item_key text, rate numeric);
  get diagnostics v_cells = row_count;

  return jsonb_build_object(
    'processor',      v_proc,
    'inserted_id',    v_new_id,
    'closed_id',      v_closed,
    'effective_from', v_from,
    'tiers',          v_tiers,
    'cells',          v_cells
  );
end;
$function$;

-- residual_supersede_merchant_rate → residuals
CREATE OR REPLACE FUNCTION public.residual_supersede_merchant_rate(p_mid text, p_effective_from date, p_risk_tier text, p_values jsonb, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_mid       text := regexp_replace(coalesce(p_mid, ''), '[^0-9]', '', 'g');
  v_from      date := p_effective_from;
  v_actor     uuid := auth.uid();
  v_standing  public.residual_merchant_rates%rowtype;
  v_new_id    uuid;
  v_closed    uuid;
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to change merchant rates.'
      using errcode = '42501';
  end if;

  if v_mid = '' then
    raise exception 'residual_supersede_merchant_rate: p_mid must contain digits.'
      using errcode = '22004';
  end if;

  if v_from is null or extract(day from v_from) <> 1 then
    raise exception 'residual_supersede_merchant_rate: p_effective_from must be the 1st of a month.'
      using errcode = '22007';
  end if;

  if not exists (
    select 1 from public.residual_risk_tiers t
     where t.tier_key = p_risk_tier and t.deleted_at is null
  ) then
    raise exception 'Unknown risk tier %.', p_risk_tier
      using errcode = '23503';
  end if;

  -- The row in force at (or after) the new date, if any.
  select * into v_standing
    from public.residual_merchant_rates r
   where r.deleted_at is null
     and r.mid = v_mid
     and (r.effective_to is null or r.effective_to > v_from)
   order by r.effective_from
   limit 1;

  -- BACKDATING IS REFUSED RATHER THAN GUESSED AT. A successor dated at or
  -- before the standing version's own start cannot be expressed: closing the
  -- standing row would need effective_to <= effective_from, which the range
  -- CHECK forbids. Correcting a historical version is a different operation
  -- with different consequences (it rewrites months that may already be
  -- computed), so it is not something this function should quietly attempt.
  if v_standing.id is not null and v_standing.effective_from >= v_from then
    raise exception
      'MID % already has a rate version starting % (on or after %). Backdating is not supported here.',
      v_mid, v_standing.effective_from, v_from
      using errcode = '22007',
            hint = 'Pick a later effective month, or correct the existing version directly if it has not been used in a computed period.';
  end if;

  -- Close first. The guard trigger deliberately does not cover effective_to,
  -- so this succeeds even when the standing version is locked.
  if v_standing.id is not null then
    update public.residual_merchant_rates
       set effective_to = v_from,
           updated_by_id = v_actor
     where id = v_standing.id;
    v_closed := v_standing.id;
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
    v_mid, v_from, null, p_risk_tier,
    (p_values->>'vmd_auth_fee')::numeric(14,6),
    (p_values->>'pin_debit_auth_fee')::numeric(14,6),
    (p_values->>'avs_fee')::numeric(14,6),
    (p_values->>'batch_fee')::numeric(14,6),
    (p_values->>'vmd_transaction_fee')::numeric(14,6),
    (p_values->>'amex_volume')::numeric(14,6),
    (p_values->>'vmd_volume')::numeric(14,6),
    (p_values->>'pin_debit_volume')::numeric(14,6),
    (p_values->>'amex_template_volume_fee')::numeric(14,6),
    nullif(btrim(coalesce(p_values->>'gateway_provider_mav', '')), ''),
    (p_values->>'gateway_monthly_mav')::numeric(14,6),
    nullif(btrim(coalesce(p_values->>'terminal_provider_mav', '')), ''),
    (p_values->>'terminal_monthly_mav')::numeric(14,6),
    (p_values->>'monthly_fee_tapdash')::numeric(14,6),
    (p_values->>'monthly_fee_maverick')::numeric(14,6),
    (p_values->>'chargeback_fee')::numeric(14,6),
    p_notes, v_actor, v_actor
  )
  returning id into v_new_id;

  return jsonb_build_object(
    'mid', v_mid,
    'inserted_id', v_new_id,
    'closed_id', v_closed,
    'effective_from', v_from
  );
end;
$function$;

-- residual_supersede_merchant_vendor_costs → residuals
CREATE OR REPLACE FUNCTION public.residual_supersede_merchant_vendor_costs(p_mid text, p_effective_from date, p_values jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_mid      text := regexp_replace(coalesce(p_mid, ''), '[^0-9]', '', 'g');
  v_from     date := p_effective_from;
  v_actor    uuid := auth.uid();
  v_standing public.residual_merchant_vendor_costs%rowtype;
  v_new_id   uuid;
  v_closed   uuid;
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to change merchant vendor costs.'
      using errcode = '42501';
  end if;

  if v_mid = '' then
    raise exception 'residual_supersede_merchant_vendor_costs: p_mid must contain digits.'
      using errcode = '22004';
  end if;

  if v_from is null or extract(day from v_from) <> 1 then
    raise exception 'residual_supersede_merchant_vendor_costs: p_effective_from must be the 1st of a month.'
      using errcode = '22007';
  end if;

  select * into v_standing
    from public.residual_merchant_vendor_costs c
   where c.deleted_at is null
     and c.mid = v_mid
     and (c.effective_to is null or c.effective_to > v_from)
   order by c.effective_from
   limit 1;

  -- BACKDATING IS REFUSED RATHER THAN GUESSED AT, the same rule as merchant
  -- rates: closing the standing row would need effective_to <= effective_from,
  -- which the range CHECK forbids.
  if v_standing.id is not null and v_standing.effective_from >= v_from then
    raise exception
      'MID % already has vendor costs starting % (on or after %). Backdating is not supported here.',
      v_mid, v_standing.effective_from, v_from
      using errcode = '22007',
            hint = 'Pick a later effective month, or correct the existing row directly.';
  end if;

  if v_standing.id is not null then
    update public.residual_merchant_vendor_costs
       set effective_to = v_from, updated_by_id = v_actor
     where id = v_standing.id;
    v_closed := v_standing.id;
  end if;

  insert into public.residual_merchant_vendor_costs (
    mid, effective_from, effective_to,
    gateway_provider, gateway_monthly_fee, gateway_auth_fee, gateway_per_update,
    terminal_provider, terminal_monthly_fee, terminal_transaction_fee,
    rewards_provider, rewards_volume_cost,
    other_provider, other_monthly_fee, notes,
    created_by_id, updated_by_id
  ) values (
    v_mid, v_from, null,
    nullif(btrim(coalesce(p_values->>'gateway_provider','')), ''),
    (p_values->>'gateway_monthly_fee')::numeric(14,6),
    (p_values->>'gateway_auth_fee')::numeric(14,6),
    (p_values->>'gateway_per_update')::numeric(14,6),
    nullif(btrim(coalesce(p_values->>'terminal_provider','')), ''),
    (p_values->>'terminal_monthly_fee')::numeric(14,6),
    (p_values->>'terminal_transaction_fee')::numeric(14,6),
    nullif(btrim(coalesce(p_values->>'rewards_provider','')), ''),
    (p_values->>'rewards_volume_cost')::numeric(14,6),
    nullif(btrim(coalesce(p_values->>'other_provider','')), ''),
    (p_values->>'other_monthly_fee')::numeric(14,6),
    nullif(btrim(coalesce(p_values->>'notes','')), ''),
    v_actor, v_actor
  )
  returning id into v_new_id;

  return jsonb_build_object(
    'mid', v_mid, 'inserted_id', v_new_id, 'closed_id', v_closed,
    'effective_from', v_from
  );
end;
$function$;

-- residual_sweep_mid_links → residuals
CREATE OR REPLACE FUNCTION public.residual_sweep_mid_links()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if not auth_admin_page('residuals') then
    raise exception 'Not authorized to sweep residual links.' using errcode = '42501';
  end if;
  return public.residual_reconcile_mid_links(null);
end;
$function$;

-- residual_synopsis → residuals
CREATE OR REPLACE FUNCTION public.residual_synopsis(p_period_id uuid, p_mid text DEFAULT NULL::text, p_lifetime boolean DEFAULT false)
 RETURNS TABLE(mid text, net_income text, rows_total integer, rows_computed integer, merchants_total integer, merchants_computed integer, periods_total integer, periods_computed integer, disclosable boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_mid text := nullif(regexp_replace(coalesce(p_mid, ''), '[^0-9]', '', 'g'), '');
  v_n_periods int;
  v_n_disclosable int;
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to read the residual synopsis.'
      using errcode = '42501';
  end if;

  if not p_lifetime and not exists (
    select 1 from public.residual_periods p
     where p.id = p_period_id and p.deleted_at is null
  ) then
    raise exception 'No live residual period with id %.', p_period_id
      using errcode = 'P0002';
  end if;

  return query
  with scope as (
    -- Lifetime is every live period; a month is the one named. In BOTH cases
    -- a period contributes money only when it carries a standing assertion.
    select p.id, (p.calculation_version is not null) as ok
      from public.residual_periods p
     where p.deleted_at is null
       and (p_lifetime or p.id = p_period_id)
  ),
  counts as (
    select count(*) filter (where s.ok)::int as n_ok, count(*)::int as n_all
      from scope s
  ),
  -- Rows: LINES ONLY. See the header.
  ln as (
    select l.mid as m, l.net_income as ni, s.ok
      from public.residual_lines l
      join scope s on s.id = l.period_id
     where l.deleted_at is null
       and (v_mid is null or l.mid = v_mid)
  ),
  -- Money: lines AND groups, but only from disclosable periods.
  money as (
    select ln.m, ln.ni from ln where ln.ok
    union all
    select g.mid, g.net_income
      from public.residual_line_groups g
      join scope s on s.id = g.period_id
     where g.deleted_at is null and s.ok
       and (v_mid is null or g.mid = v_mid)
  ),
  per_mid as (
    select ln.m,
           count(*)::int                              as n_rows,
           count(ln.ni)::int                          as n_rows_ok,
           (select sum(mo.ni) from money mo where mo.m = ln.m) as sum_ni,
           bool_or(ln.ok)                             as any_ok
      from ln
     group by ln.m
  )
  -- Per-MID rows.
  select pm.m,
         case when pm.any_ok then pm.sum_ni::text end,
         pm.n_rows,
         pm.n_rows_ok,
         1,
         case when pm.n_rows_ok > 0 then 1 else 0 end,
         (select n_all from counts),
         (select n_ok from counts),
         pm.any_ok
    from per_mid pm

  union all

  -- The company-wide rollup. mid IS NULL is the discriminator.
  select null::text,
         case when (select n_ok from counts) > 0
              then (select coalesce(sum(mo.ni), 0) from money mo)::text end,
         (select count(*)::int from ln),
         (select count(ln2.ni)::int from ln ln2),
         (select count(distinct ln3.m)::int from ln ln3),
         (select count(distinct ln4.m)::int from ln ln4 where ln4.ni is not null),
         (select n_all from counts),
         (select n_ok from counts),
         ((select n_ok from counts) > 0)

   order by 1 nulls last;
end;
$function$;

-- residual_template_rate_refs → residuals
CREATE OR REPLACE FUNCTION public.residual_template_rate_refs(p_processor text, p_month date)
 RETURNS TABLE(fee_item_key text, in_month_registry boolean, in_any_registry boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- An explicit raise rather than a WHERE clause: returning zero rows to an
  -- unauthorized caller would read as "this month prices nothing", which is a
  -- state a processor can genuinely be in. Written as `is null or not in` so it
  -- fails closed where auth.uid() — and therefore auth_role() — is NULL.
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to read the formula registry.'
      using errcode = '42501';
  end if;

  return query
  with refs as (
    select distinct
           t.rate_ref as key,
           (g.effective_from <= p_month
            and (g.effective_to is null or g.effective_to > p_month)) as this_month
      from public.residual_formula_registries g
      join public.residual_formula_rules r
        on r.registry_id = g.id and r.deleted_at is null
      join public.residual_formula_terms t
        on t.rule_id = r.id and t.deleted_at is null
     where g.deleted_at is null
       and g.processor = upper(btrim(coalesce(p_processor, '')))
       and t.rate_source = 'template'
       and t.rate_ref is not null
  )
  select refs.key,
         bool_or(refs.this_month) as in_month_registry,
         true                     as in_any_registry
    from refs
   group by refs.key;
end;
$function$;

-- residual_tolerances_for_month → residuals
CREATE OR REPLACE FUNCTION public.residual_tolerances_for_month(p_month date)
 RETURNS TABLE(step smallint, tolerance numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_n     int;
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to read verdict tolerances.'
      using errcode = '42501';
  end if;

  if v_month is null then
    raise exception 'residual_tolerances_for_month: p_month is required.'
      using errcode = '22004';
  end if;

  return query
    select t.step, t.tolerance
      from public.residual_verdict_tolerances t
     where t.deleted_at is null
       and t.effective_from <= v_month
       and (t.effective_to is null or t.effective_to > v_month)
     order by t.step;

  get diagnostics v_n = row_count;

  if v_n <> 3 then
    raise exception
      'Verdict tolerances cover % for % of 3 steps; all three are required.',
      to_char(v_month, 'YYYY-MM'), v_n
      using errcode = 'P0002',
            hint = 'Add the missing rows to residual_verdict_tolerances covering this month.';
  end if;
end;
$function$;

-- residual_unlink_mid → residuals
CREATE OR REPLACE FUNCTION public.residual_unlink_mid(p_mid text, p_period_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_mid text := regexp_replace(coalesce(p_mid,''),'[^0-9]','','g');
  v_n   integer;
  v_tot integer := 0;
begin
  if not auth_admin_page('residuals') then
    raise exception 'Not authorized to unlink a residual MID.' using errcode = '42501';
  end if;

  update public.residual_lines rl
     set record_id = null, thread_match = null,
         thread_matched_at = null, thread_confirmed_by_id = null
   where rl.deleted_at is null
     and regexp_replace(coalesce(rl.mid,''),'[^0-9]','','g') = v_mid
     and (p_period_id is null or rl.period_id = p_period_id);
  get diagnostics v_n = row_count; v_tot := v_tot + v_n;

  update public.residual_merchant_volumes rv
     set record_id = null, thread_match = null,
         thread_matched_at = null, thread_confirmed_by_id = null
   where rv.deleted_at is null
     and regexp_replace(coalesce(rv.mid,''),'[^0-9]','','g') = v_mid
     and (p_period_id is null or rv.period_id = p_period_id);
  get diagnostics v_n = row_count; v_tot := v_tot + v_n;

  update public.residual_plan_volumes pv
     set record_id = null, thread_match = null,
         thread_matched_at = null, thread_confirmed_by_id = null
   where pv.deleted_at is null
     and regexp_replace(coalesce(pv.mid,''),'[^0-9]','','g') = v_mid
     and (p_period_id is null or pv.period_id = p_period_id);
  get diagnostics v_n = row_count; v_tot := v_tot + v_n;

  return jsonb_build_object('mid', v_mid, 'rows_unlinked', v_tot);
end;
$function$;

-- residual_update_line_stated → residuals
CREATE OR REPLACE FUNCTION public.residual_update_line_stated(p_line_id uuid, p_values jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor   uuid := auth.uid();
  v_allowed text[] := array[
    'mid','merchant_name','fee_category','fee_item_name',
    'item_count','amount','buy_rate_per_item',
    'agent_income','agent_expense','net_revenue'
  ];
  v_unknown text[];
  v_before  public.residual_lines;
  v_after   public.residual_lines;
  v_changed text[];
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to edit a residual line.'
      using errcode = '42501';
  end if;

  if v_actor is null then
    raise exception 'Editing a line by hand requires an identified actor.'
      using errcode = '42501';
  end if;

  select array_agg(k) into v_unknown
    from jsonb_object_keys(coalesce(p_values, '{}'::jsonb)) k
   where k <> all(v_allowed);

  if v_unknown is not null then
    raise exception
      'residual_update_line_stated: % is not an editable column.',
      array_to_string(v_unknown, ', ')
      using errcode = '22023',
            hint = 'Only statement data is editable. total_income, total_buy_rate, tapdash_net_before_split, tapdash_net_after_split, additional_income_direct and net_income are the engine''s and are never writable by hand.';
  end if;

  select * into v_before
    from public.residual_lines
   where id = p_line_id and deleted_at is null;

  if v_before.id is null then
    raise exception 'No live residual line with id %.', p_line_id
      using errcode = 'P0002';
  end if;

  -- ABSENT LEAVES ALONE; PRESENT SETS, INCLUDING TO NULL. See the header.
  update public.residual_lines l
     set mid = case when p_values ? 'mid'
                    then regexp_replace(coalesce(p_values->>'mid',''), '[^0-9]', '', 'g')
                    else l.mid end,
         merchant_name = case when p_values ? 'merchant_name'
                              then p_values->>'merchant_name' else l.merchant_name end,
         fee_category = case when p_values ? 'fee_category'
                             then p_values->>'fee_category' else l.fee_category end,
         fee_item_name = case when p_values ? 'fee_item_name'
                              then p_values->>'fee_item_name' else l.fee_item_name end,
         item_count = case when p_values ? 'item_count'
                           then (p_values->>'item_count')::numeric else l.item_count end,
         amount = case when p_values ? 'amount'
                       then (p_values->>'amount')::numeric else l.amount end,
         buy_rate_per_item = case when p_values ? 'buy_rate_per_item'
                                  then (p_values->>'buy_rate_per_item')::numeric
                                  else l.buy_rate_per_item end,
         agent_income = case when p_values ? 'agent_income'
                             then (p_values->>'agent_income')::numeric else l.agent_income end,
         agent_expense = case when p_values ? 'agent_expense'
                              then (p_values->>'agent_expense')::numeric else l.agent_expense end,
         net_revenue = case when p_values ? 'net_revenue'
                            then (p_values->>'net_revenue')::numeric else l.net_revenue end,
         updated_by_id = v_actor
   where l.id = p_line_id
   returning * into v_after;

  select array_agg(k order by k) into v_changed
    from unnest(v_allowed) k
   where to_jsonb(v_before) -> k is distinct from to_jsonb(v_after) -> k;

  return jsonb_build_object(
    'line_id',        p_line_id,
    'period_id',      v_after.period_id,
    'changed_fields', coalesce(to_jsonb(v_changed), '[]'::jsonb),
    'before',         (select jsonb_object_agg(k, to_jsonb(v_before) -> k)
                         from unnest(coalesce(v_changed, array[]::text[])) k),
    'after',          (select jsonb_object_agg(k, to_jsonb(v_after) -> k)
                         from unnest(coalesce(v_changed, array[]::text[])) k)
  );
end;
$function$;

-- residual_update_merchant_rate_row → residuals
CREATE OR REPLACE FUNCTION public.residual_update_merchant_rate_row(p_rate_id uuid, p_risk_tier text, p_values jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_bad   text;
  v_mid   text;
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to change merchant rates.'
      using errcode = '42501';
  end if;

  if p_values is null or jsonb_typeof(p_values) <> 'object' then
    raise exception 'residual_update_merchant_rate_row: p_values must be an object.'
      using errcode = '22004';
  end if;

  -- The legal set, written out. It MUST match the assignment list in the
  -- UPDATE below, which also names its columns one by one — a rate column
  -- added by a future migration has to be added in both places or it is
  -- rejected here and never written there. That is stated rather than
  -- engineered around: the same union is already pinned in three other places
  -- (the parser's column map, the supersede RPC, the field vocabulary module),
  -- and adding a rate is a migration in every one of them.
  select string_agg(k, ', ') into v_bad
    from jsonb_object_keys(p_values) k
   where k not in (
     'vmd_auth_fee','pin_debit_auth_fee','avs_fee','batch_fee',
     'vmd_transaction_fee','amex_volume','vmd_volume','pin_debit_volume',
     'amex_template_volume_fee','gateway_provider_mav','gateway_monthly_mav',
     'terminal_provider_mav','terminal_monthly_mav','monthly_fee_tapdash',
     'monthly_fee_maverick','chargeback_fee');
  if v_bad is not null then
    raise exception 'Not editable rate field(s): %.', v_bad
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.residual_risk_tiers t
     where t.tier_key = p_risk_tier and t.deleted_at is null
  ) then
    raise exception 'Unknown risk tier %.', p_risk_tier using errcode = '23503';
  end if;

  update public.residual_merchant_rates set
    risk_tier                = p_risk_tier,
    vmd_auth_fee             = (p_values->>'vmd_auth_fee')::numeric(14,6),
    pin_debit_auth_fee       = (p_values->>'pin_debit_auth_fee')::numeric(14,6),
    avs_fee                  = (p_values->>'avs_fee')::numeric(14,6),
    batch_fee                = (p_values->>'batch_fee')::numeric(14,6),
    vmd_transaction_fee      = (p_values->>'vmd_transaction_fee')::numeric(14,6),
    amex_volume              = (p_values->>'amex_volume')::numeric(14,6),
    vmd_volume               = (p_values->>'vmd_volume')::numeric(14,6),
    pin_debit_volume         = (p_values->>'pin_debit_volume')::numeric(14,6),
    amex_template_volume_fee = (p_values->>'amex_template_volume_fee')::numeric(14,6),
    gateway_provider_mav     = nullif(btrim(coalesce(p_values->>'gateway_provider_mav', '')), ''),
    gateway_monthly_mav      = (p_values->>'gateway_monthly_mav')::numeric(14,6),
    terminal_provider_mav    = nullif(btrim(coalesce(p_values->>'terminal_provider_mav', '')), ''),
    terminal_monthly_mav     = (p_values->>'terminal_monthly_mav')::numeric(14,6),
    monthly_fee_tapdash      = (p_values->>'monthly_fee_tapdash')::numeric(14,6),
    monthly_fee_maverick     = (p_values->>'monthly_fee_maverick')::numeric(14,6),
    chargeback_fee           = (p_values->>'chargeback_fee')::numeric(14,6),
    updated_by_id            = v_actor
  where id = p_rate_id and deleted_at is null
  returning mid into v_mid;

  if v_mid is null then
    raise exception 'No live merchant rate version with id %.', p_rate_id
      using errcode = 'P0002';
  end if;

  return jsonb_build_object('mid', v_mid, 'rate_id', p_rate_id);
end;
$function$;

-- residual_update_merchant_vendor_costs → residuals
CREATE OR REPLACE FUNCTION public.residual_update_merchant_vendor_costs(p_id uuid, p_values jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_bad   text;
  v_mid   text;
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to change merchant vendor costs.'
      using errcode = '42501';
  end if;

  if p_values is null or jsonb_typeof(p_values) <> 'object' then
    raise exception 'residual_update_merchant_vendor_costs: p_values must be an object.'
      using errcode = '22004';
  end if;

  -- Written out, and it MUST match the assignment list below — a column added
  -- to this table has to be added in both places or it is rejected here and
  -- never written there. Stated rather than engineered around.
  select string_agg(k, ', ') into v_bad
    from jsonb_object_keys(p_values) k
   where k not in (
     'gateway_provider','gateway_monthly_fee','gateway_auth_fee','gateway_per_update',
     'terminal_provider','terminal_monthly_fee','terminal_transaction_fee',
     'rewards_provider','rewards_volume_cost',
     'other_provider','other_monthly_fee','notes');
  if v_bad is not null then
    raise exception 'Not an editable vendor-cost field: %.', v_bad
      using errcode = '22023';
  end if;

  update public.residual_merchant_vendor_costs set
    gateway_provider         = nullif(btrim(coalesce(p_values->>'gateway_provider','')), ''),
    gateway_monthly_fee      = (p_values->>'gateway_monthly_fee')::numeric(14,6),
    gateway_auth_fee         = (p_values->>'gateway_auth_fee')::numeric(14,6),
    gateway_per_update       = (p_values->>'gateway_per_update')::numeric(14,6),
    terminal_provider        = nullif(btrim(coalesce(p_values->>'terminal_provider','')), ''),
    terminal_monthly_fee     = (p_values->>'terminal_monthly_fee')::numeric(14,6),
    terminal_transaction_fee = (p_values->>'terminal_transaction_fee')::numeric(14,6),
    rewards_provider         = nullif(btrim(coalesce(p_values->>'rewards_provider','')), ''),
    rewards_volume_cost      = (p_values->>'rewards_volume_cost')::numeric(14,6),
    other_provider           = nullif(btrim(coalesce(p_values->>'other_provider','')), ''),
    other_monthly_fee        = (p_values->>'other_monthly_fee')::numeric(14,6),
    notes                    = nullif(btrim(coalesce(p_values->>'notes','')), ''),
    updated_by_id            = v_actor
  where id = p_id and deleted_at is null
  returning mid into v_mid;

  if v_mid is null then
    raise exception 'No live merchant vendor-cost row with id %.', p_id
      using errcode = 'P0002';
  end if;

  return jsonb_build_object('mid', v_mid, 'id', p_id);
end;
$function$;

-- residual_update_merchant_volumes → residuals
CREATE OR REPLACE FUNCTION public.residual_update_merchant_volumes(p_period_id uuid, p_mid text, p_values jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor   uuid := auth.uid();
  v_allowed text[] := array[
    'merchant_name',
    'amex_volume','vmd_volume','debit_volume','ebt_volume',
    'amex_item_count','vmd_item_count','debit_item_count','ebt_item_count'
  ];
  v_unknown text[];
  v_mid     text := regexp_replace(coalesce(p_mid, ''), '[^0-9]', '', 'g');
  v_before  public.residual_merchant_volumes;
  v_after   public.residual_merchant_volumes;
  v_changed text[];
  v_created boolean := false;
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to edit residual volumes.'
      using errcode = '42501';
  end if;

  if v_actor is null then
    raise exception 'Editing volumes by hand requires an identified actor.'
      using errcode = '42501';
  end if;

  if v_mid = '' then
    raise exception 'residual_update_merchant_volumes: p_mid must contain digits.'
      using errcode = '22004';
  end if;

  select array_agg(k) into v_unknown
    from jsonb_object_keys(coalesce(p_values, '{}'::jsonb)) k
   where k <> all(v_allowed);

  if v_unknown is not null then
    raise exception
      'residual_update_merchant_volumes: % is not an editable column.',
      array_to_string(v_unknown, ', ')
      using errcode = '22023',
            hint = 'The four buckets and their counts are hand-enterable. stated_total, reconciled and unmapped_volume are the PDF rollup''s conclusions, not observations.';
  end if;

  select * into v_before
    from public.residual_merchant_volumes
   where period_id = p_period_id and mid = v_mid and deleted_at is null;

  if v_before.id is null then
    -- A hand-created row has no import behind it, which the provenance CHECK
    -- states as an equivalence: source = 'manual' IFF import_id IS NULL.
    insert into public.residual_merchant_volumes
      (period_id, import_id, mid, merchant_name,
       amex_volume, vmd_volume, debit_volume, ebt_volume,
       amex_item_count, vmd_item_count, debit_item_count, ebt_item_count,
       source, created_by_id, updated_by_id)
    values
      (p_period_id, null, v_mid,
       p_values->>'merchant_name',
       (p_values->>'amex_volume')::numeric,
       (p_values->>'vmd_volume')::numeric,
       (p_values->>'debit_volume')::numeric,
       (p_values->>'ebt_volume')::numeric,
       (p_values->>'amex_item_count')::integer,
       (p_values->>'vmd_item_count')::integer,
       (p_values->>'debit_item_count')::integer,
       (p_values->>'ebt_item_count')::integer,
       'manual', v_actor, v_actor)
    returning * into v_after;
    v_created := true;
  else
    update public.residual_merchant_volumes v
       set merchant_name = case when p_values ? 'merchant_name'
                                then p_values->>'merchant_name' else v.merchant_name end,
           amex_volume = case when p_values ? 'amex_volume'
                              then (p_values->>'amex_volume')::numeric else v.amex_volume end,
           vmd_volume = case when p_values ? 'vmd_volume'
                             then (p_values->>'vmd_volume')::numeric else v.vmd_volume end,
           debit_volume = case when p_values ? 'debit_volume'
                               then (p_values->>'debit_volume')::numeric else v.debit_volume end,
           ebt_volume = case when p_values ? 'ebt_volume'
                             then (p_values->>'ebt_volume')::numeric else v.ebt_volume end,
           amex_item_count = case when p_values ? 'amex_item_count'
                                  then (p_values->>'amex_item_count')::integer
                                  else v.amex_item_count end,
           vmd_item_count = case when p_values ? 'vmd_item_count'
                                 then (p_values->>'vmd_item_count')::integer
                                 else v.vmd_item_count end,
           debit_item_count = case when p_values ? 'debit_item_count'
                                   then (p_values->>'debit_item_count')::integer
                                   else v.debit_item_count end,
           ebt_item_count = case when p_values ? 'ebt_item_count'
                                 then (p_values->>'ebt_item_count')::integer
                                 else v.ebt_item_count end,
           updated_by_id = v_actor
     where v.id = v_before.id
     returning * into v_after;
  end if;

  select array_agg(k order by k) into v_changed
    from unnest(v_allowed) k
   where to_jsonb(v_before) -> k is distinct from to_jsonb(v_after) -> k;

  return jsonb_build_object(
    'volume_id',      v_after.id,
    'period_id',      p_period_id,
    'created',        v_created,
    'changed_fields', coalesce(to_jsonb(v_changed), '[]'::jsonb),
    'before',         case when v_created then null
                           else (select jsonb_object_agg(k, to_jsonb(v_before) -> k)
                                   from unnest(coalesce(v_changed, array[]::text[])) k) end,
    'after',          (select jsonb_object_agg(k, to_jsonb(v_after) -> k)
                         from unnest(coalesce(v_changed, array[]::text[])) k)
  );
end;
$function$;

-- residual_vendor_card_lookup → residuals
CREATE OR REPLACE FUNCTION public.residual_vendor_card_lookup(p_provider text, p_month date)
 RETURNS TABLE(matched_processor text, fee_item_key text, fee_item_label text, vendor_cost_slot text, rate numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_key text := public.residual_vendor_provider_key(p_provider);
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to read vendor rate cards.'
      using errcode = '42501';
  end if;

  if v_key is null then
    return;
  end if;

  -- Zero rows means the name resolved to no card in force for that month —
  -- UsaEpay, IposPays and Valor all do today. That is a real answer.
  return query
  select s.processor, b.fee_item_key, fi.label, fi.vendor_cost_slot, b.rate
    from public.residual_buy_rate_schedules s
    join public.residual_buy_rate_tiers t
      on t.schedule_id = s.id and t.deleted_at is null
    join public.residual_risk_tiers rt
      on rt.tier_key = t.risk_tier and rt.deleted_at is null and rt.is_risk_tier = false
    join public.residual_buy_rates b
      on b.schedule_id = s.id and b.risk_tier = t.risk_tier and b.deleted_at is null
    join public.residual_fee_items fi
      on fi.fee_item_key = b.fee_item_key and fi.deleted_at is null
   where s.deleted_at is null
     and s.processor = v_key
     and s.effective_from <= p_month
     and (s.effective_to is null or s.effective_to > p_month)
   order by fi.sort_order;
end;
$function$;

-- residual_verdicts → residuals
CREATE OR REPLACE FUNCTION public.residual_verdicts(p_period_id uuid, p_mid text DEFAULT NULL::text, p_processor text DEFAULT NULL::text)
 RETURNS TABLE(scope text, scope_id uuid, mid text, fee_item_name text, group_key text, step smallint, verdict text, left_value numeric, right_value numeric, delta numeric, tolerance_applied numeric, ack_id uuid, suppressed boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_month     date;
  v_proc      text;
  v_registry  uuid;
  v_mid       text := nullif(regexp_replace(coalesce(p_mid, ''), '[^0-9]', '', 'g'), '');
  v_t1        numeric;
  v_t2        numeric;
  v_t3        numeric;
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to read residual verdicts.'
      using errcode = '42501';
  end if;

  -- ONE call replaces R6a's inline gate, month lookup, processor derivation and
  -- registry lookup. See residual_period_context for why it is shared with
  -- residual_grid_rows rather than copied into it.
  select c.processor, c.registry_id, c.statement_month
    into v_proc, v_registry, v_month
    from public.residual_period_context(p_period_id, p_processor) c;

  -- Raises if any of the three is uncovered. Resolved ONCE, before any row is
  -- read, so a partially-covered month cannot produce a half-verdicted period.
  select max(x.tolerance) filter (where x.step = 1),
         max(x.tolerance) filter (where x.step = 2),
         max(x.tolerance) filter (where x.step = 3)
    into v_t1, v_t2, v_t3
    from public.residual_tolerances_for_month(v_month) x;

  return query
  with
  -- ---------- the rule shapes, one pass over the registry ----------
  rule_shape as (
    select ru.id                as rule_id,
           ru.fee_item_name     as fin,
           ru.group_key         as gkey,
           -- Step-2 exemption, derived. TRUE when the buy side has no terms at
           -- all, or is exactly one net_revenue mirror term.
           (count(t.id) filter (where t.side = 'buy_rate') = 0
            or (count(t.id) filter (where t.side = 'buy_rate') = 1
                and count(t.id) filter (where t.side = 'buy_rate'
                                          and t.rate_source = 'net_revenue') = 1)
           )                    as step2_exempt
      from public.residual_formula_rules ru
      left join public.residual_formula_terms t
             on t.rule_id = ru.id and t.deleted_at is null
     where ru.registry_id = v_registry
       and ru.deleted_at is null
     group by ru.id, ru.fee_item_name, ru.group_key
  ),
  -- ---------- the period's lines, matched to their rule ----------
  ln as (
    select l.id, l.mid as lmid, l.fee_item_name as fin,
           l.amount, l.agent_expense, l.net_revenue,
           l.total_buy_rate, l.tapdash_net_before_split,
           rs.rule_id, rs.gkey, rs.step2_exempt
      from public.residual_lines l
      join rule_shape rs on rs.fin = l.fee_item_name
     where l.period_id = p_period_id
       and l.deleted_at is null
       and (v_mid is null or l.mid = v_mid)
  ),
  -- ---------- volumes for this period, one row per mid ----------
  vol as (
    select v.mid as vmid, v.amex_volume, v.vmd_volume,
           v.debit_volume, v.ebt_volume,
           v.amex_credits, v.vmd_credits,
           v.debit_credits, v.ebt_credits
      from public.residual_merchant_volumes v
     where v.period_id = p_period_id
       and v.deleted_at is null
  ),
  -- ---------- the sibling set, for conditional mappings ----------
  -- Every fee item each merchant carries this period. Built with the SAME
  -- query the engine uses for residual_formula_terms.applies_when
  -- (residual_calc_engine, "Read ONCE per merchant"), so a conditional
  -- mapping and the conditional income term it verifies can never disagree
  -- about whether the sibling is there.
  sib as (
    select regexp_replace(l.mid, '[^0-9]', '', 'g') as smid,
           array_agg(distinct l.fee_item_name)      as items
      from public.residual_lines l
     where l.period_id = p_period_id
       and l.deleted_at is null
     group by 1
  ),
  -- ---------- step 1: mapped rows only ----------
  -- The bucket-sum is built by matching the mapping's text against the volume
  -- row's columns. bool_or(... is null) is what makes a partially-extracted
  -- statement absent rather than wrong: the unreconciled-PDF path writes all
  -- four buckets NULL by design, and summing NULLs as zero would compare a real
  -- Amount against a fabricated 0.00 and call it a mismatch.
  s1 as (
    select ln.id, ln.lmid, ln.fin, ln.gkey,
           ln.amount as lv,
           -- Gross, less this bucket's credits where the mapping says net.
           -- Measured on August 2026: BIN Sponsorship is assessed net of
           -- refunds while Cash Discount and Interchange are assessed gross on
           -- the very same statements, so the basis belongs to the mapping and
           -- not to the period.
           sum(case m.volume_bucket
                 when 'amex_volume'  then vol.amex_volume
                   - case when m.basis = 'net' then coalesce(vol.amex_credits, 0) else 0 end
                 when 'vmd_volume'   then vol.vmd_volume
                   - case when m.basis = 'net' then coalesce(vol.vmd_credits, 0) else 0 end
                 when 'debit_volume' then vol.debit_volume
                   - case when m.basis = 'net' then coalesce(vol.debit_credits, 0) else 0 end
                 when 'ebt_volume'   then vol.ebt_volume
                   - case when m.basis = 'net' then coalesce(vol.ebt_credits, 0) else 0 end
               end) as rv,
           -- Unchanged, and deliberately tested on the VOLUME rather than on
           -- the credits: a NULL bucket is what makes a partially-extracted
           -- statement absent instead of wrong, while a NULL credit figure
           -- only means the statement did not print the column.
           bool_or(case m.volume_bucket
                     when 'amex_volume'  then vol.amex_volume
                     when 'vmd_volume'   then vol.vmd_volume
                     when 'debit_volume' then vol.debit_volume
                     when 'ebt_volume'   then vol.ebt_volume
                   end is null) as any_bucket_null
      from ln
      join public.residual_volume_row_mappings m
        on m.rule_id = ln.rule_id and m.deleted_at is null
      join vol on vol.vmid = ln.lmid
      left join sib on sib.smid = regexp_replace(ln.lmid, '[^0-9]', '', 'g')
     where ln.amount is not null
       -- A conditional bucket drops out of the sum entirely when its condition
       -- fails, which is what `continue` does to a conditional term in the
       -- engine's own evaluator.
       and (m.applies_when = 'always'
            or (m.applies_when = 'sibling_absent'
                and not (m.sibling_fee_item_name = any(coalesce(sib.items, '{}'::text[]))))
            or (m.applies_when = 'sibling_present'
                and m.sibling_fee_item_name = any(coalesce(sib.items, '{}'::text[]))))
     group by ln.id, ln.lmid, ln.fin, ln.gkey, ln.amount
  ),
  -- ---------- the group rows ----------
  grp as (
    select g.id, g.mid as gmid, g.group_key as gkey,
           g.stated_net_revenue, g.tapdash_net_before_split, g.total_buy_rate,
           -- The group's stated buy side is the SUM over its member lines;
           -- residual_line_groups stores the stated NET but not the stated
           -- expense, so step 2 at group grain has to add it up here.
           (select sum(l2.agent_expense)
              from public.residual_lines l2
              join rule_shape rs2 on rs2.fin = l2.fee_item_name
             where l2.period_id = p_period_id
               and l2.deleted_at is null
               and l2.mid = g.mid
               and rs2.gkey = g.group_key) as stated_expense,
           -- A group is step-2 exempt when its ANCHOR is: the anchor carries
           -- the terms, so the anchor's shape is the group's shape.
           (select bool_and(rs3.step2_exempt)
              from rule_shape rs3
              join public.residual_formula_rules ru3 on ru3.id = rs3.rule_id
             where rs3.gkey = g.group_key
               and ru3.is_group_anchor) as step2_exempt
      from public.residual_line_groups g
     where g.period_id = p_period_id
       and g.deleted_at is null
       and (v_mid is null or g.mid = v_mid)
  ),
  -- ---------- every comparison, before acks ----------
  raw as (
    -- step 1 (line grain, mapped rows with a usable volume row)
    select 'line'::text as sc, s1.id as sid, s1.lmid as m, s1.fin as fi,
           s1.gkey as gk, 1::smallint as st,
           false as exempt, s1.lv as lv, s1.rv as rv, v_t1 as tol
      from s1
     where not s1.any_bucket_null

    union all
    -- step 2 (line grain, non-group-member lines)
    select 'line', ln.id, ln.lmid, ln.fin, ln.gkey, 2::smallint,
           ln.step2_exempt, ln.agent_expense, ln.total_buy_rate, v_t2
      from ln
     where ln.gkey is null
       and (ln.step2_exempt or (ln.agent_expense is not null
                                and ln.total_buy_rate is not null))

    union all
    -- step 3 (line grain, non-group-member lines)
    select 'line', ln.id, ln.lmid, ln.fin, ln.gkey, 3::smallint,
           false, ln.net_revenue, ln.tapdash_net_before_split, v_t3
      from ln
     where ln.gkey is null
       and ln.net_revenue is not null
       and ln.tapdash_net_before_split is not null

    union all
    -- step 2 (group grain)
    select 'group', grp.id, grp.gmid, null, grp.gkey, 2::smallint,
           coalesce(grp.step2_exempt, false), grp.stated_expense, grp.total_buy_rate, v_t2
      from grp
     where coalesce(grp.step2_exempt, false)
        or (grp.stated_expense is not null and grp.total_buy_rate is not null)

    union all
    -- step 3 (group grain)
    select 'group', grp.id, grp.gmid, null, grp.gkey, 3::smallint,
           false, grp.stated_net_revenue, grp.tapdash_net_before_split, v_t3
      from grp
     where grp.stated_net_revenue is not null
       and grp.tapdash_net_before_split is not null
  ),
  scored as (
    select raw.*,
           case when raw.exempt then null::numeric
                else round(raw.rv - raw.lv, 4) end as d
      from raw
  )
  select s.sc,
         s.sid,
         s.m,
         s.fi,
         s.gk,
         s.st,
         case when s.exempt              then 'exempt'
              when abs(s.d) <= s.tol     then 'match'
              else                            'mismatch' end,
         s.lv,
         s.rv,
         s.d,
         s.tol,
         a.id,
         -- SUPPRESSION, rule 2. A live ack suppresses only while the delta it
         -- forgave is still the delta, judged by the tolerance IN FORCE NOW
         -- rather than the one captured on the ack: if the bound has since
         -- tightened, an old forgiveness should not go on being honoured under
         -- the looser rule it was written under.
         (a.id is not null
          and not s.exempt
          and abs(s.d) > s.tol
          and abs(s.d - a.delta_acknowledged) <= s.tol) as suppressed
    from scored s
    left join public.residual_verdict_acknowledgments a
           on coalesce(a.line_id, a.group_id) = s.sid
          and a.step = s.st
          and a.retired_at is null
          and a.deleted_at is null
   order by s.m, s.sc, s.fi nulls last, s.gk nulls last, s.st;
end;
$function$;

-- residual_volume_mapping_coverage → residuals
CREATE OR REPLACE FUNCTION public.residual_volume_mapping_coverage(p_period_id uuid)
 RETURNS TABLE(fee_item_name text, line_count bigint, is_mapped boolean, buckets text[], basis text, bucket_detail jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_month date;
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to read volume mapping coverage.'
      using errcode = '42501';
  end if;

  select p.statement_month into v_month
    from public.residual_periods p
   where p.id = p_period_id and p.deleted_at is null;

  if v_month is null then
    raise exception 'No live residual period with id %.', p_period_id
      using errcode = 'P0002';
  end if;

  return query
    with period_items as (
      select l.fee_item_name as fin, count(*) as n
        from public.residual_lines l
       where l.period_id = p_period_id
         and l.deleted_at is null
         and l.fee_item_name is not null
       group by l.fee_item_name
    ),
    -- Mappings reachable from ANY live registry, matched by name. Deliberately
    -- not filtered to the registry in force: a fee item mapped in the
    -- predecessor registry and not the current one is a mapping gap worth
    -- seeing, not a row to hide.
    --
    -- DISTINCT on the bucket and its properties together, because both
    -- registries carry the same mapping and an un-deduplicated list would
    -- show every bucket twice.
    rows_in as (
      select distinct
             ru.fee_item_name as fin,
             m.volume_bucket,
             m.basis,
             m.applies_when,
             m.sibling_fee_item_name
        from public.residual_volume_row_mappings m
        join public.residual_formula_rules ru on ru.id = m.rule_id
       where m.deleted_at is null and ru.deleted_at is null
    ),
    mapped as (
      select r.fin,
             array_agg(distinct r.volume_bucket order by r.volume_bucket) as bks,
             case
               when bool_and(r.basis = 'net')   then 'net'
               when bool_and(r.basis = 'gross') then 'gross'
               else 'mixed'
             end as bas,
             jsonb_agg(
               jsonb_build_object(
                 'bucket',       r.volume_bucket,
                 'basis',        r.basis,
                 'applies_when', r.applies_when,
                 'sibling',      r.sibling_fee_item_name
               )
               order by r.volume_bucket
             ) as detail
        from rows_in r
       group by r.fin
    )
    select pi.fin,
           pi.n,
           (mp.bks is not null),
           mp.bks,
           mp.bas,
           coalesce(mp.detail, '[]'::jsonb)
      from period_items pi
      left join mapped mp on mp.fin = pi.fin
     order by (mp.bks is not null), pi.fin;
end;
$function$;

-- residual_withdraw_acknowledgment → residuals
CREATE OR REPLACE FUNCTION public.residual_withdraw_acknowledgment(p_ack_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_n     int;
begin
  if auth.uid() is null
     or not public.auth_admin_page('residuals') then
    raise exception 'Not authorized to withdraw a residual acknowledgment.'
      using errcode = '42501';
  end if;

  if v_actor is null then
    raise exception 'Withdrawing an acknowledgment requires an identified actor.'
      using errcode = '42501';
  end if;

  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Withdrawing an acknowledgment requires a reason.'
      using errcode = '22004';
  end if;

  update public.residual_verdict_acknowledgments
     set retired_at     = now(),
         retired_reason = 'withdrawn',
         retired_by_id  = v_actor,
         retired_note   = btrim(p_reason)
   where id = p_ack_id
     and retired_at is null
     and deleted_at is null;

  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'No live acknowledgment with id %.', p_ack_id
      using errcode = 'P0002',
            hint = 'It may already be retired.';
  end if;
end;
$function$;

-- restore_case → recycle_bin
CREATE OR REPLACE FUNCTION public.restore_case(p_case_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_record uuid;
  v_number bigint;
begin
  if not auth_admin_page('recycle_bin') then
    raise exception 'Only an admin may restore a case thread' using errcode = '42501';
  end if;
  select record_id, number into v_record, v_number
    from cases where id = p_case_id and deleted_at is not null;
  if v_record is null then
    raise exception 'not found';
  end if;

  update cases set deleted_at = null where id = p_case_id;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (v_record, auth.uid(), 'case', format('Restored case #%s from the Recycle Bin', v_number));
end;
$function$;

-- restore_case_reply → recycle_bin
CREATE OR REPLACE FUNCTION public.restore_case_reply(p_reply_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_record uuid;
  v_number bigint;
begin
  if not auth_admin_page('recycle_bin') then
    raise exception 'Only an admin may restore a case reply' using errcode = '42501';
  end if;
  select c.record_id, c.number into v_record, v_number
    from case_replies r join cases c on c.id = r.case_id
   where r.id = p_reply_id and r.deleted_at is not null;
  if v_record is null then
    raise exception 'not found';
  end if;

  -- Refused while the thread itself is deleted: a reply cannot be live under a
  -- thread that is not. Restore the thread first, which brings its replies with
  -- it anyway.
  if exists (select 1 from case_replies r join cases c on c.id = r.case_id
              where r.id = p_reply_id and c.deleted_at is not null) then
    raise exception 'Restore the case thread first — this reply belongs to a deleted thread'
      using errcode = '23514';
  end if;

  update case_replies set deleted_at = null where id = p_reply_id;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (v_record, auth.uid(), 'case', format('Restored a reply on case #%s', v_number));
end;
$function$;

-- restore_file → recycle_bin
CREATE OR REPLACE FUNCTION public.restore_file(p_file_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_record uuid;
  v_name   text;
  v_row    uuid;
begin
  if not auth_admin_page('recycle_bin') then
    raise exception 'Only an admin may restore from the Recycle Bin' using errcode = '42501';
  end if;
  select fr.record_id, f.name, f.file_row_id into v_record, v_name, v_row
    from files f join file_rows fr on fr.id = f.file_row_id
   where f.id = p_file_id and f.deleted_at is not null;
  if v_record is null then
    raise exception 'not found';
  end if;

  if exists (select 1 from file_rows where id = v_row and deleted_at is not null) then
    raise exception 'Restore the file row this file belongs to first' using errcode = '23514';
  end if;

  -- The five-per-row cap is enforced by a trigger on INSERT only, so an UPDATE
  -- that un-deletes could quietly push a row to six. Checked here instead.
  if (select count(*) from files where file_row_id = v_row and deleted_at is null) >= 5 then
    raise exception 'That file row already holds 5 files — remove one before restoring this'
      using errcode = '23514';
  end if;

  update files set deleted_at = null where id = p_file_id;

  insert into record_activity (record_id, actor_id, kind, summary, to_value)
  values (v_record, auth.uid(), 'file', 'Restored a file from the Recycle Bin', v_name);
end;
$function$;

-- restore_login → recycle_bin
CREATE OR REPLACE FUNCTION public.restore_login(p_login_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_record uuid;
  v_type   text;
begin
  if not auth_admin_page('recycle_bin') then
    raise exception 'Only an admin may restore from the Recycle Bin' using errcode = '42501';
  end if;
  select record_id, login_type into v_record, v_type
    from logins where id = p_login_id and deleted_at is not null;
  if v_record is null then
    raise exception 'not found';
  end if;

  update logins set deleted_at = null where id = p_login_id;

  -- 'credential' rather than 'record': the reveal log already uses it, so a
  -- record's credential history reads as one filterable thread.
  insert into record_activity (record_id, actor_id, kind, summary, to_value)
  values (v_record, auth.uid(), 'credential', 'Restored a login row from the Recycle Bin', v_type);
end;
$function$;

-- restore_record → recycle_bin
CREATE OR REPLACE FUNCTION public.restore_record(rec uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_name     text;
  v_conflict uuid;
begin
  if not auth_admin_page('recycle_bin') then
    raise exception 'Admin only' using errcode = '42501';
  end if;

  select deal_name into v_name from records where id = rec and deleted_at is not null;
  if v_name is null then
    raise exception 'not found';
  end if;

  -- Checked here rather than left to the unique index, so the caller gets the
  -- blocking record's id and can build the message the client asked for.
  -- `errcode 23505` is kept deliberately: any caller that already treats a
  -- duplicate as a duplicate keeps working, and the id rides in the hint.
  v_conflict := deal_name_conflict(v_name, rec);
  if v_conflict is not null then
    raise exception 'A record named % already exists.', v_name
      using errcode = '23505', hint = v_conflict::text;
  end if;

  update records set deleted_at = null where id = rec;

  -- The archive-before-delete rule (Modules Amendment 1) means a record always
  -- holds zero display memberships by the time it can be deleted, so "the exact
  -- set of memberships it held at the moment of deletion" (Overview §3.5) is
  -- always the empty set. Admin Plan §6 names that case explicitly as valid.
  insert into record_activity (record_id, actor_id, kind, summary)
  values (rec, auth.uid(), 'record', 'Restored from the Recycle Bin — archived (no display memberships)');
end;
$function$;

-- restore_update → recycle_bin
CREATE OR REPLACE FUNCTION public.restore_update(p_update_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_record uuid;
  v_parent uuid;
begin
  if not auth_admin_page('recycle_bin') then
    raise exception 'Only an admin may restore from the Recycle Bin' using errcode = '42501';
  end if;
  select record_id, parent_id into v_record, v_parent
    from updates where id = p_update_id and deleted_at is not null;
  if v_record is null then
    raise exception 'not found';
  end if;

  -- A reply cannot be live under a deleted parent — `updates_depth_guard`
  -- keeps the tree one level deep, and this keeps it connected.
  if v_parent is not null
     and exists (select 1 from updates where id = v_parent and deleted_at is not null) then
    raise exception 'Restore the update this reply belongs to first'
      using errcode = '23514';
  end if;

  update updates set deleted_at = null where id = p_update_id;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (v_record, auth.uid(), 'update',
          case when v_parent is null then 'Restored an update from the Recycle Bin'
               else 'Restored a reply from the Recycle Bin' end);
end;
$function$;

-- restore_user → users
CREATE OR REPLACE FUNCTION public.restore_user(p_user uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_email text;
begin
  if not auth_admin_page('users') then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  select email into v_email from profiles where id = p_user and deleted_at is not null;
  if v_email is null then
    raise exception 'not found';
  end if;

  -- Comes back SUSPENDED, not active. Restoring an account and silently
  -- re-enabling sign-in are two decisions, and an admin should make the second
  -- one deliberately with Resume.
  update profiles set deleted_at = null, status = 'suspended' where id = p_user;

  insert into auth_audit_log (actor_id, event_type, email_attempted, metadata)
  values (auth.uid(), 'user_restored', v_email, jsonb_build_object('user_id', p_user));
end;
$function$;

-- soft_delete_user → users
CREATE OR REPLACE FUNCTION public.soft_delete_user(p_user uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_left  bigint;
  v_email text;
begin
  if not auth_admin_page('users') then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if p_user = auth.uid() then
    raise exception 'You cannot delete your own account' using errcode = '23514';
  end if;

  select email into v_email from profiles where id = p_user and deleted_at is null;
  if v_email is null then
    raise exception 'not found';
  end if;

  -- Re-counted at write time, never trusted from the caller.
  v_left := count_user_records(p_user);
  if v_left > 0 then
    raise exception
      'Reassign this user''s % record(s) before deleting them', v_left
      using errcode = '23514';
  end if;

  update profiles
     set deleted_at = now(),
         status = 'suspended',
         -- Every existing session dies with the account, the same lever
         -- `pauseUser` already pulls.
         sessions_valid_from = now()
   where id = p_user;

  -- Columns are event_type/metadata (migration 1), and the table is
  -- append-only at the database, so this entry cannot later be tidied away.
  insert into auth_audit_log (actor_id, event_type, email_attempted, metadata)
  values (auth.uid(), 'user_soft_deleted', v_email, jsonb_build_object('user_id', p_user));
end;
$function$;

drop policy if exists "auth_audit_select_admin" on public.auth_audit_log;
create policy "auth_audit_select_admin" on public.auth_audit_log as permissive for select to authenticated
  using (auth_admin_page('users'));

drop policy if exists "ivr_extensions_admin_all" on public.ivr_extensions;
create policy "ivr_extensions_admin_all" on public.ivr_extensions as permissive for all to authenticated
  using (auth_admin_page('numbers'))
  with check (auth_admin_page('numbers'));

drop policy if exists "ivr_hours_admin_all" on public.ivr_hours;
create policy "ivr_hours_admin_all" on public.ivr_hours as permissive for all to authenticated
  using (auth_admin_page('numbers'))
  with check (auth_admin_page('numbers'));

drop policy if exists "ivr_prompts_admin_all" on public.ivr_prompts;
create policy "ivr_prompts_admin_all" on public.ivr_prompts as permissive for all to authenticated
  using (auth_admin_page('numbers'))
  with check (auth_admin_page('numbers'));

drop policy if exists "ivr_settings_admin_all" on public.ivr_settings;
create policy "ivr_settings_admin_all" on public.ivr_settings as permissive for all to authenticated
  using (auth_admin_page('numbers'))
  with check (auth_admin_page('numbers'));

drop policy if exists "ivr_voicemail_deliveries_admin_select" on public.ivr_voicemail_deliveries;
create policy "ivr_voicemail_deliveries_admin_select" on public.ivr_voicemail_deliveries as permissive for select to authenticated
  using (auth_admin_page('numbers'));

drop policy if exists "residual_files_delete_admin" on storage.objects;
create policy "residual_files_delete_admin" on storage.objects as permissive for delete to authenticated
  using (((bucket_id = 'residual-files'::text) AND auth_admin_page('residuals')));

drop policy if exists "residual_files_insert_admin" on storage.objects;
create policy "residual_files_insert_admin" on storage.objects as permissive for insert to authenticated
  with check (((bucket_id = 'residual-files'::text) AND auth_admin_page('residuals')));

drop policy if exists "residual_files_select_admin" on storage.objects;
create policy "residual_files_select_admin" on storage.objects as permissive for select to authenticated
  using (((bucket_id = 'residual-files'::text) AND auth_admin_page('residuals')));

drop policy if exists "residual_audit_log_select" on public.residual_audit_log;
create policy "residual_audit_log_select" on public.residual_audit_log as permissive for select to authenticated
  using (auth_admin_page('residuals'));

drop policy if exists "residual_buy_rate_schedules_insert" on public.residual_buy_rate_schedules;
create policy "residual_buy_rate_schedules_insert" on public.residual_buy_rate_schedules as permissive for insert to authenticated
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_buy_rate_schedules_select" on public.residual_buy_rate_schedules;
create policy "residual_buy_rate_schedules_select" on public.residual_buy_rate_schedules as permissive for select to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)));

drop policy if exists "residual_buy_rate_schedules_update" on public.residual_buy_rate_schedules;
create policy "residual_buy_rate_schedules_update" on public.residual_buy_rate_schedules as permissive for update to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)))
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_buy_rate_tiers_insert" on public.residual_buy_rate_tiers;
create policy "residual_buy_rate_tiers_insert" on public.residual_buy_rate_tiers as permissive for insert to authenticated
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_buy_rate_tiers_select" on public.residual_buy_rate_tiers;
create policy "residual_buy_rate_tiers_select" on public.residual_buy_rate_tiers as permissive for select to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)));

drop policy if exists "residual_buy_rate_tiers_update" on public.residual_buy_rate_tiers;
create policy "residual_buy_rate_tiers_update" on public.residual_buy_rate_tiers as permissive for update to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)))
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_buy_rates_insert" on public.residual_buy_rates;
create policy "residual_buy_rates_insert" on public.residual_buy_rates as permissive for insert to authenticated
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_buy_rates_select" on public.residual_buy_rates;
create policy "residual_buy_rates_select" on public.residual_buy_rates as permissive for select to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)));

drop policy if exists "residual_buy_rates_update" on public.residual_buy_rates;
create policy "residual_buy_rates_update" on public.residual_buy_rates as permissive for update to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)))
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_calc_failures_select" on public.residual_calc_failures;
create policy "residual_calc_failures_select" on public.residual_calc_failures as permissive for select to authenticated
  using (auth_admin_page('residuals'));

drop policy if exists "residual_calc_runs_select" on public.residual_calc_runs;
create policy "residual_calc_runs_select" on public.residual_calc_runs as permissive for select to authenticated
  using (auth_admin_page('residuals'));

drop policy if exists "residual_column_mappings_insert" on public.residual_column_mappings;
create policy "residual_column_mappings_insert" on public.residual_column_mappings as permissive for insert to authenticated
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_column_mappings_select" on public.residual_column_mappings;
create policy "residual_column_mappings_select" on public.residual_column_mappings as permissive for select to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)));

drop policy if exists "residual_column_mappings_update" on public.residual_column_mappings;
create policy "residual_column_mappings_update" on public.residual_column_mappings as permissive for update to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)))
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_fee_items_insert" on public.residual_fee_items;
create policy "residual_fee_items_insert" on public.residual_fee_items as permissive for insert to authenticated
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_fee_items_select" on public.residual_fee_items;
create policy "residual_fee_items_select" on public.residual_fee_items as permissive for select to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)));

drop policy if exists "residual_fee_items_update" on public.residual_fee_items;
create policy "residual_fee_items_update" on public.residual_fee_items as permissive for update to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)))
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_formula_registries_insert" on public.residual_formula_registries;
create policy "residual_formula_registries_insert" on public.residual_formula_registries as permissive for insert to authenticated
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_formula_registries_select" on public.residual_formula_registries;
create policy "residual_formula_registries_select" on public.residual_formula_registries as permissive for select to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)));

drop policy if exists "residual_formula_registries_update" on public.residual_formula_registries;
create policy "residual_formula_registries_update" on public.residual_formula_registries as permissive for update to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)))
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_formula_rules_insert" on public.residual_formula_rules;
create policy "residual_formula_rules_insert" on public.residual_formula_rules as permissive for insert to authenticated
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_formula_rules_select" on public.residual_formula_rules;
create policy "residual_formula_rules_select" on public.residual_formula_rules as permissive for select to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)));

drop policy if exists "residual_formula_rules_update" on public.residual_formula_rules;
create policy "residual_formula_rules_update" on public.residual_formula_rules as permissive for update to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)))
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_formula_terms_insert" on public.residual_formula_terms;
create policy "residual_formula_terms_insert" on public.residual_formula_terms as permissive for insert to authenticated
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_formula_terms_select" on public.residual_formula_terms;
create policy "residual_formula_terms_select" on public.residual_formula_terms as permissive for select to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)));

drop policy if exists "residual_formula_terms_update" on public.residual_formula_terms;
create policy "residual_formula_terms_update" on public.residual_formula_terms as permissive for update to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)))
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_imports_insert" on public.residual_imports;
create policy "residual_imports_insert" on public.residual_imports as permissive for insert to authenticated
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_imports_select" on public.residual_imports;
create policy "residual_imports_select" on public.residual_imports as permissive for select to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)));

drop policy if exists "residual_imports_update" on public.residual_imports;
create policy "residual_imports_update" on public.residual_imports as permissive for update to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)))
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_line_groups_insert" on public.residual_line_groups;
create policy "residual_line_groups_insert" on public.residual_line_groups as permissive for insert to authenticated
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_line_groups_select" on public.residual_line_groups;
create policy "residual_line_groups_select" on public.residual_line_groups as permissive for select to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)));

drop policy if exists "residual_line_groups_update" on public.residual_line_groups;
create policy "residual_line_groups_update" on public.residual_line_groups as permissive for update to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)))
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_lines_insert" on public.residual_lines;
create policy "residual_lines_insert" on public.residual_lines as permissive for insert to authenticated
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_lines_select" on public.residual_lines;
create policy "residual_lines_select" on public.residual_lines as permissive for select to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)));

drop policy if exists "residual_lines_update" on public.residual_lines;
create policy "residual_lines_update" on public.residual_lines as permissive for update to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)))
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_merchant_rates_insert" on public.residual_merchant_rates;
create policy "residual_merchant_rates_insert" on public.residual_merchant_rates as permissive for insert to authenticated
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_merchant_rates_select" on public.residual_merchant_rates;
create policy "residual_merchant_rates_select" on public.residual_merchant_rates as permissive for select to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)));

drop policy if exists "residual_merchant_rates_update" on public.residual_merchant_rates;
create policy "residual_merchant_rates_update" on public.residual_merchant_rates as permissive for update to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)))
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_merchant_vendor_costs_insert" on public.residual_merchant_vendor_costs;
create policy "residual_merchant_vendor_costs_insert" on public.residual_merchant_vendor_costs as permissive for insert to authenticated
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_merchant_vendor_costs_select" on public.residual_merchant_vendor_costs;
create policy "residual_merchant_vendor_costs_select" on public.residual_merchant_vendor_costs as permissive for select to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)));

drop policy if exists "residual_merchant_vendor_costs_update" on public.residual_merchant_vendor_costs;
create policy "residual_merchant_vendor_costs_update" on public.residual_merchant_vendor_costs as permissive for update to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)))
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_merchant_volumes_insert" on public.residual_merchant_volumes;
create policy "residual_merchant_volumes_insert" on public.residual_merchant_volumes as permissive for insert to authenticated
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_merchant_volumes_select" on public.residual_merchant_volumes;
create policy "residual_merchant_volumes_select" on public.residual_merchant_volumes as permissive for select to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)));

drop policy if exists "residual_merchant_volumes_update" on public.residual_merchant_volumes;
create policy "residual_merchant_volumes_update" on public.residual_merchant_volumes as permissive for update to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)))
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_mid_partners_insert" on public.residual_mid_partners;
create policy "residual_mid_partners_insert" on public.residual_mid_partners as permissive for insert to authenticated
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_mid_partners_select" on public.residual_mid_partners;
create policy "residual_mid_partners_select" on public.residual_mid_partners as permissive for select to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)));

drop policy if exists "residual_mid_partners_update" on public.residual_mid_partners;
create policy "residual_mid_partners_update" on public.residual_mid_partners as permissive for update to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)))
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_partners_insert" on public.residual_partners;
create policy "residual_partners_insert" on public.residual_partners as permissive for insert to authenticated
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_partners_select" on public.residual_partners;
create policy "residual_partners_select" on public.residual_partners as permissive for select to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)));

drop policy if exists "residual_partners_update" on public.residual_partners;
create policy "residual_partners_update" on public.residual_partners as permissive for update to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)))
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_period_status_log_select" on public.residual_period_status_log;
create policy "residual_period_status_log_select" on public.residual_period_status_log as permissive for select to authenticated
  using (auth_admin_page('residuals'));

drop policy if exists "residual_periods_insert" on public.residual_periods;
create policy "residual_periods_insert" on public.residual_periods as permissive for insert to authenticated
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_periods_select" on public.residual_periods;
create policy "residual_periods_select" on public.residual_periods as permissive for select to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)));

drop policy if exists "residual_periods_update" on public.residual_periods;
create policy "residual_periods_update" on public.residual_periods as permissive for update to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)))
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_plan_code_buckets_insert" on public.residual_plan_code_buckets;
create policy "residual_plan_code_buckets_insert" on public.residual_plan_code_buckets as permissive for insert to authenticated
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_plan_code_buckets_update" on public.residual_plan_code_buckets;
create policy "residual_plan_code_buckets_update" on public.residual_plan_code_buckets as permissive for update to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)))
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_plan_volumes_insert" on public.residual_plan_volumes;
create policy "residual_plan_volumes_insert" on public.residual_plan_volumes as permissive for insert to authenticated
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_plan_volumes_select" on public.residual_plan_volumes;
create policy "residual_plan_volumes_select" on public.residual_plan_volumes as permissive for select to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)));

drop policy if exists "residual_plan_volumes_update" on public.residual_plan_volumes;
create policy "residual_plan_volumes_update" on public.residual_plan_volumes as permissive for update to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)))
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_risk_tiers_insert" on public.residual_risk_tiers;
create policy "residual_risk_tiers_insert" on public.residual_risk_tiers as permissive for insert to authenticated
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_risk_tiers_select" on public.residual_risk_tiers;
create policy "residual_risk_tiers_select" on public.residual_risk_tiers as permissive for select to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)));

drop policy if exists "residual_risk_tiers_update" on public.residual_risk_tiers;
create policy "residual_risk_tiers_update" on public.residual_risk_tiers as permissive for update to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)))
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_verdict_acks_insert" on public.residual_verdict_acknowledgments;
create policy "residual_verdict_acks_insert" on public.residual_verdict_acknowledgments as permissive for insert to authenticated
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_verdict_acks_select" on public.residual_verdict_acknowledgments;
create policy "residual_verdict_acks_select" on public.residual_verdict_acknowledgments as permissive for select to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)));

drop policy if exists "residual_verdict_acks_update" on public.residual_verdict_acknowledgments;
create policy "residual_verdict_acks_update" on public.residual_verdict_acknowledgments as permissive for update to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)))
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_verdict_tolerances_insert" on public.residual_verdict_tolerances;
create policy "residual_verdict_tolerances_insert" on public.residual_verdict_tolerances as permissive for insert to authenticated
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_verdict_tolerances_select" on public.residual_verdict_tolerances;
create policy "residual_verdict_tolerances_select" on public.residual_verdict_tolerances as permissive for select to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)));

drop policy if exists "residual_verdict_tolerances_update" on public.residual_verdict_tolerances;
create policy "residual_verdict_tolerances_update" on public.residual_verdict_tolerances as permissive for update to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)))
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_volume_row_mappings_insert" on public.residual_volume_row_mappings;
create policy "residual_volume_row_mappings_insert" on public.residual_volume_row_mappings as permissive for insert to authenticated
  with check (auth_admin_page('residuals'));

drop policy if exists "residual_volume_row_mappings_select" on public.residual_volume_row_mappings;
create policy "residual_volume_row_mappings_select" on public.residual_volume_row_mappings as permissive for select to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)));

drop policy if exists "residual_volume_row_mappings_update" on public.residual_volume_row_mappings;
create policy "residual_volume_row_mappings_update" on public.residual_volume_row_mappings as permissive for update to authenticated
  using ((auth_admin_page('residuals') AND (deleted_at IS NULL)))
  with check (auth_admin_page('residuals'));
