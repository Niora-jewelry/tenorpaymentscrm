-- Ported from Daniel Weissman's residuals branch, file
-- `20260908120000_residuals_grid_and_synopsis_r6b.sql`.
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
-- R6b part 1 of 2 — the readers the reconciliation surface needs.
-- ============================================================================
-- WHY THIS MIGRATION EXISTS AT ALL. R6b was scoped as a UI slice. It is not:
-- four numbers the surface has to render are returned by no function, and
-- producing them in TypeScript would mean the grid computing money.
--
--   the synopsis            per-MID and company-wide net income, month and
--                           lifetime, with completeness denominators
--   the grid rows           lines with their verdicts ATTACHED — joining
--                           residual_verdicts onto residual_lines is a join on
--                           (scope_id, step) plus an anti-join for absence,
--                           and both are easy to get quietly wrong in a client
--   the merchant volumes    the four buckets at (period, mid), with "no row"
--                           distinguished from "row with NULL buckets"
--   the period history      four append-only sources on one ordered timeline
--
-- MONEY LEAVES HERE AS text, NEVER numeric. residual_derive_plan_rollup set
-- this rule in R5a — "money is returned as text so no JS float ever holds a
-- residual dollar amount" — and a grid is exactly where a float would get one.
-- The surface right-aligns a string; it never parses one.

begin;

-- ============================================================
-- 1. residual_period_context — ONE resolution of "which registry"
-- ============================================================
-- EXTRACTED FROM residual_verdicts, WHICH IS REWRITTEN BELOW TO CALL IT.
--
-- residual_grid_rows needs the registry in force for exactly the reasons
-- residual_verdicts does: group_key decides which lines are group members (and
-- members must render their value as living on the group rather than as the
-- literal 0.00 the engine writes), and sort_order decides row order. Copying
-- the resolution would create two answers to "which registry priced this
-- month", and the day they disagreed the grid would show one registry's group
-- structure beside another registry's verdicts.
--
-- The house has made this argument twice already and both times chose one
-- implementation: residual_merchant_rate_unchanged is "the ONE
-- unchanged-comparison ... so the two cannot disagree", and
-- residual_derive_plan_rollup is "called by BOTH ... so the preview cannot
-- disagree with the commit". This is the same shape.
--
-- THE BODY IS THE R6a BLOCK, MOVED, NOT REWRITTEN. Same two raises, same
-- error codes, same messages — including the one about a period naming more
-- than one processor, which stays the honest refusal it was (residual_lines
-- has no processor column, so with two processors neither this nor the engine
-- can attribute a line).
create or replace function public.residual_period_context(
  p_period_id uuid,
  p_processor text default null
)
returns table (processor text, registry_id uuid, statement_month date)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_month    date;
  v_proc     text;
  v_registry uuid;
begin
  if auth.uid() is null
     or not public.auth_is_admin() then
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
$$;

comment on function public.residual_period_context(uuid, text) is
  'The ONE resolution of "which processor and which formula registry apply to this period". Called by residual_verdicts and residual_grid_rows so the two cannot disagree about a period''s group structure or rule set. Raises rather than guessing when a period names no processor, names more than one, or falls outside every registry.';

revoke all on function public.residual_period_context(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_period_context(uuid, text)
  to authenticated;

-- ============================================================
-- 2. residual_verdicts — REWRITTEN ONLY AT THE HEAD
-- ============================================================
-- Everything from the tolerance resolution down is byte-for-byte the R6a
-- definition. The gate, the month lookup, the processor derivation and the
-- registry lookup are replaced by one call to residual_period_context above.
-- No behaviour changes: same errors, same codes, same messages, same output.
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
  if auth.uid() is null
     or not public.auth_is_admin() then
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
-- 3. residual_grid_rows — the grid, already joined
-- ============================================================
-- ONE SERVER QUERY, NOT A CLIENT JOIN, and the argument is correctness rather
-- than round trips. Handing the surface lines and verdicts separately would
-- put three things in TypeScript that must not be there:
--
--   the JOIN KEY is (scope_id, step), and a client join written on scope_id
--   alone silently attaches step 2's delta to step 3's slot;
--
--   the ANTI-JOIN — "which rows have no verdict" — is the whole of how absence
--   renders, and `find() === undefined` over two arrays is both O(n^2) and one
--   typo away from reporting a verdict that does not exist;
--
--   the SUPPRESSION TEST compares two numerics, and any comparison done in the
--   client has to parse money into a float first.
--
-- So the join happens here, absence is represented by an ABSENT KEY in the
-- verdicts object, and every money column leaves as text.
--
-- ROW ORDER IS THE REGISTRY'S. sort_order is what the calc sheet uses, so a
-- merchant's lines read down the grid in the same order they read on the
-- statement. A line whose fee item matches no rule sorts last rather than
-- being dropped — it is exactly the row somebody needs to see.
create or replace function public.residual_grid_rows(
  p_period_id uuid,
  p_mid       text default null,
  p_processor text default null
)
returns table (
  scope                    text,
  row_id                   uuid,
  mid                      text,
  merchant_name            text,
  fee_category             text,
  fee_item_name            text,
  group_key                text,
  is_group_member          boolean,
  is_group_anchor          boolean,
  item_count               text,
  amount                   text,
  buy_rate_per_item        text,
  agent_income             text,
  agent_expense            text,
  net_revenue              text,
  total_income             text,
  total_buy_rate           text,
  tapdash_net_before_split text,
  tapdash_net_after_split  text,
  additional_income_direct text,
  net_income               text,
  is_computed              boolean,
  volume_buckets           text[],
  verdicts                 jsonb,
  source                   text,
  sort_order               integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_registry uuid;
  v_mid      text := nullif(regexp_replace(coalesce(p_mid, ''), '[^0-9]', '', 'g'), '');
begin
  if auth.uid() is null
     or not public.auth_is_admin() then
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
$$;

comment on function public.residual_grid_rows(uuid, text, text) is
  'The reconciliation grid: one row per live line plus one per live group, with the three verdicts ATTACHED as a jsonb keyed by step. An ABSENT KEY means no verdict for that step, which is how "the comparison could not be made" survives to the client without becoming a blank cell. All money leaves as text so no JS float ever holds a residual dollar amount.';

revoke all on function public.residual_grid_rows(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_grid_rows(uuid, text, text)
  to authenticated;

-- ============================================================
-- 4. residual_merchant_volume_row — and the distinction it keeps
-- ============================================================
-- Trivial, and it exists anyway, because "no volume row" and "a volume row
-- whose buckets are NULL" are different states that a client LEFT JOIN would
-- flatten into the same empty cell. The second is what the unreconciled-PDF
-- path writes on purpose (R5a: buckets and counts written NULL rather than
-- partial "so nothing downstream can read an under-counted total"), and
-- residual_merchant_states already distinguishes them in awaiting_reason.
-- The grid's merchant header has to tell the same two stories.
create or replace function public.residual_merchant_volume_row(
  p_period_id uuid,
  p_mid       text default null
)
returns table (
  mid              text,
  has_row          boolean,
  merchant_name    text,
  amex_volume      text,
  vmd_volume       text,
  debit_volume     text,
  ebt_volume       text,
  amex_item_count  integer,
  vmd_item_count   integer,
  debit_item_count integer,
  ebt_item_count   integer,
  any_bucket_null  boolean,
  source           text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_mid text := nullif(regexp_replace(coalesce(p_mid, ''), '[^0-9]', '', 'g'), '');
begin
  if auth.uid() is null
     or not public.auth_is_admin() then
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
$$;

comment on function public.residual_merchant_volume_row(uuid, text) is
  'The four statement volume buckets at (period, mid), driven from the period''s LINES so a merchant with no statement still returns a row with has_row = false. any_bucket_null separates "no statement" from "a statement whose buckets were written NULL because it did not reconcile" - two states a client LEFT JOIN would flatten into one empty cell.';

revoke all on function public.residual_merchant_volume_row(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_merchant_volume_row(uuid, text)
  to authenticated;

-- ============================================================
-- 5. residual_synopsis — where the suppression rule LIVES
-- ============================================================
-- THE RULE, AND WHY IT IS SUPPRESSION RATHER THAN A "PARTIAL" LABEL.
--
-- Measured on 2026-05 today: the partial sum is -7,086.67. That is not the
-- truth-but-smaller. The mirror rules (#9/#10/#11/#17) book Interchange and
-- card-brand costs as real positive total_buy_rate and compute FINE, because
-- they need no volumes and no merchant rate beyond a tier. The income rules
-- that offset them (#7 BIN Sponsorship, #13 Cash Disc) read volume_amex/vmd/
-- debit and FAIL on every merchant for want of a statement. So a partial run
-- is systematically all-cost-no-income: the number has the wrong SIGN, not
-- merely the wrong magnitude.
--
-- A figure labelled "Net Income: -7,086.67 (partial)" is read as two true
-- things — a loss, and some missing rows. The first is false, and the label
-- does not repair it; it licenses it. "Partial" is the right word for a sum
-- missing random rows and the wrong word for a sum missing one side of the
-- ledger.
--
-- So net_income is NULL unless calculation_version is non-NULL, which is the
-- column that already means "there is a standing assertion that this period's
-- stored outputs are current and complete". Returning NULL rather than a
-- number is what stops a caller rendering it: a component cannot format what
-- it did not receive.
--
-- THE DENOMINATORS ARE ALWAYS RETURNED, disclosable or not. They are facts
-- about coverage, not money, and they are precisely what tells an operator why
-- the figure is absent.
--
-- merchants_computed COUNTS MIDs WITH A NUMBER YOU COULD SUM, which on May is
-- ELEVEN. The engine's own summary says merchants_computed = 12, and that is a
-- different question: "not skipped whole". One merchant survived the merchant
-- gate and then had every line fail. The synopsis needs the first number, so
-- it counts lines rather than trusting the run summary.
--
-- ROWS COUNT LINES ONLY, WHILE MONEY SUMS LINES AND GROUPS. A group summary is
-- a rollup of members already counted; counting it as a row would inflate the
-- denominator by double-counting. Its MONEY must be included, because the
-- engine zeroes the member lines and puts the value on the group — summing
-- lines alone drops exactly 9.00 today and every future group.
create or replace function public.residual_synopsis(
  p_period_id uuid,
  p_mid       text default null,
  p_lifetime  boolean default false
)
returns table (
  mid                text,
  net_income         text,
  rows_total         integer,
  rows_computed      integer,
  merchants_total    integer,
  merchants_computed integer,
  periods_total      integer,
  periods_computed   integer,
  disclosable        boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_mid text := nullif(regexp_replace(coalesce(p_mid, ''), '[^0-9]', '', 'g'), '');
  v_n_periods int;
  v_n_disclosable int;
begin
  if auth.uid() is null
     or not public.auth_is_admin() then
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
$$;

comment on function public.residual_synopsis(uuid, text, boolean) is
  'Per-MID and company-wide net income with completeness denominators. net_income is NULL unless the period carries a non-NULL calculation_version: a partial run computes the cost side (mirror rules need no volumes) and fails the income side (#7 and #13 read volumes), so a partial total has the wrong SIGN, not merely the wrong magnitude - and a caller cannot render what it did not receive. Rows count LINES; money sums lines AND groups, because the engine zeroes member lines and puts the value on the group.';

revoke all on function public.residual_synopsis(uuid, text, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_synopsis(uuid, text, boolean)
  to authenticated;

-- ============================================================
-- 6. residual_period_history — four append-only sources, one timeline
-- ============================================================
-- UNIONED IN SQL RATHER THAN MERGE-SORTED IN THE CLIENT, for the same reason
-- the grid is joined here: four arrays sorted by four different timestamp
-- columns and interleaved by hand is a sort somebody gets wrong once and
-- nobody notices, because a timeline that is slightly out of order still looks
-- like a timeline.
--
-- AN ACKNOWLEDGMENT IS TWO EVENTS, not one. Creating it and retiring it happen
-- at different times, by different actors (retirement by none, when the system
-- does it), for different reasons. Collapsing them to one row keyed on
-- created_at would put a retirement in the wrong place on the timeline.
--
-- THE audit_log JOIN IS THE AWKWARD ONE, AND ITS LIMIT IS STATED. audit_log
-- records a record_id, not a period, so scoping means joining back to the row.
-- For a HARD-DELETED line that join finds nothing and the edit would vanish
-- from the history — which is why R6b's manual-entry writers put period_id
-- into after_data, and why this reads that first. A row predating those
-- writers, or one whose payload lacks the key, is still reachable through the
-- join while its line exists. Recorded as a known limit rather than papered
-- over with a schema change.
create or replace function public.residual_period_history(
  p_period_id uuid,
  p_limit     integer default 200
)
returns table (
  kind        text,
  occurred_at timestamptz,
  actor_id    uuid,
  detail      jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null
     or not public.auth_is_admin() then
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
$$;

comment on function public.residual_period_history(uuid, integer) is
  'Calc runs, status transitions, acknowledgments and manual edits for one period, interleaved on one timeline, newest first. An acknowledgment is TWO events - created and retired - because they happen at different times for different reasons. Manual edits are scoped by the period_id the R6b writers put in after_data, falling back to a join on the still-existing row; a hard-deleted line whose payload lacks the key is the known limit.';

revoke all on function public.residual_period_history(uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_period_history(uuid, integer)
  to authenticated;

commit;
