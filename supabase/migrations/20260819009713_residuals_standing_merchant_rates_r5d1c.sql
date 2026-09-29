-- Ported from Daniel Weissman's residuals branch, file
-- `20260830120000_residuals_standing_merchant_rates_r5d1c.sql`.
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
-- Residuals R5d 1c — the standing rate for many MIDs in ONE call
-- ============================================================
--
-- Fixes an N+1 on the path that unblocks the engine.
--
-- The compact monthly_fee_tapdash editor called residual_merchant_rate_versions
-- once per merchant, sequentially, awaiting each — so rendering the editor for
-- 12 covered merchants cost 12 server-action round trips (auth gate + RPC
-- each) before a single input appeared. The database side is not the problem:
-- residual_merchant_rate_versions measures 4.0 ms. The round trips are, and
-- they scale linearly with the merchant count.
--
-- That editor is the one screen standing between this module and a working
-- calculation — monthly_fee_tapdash is 0-of-33 and is rule #2's only term — so
-- a multi-second blank state before the operator can type is worth removing.
--
-- ============================================================
-- IT RETURNS THE SAME ROW THE EDITOR ALREADY USED
-- ============================================================
--
-- The client's definition of "standing" is
--     residual_merchant_rate_versions(mid).find(v => v.is_standing)
-- and that function computes is_standing as, verbatim,
--     r.effective_to is null
-- (20260829120000, section 5). So the standing row is the live row whose
-- effective_to IS NULL, and this function selects exactly that predicate.
--
-- AT MOST ONE SUCH ROW CAN EXIST PER MID, and that is a constraint rather than
-- a convention: residual_merchant_rates_no_overlap EXCLUDEs on
-- (mid, daterange(effective_from, effective_to)) among live rows, and two rows
-- with effective_to NULL both denote [from, infinity), which always overlap.
-- So a `limit 1` would be redundant and a duplicate is unrepresentable.
--
-- ZERO such rows is possible and is NOT an error: a merchant whose last
-- version was closed without a successor has no standing rate. The old loop
-- skipped that merchant (`if (!standing) continue`), and this function returns
-- no row for it, which the caller treats the same way. Returning a synthetic
-- row would invent a rate card that does not exist.
--
-- ============================================================
-- is_locked CALLS THE ONE DEFINITION
-- ============================================================
--
-- residual_merchant_rate_is_locked is the single definition of "used in a
-- computed period", and it is CALLED here rather than reimplemented. Inlining
-- its EXISTS would put a second copy of a money-safety test next to the
-- authoritative one — the same failure 20260829140000 was written to remove
-- for the unchanged-comparison. If the lock test ever changes (say, to treat a
-- 'mismatch' period as still-standing), it must change in one place.
--
-- Idempotent: create-or-replace only. No table, policy or seed is touched.

begin;

create or replace function public.residual_standing_merchant_rates(
  p_mids text[]
)
returns table (
  mid                  text,
  id                   uuid,
  effective_from       date,
  risk_tier            text,
  monthly_fee_tapdash  numeric(14,6),
  is_locked            boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- The R5b idiom, and it fails closed: auth_role() returns NULL on a
  -- service-role connection (auth.uid() is NULL), and a bare `not in` against
  -- NULL evaluates to NULL, which an IF treats as false and would let the call
  -- through unauthenticated.
  if public.auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to read merchant rates.'
      using errcode = '42501';
  end if;

  -- An empty or NULL list is a caller asking about nothing, not an error:
  -- the editor renders no merchants when the coverage list is empty.
  if p_mids is null or array_length(p_mids, 1) is null then
    return;
  end if;

  return query
    select r.mid,
           r.id,
           r.effective_from,
           r.risk_tier,
           r.monthly_fee_tapdash,
           public.residual_merchant_rate_is_locked(
             r.mid, r.effective_from, r.effective_to)
      from public.residual_merchant_rates r
     where r.deleted_at is null
       and r.effective_to is null                -- == is_standing
       and r.mid = any (
             select regexp_replace(m, '[^0-9]', '', 'g')
               from unnest(p_mids) m
           )
     order by r.mid;
end;
$$;

comment on function public.residual_standing_merchant_rates(text[]) is
  'The standing (effective_to IS NULL) rate version for each of many MIDs, in one call — replaces an N+1 that cost one server-action round trip per merchant before the compact editor could render. Selects the same row residual_merchant_rate_versions marks is_standing, which the no-overlap EXCLUDE makes unique per MID; a merchant with no standing version simply returns no row. is_locked CALLS residual_merchant_rate_is_locked rather than reimplementing it.';

revoke all on function public.residual_standing_merchant_rates(text[])
  from public, anon, authenticated, service_role;
grant execute on function public.residual_standing_merchant_rates(text[])
  to authenticated;

commit;
