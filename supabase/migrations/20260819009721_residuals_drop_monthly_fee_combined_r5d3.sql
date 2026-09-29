-- Ported from Daniel Weissman's residuals branch, file
-- `20260903120000_residuals_drop_monthly_fee_combined_r5d3.sql`.
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
-- Residuals R5d Part 3 — remove monthly_fee_combined from the model
-- ============================================================
--
-- R5d Part 3 hid this fee item from the buy-rate grid, because after the June
-- changeover no rule reads it and it rendered as one populated cell of four.
-- Hiding it was the display answer. This is the model answer: it goes.
--
-- ============================================================
-- WHAT THIS COSTS, IN MONEY, STATED BEFORE ANYTHING ELSE
-- ============================================================
--
-- The predecessor registry's rule #2 priced the Monthly Fee buy side with a
-- pair of mutually exclusive conditional terms:
--
--   Online Access line PRESENT -> template.monthly_fee           (4.00 at low)
--   Online Access line ABSENT  -> template.monthly_fee_combined  (7.50 at low)
--
-- 7.50 is NOT 4.00 + 6.50, which is exactly why it was its own fee item: a
-- merchant billed a single combined line was charged a different amount than
-- the two separate lines add to.
--
-- FOUR MERCHANTS IN THE MAY SAMPLE CARRY A Monthly Fee LINE AND NO
-- Monthly Online Access Fee LINE — three named in the change request, and one
-- more found while checking it:
--
--   Julianas        201100216416   tier low
--   Monte Carlo     201100250209   tier low
--   House Of Tacos  30119900929    tier low
--   (unnamed)       30119926551    NO RATE ROW AT ALL — tier unknown
--
-- The first three resolved their pre-June Monthly Fee buy rate to 7.50. After
-- this migration they resolve to the plain template rate of 4.00 — an
-- UNDERSTATEMENT OF 3.50 per merchant per pre-June month. Accepted
-- deliberately, and recorded here because nothing else will record it.
--
-- THE UNDERSTATEMENT IS A LOW-TIER FACT, NOT A GENERAL ONE, and this cuts the
-- other way for everyone else. monthly_fee_combined was seeded at the LOW TIER
-- ONLY — one cell of four. A medium- or high-tier merchant with no Online
-- Access line hit the sibling_absent term, found no template rate at its tier,
-- and the engine reported missing_template_rate: the line did not compute at
-- all. After this change it computes at the plain rate (4.00 medium, 7.00
-- high). So the change trades a 3.50 understatement at low for turning a
-- hard failure into a number at medium and high.
--
-- The fourth merchant, 30119926551, has no rate version at all and is skipped
-- wholesale today (no_merchant_rates). Which way this change moves it depends
-- entirely on the tier it is eventually given.
--
-- IT IS INVISIBLE TODAY AND WILL NOT STAY INVISIBLE. All three named merchants
-- currently fail on monthly_fee_tapdash before the buy side is ever evaluated —
-- the engine records the FIRST failure per line — so the May recompute is
-- byte-identical across this change. The moment somebody enters those monthly
-- fees, the lines compute and the 3.50 appears in real output.
--
-- ============================================================
-- HOW TO REVERSE IT
-- ============================================================
--
-- Everything here is a SOFT delete, so the reversal is a data change and needs
-- no migration to undo the schema:
--
--   1. Clear deleted_at / deleted_by_id on the residual_fee_items row for
--      'monthly_fee_combined'.
--   2. Clear deleted_at / deleted_by_id on its residual_buy_rates row(s) —
--      one, at the low tier, rate 7.500000.
--   3. Clear deleted_at / deleted_by_id on the two conditional buy terms
--      (ids 9f16619f-e41b-4df7-8bf3-8b3d513ba019 for monthly_fee /
--      sibling_present, and c05fee53-9cc4-4b07-9c15-786f57bbb217 for
--      monthly_fee_combined / sibling_absent).
--   4. Soft-delete the unconditional buy term this migration inserts, or the
--      restored pair and it will all three evaluate and double-count.
--
-- Step 1 MUST precede step 3: tg_residual_formula_terms_validate fires on
-- UPDATE as well as INSERT and requires a LIVE fee item for any template
-- rate_ref, so un-deleting the term while the item is still deleted raises
-- 23503. That is the same ordering trap this migration navigates going the
-- other way — see below.
--
-- ============================================================
-- ORDERING IS FORCED BY THE VALIDATION TRIGGER
-- ============================================================
--
-- tg_residual_formula_terms_validate is BEFORE INSERT OR UPDATE, and for a
-- template term it requires new.rate_ref to name a fee item with
-- deleted_at IS NULL. A soft delete of a term is an UPDATE. So:
--
--   TERMS FIRST, then the fee item. Retiring the fee item first would make the
--   very statement that retires its last reference raise 23503 — the guard
--   firing on the cleanup rather than on the mistake.
--
-- Idempotent: every statement is conditioned on the current state, so a re-run
-- changes nothing.

begin;

-- ============================================================
-- 1. The two conditional buy terms go (TERMS FIRST — see above)
-- ============================================================
update public.residual_formula_terms t
   set deleted_at = now()
  from public.residual_formula_rules r
  join public.residual_formula_registries g
    on g.id = r.registry_id and g.deleted_at is null
 where t.rule_id = r.id
   and t.deleted_at is null
   and r.deleted_at is null
   and g.processor = 'MAVERICK'
   and g.effective_from = date '2000-01-01'
   and r.fee_item_name = 'Monthly Fee'
   and t.side = 'buy_rate';

-- ============================================================
-- 2. ONE unconditional buy term replaces them
-- ============================================================
-- A RULE MUST NOT BE LEFT WITH A LONE CONDITIONAL TERM, and this is the part
-- that would have been genuinely dangerous to get wrong.
--
-- The tempting minimal edit is to soft-delete only the monthly_fee_combined
-- term and leave the other one alone. That leaves rule #2's buy side holding a
-- single term still carrying applies_when = 'sibling_present'. For the three
-- merchants above — the ones with no Online Access line — that condition is
-- FALSE, every term is skipped, and residual_eval_side returns 0.00, because
-- "a side with no active terms is $0.00" is the registry's representation of
-- "Always $0". The engine would report no failure: it would compute a buy rate
-- of zero and book the whole monthly fee as margin.
--
-- That is a silent overstatement of income, and it is strictly worse than the
-- 3.50 understatement this migration accepts — an understatement that is at
-- least visible as a number that disagrees with the processor's statement.
--
-- So both terms go and one unconditional term takes their place.
insert into public.residual_formula_terms
  (rule_id, side, operand, rate_source, rate_ref, rate_literal,
   term_sign, applies_when, sibling_fee_item_name, term_order, notes)
select r.id, 'buy_rate', 'one', 'template', 'monthly_fee', null,
       1, 'always', null, 1,
       'R5d Part 3: replaced the monthly_fee / monthly_fee_combined conditional pair. Merchants with no Monthly Online Access Fee line are now priced at the plain template rate — understated by 3.50 at the low tier, and computing at all (rather than reporting missing_template_rate) at medium and high, where monthly_fee_combined was never seeded.'
  from public.residual_formula_rules r
  join public.residual_formula_registries g
    on g.id = r.registry_id and g.deleted_at is null
 where r.deleted_at is null
   and g.processor = 'MAVERICK'
   and g.effective_from = date '2000-01-01'
   and r.fee_item_name = 'Monthly Fee'
   -- Idempotent: a re-run finds the term already there and inserts nothing.
   and not exists (
     select 1 from public.residual_formula_terms x
      where x.rule_id = r.id and x.side = 'buy_rate' and x.deleted_at is null
   );

-- ============================================================
-- 3. The low-tier rate goes
-- ============================================================
update public.residual_buy_rates
   set deleted_at = now()
 where fee_item_key = 'monthly_fee_combined'
   and deleted_at is null;

-- ============================================================
-- 4. The fee item goes
-- ============================================================
-- residual_buy_rates_for_month INNER JOINs residual_fee_items on
-- `deleted_at is null`, so this single row is what removes the item from every
-- month's grid at once — including May, where R5d Part 3's registry-derived
-- display filter would otherwise still have shown it as priced.
update public.residual_fee_items
   set deleted_at = now()
 where fee_item_key = 'monthly_fee_combined'
   and deleted_at is null;

-- ============================================================
-- 5. Prove the end state inside the transaction
-- ============================================================
-- A DO block rather than a comment: if any of this is wrong the migration
-- fails and rolls back, instead of leaving a half-retired fee item behind.
do $$
declare
  n_terms int;
  n_refs  int;
  n_live  int;
begin
  select count(*) into n_terms
    from public.residual_formula_terms t
    join public.residual_formula_rules r on r.id = t.rule_id and r.deleted_at is null
    join public.residual_formula_registries g
      on g.id = r.registry_id and g.deleted_at is null
   where g.processor = 'MAVERICK' and g.effective_from = date '2000-01-01'
     and r.fee_item_name = 'Monthly Fee' and t.deleted_at is null;

  if n_terms <> 3 then
    raise exception
      'Expected the predecessor rule #2 to end with exactly 3 live terms, found %.',
      n_terms;
  end if;

  if not exists (
    select 1 from public.residual_formula_terms t
    join public.residual_formula_rules r on r.id = t.rule_id and r.deleted_at is null
    join public.residual_formula_registries g
      on g.id = r.registry_id and g.deleted_at is null
   where g.processor = 'MAVERICK' and g.effective_from = date '2000-01-01'
     and r.fee_item_name = 'Monthly Fee' and t.deleted_at is null
     and t.side = 'buy_rate' and t.applies_when = 'always'
     and t.rate_source = 'template' and t.rate_ref = 'monthly_fee'
  ) then
    raise exception 'The predecessor rule #2 buy side is not one unconditional monthly_fee term.';
  end if;

  select count(*) into n_refs
    from public.residual_formula_terms t
   where t.deleted_at is null and t.rate_ref = 'monthly_fee_combined';
  if n_refs <> 0 then
    raise exception '% live term(s) still reference monthly_fee_combined.', n_refs;
  end if;

  select count(*) into n_live
    from public.residual_fee_items
   where fee_item_key = 'monthly_fee_combined' and deleted_at is null;
  if n_live <> 0 then
    raise exception 'monthly_fee_combined is still a live fee item.';
  end if;

  raise notice 'monthly_fee_combined retired: rule #2 buy side is one unconditional monthly_fee term.';
end$$;

commit;
