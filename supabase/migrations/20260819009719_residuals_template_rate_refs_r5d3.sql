-- Ported from Daniel Weissman's residuals branch, file
-- `20260902120000_residuals_template_rate_refs_r5d3.sql`.
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
-- Residuals R5d Part 3 — which template rates a month actually prices
-- ============================================================
--
-- WHY. The buy-rate grid shows every cell the schedule holds, and the schedule
-- outlives the rules that read it. "Monthly Fee (combined with Online Access)"
-- has one populated cell of four and belongs to the PREDECESSOR registry only:
-- after the June changeover no rule reads it, so it renders as a nearly-empty
-- row that looks like missing data rather than superseded data.
--
-- THE ROW MUST NOT BE DELETED, and this is the part worth stating plainly. The
-- fee item and its rate are load-bearing for months before 2026-06: three
-- merchants (Julianas, Monte Carlo, House of Tacos) carry no Online Access line
-- and resolve their pre-June Monthly Fee buy rate through exactly this item.
-- Deleting it makes every pre-June month report missing_template_rate for them.
-- So this is a DISPLAY question, answered with data rather than with a
-- hardcoded key: a future item that goes the same way drops out on its own.
--
-- WHAT "PRICED BY THIS MONTH" MEANS, precisely. A buy rate is only ever read
-- through a residual_formula_terms row with rate_source = 'template', whose
-- rate_ref is the fee_item_key. So the question "does this month's rules read
-- this fee item's buy rate?" is answered by the registry in force for that
-- month, and by nothing else.
--
-- TWO FLAGS, NOT ONE, because "not priced this month" has two very different
-- causes and the screen should not merge them:
--
--   in_month_registry = false, in_any_registry = true
--     SUPERSEDED. Some registry reads it, just not this month's. This is the
--     monthly_fee / monthly_fee_combined case — real history, still read when
--     an earlier month is recomputed.
--
--   in_any_registry = false
--     NEVER READ BY ANY RULE. Either the item is billed directly to the
--     merchant (pci_fee, website_monitoring_fee, irs_annual_fee — the terms
--     validation trigger forbids a term referencing them, so they can never
--     become true), or it is a rate that was loaded and no rule uses, which is
--     `chargeback` today and is a genuine gap somebody may want to know about.
--
-- Collapsing those into one "hidden" bucket would quietly bury a loaded rate
-- that nothing reads, which is the sort of thing a reconciliation screen exists
-- to surface.
--
-- Idempotent.

begin;

create or replace function public.residual_template_rate_refs(
  p_processor text,
  p_month     date
)
returns table (
  fee_item_key      text,
  in_month_registry boolean,
  in_any_registry   boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- An explicit raise rather than a WHERE clause: returning zero rows to an
  -- unauthorized caller would read as "this month prices nothing", which is a
  -- state a processor can genuinely be in. Written as `is null or not in` so it
  -- fails closed where auth.uid() — and therefore auth_role() — is NULL.
  if public.auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to read the formula registry.'
      using errcode = '42501';
  end if;

  return query
  with refs as (
    select distinct
           t.rate_ref as key,
           (g.effective_from <= p_month
            and (g.effective_to is null or g.effective_to > p_month)) as this_month
      from public.residual_formula_registries g
      join public.residual_formula_rules r
        on r.registry_id = g.id and r.deleted_at is null
      join public.residual_formula_terms t
        on t.rule_id = r.id and t.deleted_at is null
     where g.deleted_at is null
       and g.processor = upper(btrim(coalesce(p_processor, '')))
       and t.rate_source = 'template'
       and t.rate_ref is not null
  )
  select refs.key,
         bool_or(refs.this_month) as in_month_registry,
         true                     as in_any_registry
    from refs
   group by refs.key;
end;
$$;

comment on function public.residual_template_rate_refs(text, date) is
  'The fee_item_keys whose TEMPLATE buy rate is read by a formula term, with whether the registry in force for p_month reads it. Returns only keys some registry references: a key absent from the result is read by no rule at all — either billed directly to the merchant (which the terms validation trigger makes permanent) or a loaded rate nothing uses. The buy-rate grid uses this to move superseded rows out of the grid without deleting a rate that earlier months still resolve through.';

revoke all on function public.residual_template_rate_refs(text, date)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_template_rate_refs(text, date)
  to authenticated;

commit;
