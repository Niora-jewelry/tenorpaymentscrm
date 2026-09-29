-- Ported from Daniel Weissman's residuals branch, file
-- `20260901140000_residuals_merchant_rate_editor_r5d3.sql`.
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
-- Residuals R5d Part 3 — the per-merchant rate editor
-- ============================================================
--
-- WHAT CHANGED IN THE UNIT OF WORK. R5d 1c's compact editor edited ONE FIELD
-- across MANY merchants, because monthly_fee_tapdash was 0-of-33 and was the
-- only thing standing between the module and a number. That was the right
-- shape for that moment and it is the wrong shape now: the May run failed on
-- six different merchant rate columns, not one, and it failed on them merchant
-- by merchant. A screen organised by column makes the operator visit six
-- screens to finish one merchant.
--
-- So the unit is a merchant's WHOLE rate row — fourteen rates plus the risk
-- tier, one merchant at a time. These two functions are what that screen
-- reads and writes.
--
-- STILL IN-PLACE, STILL NOT A SUCCESSOR, and the R5d 1c argument is unchanged
-- and is enforced by the database rather than restated here: filling in a
-- value the sheet lacked, for a merchant whose standing version has never
-- produced a number, is a correction rather than a repricing.
-- tg_residual_merchant_rates_guard_locked decides which of those it is, and
-- the moment a version has been used it raises 42501 and the screen offers the
-- successor form instead.
--
-- Idempotent throughout.

begin;

-- ============================================================
-- 1. residual_merchant_rate_editor — everything the screen needs, once
-- ============================================================
-- ONE CALL, because the screen asks one question — "what should I type for
-- this merchant, and what is currently blocking it?" — whose answer is spread
-- across four tables. Assembling it client-side would be four round trips to
-- render one form, which is the N+1 R5d 1c already removed once.
--
-- THE FIELD FAILURES ARE READ FROM rate_ref, NOT DERIVED FROM THE REGISTRY.
-- 20260901120000 added that column precisely so this join exists; the
-- reasoning for preferring recorded fact over registry inference is in that
-- migration's header, and it comes down to first-failure-wins meaning the
-- registry would name fields the run never actually complained about.
--
-- A MERCHANT-SCOPE FAILURE IS RETURNED SEPARATELY from the per-field ones,
-- because it means something categorically different: not "this field is
-- missing" but "this merchant has no rate row at all for the month, so no
-- field on this form is being read". The screen has to say that differently or
-- the operator fills in fourteen fields on a version the period cannot see.
create or replace function public.residual_merchant_rate_editor(
  p_mid       text,
  p_period_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_mid      text := regexp_replace(coalesce(p_mid, ''), '[^0-9]', '', 'g');
  v_period   record;
  v_standing public.residual_merchant_rates%rowtype;
  v_locked   boolean := false;
  v_versions int := 0;
  v_lines    int := 0;
  v_merchfail jsonb;
  v_fields   jsonb;
begin
  if auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to read merchant rates.'
      using errcode = '42501';
  end if;

  if v_mid = '' then
    raise exception 'residual_merchant_rate_editor: p_mid must contain digits.'
      using errcode = '22004';
  end if;

  -- The period whose last run the failures belong to. Defaults to the most
  -- recent, which is what the screen shows when nothing is chosen.
  select p.id, p.statement_month, p.status, p.calculation_version
    into v_period
    from public.residual_periods p
   where p.deleted_at is null
     and (p_period_id is null or p.id = p_period_id)
   order by p.statement_month desc
   limit 1;

  -- The STANDING version — the open-ended one. The no-overlap EXCLUDE makes it
  -- unique per MID, so this is a lookup rather than a choice.
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

    -- rate_ref -> { n, reason_code, detail, fee_items[] }.
    --
    -- GROUPED, because first-failure-wins is per LINE, not per merchant: eight
    -- lines can each stop on the same missing rate, and eight identical
    -- warnings beside one input is noise. The fee items are carried so the
    -- operator can see WHICH lines are waiting on this field.
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

  return jsonb_build_object(
    'mid', v_mid,
    'period', case when v_period.id is null then null else jsonb_build_object(
        'id', v_period.id,
        'statement_month', to_char(v_period.statement_month, 'YYYY-MM-DD'),
        'status', v_period.status,
        'calculation_version', v_period.calculation_version) end,
    'line_count', v_lines,
    'version_count', v_versions,
    -- to_jsonb of the row, so adding a rate column to the table reaches the
    -- editor without a change here. The audit columns are dropped because the
    -- form has no use for them.
    'standing', case when v_standing.id is null then null
                     else (to_jsonb(v_standing)
                           - 'created_by_id' - 'updated_by_id'
                           - 'deleted_at' - 'deleted_by_id') end,
    'is_locked', v_locked,
    'merchant_failure', v_merchfail,
    'field_failures', coalesce(v_fields, '{}'::jsonb)
  );
end;
$$;

comment on function public.residual_merchant_rate_editor(text, uuid) is
  'Everything the per-merchant rate editor needs in one call: the standing rate version, whether a computed period locks it, how many versions exist, and — from the last run of the chosen period — the merchant-scope failure and the per-field failures keyed by residual_calc_failures.rate_ref. Field failures are grouped by rate_ref because first-failure-wins is per line, so one missing rate produces one warning rather than one per line.';

revoke all on function public.residual_merchant_rate_editor(text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_merchant_rate_editor(text, uuid)
  to authenticated;

-- ============================================================
-- 2. residual_update_merchant_rate_row — the whole row, one statement
-- ============================================================
-- REPLACES setMerchantRateFieldAction's single-column UPDATE. That action was
-- argued as one atomic statement needing no RPC, and the argument held while
-- the screen edited one column. It does not hold for fifteen: saving them as
-- fifteen UPDATEs would let a merchant end up half-saved, and saving them as
-- one UPDATE built in TypeScript would put the column allowlist in the client
-- layer, where the database cannot enforce it.
--
-- AN UNKNOWN KEY RAISES rather than being ignored. Silently dropping a
-- misspelled field would report success for a value that was never stored —
-- on a screen whose entire purpose is entering values that are currently
-- missing, that is the worst possible failure.
--
-- ABSENT KEY AND JSON null BOTH MEAN SQL NULL, the "no arrangement" state,
-- consistent with residual_supersede_merchant_rate. A whole-row save states
-- the whole row.
--
-- THE LOCK IS NOT CHECKED HERE. tg_residual_merchant_rates_guard_locked fires
-- on every guarded column and raises 42501 with the successor hint. Checking
-- it again in this function would be a second opinion that can drift from the
-- first, and the trigger is the one that cannot be bypassed.
create or replace function public.residual_update_merchant_rate_row(
  p_rate_id   uuid,
  p_risk_tier text,
  p_values    jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_bad   text;
  v_mid   text;
begin
  if auth.uid() is null
     or not public.auth_is_admin() then
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
$$;

comment on function public.residual_update_merchant_rate_row(uuid, text, jsonb) is
  'Saves a merchant''s whole rate row — fourteen rates, two provider names and the risk tier — in ONE statement. An unknown key raises rather than being ignored, because silently dropping a misspelled field would report success for a value that was never stored. Absent key and JSON null both mean SQL NULL, the "no arrangement" state. The lock is enforced by tg_residual_merchant_rates_guard_locked, not re-checked here.';

revoke all on function public.residual_update_merchant_rate_row(uuid, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_update_merchant_rate_row(uuid, text, jsonb)
  to authenticated;

commit;
