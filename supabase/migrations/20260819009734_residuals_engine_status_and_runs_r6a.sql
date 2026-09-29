-- Ported from Daniel Weissman's residuals branch, file
-- `20260907160000_residuals_engine_status_and_runs_r6a.sql`.
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
-- R6a part 5 of 5 — the engine stops writing status, and starts keeping a
-- record of its own runs.
-- ============================================================================
-- ORDERING: applies after parts 1-4. THIS IS NOT OPTIONAL CLEANUP. Part 4
-- narrowed residual_periods.status to ('open','reconciled') and installed a
-- transition guard; the live engine's stamp block writes 'ready' and
-- 'awaiting_volumes'. Without this file EVERY COMPUTE FAILS.
--
-- THE BODY BELOW IS THE LIVE R5e DEFINITION, COPIED. Everything from the gate
-- through the group loop is byte-for-byte what
-- 20260904140000_residuals_capped_rate_evaluation_r5e.sql left — the capped
-- rate evaluation, the {rate, cap} buy map, the sibling conditional, the group
-- grain. Only two things change, both at the end:
--
--   1. THE STAMP no longer writes status. calculation_version is still set only
--      on a clean run, which is unchanged and still load-bearing.
--   2. THE SUMMARY is captured into residual_calc_runs instead of being built
--      and thrown away, and the retirement sweep runs.
--
-- The returned object drops 'status' and gains 'stamped'. A period's status is
-- now read from residual_period_state(), which derives it.

begin;

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
  -- R6a additions.
  v_clean      boolean;
  v_failures   jsonb;
  v_summary    jsonb;
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
$$;

comment on function public.compute_residual_period(uuid, text) is
  'The calculation engine. Reads the dated registry, merchant rates, buy rates and volumes for the period''s statement month and writes the six engine-owned columns on residual_lines plus residual_line_groups. All arithmetic in SQL. A merchant with no rates is skipped WHOLE and recorded; a line whose rule cannot resolve an input has its outputs NULLed and is recorded, naming the rate it wanted in residual_calc_failures.rate_ref. The per-tier buy map carries {rate, cap} per fee item so a cap cannot be separated from its rate. Since R6a it writes NO status — the progress states are derived by residual_period_state — and records each run in residual_calc_runs.';

revoke all on function public.compute_residual_period(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.compute_residual_period(uuid, text)
  to authenticated;

commit;
