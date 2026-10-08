-- ============================================================================
-- The PCI decision, and the seven fee items August introduced.
-- ============================================================================
-- Two changes to the live registry, both forced by real data and a client
-- answer rather than by design preference.
--
-- ── 1. PCI — THE QUESTION IS SETTLED ────────────────────────────────────────
-- The handoff recorded this as the largest open mismatch group and said what
-- would resolve it: "a decision on whether TapDash absorbs the 5.00. If it
-- does, rule #6 needs a buy-side term reading `template.pci_fee` and an income
-- term — but the terms-validation trigger currently FORBIDS any term
-- referencing a `billed_directly_to_merchant` item, so the flag must come off
-- the fee item first."
--
-- The client's answer, verbatim:
--
--   "This is correct. PCI works just like the others and you can disregard
--    the verbiage 'merchant pays it directly'."
--
-- The August report agrees, which is what makes this safe to encode rather
-- than merely authorised. All 41 PCI rows satisfy the module's identity
-- (income − buy ≡ net) with the buy side at the template's 5.00:
--
--   40 rows   income 0.00, expense 5.00, net −5.00    0 − 5    = −5   ✓
--    1 row    income 9.95, expense 5.00, net  4.95    9.95 − 5 =  4.95 ✓
--
-- So PCI is an ordinary costed item: TapDash is charged 5.00 and books it.
--
-- ORDER MATTERS. The flag is cleared BEFORE the term is inserted, because
-- `tg_residual_formula_terms_validate` refuses a term that references a
-- billed-directly item. Reversing these two statements fails with 23514 on a
-- migration that reads as though it should work.
--
-- ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
-- It adds no INCOME term. One merchant in 41 shows income of 9.95 — TapDash
-- billing them directly — and there is no merchant-rate column holding a PCI
-- price, so there is nothing to read. Inventing one would mean guessing a
-- figure for forty merchants in order to flatter a single row.
--
-- The consequence is deliberate and worth stating: that one row will report a
-- step-3 mismatch of 9.95, and it SHOULD. It is a merchant being billed an
-- amount this system has no record of agreeing. Acknowledging it with a reason
-- is the right outcome; silently modelling it is not.
--
-- ── 2. SEVEN FEE ITEMS WITH NO RULE ─────────────────────────────────────────
-- The handoff states the name set "measured closed — 20 names, 20 rules, exact
-- correspondence both ways", and that an unmatched name RAISES. That was true
-- of the May sample. August carries 27 distinct names, so seven of them would
-- have stopped the month computing at the first row:
--
--   Accept Blue Setup              1 row   net  −49.99
--   Chargeback Fee                 1 row   net  −15.00   (expense 15.00)
--   NuvoLinQ 10MB Data Plan        1 row   net   +5.00
--   USA ePay Monthly Fee - Gold    1 row   net  −15.00
--   USA ePay Monthly Fee - Silver  1 row   net   +5.00
--   Valor Portal Access            1 row   net   −4.95
--   Valor Terminal Add-Ons         1 row   net   −6.00
--
-- Every one carries income 0.00 and a non-zero net, which is the MIRROR shape
-- — the same as Interchange and the other three mirror rules. Under the
-- module's identity (income − buy ≡ net, buy a positive cost) a row with no
-- income resolves to buy = −net, and that is what a mirror term encodes:
-- `side = buy_rate, sign = -1, operand = one, rate_source = net_revenue`.
--
-- A positive net therefore yields a NEGATIVE buy rate — a rebate — on the two
-- items above that carry one. That is not a mistake: the handoff is explicit
-- that there is no `CHECK (total_buy_rate >= 0)` "and there must not be",
-- because the signed identity is the invariant and non-negativity is merely
-- the usual case.
--
-- WHY MIRROR AND NOT A PRICED RULE. These are vendor and equipment
-- pass-throughs — Accept.Blue, NuvoLinQ, USA ePay, Valor — with no template
-- rate and no merchant rate on file. A priced rule would need both, and
-- inventing either is how a plausible wrong number gets into a residual.
-- Mirroring states exactly what the statement states and nothing more, and it
-- makes the identity hold on all seven rows, which is checkable rather than
-- asserted.
--
-- Chargeback Fee is included here on the same reading: income 0.00, expense
-- 15.00, net −15.00, so buy = 15.00 = the expense. Note this is the FEE
-- REPORT's chargeback row, which `r5f-chargeback-rule-pending.md` is separate
-- from — that document specifies counting Tran Code 'C' rows on the PDF
-- STATEMENT, and remains the right implementation when statements are parsed.
-- Mirroring the fee-report row does not pre-empt it; it stops the month
-- raising today, and agrees with the statement's own figure.
--
-- ── EDITED IN PLACE, NOT AS A DATED SUCCESSOR ───────────────────────────────
-- These rules are ADDITIONS to the live registry, not changes to how an
-- existing month was priced. No computed period read them, because no period
-- containing these names has ever computed — the engine would have raised.
-- A successor registry would fork the rule set to say the same thing twice.
--
-- PCI is the exception worth naming: it HAS been priced before, as 0.00 on
-- both sides. Any month already computed under the old reading will change
-- when it is recalculated, which is correct — it was wrong, and the client has
-- said so. Nothing is restated silently: `calculation_version` is cleared by
-- the engine on every run, so a recomputed month announces itself.

begin;

-- ============================================================
-- 1. PCI is no longer billed directly to the merchant
-- ============================================================
-- Must precede the term insert below — see the header.

update public.residual_fee_items
   set billed_directly_to_merchant = false,
       notes = coalesce(notes || ' ', '')
               || 'Client decision 2026-10: PCI works like any other costed item; '
               || 'the "merchant pays it directly" wording is disregarded.',
       updated_at = now()
 where fee_item_key = 'pci_fee'
   and deleted_at is null;

-- ============================================================
-- 2. PCI gains its buy side
-- ============================================================
-- One term: the processor's template rate for the item, at the merchant's
-- tier, applied once. `operand = one` because this is a flat monthly charge —
-- the statement's Count is 1 on every PCI row.

insert into public.residual_formula_terms
  (rule_id, side, operand, rate_source, rate_ref, term_sign, term_order, notes)
select ru.id, 'buy_rate', 'one', 'template', 'pci_fee', 1, 1,
       'Added 2026-10 on the client''s decision that PCI is an ordinary costed '
       || 'item. Verified against all 41 August rows: income - 5.00 = net.'
  from public.residual_formula_rules ru
  join public.residual_formula_registries reg on reg.id = ru.registry_id
 where ru.fee_item_name = 'PCI Program'
   and ru.deleted_at is null
   and reg.deleted_at is null
   and reg.effective_to is null          -- the live registry only
   and not exists (
     select 1 from public.residual_formula_terms t
      where t.rule_id = ru.id and t.side = 'buy_rate' and t.deleted_at is null
   );

-- ============================================================
-- 3. The seven fee items August introduced
-- ============================================================
-- Rules first, then one mirror term each. Guarded on name so a re-run adds
-- nothing — these are inserts into a live registry, and a duplicate rule would
-- make `fee_item_name` ambiguous for the engine's exact-name match.

insert into public.residual_formula_rules
  (registry_id, fee_item_name, fee_category, is_provisional, sort_order, notes)
select reg.id, v.name, v.category, true, v.sort_order,
       'Added 2026-10 from the August fee report. Mirror rule: income 0.00 and '
       || 'a non-zero net, so buy = -net by the module''s identity. Vendor or '
       || 'equipment pass-through with no template or merchant rate on file.'
  from public.residual_formula_registries reg
  cross join (values
    ('Accept Blue Setup',             'MISC Fixed Fees', 2010),
    ('Chargeback Fee',                'Exceptions',      2020),
    ('NuvoLinQ 10MB Data Plan',       'MISC Fixed Fees', 2030),
    ('USA ePay Monthly Fee - Gold',   'MISC Fixed Fees', 2040),
    ('USA ePay Monthly Fee - Silver', 'MISC Fixed Fees', 2050),
    ('Valor Portal Access',           'MISC Fixed Fees', 2060),
    ('Valor Terminal Add-Ons',        'MISC Fixed Fees', 2070)
  ) as v(name, category, sort_order)
 where reg.deleted_at is null
   and reg.effective_to is null
   and not exists (
     select 1 from public.residual_formula_rules ru
      where ru.registry_id = reg.id
        and ru.fee_item_name = v.name
        and ru.deleted_at is null
   );

-- The mirror term: buy_rate = -1 x one x net_revenue.
-- Identical in shape to Interchange, which is the rule this reading comes from.

insert into public.residual_formula_terms
  (rule_id, side, operand, rate_source, term_sign, term_order, notes)
select ru.id, 'buy_rate', 'one', 'net_revenue', -1, 1,
       'Mirror term. The statement carries the whole value in net_revenue and '
       || 'no income, so the cost is its negation — same shape as Interchange.'
  from public.residual_formula_rules ru
  join public.residual_formula_registries reg on reg.id = ru.registry_id
 where reg.deleted_at is null
   and reg.effective_to is null
   and ru.deleted_at is null
   and ru.fee_item_name in (
     'Accept Blue Setup', 'Chargeback Fee', 'NuvoLinQ 10MB Data Plan',
     'USA ePay Monthly Fee - Gold', 'USA ePay Monthly Fee - Silver',
     'Valor Portal Access', 'Valor Terminal Add-Ons'
   )
   and not exists (
     select 1 from public.residual_formula_terms t
      where t.rule_id = ru.id and t.deleted_at is null
   );

commit;
