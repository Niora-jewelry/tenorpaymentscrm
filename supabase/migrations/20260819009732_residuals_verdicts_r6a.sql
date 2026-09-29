-- Ported from Daniel Weissman's residuals branch, file
-- `20260907140000_residuals_verdicts_r6a.sql`.
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
-- R6a part 3 of 4 — the verdict derivation, the two grains of status, and the
-- three functions that write acknowledgments.
-- ============================================================================
-- ORDERING: applies after parts 1 and 2.
--
-- NOTHING HERE STORES A VERDICT. residual_verdicts is STABLE and writes
-- nothing. The single place derivation leaves a mark is
-- residual_retire_resolved_acks, which is VOLATILE, separately named, and
-- explicitly invoked - see its header for when it runs and why it is idempotent.

begin;

-- ============================================================
-- 1. residual_verdicts — the three comparisons
-- ============================================================
-- ONE FUNCTION, ALL THREE STEPS, BOTH GRAINS. The alternative — a function per
-- step — would have to resolve the period, the processor, the registry and the
-- tolerances three times and could return three answers built from three
-- different reads of the same rows.
--
-- WHAT EACH STEP COMPARES:
--
--   step 1  residual_lines.amount            vs SUM of the row's mapped
--                                               buckets on residual_merchant_volumes
--   step 2  residual_lines.agent_expense     vs residual_lines.total_buy_rate
--   step 3  residual_lines.net_revenue       vs residual_lines.tapdash_net_before_split
--
-- delta is always RIGHT - LEFT: computed minus stated. Signed, never absolute,
-- because the direction is the first thing an operator needs and an absolute
-- delta throws it away. The tolerance test is on |delta|.
--
-- THE FOUR OUTCOMES:
--
--   match     |delta| <= the tolerance in force for that step and month
--   mismatch  otherwise
--   exempt    this comparison does not apply to this row by RULE SHAPE. Step 2
--             only. A first-class outcome rather than an omitted row, so the
--             grid can say WHY a row has no step-2 verdict instead of leaving
--             a blank cell that reads as an oversight.
--   (no row)  the comparison cannot be made: the operand does not exist. An
--             uncomputed line, an unmapped fee item, a merchant with no volume
--             row. Absence rather than a fifth outcome, for the same reason
--             the registry represents "always $0" as no terms: a fact already
--             expressed by absence does not need a name, and naming it makes
--             two ways to say one thing.
--
-- WHY STEP 2 EXEMPTS TWO RULE FAMILIES, DERIVED FROM SHAPE AND NOT A FLAG.
-- Measured on the 63 computed May lines: 37 of 63 step-2 comparisons differ,
-- and only 5 of those 37 are real.
--
--   MIRROR RULES (22 rows). The rule's buy side is one term, one x net_revenue,
--   sign -1. total_buy_rate is therefore a restatement of the line's own stated
--   net revenue, while agent_expense on every one of those rows is 0.00.
--   Comparing them compares a number to a zero it was never meant to equal, and
--   the deltas run to +3,323.74.
--
--   BILLED-DIRECTLY RULES (10 rows). The rule has no terms at all, so
--   total_buy_rate is 0.00, while the processor did charge agent_expense — 5.00
--   for PCI, 15.00 for Website Monitoring. The delta is exactly the fee, every
--   row, every month, forever.
--
-- Both are read off residual_formula_terms rather than a column, because a flag
-- would be a second, hand-maintained statement of something the terms already
-- say — and the day the two disagreed, the flag would win silently.
--
-- STEP 3 HAS NO EXEMPTION, AND THE THREE BILLED-DIRECTLY ITEMS ARE WHY.
-- The obvious symmetry — "no terms means nothing to compare, so exempt step 3
-- too" — is wrong, and the sample says so. The three items do not behave alike:
--
--   Website Monitoring Fee (3 rows)  income 15.00 = expense 15.00, net 0.00
--   IRS Annual Fee         (2 rows)  income  1.95 = expense  1.95, net 0.00
--   PCI Program           (17 rows)  expense 5.00 on EVERY row; 15 net -5.00,
--                                    and two (201100164707, 30119889965) also
--                                    carry income 9.95 for a net of +4.95
--
-- WEBSITE MONITORING AND IRS ARE GENUINE PASS-THROUGHS. Income equals expense,
-- the stated net is exactly 0.00, and a rule with no terms computes exactly
-- 0.00. Delta zero, verdict 'match', no acknowledgment, no recurring work. They
-- were never what an exemption would have been for — they already pass.
--
-- PCI IS NOT A PASS-THROUGH AT ALL. Maverick charges TapDash 5.00 on all 17
-- rows and only two merchants recover it. The stated net is real money leaving
-- (15 x -5.00 = -75.00 a month in this sample), and our rule books 0.00. So the
-- nine PCI step-3 mismatches are NOT noise and NOT a treadmill: they are the
-- correct output of a comparison against a rule that is wrong. Exempting them
-- would suppress a finding the verdict layer made on its first contact with
-- real data — which is the one thing this layer exists to prevent.
--
-- THE FIX IS A RULE CHANGE, NOT AN EXEMPTION: PCI Program gains terms so the
-- cost it actually carries is modelled. That is pending the user's confirmation
-- and is deliberately NOT part of R6a. Until it lands, the mismatches stand and
-- are the evidence for making the change.
--
-- GROUP MEMBERS ARE EXCLUDED FROM LINE-GRAIN STEPS 2 AND 3. The engine puts a
-- group's value on residual_line_groups and leaves both member lines at 0.00,
-- so a line-grain verdict on a member is not merely redundant, it is wrong: the
-- iPOS pair yields line deltas of +4.00 and +10.00 summing to 14.00 against a
-- true group delta of +24.00. Groups are verdicted from residual_line_groups
-- instead. Step 1 is left at line grain for members too, which costs nothing
-- because no group member's fee item is volume-mapped.
--
-- STEP 1 AT LINE GRAIN ASSUMES ONE MAPPED ROW PER (period, mid, fee item).
-- Measured: zero duplicates in the 197-row sample. Nothing enforces it, and if
-- a merchant ever carries two Interchange rows each is compared to the whole
-- bucket-sum and both mismatch. That is the correct alarm — a duplicated
-- designated row is a data problem — but it will read as two failures rather
-- than one, and a reader should know why.
create or replace function public.residual_verdicts(
  p_period_id uuid,
  p_mid       text default null,
  p_processor text default null
)
returns table (
  scope             text,
  scope_id          uuid,
  mid               text,
  fee_item_name     text,
  group_key         text,
  step              smallint,
  verdict           text,
  left_value        numeric,
  right_value       numeric,
  delta             numeric,
  tolerance_applied numeric,
  ack_id            uuid,
  suppressed        boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_month     date;
  v_proc      text;
  v_registry  uuid;
  v_mid       text := nullif(regexp_replace(coalesce(p_mid, ''), '[^0-9]', '', 'g'), '');
  v_t1        numeric;
  v_t2        numeric;
  v_t3        numeric;
begin
  if public.auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to read residual verdicts.'
      using errcode = '42501';
  end if;

  select p.statement_month into v_month
    from public.residual_periods p
   where p.id = p_period_id and p.deleted_at is null;

  if v_month is null then
    raise exception 'No live residual period with id %.', p_period_id
      using errcode = 'P0002';
  end if;

  -- PROCESSOR RESOLUTION, mirroring computePeriodAction rather than inventing a
  -- second rule. Explicit when given; otherwise derived from the period's
  -- imports, where exactly one distinct value is required. The engine takes it
  -- as a mandatory argument for a reason (spec 8.8): residual_lines has no
  -- processor column, so with two processors in one period neither the engine
  -- nor this function can attribute a line. Both raise rather than guess.
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
    -- More than one row from the GROUP BY means more than one processor; the
    -- SELECT INTO would have taken an arbitrary one silently.
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
           v.debit_volume, v.ebt_volume
      from public.residual_merchant_volumes v
     where v.period_id = p_period_id
       and v.deleted_at is null
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
           sum(case m.volume_bucket
                 when 'amex_volume'  then vol.amex_volume
                 when 'vmd_volume'   then vol.vmd_volume
                 when 'debit_volume' then vol.debit_volume
                 when 'ebt_volume'   then vol.ebt_volume
               end) as rv,
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
     where ln.amount is not null
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
$$;

comment on function public.residual_verdicts(uuid, text, text) is
  'The three comparison steps, derived on read and never stored, at line grain and group grain. delta is computed minus stated, signed. ''exempt'' is step 2 on a mirror or billed-directly rule, read off the terms rather than a flag. A comparison whose operand does not exist emits NO ROW rather than a fifth outcome. Group members are excluded from line-grain steps 2 and 3 because the engine puts their value on the group.';

revoke all on function public.residual_verdicts(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_verdicts(uuid, text, text)
  to authenticated;

-- ============================================================
-- 2. residual_merchant_states — the grain the spec asked for
-- ============================================================
-- Per (period, mid), derived from three sources: the engine's recorded
-- failures, this period's volume coverage, and the verdicts above.
--
-- THE LADDER, worst first. The order is the whole definition:
--
--   blocked           the engine could not compute this merchant for a reason
--                     that is not missing volumes — no rate row, a missing
--                     template rate, an unknown fee item. Nothing downstream
--                     is trustworthy, so this outranks everything.
--   awaiting_volumes  volumes are what is missing. THREE ways to be in this
--                     state, and the second and third are why this is not just
--                     a read of residual_calc_failures:
--                       (a) the engine recorded 'no_volumes';
--                       (b) the merchant has a volume-MAPPED line but no live
--                           volume row — step 1 is uncomputable even though the
--                           engine had no complaint, because rule #20 prices
--                           EBT off item_count and never reads a volume;
--                       (c) a volume row exists but a needed bucket is NULL,
--                           which is exactly what the unreconciled-PDF path
--                           writes.
--   mismatch          computed, but at least one verdict fails and is not
--                     suppressed by a live acknowledgment.
--   ready             every verdict matches, is exempt, or is acknowledged.
--                     This merchant is ready to be signed off.
--   reconciled        'ready', AND the period has been signed off. The two are
--                     the same merchant-level fact under different period-level
--                     circumstances, which is why 'reconciled' cannot be
--                     derived from the merchant alone.
create or replace function public.residual_merchant_states(
  p_period_id uuid,
  p_processor text default null
)
returns table (
  mid                  text,
  state                text,
  blocked_count        bigint,
  awaiting_reason      text,
  mismatch_count       bigint,
  suppressed_count     bigint,
  line_count           bigint,
  uncomputed_count     bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_signed boolean;
begin
  if public.auth.uid() is null
     or not public.auth_is_admin() then
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
           count(*) filter (where f.reason_code <> 'no_volumes') as n_blocked,
           count(*) filter (where f.reason_code =  'no_volumes') as n_novol
      from public.residual_calc_failures f
     where f.period_id = p_period_id
     group by f.mid
  ),
  -- (b) and (c): a mapped line whose volume row is absent or partially NULL.
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
  )
  select mids.m,
         case
           when coalesce(f.n_blocked, 0) > 0                              then 'blocked'
           when coalesce(f.n_novol, 0) > 0
             or coalesce(vg.no_row, false)
             or coalesce(vg.null_bucket, false)                           then 'awaiting_volumes'
           when coalesce(vd.n_mismatch, 0) > 0                            then 'mismatch'
           when v_signed                                                  then 'reconciled'
           else                                                                'ready'
         end,
         coalesce(f.n_blocked, 0),
         case
           when coalesce(f.n_novol, 0) > 0        then 'engine recorded no_volumes'
           when coalesce(vg.no_row, false)        then 'a mapped row has no volume row for this merchant-month'
           when coalesce(vg.null_bucket, false)   then 'a needed volume bucket is NULL on the statement row'
           else null
         end,
         coalesce(vd.n_mismatch, 0),
         coalesce(vd.n_suppressed, 0),
         coalesce(c.n_lines, 0),
         coalesce(c.n_uncomputed, 0)
    from mids
    left join counts c  on c.m  = mids.m
    left join fails  f  on f.m  = mids.m
    left join volgap vg on vg.m = mids.m
    left join verd   vd on vd.m = mids.m
   order by 2, 1;
end;
$$;

comment on function public.residual_merchant_states(uuid, text) is
  'Per-merchant progress state for one period, derived from calc failures, volume coverage and verdicts. awaiting_volumes has three causes, not one: the engine''s own no_volumes failure, a volume-mapped line with no volume row at all, and a volume row whose needed bucket is NULL. The second exists because a merchant can be uncomputable for step 1 while the engine had no complaint.';

revoke all on function public.residual_merchant_states(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_merchant_states(uuid, text)
  to authenticated;

-- ============================================================
-- 3. residual_period_state — min() over merchants, plus the sign-off
-- ============================================================
-- THE 'open' OVERLOAD DISSOLVES HERE, and it is worth being explicit about how,
-- because nothing is renamed. Before R6a, 'open' had to mean both "nothing has
-- happened yet" and "computed, with gaps" — the engine's own comment admitted
-- the vocabulary had no word for the second. It no longer has to, because the
-- second is now said at the MERCHANT grain: a period whose merchants are some
-- ready and some blocked reports 'open' at period grain and names the blocked
-- merchants at merchant grain. 'open' recovers its single meaning — THERE IS NO
-- STANDING ASSERTION THAT THIS PERIOD IS FULLY COMPUTED — which is exactly
-- residual_periods.calculation_version IS NULL.
--
-- THE JULY BUG, FIXED BY THE SAME CHANGE. A period with zero lines has zero
-- merchants, and min() over an empty set is not 'ready' — it is nothing. Under
-- this derivation it reports 'open', which is true: nothing has been computed
-- because there is nothing to compute. The old engine reported 'ready' because
-- it asked "were there failures?" and an empty period trivially has none.
create or replace function public.residual_period_state(
  p_period_id uuid,
  p_processor text default null
)
returns table (
  derived_status    text,
  stored_status     text,
  merchant_count    bigint,
  blocked           bigint,
  awaiting_volumes  bigint,
  mismatch          bigint,
  ready             bigint,
  reconciled        bigint,
  signable          boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_stored text;
begin
  if public.auth.uid() is null
     or not public.auth_is_admin() then
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
$$;

comment on function public.residual_period_state(uuid, text) is
  'The period''s status derived as min() over its merchants, beside the stored column. Dissolves the ''open'' overload: ''computed with gaps'' is now said at merchant grain, so ''open'' recovers its single meaning of no standing assertion that the period is fully computed. A period with zero merchants derives ''open'', never ''ready''.';

revoke all on function public.residual_period_state(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_period_state(uuid, text)
  to authenticated;

-- ============================================================
-- 4. residual_acknowledge_verdict — the human act
-- ============================================================
-- THE DELTA IS DERIVED HERE, NEVER ACCEPTED FROM THE CALLER. A caller-supplied
-- delta could claim any number, and the ack's whole value is that it records
-- what was actually on the screen. The caller names the target and the reason;
-- the function looks up what it is forgiving.
create or replace function public.residual_acknowledge_verdict(
  p_scope     text,
  p_scope_id  uuid,
  p_step      smallint,
  p_reason    text,
  p_processor text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor   uuid := auth.uid();
  v_period  uuid;
  v_status  text;
  v_month   date;
  v_ver     integer;
  v_row     record;
  v_id      uuid;
begin
  if public.auth.uid() is null
     or not public.auth_is_admin() then
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
$$;

comment on function public.residual_acknowledge_verdict(text, uuid, smallint, text, text) is
  'A human forgives one step''s mismatch on one line or group, with a mandatory reason. The delta is DERIVED here and never accepted from the caller: an ack''s whole value is that it records what was actually on the screen. Refuses anything that is not currently a mismatch, and refuses outright on a signed-off month.';

revoke all on function public.residual_acknowledge_verdict(text, uuid, smallint, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_acknowledge_verdict(text, uuid, smallint, text, text)
  to authenticated;

-- ============================================================
-- 5. residual_withdraw_acknowledgment — taking one back
-- ============================================================
-- The brief specified retirement as a system act only. This is the deliberate
-- exception and it is small: a person who acknowledged the wrong row needs a
-- way out, and an append-only table with no retraction path is a trap that
-- forces someone to reach for the admin client. Distinguished from the two
-- automatic reasons by carrying an actor, which the CHECK constraints enforce
-- in both directions.
create or replace function public.residual_withdraw_acknowledgment(
  p_ack_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_n     int;
begin
  if public.auth.uid() is null
     or not public.auth_is_admin() then
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
$$;

comment on function public.residual_withdraw_acknowledgment(uuid, text) is
  'A person takes back a forgiveness they should not have given. The one human retirement reason; the other two are written by the system path. Requires an actor and a reason, both enforced by CHECK constraints on the table.';

revoke all on function public.residual_withdraw_acknowledgment(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_withdraw_acknowledgment(uuid, text)
  to authenticated;

-- ============================================================
-- 6. residual_retire_resolved_acks — THE ONE PLACE DERIVATION WRITES
-- ============================================================
-- The brief asked exactly when this runs and why it is idempotent, because a
-- read-only derivation that leaves a mark is a contradiction unless the mark is
-- carefully placed.
--
-- IT IS NOT INSIDE residual_verdicts. That function is STABLE and callable from
-- a grid render, a report, a test — none of which should mutate anything, and
-- one of which (a read replica, a future read-only role) could not. Retirement
-- is a separate, VOLATILE, separately named function that a caller invokes on
-- purpose.
--
-- WHEN IT RUNS, exhaustively:
--
--   1. At the END of compute_residual_period, after the outputs are written.
--      This is the moment deltas actually move, so it is the moment an ack can
--      become stale. (Wired in part 4.)
--   2. At the START of residual_sign_off_period, before the all-merchants-ready
--      check. Without this a sign-off could be blocked by an ack that should
--      already have been retired, or — worse — permitted by one that should.
--      (Wired in part 4.)
--   3. Explicitly, by R6b's grid, on demand.
--
-- IT NEVER RUNS ON A RECONCILED PERIOD, and never needs to: every input a
-- verdict reads is frozen while the period is signed (see part 2's header), so
-- no ack on it can become stale. The ack table's reconciled guard would refuse
-- the write, which is the check on that reasoning rather than a problem with it.
--
-- WHY IT IS IDEMPOTENT. The UPDATE's WHERE requires retired_at IS NULL and a
-- currently-justifying verdict state. A second run finds the rows already
-- retired and matches nothing. Running it a hundred times has the same effect
-- as running it once, and it returns the counts so a caller can tell the
-- difference between "nothing to do" and "did not run".
--
-- THE TWO REASONS, and note they are exhaustive over "the ack no longer
-- describes the row":
--
--   resolved    the verdict is now 'match' or 'exempt', or has vanished
--               entirely (the line was recomputed to NULL, or soft-deleted).
--               There is nothing left to forgive.
--   superseded  still a mismatch, but at a delta outside tolerance of the one
--               forgiven. The forgiveness was for a different number.
create or replace function public.residual_retire_resolved_acks(
  p_period_id uuid,
  p_processor text default null
)
returns table (resolved integer, superseded integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_res    int := 0;
  v_sup    int := 0;
begin
  if public.auth.uid() is null
     or not public.auth_is_admin() then
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
$$;

comment on function public.residual_retire_resolved_acks(uuid, text) is
  'The ONE place verdict derivation leaves a mark. Retires acknowledgments the arithmetic has overtaken: ''resolved'' when the verdict no longer fails, ''superseded'' when it fails at a different delta. Idempotent - a second run matches nothing. Runs at the end of a compute, at the start of a sign-off, and on demand; never on a signed period, where verdicts are constant.';

revoke all on function public.residual_retire_resolved_acks(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_retire_resolved_acks(uuid, text)
  to authenticated;

commit;
