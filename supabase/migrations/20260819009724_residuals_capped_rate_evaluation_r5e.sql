-- Ported from Daniel Weissman's residuals branch, file
-- `20260904140000_residuals_capped_rate_evaluation_r5e.sql`.
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
-- Residuals R5e — a capped template rate evaluates as min(op x rate, cap)
-- ============================================================
--
-- Q29 = B: extend the term evaluation to express Accept.Blue's $25 cap now,
-- rather than storing the number and leaving it inert.
--
-- ============================================================
-- THE GRAIN, RESTATED HERE BECAUSE THIS IS WHERE IT BITES
-- ============================================================
--
-- The cap applies PER TERM, WITHIN ONE LINE. The source's meaning — "5.00 per
-- payment page, capped at $25" — is per merchant per month.
--
-- Those coincide only while at most one line per merchant-month carries the
-- capped fee item. They diverge the moment a merchant has two such lines, and
-- this implementation would then allow 2 x 25 = 50 against a true cap of 25.
-- Understating a cost overstates the margin, so the error has a direction.
--
-- residual_eval_side structurally cannot do better: it is handed one line's
-- item_count and the merchant's volumes, and never sees the merchant's other
-- lines. A true per-merchant-month cap needs a second pass in
-- compute_residual_period, after every line for a merchant is evaluated, that
-- sums the capped item across them and reduces the total — and that pass has to
-- answer WHICH line absorbs the reduction, a question the source data does not
-- answer. It is not invented here.
--
-- NOTHING READS A CAPPED RATE TODAY. The only capped rate belongs to
-- ACCEPT_BLUE, which has no formula registry, so no rule can reach it. This is
-- the evaluation being ready for the day one exists.
--
-- ============================================================
-- WHY THE BUY MAP CHANGES SHAPE
-- ============================================================
--
-- residual_eval_side received p_buy as {fee_item_key: rate}. A cap cannot be
-- expressed in that shape. Two options:
--
--   1. A second jsonb parameter, p_caps. Additive, but it lets the rate and its
--      cap be passed separately — and therefore lets a caller pass one and
--      forget the other, which is the exact failure the cap-on-the-rate
--      decision was meant to prevent.
--   2. Nest: {fee_item_key: {"rate": r, "cap": c}}. The rate and its cap travel
--      together and cannot be separated by a caller.
--
-- Option 2. The cost is that every caller building a buy map must change —
-- which is compute_residual_period and the tests, both in this repo.
--
-- BACKWARD-TOLERANT READ, deliberately. The function accepts BOTH shapes: a
-- bare number is read as an uncapped rate. That is not politeness to old
-- callers; it is so a hand-built test fixture stays readable when it has no cap
-- to express, and so a jsonb built by some future caller that predates caps
-- degrades to "uncapped" rather than to NULL — which would read as
-- missing_template_rate and stop a line that was fine.
--
-- Idempotent: drop-if-exists then create.

begin;

-- ============================================================
-- 1. residual_eval_side applies the cap
-- ============================================================
-- OUT parameters are unchanged, so compute_residual_period's `select ... into`
-- by column name still binds exactly as before.
drop function if exists public.residual_eval_side(
  uuid, text, numeric, numeric, jsonb, jsonb, jsonb, text[]);

create function public.residual_eval_side(
  p_rule_id     uuid,
  p_side        text,
  p_item_count  numeric,
  p_net_revenue numeric,
  p_rates       jsonb,
  p_buy         jsonb,
  p_vol         jsonb,
  p_siblings    text[],
  out o_value    numeric,
  out o_failure  text,
  out o_reason   text,
  out o_rate_ref text
)
language plpgsql
stable
as $$
declare
  t         record;
  v_op      numeric;
  v_rate    numeric;
  v_cap     numeric;
  v_entry   jsonb;
  v_volkey  text;
  v_contrib numeric;
begin
  o_value := 0;
  o_failure := null;
  o_reason := null;
  o_rate_ref := null;

  for t in
    select * from public.residual_formula_terms
     where rule_id = p_rule_id and side = p_side and deleted_at is null
     order by term_order
  loop
    if t.applies_when = 'sibling_absent'
       and t.sibling_fee_item_name = any(p_siblings) then
      continue;
    end if;
    if t.applies_when = 'sibling_present'
       and not (t.sibling_fee_item_name = any(p_siblings)) then
      continue;
    end if;

    -- ---- operand ----
    if t.operand = 'one' then
      v_op := 1;
    elsif t.operand = 'line_item_count' then
      v_op := p_item_count;
      if v_op is null then
        o_failure := 'the line has no item count, which this rule multiplies by';
        o_reason  := 'missing_line_input';
        o_value := null; return;
      end if;
    else
      v_volkey := case t.operand
                    when 'volume_amex'  then 'amex_volume'
                    when 'volume_vmd'   then 'vmd_volume'
                    when 'volume_debit' then 'debit_volume'
                    when 'volume_ebt'   then 'ebt_volume'
                  end;
      if p_vol is null then
        o_failure := format('no statement volumes for this merchant in this period; %s needs %s',
                            p_side, t.operand);
        o_reason  := 'no_volumes';
        o_value := null; return;
      end if;
      v_op := (p_vol ->> v_volkey)::numeric;
      if v_op is null then
        o_failure := format('the statement volume row has no %s', v_volkey);
        o_reason  := 'no_volumes';
        o_value := null; return;
      end if;
    end if;

    -- ---- rate, and its cap if it has one ----
    v_cap := null;
    if t.rate_source = 'literal' then
      v_rate := t.rate_literal;
    elsif t.rate_source = 'net_revenue' then
      v_rate := p_net_revenue;
      if v_rate is null then
        o_failure := 'this rule mirrors the processor net revenue, and the line has none';
        o_reason  := 'missing_line_input';
        o_value := null; return;
      end if;
    elsif t.rate_source = 'merchant' then
      v_rate := (p_rates ->> t.rate_ref)::numeric;
      if v_rate is null then
        o_failure  := format('the merchant rate "%s" is not set', t.rate_ref);
        o_reason   := 'missing_merchant_rate';
        o_rate_ref := t.rate_ref;
        o_value := null; return;
      end if;
    else -- template
      -- BOTH SHAPES ACCEPTED: {key: rate} and {key: {"rate":r,"cap":c}}.
      v_entry := p_buy -> t.rate_ref;
      if v_entry is not null and jsonb_typeof(v_entry) = 'object' then
        v_rate := (v_entry ->> 'rate')::numeric;
        v_cap  := (v_entry ->> 'cap')::numeric;
      else
        v_rate := (p_buy ->> t.rate_ref)::numeric;
      end if;

      if v_rate is null then
        o_failure  := format('no template buy rate for "%s" at this merchant''s risk tier', t.rate_ref);
        o_reason   := 'missing_template_rate';
        o_rate_ref := t.rate_ref;
        o_value := null; return;
      end if;
    end if;

    -- ---- accumulate at FULL precision (header, step 1) ----
    --
    -- THE CAP APPLIES TO THE MAGNITUDE, BEFORE THE SIGN. A capped term with
    -- term_sign = -1 is a capped subtraction, so min() has to bound
    -- (operand x rate) and the sign is applied to the bounded result. Applying
    -- min() after the sign would turn a cap into a FLOOR for negative terms:
    -- min(-35, 25) = -35, capping nothing at all.
    v_contrib := v_op * v_rate;
    if v_cap is not null and v_contrib > v_cap then
      v_contrib := v_cap;
    end if;
    o_value := o_value + (t.term_sign * v_contrib);
  end loop;
end;
$$;

comment on function public.residual_eval_side(uuid, text, numeric, numeric, jsonb, jsonb, jsonb, text[]) is
  'Evaluates one side of one rule to an UNROUNDED value, or reports the first input it could not resolve — as a reason code, a human sentence, and, when that input was a rate, the rate reference itself. A template entry may be a bare rate or {"rate":r,"cap":c}; a cap bounds (operand x rate) BEFORE term_sign is applied, so a capped subtraction is capped rather than floored. The cap is PER TERM WITHIN ONE LINE, which equals the source''s per-merchant-month meaning only while at most one line per merchant-month carries the item.';

revoke all on function public.residual_eval_side(uuid, text, numeric, numeric, jsonb, jsonb, jsonb, text[])
  from public, anon, authenticated, service_role;

-- ============================================================
-- 2. compute_residual_period builds the nested buy map
-- ============================================================
-- The ONLY change to this function is the jsonb_object_agg that builds
-- v_buy_by_tier: 'rates' now maps each fee item to {"rate":…, "cap":…} instead
-- of to a bare number. Everything else — the chain, the rounding, the failure
-- grain, the version stamping — is byte-for-byte what 20260901120000 left.
create or replace function public.compute_residual_period(
  p_period_id uuid,
  p_processor text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
begin
  if auth.uid() is null
     or not public.auth_is_admin() then
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

  select case
           when not exists (select 1 from public.residual_calc_failures where period_id = p_period_id)
             then 'ready'
           when exists (select 1 from public.residual_calc_failures
                         where period_id = p_period_id and reason_code = 'no_volumes')
             then 'awaiting_volumes'
           else 'open'
         end
    into v_status;

  update public.residual_periods
     set calculation_version = case when v_status = 'ready' then v_version else null end,
         status = v_status,
         updated_by_id = v_actor
   where id = p_period_id;

  return jsonb_build_object(
    'period_id',           p_period_id,
    'statement_month',     to_char(v_month, 'YYYY-MM-DD'),
    'processor',           v_processor,
    'calculation_version', v_version,
    'registry',            v_reg_label,
    'status',              v_status,
    'merchants_computed',  n_merch_ok,
    'merchants_failed',    n_merch_fail,
    'lines_computed',      n_line_ok,
    'lines_failed',        n_line_fail,
    'groups_computed',     n_groups,
    'failures_by_reason',  coalesce((
      select jsonb_object_agg(reason_code, n)
        from (select reason_code, count(*) n
                from public.residual_calc_failures
               where period_id = p_period_id group by 1) x), '{}'::jsonb)
  );
end;
$$;

comment on function public.compute_residual_period(uuid, text) is
  'The calculation engine. Reads the dated registry, merchant rates, buy rates and volumes for the period''s statement month and writes the six engine-owned columns on residual_lines plus residual_line_groups. All arithmetic in SQL. A merchant with no rates is skipped WHOLE and recorded; a line whose rule cannot resolve an input has its outputs NULLed and is recorded, naming the rate it wanted in residual_calc_failures.rate_ref. The per-tier buy map carries {rate, cap} per fee item so a cap cannot be separated from its rate. Never writes reconciled/mismatch — those are R6 verdicts.';

revoke all on function public.compute_residual_period(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.compute_residual_period(uuid, text)
  to authenticated;

commit;
