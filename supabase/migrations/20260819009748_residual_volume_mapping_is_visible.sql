begin;

-- ════════════════════════════════════════════════════════════════════════
-- What each fee item is assessed on, where somebody can read it
-- ════════════════════════════════════════════════════════════════════════
--
-- `residual_volume_mapping_coverage` has existed since R6a and had an
-- integration test from the start, but nothing in the application ever called
-- it — the only reference outside the migration is the test. So the one place
-- that records which volumes a fee item is charged on has never been on a
-- screen.
--
-- That was tolerable while the mapping was a flat list of buckets. Migration
-- 747 made it conditional and gave it a basis, because the measurement
-- required both: BIN Sponsorship is assessed NET of refunds and picks up Amex
-- only when the merchant is not on Cash Discount, while Cash Discount and
-- Interchange are assessed GROSS on the very same statements.
--
-- A step-1 difference is now unreadable without that detail. An operator
-- looking at BIN out by 1.34 cannot tell whether the comparison was against
-- two buckets or three, gross or net — and those are exactly the questions
-- that decide whether the difference matters. So the function gains the detail
-- and the Statements screen shows it.
--
-- DROP and recreate, not `create or replace`: the return type changes, and
-- Postgres will not replace a function's signature in place.

drop function if exists public.residual_volume_mapping_coverage(uuid);

create or replace function public.residual_volume_mapping_coverage(
  p_period_id uuid
)
returns table (
  fee_item_name text,
  line_count    bigint,
  is_mapped     boolean,
  buckets       text[],
  -- 'gross', 'net', or 'mixed' when one fee item's buckets disagree. Mixed is
  -- a real possibility and worth seeing rather than averaging away.
  basis         text,
  -- One entry per bucket: its basis, its condition, and the sibling the
  -- condition names. jsonb rather than more parallel arrays, so adding a
  -- property to a mapping reaches the screen without another signature change.
  bucket_detail jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_month date;
begin
  if auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to read volume mapping coverage.'
      using errcode = '42501';
  end if;

  select p.statement_month into v_month
    from public.residual_periods p
   where p.id = p_period_id and p.deleted_at is null;

  if v_month is null then
    raise exception 'No live residual period with id %.', p_period_id
      using errcode = 'P0002';
  end if;

  return query
    with period_items as (
      select l.fee_item_name as fin, count(*) as n
        from public.residual_lines l
       where l.period_id = p_period_id
         and l.deleted_at is null
         and l.fee_item_name is not null
       group by l.fee_item_name
    ),
    -- Mappings reachable from ANY live registry, matched by name. Deliberately
    -- not filtered to the registry in force: a fee item mapped in the
    -- predecessor registry and not the current one is a mapping gap worth
    -- seeing, not a row to hide.
    --
    -- DISTINCT on the bucket and its properties together, because both
    -- registries carry the same mapping and an un-deduplicated list would
    -- show every bucket twice.
    rows_in as (
      select distinct
             ru.fee_item_name as fin,
             m.volume_bucket,
             m.basis,
             m.applies_when,
             m.sibling_fee_item_name
        from public.residual_volume_row_mappings m
        join public.residual_formula_rules ru on ru.id = m.rule_id
       where m.deleted_at is null and ru.deleted_at is null
    ),
    mapped as (
      select r.fin,
             array_agg(distinct r.volume_bucket order by r.volume_bucket) as bks,
             case
               when bool_and(r.basis = 'net')   then 'net'
               when bool_and(r.basis = 'gross') then 'gross'
               else 'mixed'
             end as bas,
             jsonb_agg(
               jsonb_build_object(
                 'bucket',       r.volume_bucket,
                 'basis',        r.basis,
                 'applies_when', r.applies_when,
                 'sibling',      r.sibling_fee_item_name
               )
               order by r.volume_bucket
             ) as detail
        from rows_in r
       group by r.fin
    )
    select pi.fin,
           pi.n,
           (mp.bks is not null),
           mp.bks,
           mp.bas,
           coalesce(mp.detail, '[]'::jsonb)
      from period_items pi
      left join mapped mp on mp.fin = pi.fin
     order by (mp.bks is not null), pi.fin;
end;
$$;

comment on function public.residual_volume_mapping_coverage(uuid) is
  'Every fee item this period''s lines actually carry, whether a volume-row mapping covers it, and for the ones it does: which buckets, on what basis (gross or net of refunds), and under what condition. The reason there is no ''unmapped'' verdict outcome: an unmapped row is a question about the MAPPING, not about that row''s money, and a signal that fires on 15 of 20 fee items every period is not a signal.';

revoke all on function public.residual_volume_mapping_coverage(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_volume_mapping_coverage(uuid)
  to authenticated;

commit;
