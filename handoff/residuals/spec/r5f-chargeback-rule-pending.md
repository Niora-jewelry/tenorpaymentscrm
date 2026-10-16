# Chargeback needs a rule — pending one statement

**Not seeded.** The rule is fully specified below; what is missing is data to
seed it against.

**The blocker has moved.** This document originally said the missing fact was
*what Maverick calls it on the fee report*, on the assumption that a chargeback
would arrive as a `fee_item_name` like every other rule. It does not. The count
comes from the **PDF statement's Deposits section**, not from the fee report, and
the remaining blocker is therefore **a statement carrying a Tran Code `C` row** —
none of the sampled statements has one.

---

## Decision of record — Q35: a reversal does NOT refund the fee

**Confirmed by the user.** A chargeback reversal does **not** refund the
per-occurrence chargeback fee.

So the rule **counts Tran Code `C` rows only, and never nets them against Tran
Code `B` (chargeback reversal)**. A merchant who is charged back and then wins
the reversal still pays the fee: the fee buys the handling of the event, not its
outcome.

**Why this has to be written down rather than inferred.** Netting is the
intuitive reading — a reversal looks like an undo, and every other quantity in
this module is signed — so an implementer who is not told will very reasonably
subtract the B rows and produce a number that is wrong only for the merchants
who had reversals. That is the worst shape of error available here: correct for
most merchants, quietly wrong for a subset, and invisible without a statement
carrying both codes to test against.

**Never sum the amounts.** The fee is per occurrence, so the operand is the row
**count** (`line_item_count`), not the dollar value of the chargebacks.

---

## The complete pending spec

Everything needed to build it, once a statement with a `C` row exists:

1. **Band the Deposits section columns** of the PDF statement, using the
   right-edge banding idiom already established in `lib/residuals/pdf-layout.ts`.
2. **Filter `Tran Code = 'C'`.** Not `B`, and never `C` minus `B` — see the
   decision of record above.
3. **Count the rows.** The count is the operand; the amounts are not summed.
4. **Buy side** = `line_item_count` × `template.chargeback`.
5. **Income side** = `line_item_count` × `merchant.chargeback_fee`.
6. **Live registry only** — see below.

---

## Why this is a model gap, not a display quirk

Chargebacks are charged to TapDash and billed **once per occurrence** — a real
per-event cost with a count. Both sides of it are already loaded and neither is
read by anything:

| side | where | state |
|---|---|---|
| buy | `residual_buy_rates.chargeback` | **4 tier rates** — `no_program` 10.00, `low` 15.00, `medium` 20.00, `high` 25.00 |
| sell | `residual_merchant_rates.chargeback_fee` | **34 of 34 merchants carry a value** |

The buy-rate grid currently files it under *"no rule in any registry reads this
rate"*, which is accurate and is the symptom rather than the problem.

## Is anything else in the same position?

**No — chargeback is the only one, and it is the only one on either side.**
Surveyed both directions rather than assuming:

**Fee items with seeded Maverick rates and no rule:**

| fee item | rates | why no rule |
|---|---|---|
| `pci_fee` | 4 | `billed_directly_to_merchant` — the terms validation trigger **forbids** a rule. Correct. |
| `website_monitoring_fee` | 4 | same |
| `irs_annual_fee` | 4 | same |
| **`chargeback`** | **4** | **not billed direct. A genuine gap.** |

**Merchant rate columns no rule reads** — the complement, and the stronger
signal because it is the sell side:

| column | merchants with a value | read by a rule |
|---|---|---|
| **`chargeback_fee`** | **34** | **no** |
| every other legal column | — | yes |

All 20 distinct `fee_item_name` values in the sample already have rules — the
May run recorded **zero** `unknown_fee_item` failures — so nothing is missing a
rule *because the name is unknown*. Chargeback is missing because the **line
never appeared**, which is exactly what a one-month, one-processor sample cannot
rule out.

The only sample name matching `%charge%` is `Cash Disc/Surcharge Program`, which
is unrelated.

## What to seed once a statement carries a C row

Same shape as **AVS Fee**, verified against its live definition.

Replace `<<EXACT NAME>>` with whatever the statement's Deposits section prints
for the row, and run once:

```sql
begin;

with target as (
  select g.id as registry_id
    from public.residual_formula_registries g
   where g.deleted_at is null
     and g.processor = 'MAVERICK'
     -- LIVE REGISTRY ONLY. See "Live registry only" below; the unfiltered
     -- form this file used to carry seeded both and is no longer correct.
     and g.effective_from = date '2026-06-01'
), new_rule as (
  insert into public.residual_formula_rules
    (registry_id, fee_item_name, fee_category, group_key, is_group_anchor,
     is_provisional, sort_order, notes)
  select t.registry_id, '<<EXACT NAME>>', 'Authorization Other',
         null, false, false, 115,
         'Per-occurrence chargeback. buy = count x template.chargeback; income = count x merchant.chargeback_fee.'
    from target t
  returning id
)
insert into public.residual_formula_terms
  (rule_id, side, operand, rate_source, rate_ref, term_sign, applies_when, term_order)
select r.id, v.side, 'line_item_count', v.rate_source, v.rate_ref, 1, 'always', 1
  from new_rule r
  cross join (values
    ('buy_rate', 'template', 'chargeback'),
    ('income',   'merchant', 'chargeback_fee')
  ) as v(side, rate_source, rate_ref);

commit;
```

`sort_order` 115 puts it after Amex OptBlue (110) and before the monthly block,
matching where a per-event authorization cost sits in the existing order.

### Live registry only — reversed 2026-09-23

**Final state: seed the LIVE registry only.** The `with target as (...)` above
must therefore carry an `effective_from` filter selecting the live registry
(`2026-06-01` → open), not the unfiltered form.

This reverses what this document previously said. The earlier reasoning was that
chargebacks have nothing to do with the June monthly-fee changeover, so a
pre-June month should price them identically, and seeding only the live registry
would make a recomputed historical month report `unknown_fee_item`.

**The consequence of the reversal, stated rather than glossed:** a recomputed
pre-June month carrying a chargeback row will not price it. If historical
chargebacks ever need computing, the predecessor registry needs the same rule
seeded into it as a separate, dated decision — at which point the question of
whether the pre-June arrangement was actually identical can be answered against
data rather than assumed.

### Before running it

1. Confirm the exact name against a real statement row, not from memory, and
   confirm the row's Tran Code is `C`.
2. Confirm the count you are seeding against excludes Tran Code `B` — a
   reversal does not refund the fee (decision of record above).
3. Check nothing already claims it:
   ```sql
   select g.label, r.fee_item_name
     from public.residual_formula_rules r
     join public.residual_formula_registries g on g.id = r.registry_id
    where r.deleted_at is null and r.fee_item_name = '<<EXACT NAME>>';
   ```
4. After seeding, recompute and confirm the line computes rather than
   appearing as `unknown_fee_item`.

### What it will surface immediately

`chargeback_fee` is populated for all 34 merchants and `chargeback` is priced at
all four tiers, so the first period carrying a chargeback line should compute it
straight away — no `missing_merchant_rate` or `missing_template_rate` on either
side. If either appears, the rule is reading a different ref than intended.
