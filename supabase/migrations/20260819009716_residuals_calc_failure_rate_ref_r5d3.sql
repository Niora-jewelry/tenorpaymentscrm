-- Ported from Daniel Weissman's residuals branch, file
-- `20260901120000_residuals_calc_failure_rate_ref_r5d3.sql`.
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
-- Residuals R5d Part 3 — the failed INPUT, recorded as data
-- ============================================================
--
-- WHY THIS MIGRATION EXISTS, AND WHY IT TOUCHES THE ENGINE.
--
-- The Part 3 rate editor has to show, per field, whether the last run failed
-- on that field. residual_calc_failures already knows — it is right there in
-- the detail text: `the merchant rate "monthly_fee_tapdash" is not set`. But
-- it is there as PROSE, and prose is not a join key. A UI that recovered the
-- column name with a regular expression would be reading a sentence written
-- one line earlier by the same codebase, and would break the day somebody
-- improves the wording of an error message — the kind of change nobody
-- expects to have consequences.
--
-- THE ALTERNATIVE CONSIDERED AND REJECTED: derive the field from the registry
-- instead, by joining the failed line's fee item to its rule's terms and
-- taking the ones with rate_source = 'merchant'. That needs no engine change,
-- and it is wrong. A rule can have several merchant terms — "Monthly Fee" has
-- both monthly_fee_tapdash and monthly_fee_maverick — while the engine records
-- the FIRST failure only. The registry join would light up both fields on a
-- line that failed on one, telling the operator to fill in something that is
-- not blocking anything. What was asked for is what the run RECORDED, not what
-- it might have wanted, and those differ precisely because of
-- first-failure-wins.
--
-- So the engine records it. One nullable column, one extra OUT parameter, and
-- the call sites that carry it. No arithmetic changes, no rounding changes, no
-- row written that was not written before.
--
-- NO BACKFILL, DELIBERATELY. residual_calc_failures is replaced wholesale on
-- every run and is defined as describing the LATEST run; rows written before
-- this column existed carry NULL, and the next run replaces them. Backfilling
-- would mean parsing the detail text — the exact coupling this migration
-- exists to remove — to populate rows that are about to be deleted anyway.
--
-- Idempotent: add-column-if-not-exists, drop-if-exists then create.

begin;

-- ============================================================
-- 1. The column
-- ============================================================
-- NULLABLE, AND NULL IS MEANINGFUL: most failures are not about a rate at
-- all. no_volumes, missing_line_input, unknown_fee_item, group_no_anchor_line,
-- unusable_mid and no_merchant_rates all leave it NULL, because no single rate
-- column is the thing that failed. Only missing_merchant_rate and
-- missing_template_rate name one.
--
-- NO FOREIGN KEY, AND NO CHECK AGAINST A COLUMN LIST. The value is a rate
-- REFERENCE, and rate_source decides what it references: for
-- missing_merchant_rate it is a column of residual_merchant_rates; for
-- missing_template_rate it is a residual_fee_items.fee_item_key. A constraint
-- would have to switch on reason_code to be correct, and the value is copied
-- verbatim from residual_formula_terms.rate_ref, which
-- tg_residual_formula_terms_validate already checks at write time.
-- Constraining it a second time, differently, in a table of transient work
-- items is not protection — it is a second opinion that can disagree with the
-- first.
alter table public.residual_calc_failures
  add column if not exists rate_ref text;

comment on column public.residual_calc_failures.rate_ref is
  'The rate the engine could not resolve, as data rather than prose: a residual_merchant_rates column name when reason_code = missing_merchant_rate, a residual_fee_items.fee_item_key when missing_template_rate, NULL otherwise. Copied verbatim from residual_formula_terms.rate_ref. This is what the rate editor joins on to mark a field as blocking; the detail text remains the human sentence and is parsed by nothing.';

-- Supports the editor's one question: "for this period and this MID, which
-- rate fields did the last run fail on?"
create index if not exists residual_calc_failures_rate_ref
  on public.residual_calc_failures (period_id, mid, rate_ref)
  where rate_ref is not null;

-- ============================================================
-- 2. residual_eval_side gains o_rate_ref
-- ============================================================
-- DROPPED AND RECREATED rather than replaced: adding an OUT parameter changes
-- the function's result type, which create-or-replace refuses. Nothing depends
-- on it structurally — it is granted to no role and no view selects from it —
-- and compute_residual_period calls it by column NAME, so the extra column is
-- invisible to any caller that does not ask for it.
--
-- THE BODY IS OTHERWISE UNCHANGED. Two assignments are added, both on branches
-- that were already returning a failure; no branch that previously produced a
-- value produces a different one.
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
  t        record;
  v_op     numeric;
  v_rate   numeric;
  v_volkey text;
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
    -- ---- the sibling condition, evaluated against this (period, mid) ----
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

    -- ---- rate ----
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
        -- NULL is "no arrangement recorded", which must fail loud rather than
        -- contribute zero. This is the single most common failure on May: it
        -- is what monthly_fee_tapdash being 0-of-33 produces.
        o_failure  := format('the merchant rate "%s" is not set', t.rate_ref);
        o_reason   := 'missing_merchant_rate';
        o_rate_ref := t.rate_ref;
        o_value := null; return;
      end if;
    else -- template
      v_rate := (p_buy ->> t.rate_ref)::numeric;
      if v_rate is null then
        o_failure  := format('no template buy rate for "%s" at this merchant''s risk tier', t.rate_ref);
        o_reason   := 'missing_template_rate';
        o_rate_ref := t.rate_ref;
        o_value := null; return;
      end if;
    end if;

    -- ---- accumulate at FULL precision (header, step 1) ----
    o_value := o_value + (t.term_sign * v_op * v_rate);
  end loop;
end;
$$;

comment on function public.residual_eval_side(uuid, text, numeric, numeric, jsonb, jsonb, jsonb, text[]) is
  'Evaluates one side of one rule to an UNROUNDED value, or reports the first input it could not resolve — as a reason code, a human sentence, and, when that input was a rate, the rate reference itself. A side with no active terms is 0 — the registry''s representation of "Always $0". Takes scalars and jsonb rather than composite types so it is testable without constructing a period.';

revoke all on function public.residual_eval_side(uuid, text, numeric, numeric, jsonb, jsonb, jsonb, text[])
  from public, anon, authenticated, service_role;

-- ============================================================
-- 3. compute_residual_period carries it to the failure row
-- ============================================================
-- IDENTICAL to 20260831120000 except for the rate_ref plumbing:
--   * three new locals, v_inc_rr / v_buy_rr / v_add_rr;
--   * the three residual_eval_side calls per line and per group also select
--     o_rate_ref;
--   * the line-scope and group-scope failure inserts write rate_ref.
--
-- THE PICK IS A CASE, NOT A COALESCE, AND THAT IS THE ONE SUBTLE PART.
-- The reason and the sentence are chosen by `coalesce(v_inc_*, v_buy_*,
-- v_add_*)` — first side that failed wins. coalesce on the rate refs would NOT
-- agree with that, because most failures leave rate_ref NULL: a line whose
-- income side failed on no_volumes and whose buy_rate side failed on a missing
-- template rate would get reason 'no_volumes' from income and rate_ref from
-- buy_rate, producing a row claiming a volume failure on a named rate. The
-- case expression takes the ref from the SAME side that supplied the reason,
-- so the row is internally consistent or the ref is NULL.
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
  /** tier -> { share, rates{fee_item_key: rate} }, built once per run. */
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
  -- ---------- gate ----------
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

  -- A reconciled period is signed off. The Part 1 write guard would reject the
  -- first engine-column UPDATE anyway, but that raise would come from deep
  -- inside the loop after work had been done. Refusing here says the same
  -- thing at the point the operator can act on it.
  if v_status = 'reconciled' then
    raise exception
      'Statement month % is reconciled; reopen it before recomputing.',
      to_char(v_month, 'YYYY-MM')
      using errcode = '42501',
            hint = 'Set residual_periods.status to ''open'' for this period first.';
  end if;

  -- ---------- registry, by the period's month ----------
  select g.id, g.label into v_registry, v_reg_label
    from public.residual_formula_registries g
   where g.processor = v_processor and g.deleted_at is null
     and g.effective_from <= v_month
     and (g.effective_to is null or g.effective_to > v_month);

  -- Should be impossible while the predecessor registry starts at 2000-01-01,
  -- but the raise beats the assumption: computing a month no rule set covers
  -- would mean evaluating nothing and calling it zero.
  if v_registry is null then
    raise exception 'No % formula registry covers %.', v_processor, v_month
      using errcode = '22023';
  end if;

  -- ---------- buy rates, genuinely once per run ----------
  -- Hoisted out of the merchant loop into a tier -> {share, rates} map. Called
  -- per merchant it would be 21 calls to a SECURITY DEFINER function returning
  -- the same 44 rows every time; the month is fixed for the whole run, so the
  -- answer is too.
  --
  -- It RAISES on an uncovered month, and that raise is correct and fatal
  -- rather than per-merchant: a missing template grid is not one merchant's
  -- problem, and computing without it would mean treating every buy rate as
  -- absent.
  select jsonb_object_agg(t.risk_tier, t.obj)
    into v_buy_by_tier
    from (
      select b.risk_tier,
             jsonb_build_object(
               'share', min(b.tapdash_share),
               'rates', jsonb_object_agg(b.fee_item_key, b.rate)) as obj
        from public.residual_buy_rates_for_month(v_processor, v_month) b
       group by b.risk_tier
    ) t;

  v_version := v_version + 1;

  -- ---------- the previous run's work list goes ----------
  delete from public.residual_calc_failures where period_id = p_period_id;

  -- ---------- per merchant ----------
  for v_mid in
    select distinct regexp_replace(l.mid, '[^0-9]', '', 'g')
      from public.residual_lines l
     where l.period_id = p_period_id and l.deleted_at is null
     order by 1
  loop
    v_rates := null;

    -- ---- an unusable MID is its own problem, with its own owner ----
    --
    -- residual_lines.mid is bare `text not null` — it has NO digits-only CHECK,
    -- unlike residual_merchant_rates.mid which does. So a line whose MID is
    -- blank, "N/A" or punctuation-only is storable today (none exist: all 394
    -- rows normalize to at least one digit), and it would normalize to the
    -- empty string here.
    --
    -- Passing that to residual_merchant_rates_for_month raises 22004, which is
    -- NOT in the catch below and would therefore abort the entire run — twenty
    -- priced merchants losing their numbers because one line has a junk MID.
    -- That is precisely the failure grain this engine exists to avoid.
    --
    -- It is CAUGHT HERE, BEFORE THE CALL, rather than by widening the catch,
    -- for two reasons. Testing the value directly is cheaper and clearer than
    -- catching an exception raised on our behalf. And "this line's MID is
    -- unusable" is a DIFFERENT problem from "this merchant has no rates", with
    -- a different owner — the first belongs to whoever fixes the import, the
    -- second to whoever enters rates — so it gets its own reason code rather
    -- than being lumped in with a missing rate card.
    --
    -- THE ROOT FIX IS A CHECK ON residual_lines.mid, deliberately not made
    -- here: it is an import-path change that would need every write path
    -- traced, and it belongs with whoever owns R4a rather than with the engine.
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

    -- The ONE lookup, in its own exception scope.
    --
    -- P0002 is its documented "no rates in effect" signal and is the only code
    -- caught. The other two it can raise are both unreachable from here:
    --   22004 — blank MID — is pre-empted immediately above.
    --   42501 — not authorized — cannot fire, because this function gated on
    --           the same auth_role() in its first statement and a nested call
    --           preserves auth.uid() (it reads a GUC, not a parameter). If the
    --           outer gate passed, the inner one passes.
    -- Anything else is a bug and is re-raised rather than being reported as
    -- "this merchant has no rates".
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

      -- Any outputs from a previous run are no longer true of this one.
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

    -- The tier's share and template rates, out of the map built once above.
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

    -- Volumes for this (period, mid). NULL is normal and is only a failure for
    -- a rule that actually reads one — resolved per term, not here.
    select to_jsonb(v) into v_vol
      from public.residual_merchant_volumes v
     where v.period_id = p_period_id and v.deleted_at is null
       and regexp_replace(v.mid, '[^0-9]', '', 'g') = v_mid
     limit 1;

    -- Every fee item this merchant carries this period — the sibling test's
    -- input. Read ONCE per merchant: the conditional must see the whole set,
    -- so the engine can never be handed a filtered subset of a merchant's rows.
    select array_agg(distinct l.fee_item_name)
      into v_siblings
      from public.residual_lines l
     where l.period_id = p_period_id and l.deleted_at is null
       and regexp_replace(l.mid, '[^0-9]', '', 'g') = v_mid;

    n_merch_ok := n_merch_ok + 1;

    -- ---------- per line ----------
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

      -- EXACT NAME, NO CATEGORY FALLBACK. A category maps to many rules, so a
      -- fallback has no single answer and would apply an arbitrary rule to
      -- real money. An unknown name is news, and the response to news is to
      -- record it, not to guess.
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

      -- A GROUP MEMBER contributes 0.00 at the line grain; its value lives on
      -- residual_line_groups. Writing 0.00 rather than NULL keeps NULL meaning
      -- "not computed" and keeps SUM(lines) + SUM(groups) correct.
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
                -- Same side as the reason above; see the header.
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

      -- ---------- the chain, with rounding exactly where the header says ----------
      v_inc    := round(v_inc,  2);              -- step 2
      v_buyv   := round(v_buyv, 2);              -- step 2
      v_add    := round(v_add,  2);              -- step 2
      v_before := v_inc - v_buyv;                -- step 3, exact
      v_after  := round(v_before * v_share, 2);  -- step 4, THE Q17 POINT

      update public.residual_lines set
        total_income             = v_inc,
        total_buy_rate           = v_buyv,
        tapdash_net_before_split = v_before,
        tapdash_net_after_split  = v_after,
        additional_income_direct = v_add,
        net_income               = v_after + v_add,   -- step 5, exact
        updated_by_id            = v_actor
       where id = v_line.id;

      n_line_ok := n_line_ok + 1;
    end loop;

    -- ---------- groups, computed ONCE per (mid, group_key) ----------
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

        -- The anchor's terms use `one`, so no anchor LINE is required to
        -- evaluate them. A future anchor reading line_item_count would need
        -- one, and residual_eval_side reports that as missing_line_input.
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
  -- STATUS. 'ready' only on a clean run — the period is then computed and
  -- waiting for R6's comparison. Otherwise the failures decide: a period
  -- missing volumes is genuinely awaiting_volumes, which is the one status in
  -- R1b's ladder that has never been written and is exactly right for May.
  -- Anything else stays 'open', because the vocabulary has no "computed with
  -- gaps" and inventing one is a CHECK change this slice does not make.
  --
  -- reconciled/mismatch ARE NOT WRITTEN HERE. They are verdicts on a
  -- comparison this function does not perform — R6 owns them.
  select case
           when not exists (select 1 from public.residual_calc_failures where period_id = p_period_id)
             then 'ready'
           when exists (select 1 from public.residual_calc_failures
                         where period_id = p_period_id and reason_code = 'no_volumes')
             then 'awaiting_volumes'
           else 'open'
         end
    into v_status;

  -- calculation_version IS SET ONLY ON A CLEAN RUN, and this is load-bearing
  -- rather than fastidious.
  --
  -- That column means "there is a standing assertion that this period's stored
  -- outputs are current and complete". A run that recorded failures has not
  -- computed the period; it has computed part of it. Stamping a version on
  -- that would be the claim the header already forbids.
  --
  -- IT ALSO HAS A CONSEQUENCE THAT A TEST FOUND, and the consequence is the
  -- stronger argument. residual_merchant_rate_is_locked treats any period with
  -- a non-null calculation_version as depending on the rates it read, so
  -- stamping a gappy run LOCKS every merchant it touched — including the ones
  -- whose failure is "monthly_fee_tapdash is not set". The operator would then
  -- be unable to fill in that field in place, and would have to create a dated
  -- successor per merchant: a version history recording nothing but the fact
  -- that the sheet was incomplete, which is exactly what R5d 1c's editor
  -- exists to avoid.
  --
  -- So: version and 'ready' and the lock all engage together, or none of them
  -- do. A period with gaps stays editable, which is what a period with gaps
  -- needs to be.
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
  'The calculation engine. Reads the dated registry, merchant rates, buy rates and volumes for the period''s statement month and writes the six engine-owned columns on residual_lines plus residual_line_groups. All arithmetic in SQL. A merchant with no rates is skipped WHOLE and recorded; a line whose rule cannot resolve an input has its outputs NULLed and is recorded, naming the rate it wanted in residual_calc_failures.rate_ref. Never writes reconciled/mismatch — those are R6 verdicts.';

revoke all on function public.compute_residual_period(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.compute_residual_period(uuid, text)
  to authenticated;

commit;
