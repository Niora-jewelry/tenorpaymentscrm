-- Ported from Daniel Weissman's residuals branch, file
-- `20260904150000_residuals_buy_rate_processors_r5e.sql`.
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
-- Residuals R5e — what the buy-rate screen can show
-- ============================================================
--
-- The screen was built for one processor and named MAVERICK in one constant.
-- There are now six schedules across six payers, and two KINDS of payer:
--
--   MAVERICK pays TapDash a share of the net. Its schedule is priced across
--   four risk tiers and carries a tapdash_share per tier.
--
--   ACCEPT_BLUE, TUZO, RICHARD, PAYA_ACH_PPD and PAYA_ACH_WEB are vendors
--   TapDash pays. They have one flat card, no risk dimension, and no share.
--
-- is_residual_split IS DERIVED, NOT DECLARED. It asks whether the schedule's
-- tiers are real risk tiers, so a schedule cannot claim to be one kind while
-- being priced as the other. A new vendor added tomorrow with a vendor_flat
-- tier is classified correctly without anybody updating a list — which is the
-- same reason the grid's row filtering reads the registry rather than a set of
-- hardcoded keys.
--
-- The screen uses it to decide whether to render tier COLUMNS and a share
-- block at all. A vendor card rendered across four tier columns would imply a
-- risk dimension it does not have, and a share block would imply a split that
-- does not exist.
--
-- Idempotent.

begin;

create or replace function public.residual_buy_rate_processors()
returns table (
  processor          text,
  schedule_count     integer,
  is_residual_split  boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if public.auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to read buy-rate schedules.'
      using errcode = '42501';
  end if;

  return query
  select s.processor,
         count(distinct s.id)::int as schedule_count,
         -- TRUE when this payer's schedules are priced across REAL risk tiers.
         -- bool_or over the tier rows, so a schedule with no tiers at all reads
         -- false rather than NULL — an unpriced schedule is not a residual
         -- split either.
         coalesce(bool_or(rt.is_risk_tier), false) as is_residual_split
    from public.residual_buy_rate_schedules s
    left join public.residual_buy_rate_tiers t
      on t.schedule_id = s.id and t.deleted_at is null
    left join public.residual_risk_tiers rt
      on rt.tier_key = t.risk_tier and rt.deleted_at is null
   where s.deleted_at is null
   group by s.processor
   order by (coalesce(bool_or(rt.is_risk_tier), false)) desc, s.processor;
end;
$$;

comment on function public.residual_buy_rate_processors() is
  'Every payer with a buy-rate schedule, and whether its schedules are priced across REAL risk tiers (a residual split, i.e. Maverick) or across a non-risk tier (a vendor card TapDash pays). is_residual_split is DERIVED from residual_risk_tiers.is_risk_tier rather than declared on the schedule, so a schedule cannot claim one kind while being priced as the other, and a new vendor is classified without anyone maintaining a list. Residual-split payers sort first.';

revoke all on function public.residual_buy_rate_processors()
  from public, anon, authenticated, service_role;
grant execute on function public.residual_buy_rate_processors()
  to authenticated;

commit;
