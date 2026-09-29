-- Ported from Daniel Weissman's residuals branch, file
-- `20260829130000_residuals_predecessor_registry_r5d1c.sql`.
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
-- Residuals R5d 1c — the PREDECESSOR formula registry (Q22, unparked)
-- ============================================================
--
-- Seeds the pre-changeover rule set, so months before the monthly-fee
-- changeover can be computed under the rules that actually applied to them.
--
-- SEPARATE FILE FROM 20260829120000 DELIBERATELY. That migration builds the
-- rate-entry path and changes no money semantics. This one changes what every
-- pre-June-2026 month means. They have different risk profiles and different
-- reviewers, and either should be appliable or revertible without the other.
--
-- ============================================================
-- THE BOUNDARY, AND WHAT IT PUTS WHERE
-- ============================================================
--
--   predecessor : [2000-01-01, 2026-06-01)   <- MAY 2026 FALLS HERE
--   live        : [2026-06-01, open)
--
-- The changeover month is a PLACEHOLDER supplied by the user (May 2026 is the
-- last old-regime month). It is a date, not a discovery: nothing in the
-- workbook records when Maverick stopped collecting the monthly fee. If the
-- real date differs, the fix is two UPDATEs — this registry's effective_to
-- and the live registry's effective_from — and no other row changes.
--
-- ============================================================
-- STATEMENT ORDER IS LOAD-BEARING (the EXCLUDE constraint)
-- ============================================================
--
-- residual_formula_registries_no_overlap forbids two live registries for one
-- processor whose date ranges overlap, and it is not DEFERRABLE. The live
-- registry currently spans [2000-01-01, open), which CONTAINS the whole
-- predecessor range. So:
--
--   1. UPDATE the live registry's effective_from 2000-01-01 -> 2026-06-01
--   2. THEN INSERT the predecessor [2000-01-01, 2026-06-01)
--
-- Reversing these two raises 23P01 on the insert. Step 1 alone is safe: it
-- SHRINKS the only live range, and a shrinking range cannot begin to overlap
-- anything. There is no window in which the constraint is violated, and no
-- window in which a month resolves to two registries — only a window inside
-- this transaction where months before 2026-06 resolve to NONE, which is why
-- both statements are in one transaction.
--
-- STEP 1 IS AN UPDATE TO A SEEDED ROW, which R5d Part 1 otherwise avoids.
-- That is acceptable here and nowhere else: effective_from is not a VALUE the
-- seed asserts, it is the boundary of the seed's applicability, and moving a
-- boundary is exactly what dating a registry is for. No rule, term or rate
-- seeded by 20260828120000 is touched.
--
-- ============================================================
-- WHAT THE FIRST ENGINE RUN ON MAY 2026 SHOULD SHOW
-- ============================================================
--
-- Stated up front so the run can be JUDGED rather than merely observed.
-- Measured against the May sample and the source rate sheet:
--
--   * 9 of the 21 May MIDs have no row in the rate sheet at all, so they
--     RAISE on every line regardless of registry.
--   * Of the 12 that do, rule #2 (Monthly Fee) under this predecessor reads
--     income = merchant.monthly_fee_maverick. Comparing that column against
--     the Agent Income actually reported on each May Monthly Fee row:
--         5 MATCH   (201100216416, 30119889965, 30119900929, 201100164707,
--                    and 201100169797 — the last is the parked Orlando MID)
--         6 DIFFER  (201100231605, 30119889981, 201100241497, 30119896606,
--                    201100250209, 30119808296 — each reports income 0 while
--                    the sheet carries 99.00 / 39.95 / 50.00 / 9.95)
--         1 RAISES  (30119876848 — blank Monthly Fee cell, so NULL)
--
-- SO THE EXPECTATION IS 5 RECONCILE / 6 MISMATCH / 1 RAISE ON RULE #2, not
-- the 11-reconcile / 10-mismatch split that the raw "11 rows report non-zero
-- income" count suggests. The two differ because only 12 of the 21 MIDs have
-- rate data at all, and one of those 12 has no monthly fee recorded.
--
-- ============================================================
-- THE CHANGEOVER WAS STAGED PER MERCHANT. DO NOT CHASE THE SIX.
-- ============================================================
--
-- The 6 DIFFER cases are the transition itself showing through: those
-- merchants had already stopped being billed by Maverick in May while the
-- rate sheet still carries their old fee. Five other merchants in the same
-- month were still being billed. Both groups are in one statement month, so
-- they cannot both be explained by any boundary date.
--
-- THAT IS THE WHOLE POINT AND IT MUST NOT BE "FIXED". No value of the June
-- boundary makes May reconcile. Moving it earlier makes the 5 currently-
-- reconciling merchants mismatch; moving it later leaves the 6 mismatching.
-- Tuning it would be fitting a GLOBAL parameter to a PER-MERCHANT fact, which
-- buys a better-looking number by making the model less true — and the next
-- month's data would break it again in a different place.
--
-- A first engine run that reproduces EXACTLY the 5 / 6 / 1 split predicted
-- above is a better validation than one that reconciles because somebody
-- adjusted a date until it did. If the run shows that split, the registry,
-- the rate table and the sign convention are all behaving. If it shows a
-- DIFFERENT split, something is genuinely wrong and is worth investigating —
-- which is a signal the tuned version would have destroyed.
--
-- IF A PER-MERCHANT CHANGEOVER DATE IS EVER WANTED, HERE IS ITS SHAPE, so the
-- next person does not reach for the boundary again:
--
--   It does NOT belong on the registry. A registry is one processor's
--   complete rule set over a date range, and there is no version of it that
--   is true for merchant A and false for merchant B in the same month.
--   Splitting registries per merchant would multiply a 20-rule, 33-term
--   structure by the merchant count to express one column's worth of fact.
--
--   It belongs on residual_merchant_rates, as the effective dating that table
--   ALREADY HAS. A merchant who stopped being billed in March gets a dated
--   successor at 2026-03-01 whose monthly_fee_maverick is 0.00 — a recorded
--   decision, not a NULL — while the merchants still being billed keep their
--   standing version. Rule #2's income term then reads the same column for
--   everyone and lands on the right number per merchant, because the DATE
--   lives with the merchant rather than with the rule.
--
--   Under that approach this predecessor registry stays exactly as seeded and
--   its boundary never moves: it describes the RULES, and the per-merchant
--   timing is data underneath them. That separation is why the boundary is
--   safe to leave alone even when it does not make May tidy.
--
-- Idempotent throughout.

begin;

-- ============================================================
-- 1. monthly_fee_combined — the fee item the combine needs
-- ============================================================
-- Removed from the live registry by Q24a because Maverick will no longer
-- quote a monthly buy rate at all. It belongs here, in the registry that
-- describes the months when it did.
--
-- NOT monthly + online. The observed low-tier combined value is 7.50 while
-- monthly + online is 4.00 + 6.50 = 10.50, so it is its own rate.
insert into public.residual_fee_items
  (fee_item_key, label, rate_kind, billed_directly_to_merchant, sort_order, notes)
select 'monthly_fee_combined',
       'Monthly Fee (combined with Online Access)',
       'amount',
       false,
       55,
       'PRE-CHANGEOVER ONLY. The single buy rate charged when a MID had NO Monthly Online Access Fee row. NOT monthly + online (7.50 vs 10.50 at low tier). Referenced only by the predecessor registry; the live registry has no monthly buy rate at all. Only the LOW tier is seeded — the confirmed observation.'
where not exists (
  select 1 from public.residual_fee_items fi
  where fi.fee_item_key = 'monthly_fee_combined'
);

-- ONLY THE LOW TIER IS SEEDED, AND THE OMISSION IS THE POINT.
-- 7.50 is measured: all four sample MIDs lacking a Monthly Online Access Fee
-- row carry a Monthly Fee buy rate of exactly 7.50, three of them confirmed
-- low-tier. The medium / high / no_program combined values are NOT known.
-- Seeding a guess would compute a wrong number silently; seeding nothing
-- makes the lookup return no rate, which the fail-loud contract turns into a
-- raise naming the merchant and the month. An operator then enters the real
-- value. An unknown rate needs no placeholder mechanism — only an absence.
insert into public.residual_buy_rates (schedule_id, risk_tier, fee_item_key, rate)
select s.id, 'low', 'monthly_fee_combined', 7.500000
  from public.residual_buy_rate_schedules s
 where s.processor = 'MAVERICK'
   and s.deleted_at is null
   and not exists (
     select 1 from public.residual_buy_rates br
      where br.schedule_id = s.id
        and br.risk_tier = 'low'
        and br.fee_item_key = 'monthly_fee_combined'
   );

-- ============================================================
-- 2. Move the live registry's boundary FIRST (see header)
-- ============================================================
update public.residual_formula_registries
   set effective_from = date '2026-06-01',
       notes = coalesce(notes, '') ||
         ' [R5d 1c: effective_from moved from 2000-01-01 to 2026-06-01; months before that resolve to the predecessor registry.]'
 where processor = 'MAVERICK'
   and deleted_at is null
   and effective_from = date '2000-01-01'
   and effective_to is null;

-- ============================================================
-- 3. The predecessor registry
-- ============================================================
insert into public.residual_formula_registries
  (processor, label, effective_from, effective_to, notes)
select 'MAVERICK',
       'Maverick Processor Monthly Reconciliation (pre-changeover)',
       date '2000-01-01',
       date '2026-06-01',
       'The rule set in force while Maverick still collected the merchant monthly fee. Identical to the live registry except rule #2, which reads income = merchant.monthly_fee_maverick, a two-term conditional buy side (monthly_fee / monthly_fee_combined on the presence of a Monthly Online Access Fee row), and additional_income = merchant.monthly_fee_tapdash. Boundary month 2026-06-01 is a PLACEHOLDER; May 2026 is the last month under these rules.'
where not exists (
  select 1 from public.residual_formula_registries r
  where r.processor = 'MAVERICK'
    and r.deleted_at is null
    and r.effective_from = date '2000-01-01'
);

-- ============================================================
-- 4. Copy all 20 rules from the live registry
-- ============================================================
-- COPIED RATHER THAN RETYPED. A registry's grain is "one processor's COMPLETE
-- rule set over one date range", so the predecessor needs all 20 rules, not a
-- diff. Copying by INSERT ... SELECT makes the 19 unchanged rules provably
-- identical to the live ones instead of identical-by-careful-transcription,
-- which is the failure mode a hand-written second copy invites.
insert into public.residual_formula_rules
  (registry_id, fee_item_name, fee_category, group_key, is_group_anchor,
   is_provisional, sort_order, notes)
select pre.id, live_r.fee_item_name, live_r.fee_category, live_r.group_key,
       live_r.is_group_anchor, live_r.is_provisional, live_r.sort_order,
       case when live_r.fee_item_name = 'Monthly Fee'
            then 'PRE-CHANGEOVER rule #2: Maverick still collected the merchant monthly fee. income = merchant.monthly_fee_maverick; buy rate = template Monthly Fee, or the COMBINED rate when the MID has no Monthly Online Access Fee row (verified 4-for-4 in the May 2026 sample at 7.50 low tier); additional_income = merchant.monthly_fee_tapdash. The live registry replaces all of this with a single Additional Income term.'
            else live_r.notes
       end
from public.residual_formula_registries pre
join public.residual_formula_registries live
  on live.processor = 'MAVERICK' and live.deleted_at is null
 and live.effective_from = date '2026-06-01'
join public.residual_formula_rules live_r
  on live_r.registry_id = live.id and live_r.deleted_at is null
where pre.processor = 'MAVERICK'
  and pre.deleted_at is null
  and pre.effective_from = date '2000-01-01'
  and not exists (
    select 1 from public.residual_formula_rules x
     where x.registry_id = pre.id
       and x.fee_item_name = live_r.fee_item_name
       and x.deleted_at is null
  );

-- ============================================================
-- 5. Copy the terms of the 19 UNCHANGED rules
-- ============================================================
-- Rule #2 is excluded here and written explicitly in section 6, because its
-- term set differs on all three sides.
insert into public.residual_formula_terms
  (rule_id, side, operand, rate_source, rate_ref, rate_literal,
   term_sign, applies_when, sibling_fee_item_name, term_order, notes)
select pre_r.id, t.side, t.operand, t.rate_source, t.rate_ref, t.rate_literal,
       t.term_sign, t.applies_when, t.sibling_fee_item_name, t.term_order, t.notes
from public.residual_formula_registries pre
join public.residual_formula_rules pre_r
  on pre_r.registry_id = pre.id and pre_r.deleted_at is null
join public.residual_formula_registries live
  on live.processor = 'MAVERICK' and live.deleted_at is null
 and live.effective_from = date '2026-06-01'
join public.residual_formula_rules live_r
  on live_r.registry_id = live.id
 and live_r.fee_item_name = pre_r.fee_item_name
 and live_r.deleted_at is null
join public.residual_formula_terms t
  on t.rule_id = live_r.id and t.deleted_at is null
where pre.processor = 'MAVERICK'
  and pre.deleted_at is null
  and pre.effective_from = date '2000-01-01'
  and pre_r.fee_item_name <> 'Monthly Fee'
  and not exists (
    select 1 from public.residual_formula_terms x
     where x.rule_id = pre_r.id
       and x.side = t.side
       and x.term_order = t.term_order
       and x.deleted_at is null
  );

-- ============================================================
-- 6. Rule #2's pre-changeover terms — all four
-- ============================================================
-- income            : one x merchant.monthly_fee_maverick
-- buy_rate (1 of 2) : one x template.monthly_fee           when Online row PRESENT
-- buy_rate (2 of 2) : one x template.monthly_fee_combined  when Online row ABSENT
-- additional_income : one x merchant.monthly_fee_tapdash
--
-- The additional-income term is NOT new to the old regime and is not dropped
-- by the new one: the original calc sheet's column T for this row read
-- "Monthly Fee under Fees Charged Directly by TapDash to Merchant" all along.
-- What the changeover did was remove the processor-side income and buy rate,
-- leaving that term alone standing. So it appears in BOTH registries, and
-- that is correct rather than a copy-paste artifact.
insert into public.residual_formula_terms
  (rule_id, side, operand, rate_source, rate_ref, rate_literal,
   term_sign, applies_when, sibling_fee_item_name, term_order, notes)
select pre_r.id, v.side, v.operand, v.rate_source, v.rate_ref, v.rate_literal,
       v.term_sign, v.applies_when, v.sibling, v.term_order, v.notes
from public.residual_formula_registries pre
join public.residual_formula_rules pre_r
  on pre_r.registry_id = pre.id
 and pre_r.fee_item_name = 'Monthly Fee'
 and pre_r.deleted_at is null
cross join (values
  ('income','one','merchant','monthly_fee_maverick', null::numeric, 1::smallint,
   'always', null::text, 1,
   'Maverick still collected the merchant monthly fee and passed it through as Agent Income.'),
  ('buy_rate','one','template','monthly_fee', null, 1,
   'sibling_present','Monthly Online Access Fee', 1,
   'Standard monthly buy rate when the merchant also has a separate Online Access row.'),
  ('buy_rate','one','template','monthly_fee_combined', null, 1,
   'sibling_absent','Monthly Online Access Fee', 2,
   'Combined monthly+online buy rate. Verified 4-for-4 in the May 2026 sample at 7.50 (low tier). NOT monthly + online, which would be 10.50.'),
  ('additional_income','one','merchant','monthly_fee_tapdash', null, 1,
   'always', null, 1,
   'Unchanged across the changeover: the calc sheet''s column T read this all along. Outside the tier split by design.')
) as v(side, operand, rate_source, rate_ref, rate_literal, term_sign,
       applies_when, sibling, term_order, notes)
where pre.processor = 'MAVERICK'
  and pre.deleted_at is null
  and pre.effective_from = date '2000-01-01'
  and not exists (
    select 1 from public.residual_formula_terms x
     where x.rule_id = pre_r.id
       and x.side = v.side
       and x.term_order = v.term_order
       and x.deleted_at is null
  );

commit;
