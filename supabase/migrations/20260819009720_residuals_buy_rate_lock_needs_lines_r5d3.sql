-- Ported from Daniel Weissman's residuals branch, file
-- `20260902130000_residuals_buy_rate_lock_needs_lines_r5d3.sql`.
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
-- Residuals R5d Part 3 — an EMPTY period must not lock the template
-- ============================================================
--
-- A BUG IN 20260901130000, found by real data rather than by reasoning.
--
-- residual_buy_rate_schedule_is_locked asked one question: does a computed,
-- still-standing period fall inside this schedule's range? It deliberately
-- carried NO line filter, and the header argued why:
--
--   "Unlike the merchant-rate equivalent there is no MID filter: every
--    computed line in a period reads the schedule, so a computed period in
--    range locks it outright."
--
-- Every computed line does read the schedule. The unexamined step is the one
-- that broke: a period can be computed and have NO LINES AT ALL.
--
-- That is exactly what happened. The 2026-07 period holds a PDF import and no
-- fee lines. Pressing Compute on it ran the engine over an empty set, recorded
-- zero failures, and therefore — correctly, by the engine's own rule that
-- version and 'ready' and the lock engage together — stamped status 'ready'
-- and calculation_version 1. A period with nothing in it is trivially complete.
--
-- The consequence was not trivial. That vacuous run locked the entire Maverick
-- buy-rate template against in-place edits, on behalf of zero lines that read
-- zero rates. It was caught because it broke a seed-idempotency test that had
-- been passing for weeks, which is a poor way to find out.
--
-- THE FIX IS THE HALF OF THE MERCHANT-RATE PREDICATE THAT GENERALISES.
-- residual_merchant_rate_is_locked filters on the period carrying lines FOR
-- THAT MID, and its header states the principle: "a merchant boarded but never
-- billed has nothing depending on its rates". The MID half is genuinely
-- specific to merchant rates — every line reads the shared schedule, so which
-- merchant is irrelevant here. The EXISTENCE half is not specific at all, and
-- dropping it was the error: a period billed for nobody has nothing depending
-- on the template either.
--
-- WHY "HAS LINES" AND NOT "HAS COMPUTED LINES". calculation_version is only
-- stamped on a fully clean run, so a still-standing period with at least one
-- line is a period in which every one of those lines computed from this
-- schedule. Testing for computed lines specifically would be the same set
-- reached by a longer route.
--
-- Idempotent: create-or-replace.

begin;

create or replace function public.residual_buy_rate_schedule_is_locked(
  p_processor text,
  p_from      date,
  p_to        date
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.residual_periods p
     where p.deleted_at is null
       and p.calculation_version is not null
       and p.statement_month >= p_from
       and (p_to is null or p.statement_month < p_to)
       -- The period must actually have priced something. An empty period is
       -- trivially 'ready' and depends on no rate in this schedule.
       and exists (
         select 1
           from public.residual_lines l
          where l.period_id = p.id
            and l.deleted_at is null
       )
  );
$$;

comment on function public.residual_buy_rate_schedule_is_locked(text, date, date) is
  'True when a computed, still-standing period that CARRIES LINES falls inside this buy-rate schedule''s effective range. Unlike the merchant-rate equivalent there is no MID filter — every computed line reads the shared schedule, so which merchant is irrelevant — but the existence test is kept, because a period with no lines is trivially ''ready'' and depends on no rate here. Omitting it let an empty period lock the whole template.';

revoke all on function public.residual_buy_rate_schedule_is_locked(text, date, date)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_buy_rate_schedule_is_locked(text, date, date)
  to authenticated;

commit;
