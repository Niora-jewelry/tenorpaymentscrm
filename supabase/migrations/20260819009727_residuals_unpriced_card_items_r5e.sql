-- Ported from Daniel Weissman's residuals branch, file
-- `20260905120000_residuals_unpriced_card_items_r5e.sql`.
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
-- Residuals R5e — an item can be ON a card with no price recorded
-- ============================================================
--
-- TWO THINGS WERE INVISIBLE ON THE BUY-RATE SCREEN, and both come back to the
-- same gap: the grid builds its rows from RATE rows, so a fee item with no rate
-- has no row and cannot be seen, let alone filled in.
--
-- Q30 = A deliberately seeded Accept.Blue's two card-updater items with no
-- rates, so a lookup would raise rather than guess zero. That worked — the
-- engine reports missing_template_rate — but it also made them invisible
-- everywhere, which is the opposite of what an operator needs in order to enter
-- the missing price.
--
-- ============================================================
-- REVERSING AN EARLIER DECISION, AND SAYING SO
-- ============================================================
--
-- 20260901130000's residual_supersede_buy_rate_schedule dropped NULL-rate cells
-- rather than storing them, and argued:
--
--   "A NULL rate is DROPPED, not stored. The grid is ragged and an absent cell
--    is the representation of 'this tier has no template rate for this item'.
--    Storing a NULL rate row would be a second way to say the same thing, and
--    residual_buy_rates.rate would have to become nullable to allow it."
--
-- That was sound while absent and NULL meant the same thing. Q30 = A created a
-- case where they do NOT:
--
--   NO ROW          the item is not on this card at all.
--   ROW, rate NULL  the item IS on this card; nobody has recorded its price.
--
-- Those are different claims, and only the second one is something an operator
-- should be shown and asked to fill in. So rate becomes nullable, and the
-- earlier argument is superseded rather than quietly contradicted.
--
-- NOTHING DOWNSTREAM HAS TO CHANGE TO STAY SAFE. residual_eval_side already
-- reads the rate out of the buy map and reports missing_template_rate when it
-- is NULL, so a NULL-rate row and an absent row fail identically at calculation
-- time. The difference is purely in what the screen can show.
--
-- Idempotent throughout.

begin;

-- ============================================================
-- 1. rate becomes nullable
-- ============================================================
alter table public.residual_buy_rates
  alter column rate drop not null;

comment on column public.residual_buy_rates.rate is
  'The template rate, or NULL meaning "this fee item is on this card and nobody has recorded its price". NULL is NOT the same as having no row: no row means the item is not on the card at all. Both fail identically at calculation time — residual_eval_side reports missing_template_rate either way — but only a NULL-rate row is something the buy-rate screen can show an operator and ask them to fill in.';

-- ============================================================
-- 2. Accept.Blue's card-updater items get rows, priced NULL
-- ============================================================
-- They belong to that card: the sheet lists them under Accept.Blue with the
-- value column blank. Now they say so.
insert into public.residual_buy_rates
  (schedule_id, risk_tier, fee_item_key, rate, rate_cap)
select s.id, 'vendor_flat', v.fee_item_key, null, null
  from (values
    ('vendor_card_updater_monthly'),
    ('vendor_card_updater_per_update')
  ) as v(fee_item_key)
  join public.residual_buy_rate_schedules s
    on s.processor = 'ACCEPT_BLUE' and s.deleted_at is null
 where not exists (
   select 1 from public.residual_buy_rates b
    where b.schedule_id = s.id and b.fee_item_key = v.fee_item_key
      and b.deleted_at is null
 );

-- ============================================================
-- 3. A successor preserves the card's ITEM SET, not just its prices
-- ============================================================
-- The only change from 20260901130000 is that a NULL rate is now STORED rather
-- than skipped. The caller sends one cell per (tier, item) already on the card,
-- so storing them all is what makes "a successor states the WHOLE card"
-- literally true — including which items are on it and which are unpriced.
--
-- Dropping them, under the new meaning, would silently remove an unpriced item
-- from the card the moment anyone opened a successor: the operator would see
-- the row, leave it blank because they still do not know the price, and the
-- row would disappear.
create or replace function public.residual_supersede_buy_rate_schedule(
  p_processor      text,
  p_effective_from date,
  p_label          text,
  p_tiers          jsonb,
  p_cells          jsonb,
  p_notes          text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
  if public.auth.uid() is null
     or not public.auth_is_admin() then
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
$$;

comment on function public.residual_supersede_buy_rate_schedule(text, date, text, jsonb, jsonb, text) is
  'Closes the standing buy-rate schedule and opens its dated successor — schedule, tiers and grid cells — atomically. tapdash_share is accepted ONLY in p_tiers, never as a grid cell. A successor states the WHOLE card: every cell sent is stored, INCLUDING one with a NULL rate, which means "this item is on the card and nobody has recorded its price". Sending no cell for an item removes it from the card.';

revoke all on function public.residual_supersede_buy_rate_schedule(text, date, text, jsonb, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_supersede_buy_rate_schedule(text, date, text, jsonb, jsonb, text)
  to authenticated;

-- ============================================================
-- 4. Does a formula registry cover this month for this payer?
-- ============================================================
-- THE GRID'S HIDDEN-ROWS RULE ONLY MAKES SENSE WHERE THERE IS A REGISTRY.
--
-- R5d Part 3 moved fee items out of the grid when no template term in the
-- month's registry referenced them. For MAVERICK that is right: an unreferenced
-- rate like `chargeback` is an anomaly worth seeing behind a disclosure.
--
-- The five vendor cards have NO REGISTRY AT ALL, so residual_template_rate_refs
-- returns nothing for them and every vendor rate fell into the hidden set —
-- five clearly-labelled cards with no rows.
--
-- The screen needs to distinguish "referenced by no rule, and that is strange"
-- from "there are no rules here at all, so nothing can be referenced". This
-- answers that, derived from the registry table rather than from a list of
-- processor names somebody has to maintain.
create or replace function public.residual_formula_registry_for_month(
  p_processor text,
  p_month     date
)
returns table (
  id             uuid,
  label          text,
  effective_from date,
  effective_to   date
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if public.auth.uid() is null
     or not public.auth_is_admin() then
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
$$;

comment on function public.residual_formula_registry_for_month(text, date) is
  'The formula registry in force for a payer and month, or no rows when that payer has none. The buy-rate screen uses it to decide whether "referenced by no rule" is meaningful: with a registry it is an anomaly worth surfacing, without one it is the normal state of a vendor card and the grid shows every rate plainly.';

revoke all on function public.residual_formula_registry_for_month(text, date)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_formula_registry_for_month(text, date)
  to authenticated;

-- ============================================================
-- 5. Prove it
-- ============================================================
do $$
declare n_null int; n_ab int;
begin
  select count(*) into n_null
    from public.residual_buy_rates b
    join public.residual_buy_rate_schedules s on s.id = b.schedule_id
   where b.deleted_at is null and s.deleted_at is null
     and s.processor = 'ACCEPT_BLUE' and b.rate is null;
  if n_null <> 2 then
    raise exception 'Expected 2 unpriced Accept.Blue rows, found %.', n_null;
  end if;

  select count(*) into n_ab
    from public.residual_buy_rates b
    join public.residual_buy_rate_schedules s on s.id = b.schedule_id
   where b.deleted_at is null and s.deleted_at is null and s.processor = 'ACCEPT_BLUE';
  if n_ab <> 5 then
    raise exception 'Expected 5 Accept.Blue rows (3 priced + 2 unpriced), found %.', n_ab;
  end if;

  -- MAVERICK gains nothing and loses nothing.
  if (select count(*) from public.residual_buy_rates b
        join public.residual_buy_rate_schedules s on s.id = b.schedule_id
       where b.deleted_at is null and s.deleted_at is null
         and s.processor = 'MAVERICK') <> 44 then
    raise exception 'Maverick rate count moved.';
  end if;
  if exists (select 1 from public.residual_buy_rates b
               join public.residual_buy_rate_schedules s on s.id = b.schedule_id
              where b.deleted_at is null and s.deleted_at is null
                and s.processor = 'MAVERICK' and b.rate is null) then
    raise exception 'A Maverick rate went NULL; nothing here should have touched it.';
  end if;

  raise notice 'Accept.Blue: 3 priced + 2 unpriced rows. Maverick untouched at 44, none NULL.';
end$$;

commit;
