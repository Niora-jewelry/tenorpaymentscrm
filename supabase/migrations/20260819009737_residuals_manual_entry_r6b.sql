-- Ported from Daniel Weissman's residuals branch, file
-- `20260908130000_residuals_manual_entry_r6b.sql`.
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

-- ============================================================================
-- R6b part 2 of 2 — manual entry, and the boundary it must not cross.
-- ============================================================================
-- ORDERING: applies after 20260908120000.
--
-- SPEC 4.1 asks for hand entry and hand correction of statement data. SPEC 7
-- deliberately EXCLUDED an "override the engine's output" column from R5d, and
-- that exclusion stands: these functions edit INPUTS. They cannot reach an
-- engine column, and the way they cannot is structural rather than a promise.
--
-- THE ALLOWLIST IS THE INVALIDATION TRIGGER'S COLUMN LIST, which is also the
-- reconciled guard's column list. The schema already states that symmetry
-- twice — "THE CHANGES THAT INVALIDATE A CALCULATION ARE PRECISELY THE CHANGES
-- A RECONCILED PERIOD FORBIDS" — and stating it a third time here keeps it true
-- by construction rather than by memory:
--
--   if a column is editable here, editing it invalidates the calculation;
--   if editing it invalidates, a reconciled period forbids it.
--
-- An engine column satisfies neither, so it cannot be in the list.
--
-- AN UNKNOWN KEY RAISES. It is not ignored. residual_update_merchant_rate_row
-- settled this in R5d Part 3 — "silently dropping a misspelled field would
-- report success for a value that was never stored" — and the same reasoning
-- applies with more force here, because the misspelled field might be
-- 'net_income'.
--
-- ABSENT AND NULL MEAN DIFFERENT THINGS HERE, and this is the ONE place in the
-- module where they do. The rate editors take a jsonb that states a merchant's
-- WHOLE rate card, so there "absent" and "JSON null" both mean SQL NULL. A
-- manual edit is a PATCH on one or two cells of an existing row: absent means
-- "leave this column alone" and JSON null means "set it to NULL". Collapsing
-- them would make every single-cell edit silently blank every other cell.
--
-- NO RECONCILED CHECK IN THESE FUNCTIONS. tg_residual_guard_reconciled_period
-- already refuses every one of these writes and raises naming the month with a
-- hint to reopen. Re-checking here would be a second statement of a rule that
-- already has one, and the second copy is the one that stops matching.

begin;

-- ============================================================
-- 1. residual_insert_manual_line
-- ============================================================
-- source = 'manual' and import_id = NULL, which residual_lines_provenance_
-- consistent requires as an equivalence in both directions. That pairing is
-- also what makes the row survive a later re-import: R4a's supersede sweep
-- soft-deletes "every line from the superseded import", and a line belonging
-- to no import is spared. A hand-entered correction is meant to outlive the
-- next upload.
--
-- THE FEE ITEM NAME IS NOT VALIDATED against the registry, deliberately. An
-- unrecognised name is news, and the engine already raises unknown_fee_item and
-- names the offending value. Pre-validating here would move that refusal
-- earlier at the cost of a second implementation of the registry's matching
-- rule, and the two would drift.
create or replace function public.residual_insert_manual_line(
  p_period_id uuid,
  p_values    jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
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
  if public.auth.uid() is null
     or not public.auth_is_admin() then
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
$$;

comment on function public.residual_insert_manual_line(uuid, jsonb) is
  'Adds a hand-entered statement line: source = manual and import_id NULL, the pairing residual_lines_provenance_consistent requires and the one that makes the row survive a later re-import, because the supersede sweep spares lines belonging to no import. An unknown key raises rather than being ignored.';

revoke all on function public.residual_insert_manual_line(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_insert_manual_line(uuid, jsonb)
  to authenticated;

-- ============================================================
-- 2. residual_update_line_stated
-- ============================================================
-- RETURNS before / after / changed_fields so the caller can write one audit row
-- without a second read. Doing it any other way means SELECT-then-UPDATE with a
-- gap in between, and the "before" an audit row claims would be a value that
-- might already have moved.
--
-- changed_fields LISTS ONLY COLUMNS WHOSE VALUE ACTUALLY MOVED, compared with
-- IS DISTINCT FROM so NULL-to-NULL is not a change. A save that changes nothing
-- returns an empty array, and the caller writes NO audit row — an audit trail
-- asserting a change that did not happen is worse than one row shorter.
create or replace function public.residual_update_line_stated(
  p_line_id uuid,
  p_values  jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
  if public.auth.uid() is null
     or not public.auth_is_admin() then
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
$$;

comment on function public.residual_update_line_stated(uuid, jsonb) is
  'Edits statement data on one line and returns before / after / changed_fields so the caller writes one audit row without a second read. An absent key leaves a column alone; a JSON null sets it to NULL - the opposite of the rate editors, because this is a patch on a row rather than a statement of a whole card. changed_fields lists only columns that actually moved, so a no-op save produces no audit row.';

revoke all on function public.residual_update_line_stated(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_update_line_stated(uuid, jsonb)
  to authenticated;

-- ============================================================
-- 3. residual_update_merchant_volumes
-- ============================================================
-- Spec 4.3 makes hand-entered volumes as valid as extracted ones, and R1b's
-- own comment agrees: manual entry "is exactly what a period sitting in
-- awaiting_volumes needs when the PDF is missing or unparseable".
--
-- UPSERT AT THE ENFORCED GRAIN. residual_merchant_volumes_period_mid_unique
-- makes one live row per (period, mid) the grain rather than a convention, so
-- this either updates the row that exists or creates the one that does not.
--
-- THE ROLLUP-PROVENANCE COLUMNS ARE NOT EDITABLE: stated_total, reconciled and
-- unmapped_volume are what residual_derive_plan_rollup concluded about a PDF,
-- not facts a human observed. Letting someone type over "did the plan rows add
-- up to the statement total" would overwrite a verdict with an opinion. A hand
-- entry states the four buckets and their counts; if the PDF's rollup is wrong,
-- the fix is the plan-code mapping, which R5a made re-derivable in place.
create or replace function public.residual_update_merchant_volumes(
  p_period_id uuid,
  p_mid       text,
  p_values    jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
  if public.auth.uid() is null
     or not public.auth_is_admin() then
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
$$;

comment on function public.residual_update_merchant_volumes(uuid, text, jsonb) is
  'Hand-enters or corrects the four statement volume buckets at the enforced (period, mid) grain, creating the row when none exists with source = manual and a NULL import_id. The PDF rollup''s own conclusions - stated_total, reconciled, unmapped_volume - are deliberately not editable: they are what the parser decided, not what a human observed.';

revoke all on function public.residual_update_merchant_volumes(uuid, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_update_merchant_volumes(uuid, text, jsonb)
  to authenticated;

commit;
