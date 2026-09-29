-- Ported from Daniel Weissman's residuals branch, file
-- `20260905130000_residuals_merchant_vendor_costs_editor_r5e.sql`.
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
-- Residuals R5e — the merchant vendor-costs editor
-- ============================================================
--
-- residual_merchant_vendor_costs has existed since R5c: per-MID, effective
-- dated, EXCLUDE-guarded, admin-gated — and with no UI and zero rows. It is
-- where a merchant gets attached to a vendor, and it is the screen nobody could
-- find because it did not exist.
--
-- Same shape and conventions as the merchant RATE editor, deliberately: one RPC
-- assembles everything the form needs, one RPC saves the whole row, and a
-- separate RPC opens a dated successor. An operator who has used one screen has
-- used the other.
--
-- ============================================================
-- NO LOCK, AND THAT IS AN ARGUMENT RATHER THAN AN OMISSION
-- ============================================================
--
-- The rate editor refuses an in-place edit once a computed, still-standing
-- period carries lines for that MID, because the engine READ those rates to
-- produce numbers somebody has seen.
--
-- NOTHING READS residual_merchant_vendor_costs. No formula term can reference
-- it — residual_formula_terms.rate_source is merchant | template | literal |
-- net_revenue, and "merchant" resolves against residual_merchant_rates, whose
-- legal column list is pinned by a CHECK that contains none of these columns.
-- So no computed period depends on a vendor-cost row, and a lock keyed on
-- "a computed period exists for this MID" would assert a dependency that does
-- not exist.
--
-- That is not hypothetical: 20260902130000 had to correct exactly this mistake
-- for buy-rate schedules, where an EMPTY computed period locked the whole
-- template on behalf of nothing. Adding a lock here would be repeating it
-- knowingly.
--
-- THE DATED SUCCESSOR IS STILL OFFERED, because effective dating is how vendor
-- pricing changes over time whether or not anything is locked — a merchant who
-- moves to a new gateway in March should not have February repriced. The choice
-- between correcting the standing row and opening a successor is the operator's
-- and is about what actually happened, not about what the database will permit.
--
-- WHEN SOMETHING DOES READ THESE ROWS — an R6 vendor-cost line, most likely —
-- the lock question becomes live and should be answered THEN, against the real
-- dependency, using residual_merchant_rate_is_locked as the model.
--
-- Idempotent throughout.

begin;

-- ============================================================
-- 1. The read
-- ============================================================
create or replace function public.residual_merchant_vendor_costs_editor(
  p_mid text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_mid       text := regexp_replace(coalesce(p_mid, ''), '[^0-9]', '', 'g');
  v_standing  public.residual_merchant_vendor_costs%rowtype;
  v_versions  int := 0;
begin
  if auth.uid() is null
     or not public.auth_is_admin() then
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
$$;

comment on function public.residual_merchant_vendor_costs_editor(text) is
  'Everything the merchant vendor-costs editor needs in one call: the standing effective-dated row, how many versions exist, and every open vendor rate card as {processor: {fee_item_key: rate}}. The cards are returned so the form can prefill on provider selection and, per field, say whether the merchant still matches the card — a comparison DERIVED at read time rather than stored, so a later card change shows up as a difference instead of leaving a merchant row that looks deliberate.';

revoke all on function public.residual_merchant_vendor_costs_editor(text)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_merchant_vendor_costs_editor(text)
  to authenticated;

-- ============================================================
-- 2. The whole-row save
-- ============================================================
-- ONE statement, the same argument as residual_update_merchant_rate_row: eleven
-- fields saved separately could half-succeed, and an allowlist built in
-- TypeScript is an allowlist the database cannot enforce.
--
-- ABSENT KEY AND JSON null BOTH MEAN SQL NULL — the "no arrangement" state the
-- rest of the module uses, and the reason the screen distinguishes it from an
-- explicit 0.
create or replace function public.residual_update_merchant_vendor_costs(
  p_id     uuid,
  p_values jsonb
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
$$;

comment on function public.residual_update_merchant_vendor_costs(uuid, jsonb) is
  'Saves a merchant''s whole vendor-cost row in ONE statement. An unknown key raises rather than being ignored, because silently dropping a misspelled field would report success for a value that was never stored. Absent key and JSON null both mean SQL NULL — the "no arrangement" state, which the screen shows as distinct from an explicit 0.';

revoke all on function public.residual_update_merchant_vendor_costs(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_update_merchant_vendor_costs(uuid, jsonb)
  to authenticated;

-- ============================================================
-- 3. The dated successor
-- ============================================================
-- ONE RPC, for the reason every supersede in this module is one RPC: the
-- EXCLUDE on (mid, daterange) is not deferrable, so the standing row must be
-- closed BEFORE its successor is inserted. Across two client calls a failure
-- between them leaves the merchant with no vendor costs in effect, or an
-- EXCLUDE violation.
create or replace function public.residual_supersede_merchant_vendor_costs(
  p_mid            text,
  p_effective_from date,
  p_values         jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mid      text := regexp_replace(coalesce(p_mid, ''), '[^0-9]', '', 'g');
  v_from     date := p_effective_from;
  v_actor    uuid := auth.uid();
  v_standing public.residual_merchant_vendor_costs%rowtype;
  v_new_id   uuid;
  v_closed   uuid;
begin
  if auth.uid() is null
     or not public.auth_is_admin() then
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
$$;

comment on function public.residual_supersede_merchant_vendor_costs(text, date, jsonb) is
  'Closes the standing vendor-cost row and inserts its dated successor, atomically. Must be one call: the EXCLUDE on (mid, daterange) is not deferrable, so close-then-insert is forced ordering and a failure between two client calls would leave the merchant with no vendor costs in effect. A successor states the merchant''s WHOLE vendor arrangement as of its date.';

revoke all on function public.residual_supersede_merchant_vendor_costs(text, date, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_supersede_merchant_vendor_costs(text, date, jsonb)
  to authenticated;

commit;
