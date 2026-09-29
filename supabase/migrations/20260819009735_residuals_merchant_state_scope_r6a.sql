-- Ported from Daniel Weissman's residuals branch, file
-- `20260907170000_residuals_merchant_state_scope_r6a.sql`.
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
-- R6a follow-up — two fixes the first real run of residual_merchant_states
-- found on the May 2026 data. The ladder itself is unchanged.
-- ============================================================================
-- 1. awaiting_reason LEAKED ONTO STATES THAT ARE NOT awaiting_volumes.
--    The reason expression was a CASE evaluated independently of the state
--    CASE, so a 'blocked' merchant that ALSO had a no_volumes failure came back
--    reading "engine recorded no_volumes" — naming a cause that is not why it
--    is in the state it is in. On the May data that was 9 of 21 rows. A column
--    that explains a different row's state is worse than an empty one.
--
-- 2. blocked_count COLLAPSED TWO COHORTS THAT NEED DIFFERENT ACTIONS.
--    'blocked' is correct for both, and the ladder stays as designed — but the
--    failure SCOPE distinguishes them and the caller could not see it:
--
--      merchant scope  the engine skipped the merchant WHOLE (no rate row in
--                      effect). Nothing computed. On May: 9 merchants.
--      line scope      the merchant computed, and some line could not resolve
--                      an input (a missing template or merchant rate). Most of
--                      its figures are real. On May: 12 merchants.
--
--    That is the 12/9 split the engine's own summary reports as
--    merchants_computed / merchants_failed, and at merchant grain it was
--    invisible. "Enter this merchant's rates" and "fill in one rate this
--    merchant's line wanted" are different jobs, so the counts are now
--    separate. blocked_count is retained as their sum so no caller breaks.

begin;

-- The return signature gains two columns, and CREATE OR REPLACE cannot change
-- the return type of an existing set-returning function. Dropping is safe here:
-- residual_period_state calls this by name from plpgsql, which resolves at
-- execution time, so it picks up the new definition without being rebuilt.
drop function if exists public.residual_merchant_states(uuid, text);

create or replace function public.residual_merchant_states(
  p_period_id uuid,
  p_processor text default null
)
returns table (
  mid                  text,
  state                text,
  blocked_count        bigint,
  skipped_whole        bigint,
  blocked_lines        bigint,
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
           count(*) filter (where f.reason_code <> 'no_volumes')                        as n_blocked,
           count(*) filter (where f.reason_code <> 'no_volumes' and f.scope =  'merchant') as n_whole,
           count(*) filter (where f.reason_code <> 'no_volumes' and f.scope <> 'merchant') as n_lineblk,
           count(*) filter (where f.reason_code =  'no_volumes')                        as n_novol
      from public.residual_calc_failures f
     where f.period_id = p_period_id
     group by f.mid
  ),
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
  ),
  resolved as (
    select mids.m,
           case
             when coalesce(f.n_blocked, 0) > 0                            then 'blocked'
             when coalesce(f.n_novol, 0) > 0
               or coalesce(vg.no_row, false)
               or coalesce(vg.null_bucket, false)                         then 'awaiting_volumes'
             when coalesce(vd.n_mismatch, 0) > 0                          then 'mismatch'
             when v_signed                                                then 'reconciled'
             else                                                              'ready'
           end as st,
           coalesce(f.n_blocked, 0)  as n_blocked,
           coalesce(f.n_whole, 0)    as n_whole,
           coalesce(f.n_lineblk, 0)  as n_lineblk,
           coalesce(f.n_novol, 0)    as n_novol,
           coalesce(vg.no_row, false)      as no_row,
           coalesce(vg.null_bucket, false) as null_bucket,
           coalesce(vd.n_mismatch, 0)   as n_mismatch,
           coalesce(vd.n_suppressed, 0) as n_suppressed,
           coalesce(c.n_lines, 0)       as n_lines,
           coalesce(c.n_uncomputed, 0)  as n_uncomputed
      from mids
      left join counts c  on c.m  = mids.m
      left join fails  f  on f.m  = mids.m
      left join volgap vg on vg.m = mids.m
      left join verd   vd on vd.m = mids.m
  )
  select r.m,
         r.st,
         r.n_blocked,
         r.n_whole,
         r.n_lineblk,
         -- GATED ON THE RESOLVED STATE. This is fix 1: the reason explains the
         -- state this row is actually in, or it is NULL.
         case when r.st <> 'awaiting_volumes' then null
              when r.n_novol > 0    then 'engine recorded no_volumes'
              when r.no_row         then 'a mapped row has no volume row for this merchant-month'
              when r.null_bucket    then 'a needed volume bucket is NULL on the statement row'
              else null
         end,
         r.n_mismatch,
         r.n_suppressed,
         r.n_lines,
         r.n_uncomputed
    from resolved r
   order by r.st, r.m;
end;
$$;

comment on function public.residual_merchant_states(uuid, text) is
  'Per-merchant progress state for one period, derived from calc failures, volume coverage and verdicts. awaiting_volumes has three causes, not one: the engine''s own no_volumes failure, a volume-mapped line with no volume row at all, and a volume row whose needed bucket is NULL. awaiting_reason is NULL unless the state IS awaiting_volumes. blocked splits by failure scope: skipped_whole (no rate row, nothing computed) and blocked_lines (computed, but a line could not resolve an input) are different jobs for an operator.';

revoke all on function public.residual_merchant_states(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_merchant_states(uuid, text)
  to authenticated;

commit;
