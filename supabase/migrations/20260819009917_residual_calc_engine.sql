-- Residual calculator, SQL engine.
--
-- The Acquiring, ACH and Accept.blue reconciliations as pure functions:
-- JSON in, JSON out, no table reads or writes. They implement the contract in
-- src/lib/residuals/calc/types.ts and are held to the same test suite as the
-- TypeScript engine (src/lib/residuals/calc/contract.ts), so the two
-- approaches can be compared on equal terms.
--
-- Arithmetic is numeric throughout (exact). Rounding: round(x, 2), half away
-- from zero, applied to each Merchant payment and Buy rate and once to a
-- share. Every money result leaves as text with two decimals.

-- ── Helpers ──────────────────────────────────────────────────────────────

/* A JSON value (decimal text, number, null or "") as numeric; blank = 0. */
create or replace function residual_calc_dec(v jsonb)
returns numeric language sql immutable
set search_path = public, pg_temp as $$
  select case
    when v is null or jsonb_typeof(v) = 'null' or (v #>> '{}') = '' then 0::numeric
    else (v #>> '{}')::numeric
  end
$$;

/* Money as text, exactly two decimals. */
create or replace function residual_calc_money(x numeric)
returns text language sql immutable
set search_path = public, pg_temp as $$
  select round(x, 2)::text
$$;

/* A flag, with its colour from the one table of codes (types.ts FLAG_CODES). */
create or replace function residual_calc_flag(p_section text, p_code text, p_message text, p_field text default null)
returns jsonb language plpgsql immutable
set search_path = public, pg_temp as $$
declare
  v_color text;
begin
  v_color := case p_section || ':' || p_code
    when 'acquiring:VOLUME_MISMATCH' then 'red'
    when 'acquiring:RISK_LEVEL_BLANK' then 'red'
    when 'acquiring:NO_STATEMENT' then 'red'
    when 'acquiring:MID_NOT_IN_CRM' then 'orange'
    when 'acquiring:UNKNOWN_FEE_ITEM' then 'orange'
    when 'acquiring:CREDIT_REFUND' then 'orange'
    when 'acquiring:NO_EQUIPMENT_ROW' then 'orange'
    when 'acquiring:EQUIPMENT_SUPPLIES_REVIEW' then 'orange'
    when 'acquiring:NEGATIVE_NET_REVENUE' then 'orange'
    when 'acquiring:AGENT_EXPENSE_NONZERO' then 'orange'
    when 'acquiring:INCOME_ABOVE_REPORTED' then 'light_red'
    when 'acquiring:REPORTED_ABOVE_INCOME' then 'light_green'
    when 'acquiring:AGENT_PCT_MISMATCH' then null
    when 'acquiring:UNKNOWN_PLAN_CODE' then null
    when 'ach:OUR_NET_HIGHER' then 'red'
    when 'ach:OUR_NET_LOWER' then 'green'
    when 'ach:REJECT_FEES_NO_RULE' then 'orange'
    when 'ach:NAME_NOT_MATCHED' then 'red'
    when 'ach:RISK_LEVEL_BLANK' then 'red'
    when 'ach:ACH_PROVIDER_NOT_MAVERICK' then 'orange'
    when 'ach:MID_NOT_IN_CRM' then 'orange'
    when 'ach:UNKNOWN_FEE_CATEGORY' then 'orange'
    when 'acceptBlue:MID_NOT_IN_CRM' then 'orange'
    when 'acceptBlue:NO_AB_ROW' then 'orange'
    when 'acceptBlue:AB_NOT_BILLED_TO_ISO' then 'orange'
    when 'acceptBlue:CALC_ABOVE_CHARGED' then 'green'
    when 'acceptBlue:CALC_BELOW_CHARGED' then 'red'
    when 'acceptBlue:OVER_5_REVIEW' then 'orange'
    when 'acceptBlue:UNRECOGNIZED_COLUMN' then 'orange'
    when 'acceptBlue:MULTIPLE_AB_ROWS' then null
    when 'acceptBlue:MISSING_FROM_REPORT' then 'orange'
    when 'acceptBlue:MONTH_MISMATCH' then 'orange'
    else 'unknown'
  end;
  if v_color is not distinct from 'unknown' then
    raise exception 'residual_calc_flag: unknown flag %:%', p_section, p_code;
  end if;
  return jsonb_build_object('code', p_code, 'color', v_color, 'message', p_message)
      || case when p_field is null then '{}'::jsonb else jsonb_build_object('field', p_field) end;
end
$$;

/* The colour a row shows: the highest-priority colour among its flags. */
create or replace function residual_calc_color(p_flags jsonb)
returns text language sql immutable
set search_path = public, pg_temp as $$
  select u.c
    from unnest(array['red', 'orange', 'light_red', 'light_green', 'green']) with ordinality u(c, o)
   where exists (select 1 from jsonb_array_elements(p_flags) f where f ->> 'color' = u.c)
   order by u.o
   limit 1
$$;

create or replace function residual_calc_provider(p text)
returns text language sql immutable
set search_path = public, pg_temp as $$
  select lower(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g'))
$$;

create or replace function residual_calc_norm(p text)
returns text language sql immutable
set search_path = public, pg_temp as $$
  select lower(btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g')))
$$;

/* Fee item name → rule key. Matching ignores dash style, case and spacing. */
create or replace function residual_calc_fee_rule(p_name text)
returns text language sql immutable
set search_path = public, pg_temp as $$
  select case residual_calc_norm(regexp_replace(p_name, '[‐‑‒–—―−]', '-', 'g'))
    when 'amex optblue fee' then 'amex_optblue'
    when 'bin sponsorship fees' then 'bin'
    when 'cash disc/surcharge program' then 'cash_disc'
    when 'authorization fee ip/ssl' then 'auth'
    when 'avs fee' then 'avs'
    when 'merchant deposit transaction' then 'deposit'
    when 'chargeback fee' then 'chargeback'
    when 'ebt authorization fee' then 'ebt_auth'
    when 'pin debit auth fee' then 'pin_auth'
    when 'credit/refund' then 'credit_refund'
    when 'monthly fee' then 'monthly'
    when 'monthly online access fee' then 'online_access'
    when 'pci program' then 'pci'
    when 'website monitoring fee' then 'website'
    when 'irs annual fee' then 'irs'
    when 'interchange' then 'passthrough'
    when 'card brand fees' then 'passthrough'
    when 'card brand fees v/mc/d/pp' then 'passthrough'
    when 'amex pass thru fees (non ob)' then 'passthrough'
    when 'pin debit interchange' then 'passthrough'
    when 'accept blue monthly' then 'ab_monthly'
    when 'usa epay gold' then 'epay_gold'
    when 'usa epay monthly fee - gold' then 'epay_gold'
    when 'usa epay silver' then 'epay_silver'
    when 'usa epay monthly fee - silver' then 'epay_silver'
    when 'accept blue setup' then 'ab_setup'
    when 'accept.blue per item total' then 'ab_per_item'
    when 'ipos spin' then 'ipos_spin'
    when 'ipos spin fee' then 'ipos_spin'
    when 'ipospays terminal' then 'ipospays'
    when 'nuvolinq' then 'nuvolinq'
    when 'nuvolinq 10mb data' then 'nuvolinq'
    when 'nuvolinq 10mb data plan' then 'nuvolinq'
    when 'valor portal access' then 'valor_portal'
    when 'valor terminal add-ons' then 'valor_addons'
    when 'equipment & supplies' then 'equipment_supplies'
  end
$$;

/* Statement plan code → volume bucket (null = not in the spec's list). */
create or replace function residual_calc_bucket(p_code text)
returns text language sql immutable
set search_path = public, pg_temp as $$
  select case upper(btrim(p_code))
    when 'VS' then 'vmd' when 'VB' then 'vmd' when 'MC' then 'vmd' when 'MB' then 'vmd'
    when 'JC' then 'vmd' when 'DS' then 'vmd' when 'DZ' then 'vmd' when 'DJ' then 'vmd' when 'DB' then 'vmd'
    when 'AM' then 'amex'
    when 'MD' then 'debit' when 'DD' then 'debit' when 'VD' then 'debit'
    when 'EBT' then 'ebt'
  end
$$;

-- ── Acquiring ────────────────────────────────────────────────────────────

/* One report row: Merchant payment and Buy rate, unrounded (null = not calculated). */
create or replace function residual_calc_acq_row(
  r jsonb, tpl jsonb, risk text, pricing jsonb, equipment jsonb,
  vmd numeric, amex numeric, debit numeric, ebt numeric,
  has_cd boolean, has_monthly boolean, first_gateway boolean, first_terminal boolean,
  out mp numeric, out br numeric, out flags jsonb)
language plpgsql immutable
set search_path = public, pg_temp as $$
declare
  v_rule text := residual_calc_fee_rule(r ->> 'feeItemName');
  v_count numeric := residual_calc_dec(r -> 'count');
  v_no_eq jsonb;
  v_n int;
  v_sum numeric;
  v_item text;
begin
  flags := '[]';
  v_no_eq := case when residual_calc_dec(r -> 'agentExpense') > 0
    then jsonb_build_array(residual_calc_flag('acquiring', 'NO_EQUIPMENT_ROW', 'No matching Equipment row, but Maverick charged for it'))
    else '[]'::jsonb end;

  if v_rule is null then
    flags := jsonb_build_array(residual_calc_flag('acquiring', 'UNKNOWN_FEE_ITEM', format('Unknown fee item "%s"', r ->> 'feeItemName')));
    return;
  end if;

  case v_rule
    when 'amex_optblue' then
      mp := amex * residual_calc_dec(pricing -> 'amexOptBlueFee');
      br := amex * case when jsonb_typeof(pricing -> 'amexVolumeBuyRateAdjustment') in ('string', 'number')
        then residual_calc_dec(pricing -> 'amexVolumeBuyRateAdjustment') else residual_calc_dec(tpl -> 'amexOptBlue' -> risk) end;
    when 'bin', 'cash_disc' then
      if v_rule = 'bin' and has_cd then
        mp := 0;
      else
        mp := amex * residual_calc_dec(pricing -> 'amexVolume')
            + vmd * residual_calc_dec(pricing -> 'vmdVolume')
            + debit * residual_calc_dec(pricing -> 'pinDebitVolume')
            + ebt * residual_calc_dec(pricing -> 'ebtVolume')
            + v_count * residual_calc_dec(pricing -> 'vmdTransactionFee');
      end if;
      if v_rule = 'cash_disc' then
        br := 0;
      else
        br := vmd * case when jsonb_typeof(pricing -> 'vmdVolumeBuyRateAdjustment') in ('string', 'number')
                then residual_calc_dec(pricing -> 'vmdVolumeBuyRateAdjustment') else residual_calc_dec(tpl -> 'vmdBin' -> risk) end
            + debit * case when jsonb_typeof(pricing -> 'pinDebitVolumeBuyRateAdjustment') in ('string', 'number')
                then residual_calc_dec(pricing -> 'pinDebitVolumeBuyRateAdjustment') else residual_calc_dec(tpl -> 'vmdBin' -> risk) end;
      end if;
    when 'auth' then
      mp := v_count * residual_calc_dec(pricing -> 'vmdAuthFee'); br := v_count * residual_calc_dec(tpl -> 'vmdAuthFee' -> risk);
    when 'avs' then
      mp := v_count * residual_calc_dec(pricing -> 'avsFee'); br := v_count * residual_calc_dec(tpl -> 'avsFee' -> risk);
    when 'deposit' then
      mp := v_count * residual_calc_dec(pricing -> 'batchFee'); br := v_count * residual_calc_dec(tpl -> 'batchFee' -> risk);
    when 'chargeback' then
      mp := v_count * residual_calc_dec(pricing -> 'chargebackFee'); br := v_count * residual_calc_dec(tpl -> 'chargeback' -> risk);
    when 'ebt_auth' then
      mp := v_count * residual_calc_dec(pricing -> 'ebtAuthFee'); br := v_count * residual_calc_dec(tpl -> 'ebtAuthFee' -> risk);
    when 'pin_auth' then
      mp := v_count * residual_calc_dec(pricing -> 'pinDebitAuthFee'); br := 0;
    when 'credit_refund' then
      mp := null; br := 0;
      flags := jsonb_build_array(residual_calc_flag('acquiring', 'CREDIT_REFUND', 'Credit/Refund: review manually'));
    when 'monthly' then
      mp := residual_calc_dec(pricing -> 'monthlyFee'); br := residual_calc_dec(tpl -> 'monthlyFee' -> risk);
    when 'online_access' then
      -- The CRM Monthly Fee covers both rows; it sits on the Monthly Fee row (ASSUMPTION X3).
      mp := case when has_monthly then 0 else residual_calc_dec(pricing -> 'monthlyFee') end;
      br := residual_calc_dec(tpl -> 'monthlyOnlineAccessFee' -> risk);
    when 'pci' then
      mp := residual_calc_dec(pricing -> 'pciFee'); br := residual_calc_dec(tpl -> 'pciFee' -> risk);
    when 'website' then
      mp := residual_calc_dec(pricing -> 'monthlyWebsiteMonitoringFee'); br := residual_calc_dec(tpl -> 'websiteMonitoringFee' -> risk);
    when 'irs' then
      mp := residual_calc_dec(r -> 'netRevenue'); br := residual_calc_dec(tpl -> 'irsAnnualFee' -> risk);
    when 'passthrough' then
      mp := residual_calc_dec(r -> 'netRevenue'); br := 0;
    when 'ab_setup', 'ab_per_item' then
      select count(*), coalesce(sum(residual_calc_dec(e -> case when v_rule = 'ab_setup' then 'oneTimeFee' else 'perItemFee' end)), 0)
        into v_n, v_sum
        from jsonb_array_elements(coalesce(equipment, '[]')) e
       where residual_calc_provider(e ->> 'billedBy') = 'maverick' and residual_calc_provider(e ->> 'provider') = 'acceptblue';
      if v_rule = 'ab_setup' then
        mp := v_sum; br := residual_calc_dec(tpl -> 'acceptBlueSetup' -> risk);
      else
        mp := v_count * v_sum; br := v_count * residual_calc_dec(tpl -> 'acceptBluePerItem' -> risk);
      end if;
      if v_n = 0 then flags := v_no_eq; end if;
    when 'equipment_supplies' then
      select count(*), coalesce(sum(residual_calc_dec(e -> 'oneTimeFee')), 0) into v_n, v_sum
        from jsonb_array_elements(coalesce(equipment, '[]')) e
       where residual_calc_provider(e ->> 'provider') = 'maverick';
      mp := v_sum; br := null;
      flags := jsonb_build_array(residual_calc_flag('acquiring', 'EQUIPMENT_SUPPLIES_REVIEW', 'Equipment & Supplies: buy rate needs manual review'))
            || case when v_n = 0 then v_no_eq else '[]'::jsonb end;
    else
      -- Gateway and terminal groups share one payment, on the group's first row (ASSUMPTIONS X3, X4).
      select count(*), coalesce(sum(residual_calc_dec(e -> 'monthlyFee')), 0) into v_n, v_sum
        from jsonb_array_elements(coalesce(equipment, '[]')) e
       where residual_calc_provider(e ->> 'billedBy') = 'maverick'
         and residual_calc_provider(e ->> 'provider') = any (
           case when v_rule in ('ab_monthly', 'epay_gold', 'epay_silver')
             then array['acceptblue', 'usaepay'] else array['ipos', 'valor'] end);
      mp := case
        when v_rule in ('ab_monthly', 'epay_gold', 'epay_silver') and first_gateway then v_sum
        when v_rule not in ('ab_monthly', 'epay_gold', 'epay_silver') and first_terminal then v_sum
        else 0 end;
      v_item := case v_rule
        when 'ab_monthly' then 'acceptBlueMonthly'
        when 'epay_gold' then 'usaEpayGold'
        when 'epay_silver' then 'usaEpaySilver'
        when 'ipos_spin' then 'iposSpinFeeMonthly'
        when 'ipospays' then 'ipospaysTerminalMonthly'
        when 'nuvolinq' then 'nuvolinq10mbData'
        when 'valor_portal' then 'valorPortalAccess'
        when 'valor_addons' then 'valorTerminalAddOns'
      end;
      br := residual_calc_dec(tpl -> v_item -> risk);
      if v_n = 0 then flags := v_no_eq; end if;
  end case;
end
$$;

/* Checks on the report's own figures; they apply to every row. */
create or replace function residual_calc_acq_report_flags(r jsonb)
returns jsonb language sql immutable
set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(f), '[]'::jsonb) from (
    select residual_calc_flag('acquiring', 'NEGATIVE_NET_REVENUE', 'Net Revenue is below $0') f
     where residual_calc_dec(r -> 'netRevenue') < 0
    union all
    select residual_calc_flag('acquiring', 'AGENT_EXPENSE_NONZERO', 'Agent Expense is not $0')
     where residual_calc_dec(r -> 'agentExpense') <> 0
  ) q
$$;

create or replace function residual_calc_acquiring(p jsonb)
returns jsonb language plpgsql immutable
set search_path = public, pg_temp as $$
declare
  v_month text := p ->> 'month';
  v_tpl jsonb := p -> 'template';
  v_proceed boolean := coalesce((p ->> 'proceedWithoutStatement')::boolean, false);
  v_mid text;
  v_m jsonb;
  v_risk text;
  v_block jsonb;
  v_mid_flags jsonb;
  v_row_flags jsonb;
  v_has_stmt boolean;
  g_vmd numeric; g_amex numeric; g_debit numeric; g_ebt numeric;
  n_vmd numeric; n_amex numeric; n_debit numeric; n_ebt numeric;
  v_unknown text;
  v_has_cd boolean;
  v_has_monthly boolean;
  v_off text;
  v_pct text;
  v_first_agent text;
  v_first_gateway bigint;
  v_first_terminal bigint;
  v_rows jsonb := '[]';
  v_mids jsonb := '[]';
  v_total numeric := 0;
  v_income numeric;
  v_sum numeric;
  v_net_income numeric;
  v_nr numeric;
  v_flags jsonb;
  v_volumes jsonb;
  rec record;
  c record;
begin
  for v_mid in
    select x.mid from (
      select e ->> 'mid' as mid, min(o) as first_o
        from jsonb_array_elements(p -> 'reportRows') with ordinality t(e, o)
       where e ->> 'date' = v_month
       group by 1) x
     order by x.first_o
  loop
    select m into v_m from jsonb_array_elements(coalesce(p -> 'merchants', '[]')) m where m ->> 'mid' = v_mid limit 1;
    v_mid_flags := '[]';
    v_row_flags := '[]';
    v_block := null;
    v_has_stmt := v_m is not null and jsonb_typeof(v_m -> 'statement') = 'array';
    v_volumes := null;

    g_vmd := 0; g_amex := 0; g_debit := 0; g_ebt := 0;
    n_vmd := 0; n_amex := 0; n_debit := 0; n_ebt := 0;
    v_unknown := null;
    if v_has_stmt then
      select coalesce(sum(amt) filter (where b = 'vmd'), 0), coalesce(sum(amt) filter (where b = 'amex'), 0),
             coalesce(sum(amt) filter (where b = 'debit'), 0), coalesce(sum(amt) filter (where b = 'ebt'), 0),
             coalesce(sum(amt - cr) filter (where b = 'vmd'), 0), coalesce(sum(amt - cr) filter (where b = 'amex'), 0),
             coalesce(sum(amt - cr) filter (where b = 'debit'), 0), coalesce(sum(amt - cr) filter (where b = 'ebt'), 0),
             string_agg(code, ', ' order by o) filter (where b is null and amt <> 0)
        into g_vmd, g_amex, g_debit, g_ebt, n_vmd, n_amex, n_debit, n_ebt, v_unknown
        from (select residual_calc_bucket(s ->> 'planCode') b, s ->> 'planCode' code, o,
                     residual_calc_dec(s -> 'amount') amt, residual_calc_dec(s -> 'creditAmount') cr
                from jsonb_array_elements(v_m -> 'statement') with ordinality t(s, o)) q;
      v_volumes := jsonb_build_object('vmd', residual_calc_money(g_vmd), 'amex', residual_calc_money(g_amex),
                                      'debit', residual_calc_money(g_debit), 'ebt', residual_calc_money(g_ebt));
    end if;

    if v_m is null then
      v_block := residual_calc_flag('acquiring', 'MID_NOT_IN_CRM', format('MID %s is not in the CRM', v_mid));
    elsif v_m ->> 'riskLevel' is null then
      v_block := residual_calc_flag('acquiring', 'RISK_LEVEL_BLANK', 'Risk Level is blank in the CRM');
    elsif not v_has_stmt and not v_proceed then
      v_block := residual_calc_flag('acquiring', 'NO_STATEMENT', 'No statement for this month');
    end if;

    if v_block is not null then
      for rec in
        select e, o from jsonb_array_elements(p -> 'reportRows') with ordinality t(e, o)
         where e ->> 'date' = v_month and e ->> 'mid' = v_mid order by o
      loop
        v_flags := jsonb_build_array(v_block) || residual_calc_acq_report_flags(rec.e);
        v_rows := v_rows || jsonb_build_array(jsonb_build_object('o', rec.o, 'row', jsonb_build_object(
          'mid', v_mid, 'feeItemName', rec.e ->> 'feeItemName',
          'netRevenue', residual_calc_money(residual_calc_dec(rec.e -> 'netRevenue')),
          'merchantPayment', null, 'buyRate', null, 'income', null,
          'flags', v_flags, 'color', residual_calc_color(v_flags))));
      end loop;
      v_mids := v_mids || jsonb_build_array(jsonb_build_object(
        'mid', v_mid, 'calculated', false, 'riskLevel', v_m ->> 'riskLevel', 'volumes', v_volumes,
        'income', null, 'percentage', null, 'netIncome', null, 'flags', jsonb_build_array(v_block)));
      continue;
    end if;

    v_risk := v_m ->> 'riskLevel';

    select bool_or(residual_calc_fee_rule(e ->> 'feeItemName') = 'cash_disc'),
           bool_or(residual_calc_fee_rule(e ->> 'feeItemName') = 'monthly'),
           min(o) filter (where residual_calc_fee_rule(e ->> 'feeItemName') in ('ab_monthly', 'epay_gold', 'epay_silver')),
           min(o) filter (where residual_calc_fee_rule(e ->> 'feeItemName') in ('ipos_spin', 'ipospays', 'nuvolinq', 'valor_portal', 'valor_addons'))
      into v_has_cd, v_has_monthly, v_first_gateway, v_first_terminal
      from jsonb_array_elements(p -> 'reportRows') with ordinality t(e, o)
     where e ->> 'date' = v_month and e ->> 'mid' = v_mid;

    if v_has_stmt then
      if v_unknown is not null then
        v_mid_flags := v_mid_flags || jsonb_build_array(
          residual_calc_flag('acquiring', 'UNKNOWN_PLAN_CODE', 'Plan code not counted: ' || v_unknown));
      end if;
      -- Volume check (ASSUMPTION X2: BIN net of refunds, the others gross).
      select string_agg(format('%s: report %s, statement %s', name, residual_calc_money(amt), residual_calc_money(expected)), '; ' order by o)
        into v_off
        from (
          select e ->> 'feeItemName' name, o, residual_calc_dec(e -> 'amount') amt,
                 case residual_calc_fee_rule(e ->> 'feeItemName')
                   when 'cash_disc' then g_vmd + g_amex + g_debit + g_ebt
                   when 'bin' then case when v_has_cd then n_vmd + n_debit + n_ebt else n_vmd + n_amex + n_debit + n_ebt end
                   when 'amex_optblue' then g_amex
                 end expected
            from jsonb_array_elements(p -> 'reportRows') with ordinality t(e, o)
           where e ->> 'date' = v_month and e ->> 'mid' = v_mid) q
       where expected is not null and abs(amt - expected) > 1;
      if v_off is not null then
        v_flags := jsonb_build_array(residual_calc_flag('acquiring', 'VOLUME_MISMATCH', 'Volume check failed. ' || v_off));
        v_mid_flags := v_mid_flags || v_flags;
        v_row_flags := v_row_flags || v_flags;
      end if;
    else
      -- Proceeding without a statement (ASSUMPTION X5).
      select coalesce(sum(residual_calc_dec(e -> 'amount')) filter (where residual_calc_fee_rule(e ->> 'feeItemName') = 'amex_optblue'), 0),
             coalesce(sum(residual_calc_dec(e -> 'amount')) filter (where residual_calc_fee_rule(e ->> 'feeItemName') = 'bin'), 0)
        into g_amex, v_sum
        from jsonb_array_elements(p -> 'reportRows') e
       where e ->> 'date' = v_month and e ->> 'mid' = v_mid;
      g_vmd := case when v_has_cd then v_sum else v_sum - g_amex end;
      v_volumes := jsonb_build_object('vmd', residual_calc_money(g_vmd), 'amex', residual_calc_money(g_amex),
                                      'debit', '0.00', 'ebt', '0.00');
      v_flags := jsonb_build_array(residual_calc_flag('acquiring', 'NO_STATEMENT', 'No statement: volumes taken from the report Amount'));
      v_mid_flags := v_mid_flags || v_flags;
      v_row_flags := v_row_flags || v_flags;
    end if;

    v_pct := v_tpl -> 'percentage' ->> v_risk;
    select e ->> 'agentPct' into v_first_agent
      from jsonb_array_elements(p -> 'reportRows') with ordinality t(e, o)
     where e ->> 'date' = v_month and e ->> 'mid' = v_mid order by o limit 1;
    if v_first_agent is not null and v_first_agent::numeric / 100 <> v_pct::numeric then
      v_mid_flags := v_mid_flags || jsonb_build_array(residual_calc_flag('acquiring', 'AGENT_PCT_MISMATCH',
        format('Maverick''s Agent %% is %s; the CRM Risk Level gives %s', v_first_agent, (v_pct::numeric * 100)::text)));
    end if;

    v_sum := 0;
    for rec in
      select e, o from jsonb_array_elements(p -> 'reportRows') with ordinality t(e, o)
       where e ->> 'date' = v_month and e ->> 'mid' = v_mid order by o
    loop
      select * into c from residual_calc_acq_row(
        rec.e, v_tpl, v_risk, v_m -> 'pricing', v_m -> 'equipment',
        g_vmd, g_amex, g_debit, g_ebt, coalesce(v_has_cd, false), coalesce(v_has_monthly, false),
        rec.o = v_first_gateway, rec.o = v_first_terminal);
      v_flags := v_row_flags || c.flags || residual_calc_acq_report_flags(rec.e);
      v_income := null;
      if c.mp is not null and c.br is not null then
        v_income := round(c.mp, 2) - round(c.br, 2);
        v_sum := v_sum + v_income;
        v_nr := residual_calc_dec(rec.e -> 'netRevenue');
        if v_income - v_nr > 1 then
          v_flags := v_flags || jsonb_build_array(residual_calc_flag('acquiring', 'INCOME_ABOVE_REPORTED',
            format('Income %s is above Net Revenue %s', residual_calc_money(v_income), residual_calc_money(v_nr))));
        end if;
        if v_nr - v_income > 1 then
          v_flags := v_flags || jsonb_build_array(residual_calc_flag('acquiring', 'REPORTED_ABOVE_INCOME',
            format('Net Revenue %s is above Income %s', residual_calc_money(v_nr), residual_calc_money(v_income))));
        end if;
      end if;
      v_rows := v_rows || jsonb_build_array(jsonb_build_object('o', rec.o, 'row', jsonb_build_object(
        'mid', v_mid, 'feeItemName', rec.e ->> 'feeItemName',
        'netRevenue', residual_calc_money(residual_calc_dec(rec.e -> 'netRevenue')),
        'merchantPayment', residual_calc_money(c.mp), 'buyRate', residual_calc_money(c.br),
        'income', residual_calc_money(v_income),
        'flags', v_flags, 'color', residual_calc_color(v_flags))));
    end loop;

    -- Negative income: the percentage is not applied.
    v_net_income := case when v_sum < 0 then v_sum else round(v_sum * v_pct::numeric, 2) end;
    v_total := v_total + v_net_income;
    v_mids := v_mids || jsonb_build_array(jsonb_build_object(
      'mid', v_mid, 'calculated', true, 'riskLevel', v_risk,
      'volumes', coalesce(v_volumes, jsonb_build_object('vmd', '0.00', 'amex', '0.00', 'debit', '0.00', 'ebt', '0.00')),
      'income', residual_calc_money(v_sum), 'percentage', v_pct,
      'netIncome', residual_calc_money(v_net_income), 'flags', v_mid_flags));
  end loop;

  return jsonb_build_object(
    'rows', coalesce((select jsonb_agg(x -> 'row' order by (x ->> 'o')::bigint) from jsonb_array_elements(v_rows) x), '[]'::jsonb),
    'mids', v_mids,
    'total', residual_calc_money(v_total));
end
$$;

-- ── ACH ──────────────────────────────────────────────────────────────────

create or replace function residual_calc_ach(p jsonb)
returns jsonb language plpgsql immutable
set search_path = public, pg_temp as $$
declare
  v_month text := p ->> 'month';
  v_tpl jsonb := p -> 'template';
  v_name text;
  v_mid text;
  v_m jsonb;
  v_block jsonb;
  v_blocks jsonb := '{}';
  v_sums jsonb := '{}';
  v_order text[] := '{}';
  v_unmatched text[] := '{}';
  v_rows jsonb := '[]';
  v_mids jsonb := '[]';
  v_risk text;
  v_col text;
  v_pct text;
  v_cat text;
  v_count numeric;
  v_report_net numeric;
  v_mp numeric;
  v_br numeric;
  v_net numeric;
  v_split numeric;
  v_flags jsonb;
  v_total numeric := 0;
  v_mid_net numeric;
  v_mid_total numeric;
  rec record;
begin
  for rec in
    select e, o from jsonb_array_elements(p -> 'reportRows') with ordinality t(e, o)
     where e ->> 'date' = v_month order by o
  loop
    v_name := rec.e ->> 'merchantName';
    v_report_net := residual_calc_dec(rec.e -> 'net');
    select value #>> '{}' into v_mid from jsonb_each(coalesce(p -> 'nameMatches', '{}'))
     where residual_calc_norm(key) = residual_calc_norm(v_name) limit 1;

    v_mp := null; v_br := null; v_net := null; v_split := null; v_flags := '[]';

    if v_mid is null then
      if not v_name = any (v_unmatched) then v_unmatched := v_unmatched || v_name; end if;
      v_flags := jsonb_build_array(residual_calc_flag('ach', 'NAME_NOT_MATCHED', format('"%s" has no MID', v_name)));
    else
      if not v_mid = any (v_order) then v_order := v_order || v_mid; end if;
      select m into v_m from jsonb_array_elements(coalesce(p -> 'merchants', '[]')) m where m ->> 'mid' = v_mid limit 1;
      v_block := case
        when v_m is null then residual_calc_flag('ach', 'MID_NOT_IN_CRM', format('MID %s is not in the CRM', v_mid))
        when v_m ->> 'riskLevel' is null then residual_calc_flag('ach', 'RISK_LEVEL_BLANK', 'Risk Level is blank in the CRM')
        when residual_calc_norm(v_m ->> 'achProvider') <> 'maverick' then
          residual_calc_flag('ach', 'ACH_PROVIDER_NOT_MAVERICK', format('ACH Provider is %s, not Maverick', coalesce(v_m ->> 'achProvider', 'blank')))
      end;

      if v_block is not null then
        v_blocks := v_blocks || jsonb_build_object(v_mid, v_block);
        v_flags := jsonb_build_array(v_block);
      else
        v_risk := v_m ->> 'riskLevel';
        v_col := case when v_risk = 'no_risk' then 'low_risk' else v_risk end;
        -- ACH spec: High Risk is 90% on purpose.
        v_pct := case v_risk when 'moderate_risk' then '0.80' else '0.90' end;
        v_count := residual_calc_dec(rec.e -> 'count');
        v_cat := residual_calc_norm(rec.e ->> 'feeCategory');

        case v_cat
          when 'account on file' then
            v_mp := 0; v_br := residual_calc_dec(v_tpl -> 'monthly' -> v_col);
          when 'credit trans fees', 'debit trans fees' then
            v_mp := v_count * residual_calc_dec(v_m -> 'achTransactionFee');
            v_br := v_count * residual_calc_dec(v_tpl -> 'transaction' -> v_col);
          when 'debit fees', 'debit late fees' then
            v_mp := v_count * residual_calc_dec(v_m -> 'achReturn');
            v_br := v_count * residual_calc_dec(v_tpl -> 'achReturn' -> v_col);
          when 'debit unauth fees' then
            -- ASSUMPTION X6: per occurrence (× Count).
            v_mp := v_count * case v_risk when 'moderate_risk' then 7.50 when 'high_risk' then 10.00 else 5.00 end;
            v_br := v_count * residual_calc_dec(v_tpl -> 'debitUnauthorizedFee' -> v_col);
          when 'discount' then
            -- Count is the dollar volume here.
            v_mp := v_count * residual_calc_dec(v_m -> 'achBin');
            v_br := v_count * residual_calc_dec(v_tpl -> 'odfiSponsorship' -> v_col);
          when 'gateway fees' then
            v_mp := residual_calc_dec(v_m -> 'achMonthlyGatewayFee'); v_br := 0;
          when 'noc' then
            v_mp := v_count * residual_calc_dec(v_m -> 'achExceptionCorrectionsFee'); v_br := 0;
          when 'reject fees' then
            if v_count <> 0 or v_report_net <> 0 then
              v_flags := jsonb_build_array(residual_calc_flag('ach', 'REJECT_FEES_NO_RULE', 'Reject Fees: no rule yet'));
            end if;
          else
            v_flags := jsonb_build_array(residual_calc_flag('ach', 'UNKNOWN_FEE_CATEGORY',
              format('Unknown fee category "%s"', rec.e ->> 'feeCategory')));
        end case;

        if v_mp is not null and v_br is not null then
          v_net := round(v_mp, 2) - round(v_br, 2);
          v_split := round(v_net * v_pct::numeric, 2);
          v_sums := v_sums || jsonb_build_object(v_mid, jsonb_build_object(
            'net', residual_calc_dec(v_sums -> v_mid -> 'net') + v_net,
            'split', residual_calc_dec(v_sums -> v_mid -> 'split') + v_split,
            'pct', v_pct));
          if v_net - v_report_net > 1 then
            v_flags := v_flags || jsonb_build_array(residual_calc_flag('ach', 'OUR_NET_HIGHER',
              format('Our Net %s is higher than the report''s %s', residual_calc_money(v_net), residual_calc_money(v_report_net))));
          end if;
          if v_report_net - v_net > 1 then
            v_flags := v_flags || jsonb_build_array(residual_calc_flag('ach', 'OUR_NET_LOWER',
              format('Our Net %s is lower than the report''s %s', residual_calc_money(v_net), residual_calc_money(v_report_net))));
          end if;
        end if;
      end if;
    end if;

    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'merchantName', v_name, 'mid', v_mid, 'feeCategory', rec.e ->> 'feeCategory',
      'reportNet', residual_calc_money(v_report_net),
      'merchantPayment', residual_calc_money(v_mp), 'buyRate', residual_calc_money(v_br),
      'net', residual_calc_money(v_net), 'split', residual_calc_money(v_split),
      'flags', v_flags, 'color', residual_calc_color(v_flags)));
  end loop;

  foreach v_mid in array v_order loop
    if v_blocks ? v_mid then
      v_mids := v_mids || jsonb_build_array(jsonb_build_object('mid', v_mid, 'calculated', false, 'net', null,
        'percentage', null, 'total', null, 'flags', jsonb_build_array(v_blocks -> v_mid)));
    else
      select m ->> 'riskLevel' into v_risk from jsonb_array_elements(p -> 'merchants') m where m ->> 'mid' = v_mid limit 1;
      v_mid_net := residual_calc_dec(v_sums -> v_mid -> 'net');
      -- Negative Net: the total is the Net, the percentage not applied.
      v_mid_total := case when v_mid_net < 0 then v_mid_net else residual_calc_dec(v_sums -> v_mid -> 'split') end;
      v_total := v_total + v_mid_total;
      v_mids := v_mids || jsonb_build_array(jsonb_build_object('mid', v_mid, 'calculated', true,
        'net', residual_calc_money(v_mid_net),
        'percentage', case v_risk when 'moderate_risk' then '0.80' else '0.90' end,
        'total', residual_calc_money(v_mid_total), 'flags', '[]'::jsonb));
    end if;
  end loop;

  return jsonb_build_object('rows', v_rows, 'mids', v_mids, 'unmatchedNames', to_jsonb(v_unmatched),
                            'total', residual_calc_money(v_total));
end
$$;

-- ── Accept.blue ──────────────────────────────────────────────────────────

create or replace function residual_calc_ab_amounts(setup numeric, monthly numeric, txn numeric, cu numeric, daf numeric)
returns jsonb language sql immutable
set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'setup', residual_calc_money(setup), 'monthly', residual_calc_money(monthly),
    'transaction', residual_calc_money(txn), 'cardUpdaterPerUpdate', residual_calc_money(cu),
    'daf', residual_calc_money(daf),
    'total', residual_calc_money(coalesce(setup, 0) + monthly + txn + cu + daf))
$$;

create or replace function residual_calc_accept_blue(p jsonb)
returns jsonb language plpgsql immutable
set search_path = public, pg_temp as $$
declare
  v_month text := p ->> 'month';
  v_report_month text;
  v_alerts jsonb := '[]';
  v_results jsonb := '[]';
  v_matched text[] := '{}';
  v_missing text[];
  v_col text;
  v_mid text;
  v_by text;
  v_m jsonb;
  v_flags jsonb;
  v_expected jsonb;
  v_ab_n int;
  v_iso_n int;
  v_first_billed text;
  v_setup numeric;
  v_monthly numeric;
  v_txn numeric;
  v_charged_monthly numeric;
  v_charged_setup numeric;
  v_expected_total numeric := 0;
  v_charged_total numeric := 0;
  rec record;
begin
  -- The Month cell: an Excel date serial (day 0 = 1899-12-30) or 'YYYY-MM[-DD]'.
  v_report_month := case jsonb_typeof(p -> 'reportMonth')
    when 'number' then to_char(date '1899-12-30' + (p ->> 'reportMonth')::int, 'YYYY-MM')
    else left(p ->> 'reportMonth', 7) end;
  if v_report_month is distinct from v_month then
    v_alerts := v_alerts || jsonb_build_array(residual_calc_flag('acceptBlue', 'MONTH_MISMATCH',
      format('The report is for %s, not %s', v_report_month, v_month)));
  end if;

  for v_col in
    select k from (select k, min(o) first_o
                     from jsonb_array_elements(p -> 'reportRows') with ordinality t(e, o),
                          jsonb_object_keys(coalesce(e -> 'otherColumns', '{}')) k
                    group by k) x order by first_o
  loop
    v_alerts := v_alerts || jsonb_build_array(residual_calc_flag('acceptBlue', 'UNRECOGNIZED_COLUMN',
      format('Column "%s" is not in the spec', v_col), v_col));
  end loop;

  for rec in select e, o from jsonb_array_elements(p -> 'reportRows') with ordinality t(e, o) order by o loop
    v_flags := '[]';
    v_expected := null;
    v_by := null;

    -- Match the MID: ERTCFunding LLC by name; otherwise exact, then without the trailing digit.
    if jsonb_typeof(rec.e -> 'mid') is distinct from 'string' then
      v_mid := case when lower(btrim(rec.e ->> 'name')) = 'ertcfunding llc' then '30119801440' end;
      if v_mid is not null then v_by := 'name_exception'; end if;
    else
      v_mid := btrim(rec.e ->> 'mid');
      if exists (select 1 from jsonb_array_elements(p -> 'merchants') m where m ->> 'mid' = v_mid) then
        v_by := 'exact';
      elsif length(v_mid) > 1 and exists (select 1 from jsonb_array_elements(p -> 'merchants') m where m ->> 'mid' = left(v_mid, -1)) then
        v_mid := left(v_mid, -1);
        v_by := 'trailing_zero';
      end if;
    end if;
    select m into v_m from jsonb_array_elements(p -> 'merchants') m where m ->> 'mid' = v_mid limit 1;
    if v_m is null then v_mid := null; v_by := null; else v_matched := v_matched || v_mid; end if;

    v_charged_monthly := residual_calc_dec(rec.e -> 'monthlyGatewayFeeIso') + residual_calc_dec(rec.e -> 'paymentPagesIso')
                       + residual_calc_dec(rec.e -> 'cardUpdaterMonthlyIso');
    v_charged_setup := case when jsonb_typeof(rec.e -> 'setupFeeIso') in ('string', 'number')
                         then residual_calc_dec(rec.e -> 'setupFeeIso') end;

    if v_m is null then
      v_flags := v_flags || jsonb_build_array(residual_calc_flag('acceptBlue', 'MID_NOT_IN_CRM', 'MID not found in the CRM'));
    else
      select count(*) filter (where residual_calc_provider(e ->> 'provider') = 'acceptblue'),
             count(*) filter (where residual_calc_provider(e ->> 'provider') = 'acceptblue' and residual_calc_norm(e ->> 'billedTo') = 'iso'),
             (array_agg(e ->> 'billedTo') filter (where residual_calc_provider(e ->> 'provider') = 'acceptblue'))[1],
             sum(residual_calc_dec(e -> 'oneTimeFee')) filter (where residual_calc_provider(e ->> 'provider') = 'acceptblue' and residual_calc_norm(e ->> 'billedTo') = 'iso'),
             sum(residual_calc_dec(e -> 'monthlyFee')) filter (where residual_calc_provider(e ->> 'provider') = 'acceptblue' and residual_calc_norm(e ->> 'billedTo') = 'iso'),
             sum(residual_calc_dec(e -> 'perItemFee')) filter (where residual_calc_provider(e ->> 'provider') = 'acceptblue' and residual_calc_norm(e ->> 'billedTo') = 'iso')
        into v_ab_n, v_iso_n, v_first_billed, v_setup, v_monthly, v_txn
        from jsonb_array_elements(coalesce(v_m -> 'equipment', '[]')) e;

      if v_ab_n = 0 then
        v_flags := v_flags || jsonb_build_array(residual_calc_flag('acceptBlue', 'NO_AB_ROW', 'No Accept.blue row in Merchant Equipment Setup'));
      elsif v_iso_n = 0 then
        v_flags := v_flags || jsonb_build_array(residual_calc_flag('acceptBlue', 'AB_NOT_BILLED_TO_ISO',
          format('Accept.blue row is billed to %s, not ISO', v_first_billed)));
      else
        if v_iso_n > 1 then
          v_flags := v_flags || jsonb_build_array(residual_calc_flag('acceptBlue', 'MULTIPLE_AB_ROWS',
            format('%s Accept.blue rows billed to ISO, added together', v_iso_n)));
        end if;
        -- Setup is compared only when the report's Setup Fee ISO is above 0 (ASSUMPTION X10).
        v_setup := case when v_charged_setup > 0 then round(v_setup, 2) end;
        v_monthly := round(v_monthly, 2);
        v_txn := round(v_txn * residual_calc_dec(rec.e -> 'transactionCount'), 2);
        v_expected := residual_calc_ab_amounts(v_setup, v_monthly, v_txn,
          residual_calc_dec(rec.e -> 'cardUpdaterPerUpdateIso'), residual_calc_dec(rec.e -> 'dafTransactionFeeIso'));

        v_flags := v_flags || coalesce((
          select jsonb_agg(case when calc > actual
              then residual_calc_flag('acceptBlue', 'CALC_ABOVE_CHARGED',
                     format('Calculated %s is %s more than charged %s', residual_calc_money(calc), residual_calc_money(calc - actual), residual_calc_money(actual)), field)
              else residual_calc_flag('acceptBlue', 'CALC_BELOW_CHARGED',
                     format('Charged %s is %s more than calculated %s', residual_calc_money(actual), residual_calc_money(actual - calc), residual_calc_money(calc)), field)
            end)
            from (values ('monthly', v_monthly, v_charged_monthly),
                         ('transaction', v_txn, residual_calc_dec(rec.e -> 'transactionFeeIso')),
                         ('setup', v_setup, v_charged_setup)) cmp(field, calc, actual)
           where calc is not null and abs(calc - actual) > 0.02), '[]'::jsonb);
      end if;
    end if;

    if residual_calc_dec(rec.e -> 'cardUpdaterPerUpdateIso') > 5 then
      v_flags := v_flags || jsonb_build_array(residual_calc_flag('acceptBlue', 'OVER_5_REVIEW',
        'Card Updater Per Update over $5: manual review', 'cardUpdaterPerUpdate'));
    end if;
    if residual_calc_dec(rec.e -> 'dafTransactionFeeIso') > 5 then
      v_flags := v_flags || jsonb_build_array(residual_calc_flag('acceptBlue', 'OVER_5_REVIEW',
        'DAF Transaction Fee over $5: manual review', 'daf'));
    end if;
    v_flags := v_flags || coalesce((
      select jsonb_agg(residual_calc_flag('acceptBlue', 'UNRECOGNIZED_COLUMN', format('Column "%s" is not in the spec', k), k))
        from jsonb_object_keys(coalesce(rec.e -> 'otherColumns', '{}')) k), '[]'::jsonb);

    v_expected_total := v_expected_total + residual_calc_dec(v_expected -> 'total');
    v_charged_total := v_charged_total + residual_calc_dec(rec.e -> 'isoTotal');

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'name', rec.e ->> 'name',
      'reportMid', case when jsonb_typeof(rec.e -> 'mid') = 'string' then rec.e ->> 'mid' end,
      'mid', v_mid, 'matchedBy', v_by,
      'expected', v_expected,
      'charged', residual_calc_ab_amounts(v_charged_setup, v_charged_monthly,
        residual_calc_dec(rec.e -> 'transactionFeeIso'), residual_calc_dec(rec.e -> 'cardUpdaterPerUpdateIso'),
        residual_calc_dec(rec.e -> 'dafTransactionFeeIso')),
      'isoTotal', residual_calc_money(residual_calc_dec(rec.e -> 'isoTotal')),
      'flags', v_flags));
  end loop;

  select coalesce(array_agg(m ->> 'mid' order by o), '{}') into v_missing
    from jsonb_array_elements(coalesce(p -> 'merchants', '[]')) with ordinality t(m, o)
   where not (m ->> 'mid') = any (v_matched)
     and exists (select 1 from jsonb_array_elements(coalesce(m -> 'equipment', '[]')) e
                  where residual_calc_provider(e ->> 'provider') = 'acceptblue' and residual_calc_norm(e ->> 'billedTo') = 'iso');
  v_alerts := v_alerts || coalesce((
    select jsonb_agg(residual_calc_flag('acceptBlue', 'MISSING_FROM_REPORT',
             format('MID %s has an Accept.blue row but is missing from the report', x), x))
      from unnest(v_missing) x), '[]'::jsonb);

  return jsonb_build_object(
    'merchants', v_results,
    'missingFromReport', to_jsonb(v_missing),
    'alerts', v_alerts,
    'expectedTotal', residual_calc_money(v_expected_total),
    'chargedTotal', residual_calc_money(v_charged_total));
end
$$;

-- ── Access ───────────────────────────────────────────────────────────────
-- Pure functions over their arguments: they read no table, so they expose
-- nothing. Still kept off anon and public.

do $$
declare f text;
begin
  foreach f in array array[
    'residual_calc_dec(jsonb)', 'residual_calc_money(numeric)', 'residual_calc_flag(text,text,text,text)',
    'residual_calc_color(jsonb)', 'residual_calc_provider(text)', 'residual_calc_norm(text)',
    'residual_calc_fee_rule(text)', 'residual_calc_bucket(text)',
    'residual_calc_acq_row(jsonb,jsonb,text,jsonb,jsonb,numeric,numeric,numeric,numeric,boolean,boolean,boolean,boolean)',
    'residual_calc_acq_report_flags(jsonb)', 'residual_calc_acquiring(jsonb)', 'residual_calc_ach(jsonb)',
    'residual_calc_ab_amounts(numeric,numeric,numeric,numeric,numeric)', 'residual_calc_accept_blue(jsonb)']
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end
$$;
