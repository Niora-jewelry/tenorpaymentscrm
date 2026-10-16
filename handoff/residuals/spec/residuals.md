# Residuals — product spec

The Residuals module reconciles a payment processor's monthly fee report against
what TapDash believes it should have earned, and computes what TapDash banks.

**This document is the in-repo form of the calculation registry.** Until it
existed, the only definition of a twenty-rule money registry was a spreadsheet
("Calc and Field Sheet.xlsx", tab *Tab - Processor Monthly Reconci*) that lived
in one person's Downloads folder and was in no version control. If this
document and that workbook ever disagree, that is a bug in one of them and
somebody has to decide which — but at least both are now findable.

Scope note: this file carries the *product* requirements. Architectural
conventions live in [`CLAUDE.md`](../../CLAUDE.md); the migrations carry the
reasoning for individual schema decisions.

---

## 1. The computation chain

Six values per line, in order:

| # | Value | Formula |
|---|---|---|
| 1 | **Total Income** | merchant-facing rate × count or volume |
| 2 | **Total Buy Rate** | processor's template rate at the merchant's risk tier × count or volume |
| 3 | **pre-split net** | Total Income − Total Buy Rate |
| 4 | **TapDash Net (after split)** | pre-split net × `tapdash_share(tier)` |
| 5 | **Additional Income Directly to TapDash** | a fee TapDash bills the merchant itself |
| 6 | **Net Income** | TapDash Net + Additional Income |

Value 3 is the reconciliation target: it must equal the processor's stated
`net_revenue` for that line. Value 6 is what TapDash keeps.

**Additional Income sits outside the split deliberately.** Maverick is not
party to a fee TapDash bills the merchant directly, so it is added *after* the
multiplication, never inside it.

### Why six values and not five

`residual_lines` originally had five engine-owned columns, because the calc
sheet's column S is *labelled* "TapDash Net (after split)" while its formula —
verbatim on all twenty rows — is "Total Income − Total Buy Rate", with no share
multiplication anywhere on the tab. The schema faithfully reproduced the
mislabel.

Values 3 and 4 differ by 10–30% at shares of 0.9/0.8/0.7 and cannot share a
column: 3 is what reconciles against the processor, 4 is what TapDash banks.
Storing only 4 would make every reconciliation failure unexplainable. So
`tapdash_net_before_split` was added and `tapdash_net_after_split` now means
what its name says.

### Grain and rounding

The tier share applies **per line**, rounded to 2dp per line. A merchant's
month is:

```
SUM(residual_lines) + SUM(residual_line_groups)
```

**Both terms are required.** Reports that sum only lines silently under-report
any merchant with a grouped rule (see §5, many-to-one).

Per-line and per-merchant rounding are **not** interchangeable. Multiplication
distributes over addition; rounding to `numeric(14,2)` does not. Measured on
the May 2026 sample, per-row-rounded-then-summed and summed-then-rounded differ
by a penny on **3 of 12** merchants. The grain is therefore a decision that
changes the money, not a detail.

---

## 2. The sign convention

> **Total Income − Total Buy Rate ≡ Net Revenue**, where Total Income is money
> in and Total Buy Rate is a cost carried as a **positive** number.

Verified across all 197 rows of the May 2026 sample. Agent Income and Agent
Expense are never negative (min 0.00 on both); `net_revenue` is the only column
that goes negative (144 of 197 rows).

**The mirror rules are implemented as `−net_revenue`, not `net_revenue`.** The
calc sheet says "Buy Rate = Net Revenue", and taken literally that inverts the
sign of a cost: `0 − (−375.32) = +375.32`. Storing the negation makes the
identity hold on all 40 mirror rows.

Two consequences that look like bugs and are not:

- **There is no `CHECK (total_buy_rate >= 0)` and there must not be.** Two
  Interchange rows in the sample have *positive* net revenue, which under the
  mirror rule yields a legitimately negative buy rate — a rebate. The signed
  identity is the invariant; non-negativity is merely the usual case.
- **Reconciliation needs a per-line tolerance, and it is ±$0.05 — decided,
  not drifted.** Two Merchant Deposit Transaction rows in the sample miss by
  exactly one cent (0.30 − 0.08 = 0.22 against a stated 0.23) from the
  processor's own rounding, which is what first established that a tolerance is
  needed at all. The figure recorded here was ±$0.01 until R6a.

  **R6a set it to ±$0.05 (Q36 = B), knowing what that costs.** The cost is one
  row in the 63-line sample: Orlando's Merchant Deposit row misses by **0.04**,
  and that is *not* rounding — it is a genuine rate variance, 9 items at an
  implied 0.0300 against a template 0.025. **±0.01 would have caught it;
  ±0.05 forgives it.** The looser bound was chosen with that trade in hand, so
  this paragraph exists rather than a silently edited number.

  The value now lives in `residual_verdict_tolerances`, **per step and
  effective-dated**, on the same `(effective_from, effective_to)` + GiST
  `EXCLUDE` + `*_for_month()` idiom as the buy-rate schedules — so changing it
  opens a dated successor rather than re-verdicting every month already signed
  off. `residual_tolerance_is_locked` refuses a change covering a reconciled
  month outright. **Step 1's 0.05 is a placeholder, not a measurement:** no
  statement/report pair has ever been compared, so the right number for it is
  unknown.

---

## 3. Two rate tables

The two sides of every rule read different things, owned by different parties.

| | **Buy side** | **Sell side** |
|---|---|---|
| Table | `residual_buy_rates` (+ schedules, tiers) | `residual_merchant_rates` |
| Means | what TapDash **pays** the processor | what the **merchant pays** TapDash |
| Varies by | risk tier, processor, month | merchant, month |
| Set by | the processor | negotiation |
| Introduced | R5c | R5d |

**Some columns exist on one side only.** There is no template "Amex Template
Volume Fee" and no per-merchant "VMD BIN". A single combined table would be
half NULL by construction and would invite a rule to read a buy rate as a sell
rate — the one confusion that silently inverts a margin.

### Risk tiers

Four tiers, three vocabularies, one mapping table (`residual_risk_tiers`):

| `tier_key` | drawer option | statement integer | rate-grid label | `tapdash_share` |
|---|---|---|---|---|
| `no_program` | No risk | *(none)* | No Buy Rate Program | 0.90 |
| `low` | Low risk | 1 | Low Risk | 0.90 |
| `medium` | Moderate risk | 2 | Medium Risk | 0.80 |
| `high` | High risk | 3 | High Risk | 0.70 |

"Moderate" (drawer) vs "Medium" (workbook) is a genuine vocabulary mismatch,
not a typo. **A merchant's tier is resolved from `residual_merchant_rates`, not
from the drawer** — that is what makes a tier for month *M* a dated fact rather
than a current one.

### `tapdash_share` is not the partner split

Two different splits at two different stages, and conflating them is a
wrong-money bug:

- **`tapdash_share`** (0.9 / 0.9 / 0.8 / 0.7) — the tier percentage, applied in
  value 4 above. In scope for R5d.
- **partner split** (`residual_partners.split`) — a referral partner's cut,
  taken later on the Partner Residual Reconciliation stage, after vendor costs
  and offsets. **Out of scope for R5d**; belongs to R6.

### Fail loud, never zero

A missing rate must never read as a zero rate. Both lookups
(`residual_buy_rates_for_month`, `residual_merchant_rates_for_month`) **raise**
rather than return an empty set, because an empty rate set is indistinguishable
from a genuinely free month, and computing income of 0.00 against a real buy
rate books the entire cost as a loss — a number that looks like an answer.

A MID with no rate row for month *M* is the **"merchant's rate is undefined"**
case. After the 33-merchant load (§11) that is 9 of the 21 May MIDs — they are
billed but absent from the rate sheet. Use
`residual_merchant_rate_coverage(period_id)` to find them *before* running the
engine, rather than discovering them as a raise mid-run.

---

## 4. The formula registry

Twenty rules, stored as **data** (`residual_formula_rules` +
`residual_formula_terms`), not code, inside a dated
`residual_formula_registries` row.

### Matching

**Exact fee item name, and nothing else.** "Card Brand Fees V/MC/D/PP" and
"Card Brand Fees" are distinct rules differing only by suffix; any prefix or
`LIKE` match collapses them into a silent wrong rate.

**There is deliberately no fee-category fallback.** A category maps to *many*
rules — 'MISC Fixed Fees' alone covers eight rules with five different shapes —
so "fall back to the category" has no single answer to fall back *to* and would
resolve to whichever row sorted first. The name set measured **closed** (20
names, 20 rules, exact correspondence both ways), so an unrecognised name is
news, and the safe response to news is to stop: **an unmatched fee item name
raises.** `fee_category` is stored anyway, purely as a rename detector.

### The term vocabulary

A side's value is the sum of its active terms:

```
side_value = Σ ( term_sign × operand × rate )
```

| Field | Values |
|---|---|
| `side` | `income`, `buy_rate`, `additional_income` |
| `operand` | `one`, `line_item_count`, `volume_amex`, `volume_vmd`, `volume_debit`, `volume_ebt` |
| `rate_source` | `merchant` (a `residual_merchant_rates` column), `template` (a `residual_fee_items` key at the merchant's tier), `literal` (a bare number), `net_revenue` (this line's stated net) |
| `term_sign` | `+1` or `−1` |
| `applies_when` | `always`, `sibling_absent`, `sibling_present` (+ `sibling_fee_item_name`) |

**A side with no terms is $0.00.** That single rule removes an entire opcode:
the calc sheet's "Always $0" — 19 of 20 Additional Income cells, both sides of
three rules, one side of six more — needs no representation, because absence
already means it. An explicit ZERO opcode would be a second way to say the same
thing, and two ways to say one thing is how they come to disagree.

`side` has three values, not two, because Additional Income sits outside the
split and cannot be folded into income without being multiplied by the share.

---

## 5. The twenty rules

`m:` = a `residual_merchant_rates` column. `t:` = a `residual_fee_items` key,
resolved at the merchant's tier. Empty cell = no terms = **$0.00**.

| # | Fee item name | Category | Total Income | Total Buy Rate | Additional | Notes |
|---|---|---|---|---|---|---|
| 1 | Authorization Fee IP/SSL | Authorization Trxns | count × `m:vmd_auth_fee` | count × `t:vmd_auth_fee` | | sheet: "must always confirm risk level" |
| 2 | Monthly Fee | MISC Fixed Fees | — | — | `m:monthly_fee_tapdash` | **revised — see §6.2** |
| 3 | Merchant Deposit Transaction | Data Capture Trxns | count × `m:batch_fee` | count × `t:batch_fee` | | |
| 4 | Monthly Online Access Fee | MISC Fixed Fees | — | `t:monthly_online_access_fee` | | income confirmed $0 on all 17 sample rows |
| 5 | PIN Debit Auth Fee | Debit Network | count × `m:pin_debit_auth_fee` | count × **$0.02** | | literal, tier-invariant |
| 6 | PCI Program | MISC Fixed Fees | — | — | | billed directly to merchant |
| 7 | BIN Sponsorship Fees | Discount | *(amex vol × `m:amex_volume`) + (vmd vol × `m:vmd_volume`) + (debit vol × `m:pin_debit_volume`) + (count × `m:vmd_transaction_fee`)* — **only if no Cash Disc row** | (vmd vol × `t:vmd_bin`) + (debit vol × `t:vmd_bin`) | | cross-row conditional |
| 8 | AVS Fee | Authorization Other | count × `m:avs_fee` | count × `t:avs_fee` | | |
| 9 | Interchange | Interchange | — | **−**`net_revenue` | | mirror |
| 10 | Amex Pass Thru Fees (Non OB) | Card Brand Fees | — | **−**`net_revenue` | | mirror |
| 11 | Card Brand Fees V/MC/D/PP | Card Brand Fees | — | **−**`net_revenue` | | mirror; ≠ #17 |
| 12 | Amex OptBlue Fee | Card Brand Fees | amex vol × `m:amex_template_volume_fee` | amex vol × `t:amex_optblue` | | buy side verified exactly on 9 rows |
| 13 | Cash Disc/Surcharge Program | Individual Plan | *same four terms as #7, unconditional* | — | | |
| 14 | iPOS Spin Fee | MISC Fixed Fees | `m:terminal_monthly_mav` | — *(provisional)* | | **group anchor** |
| 15 | iPOSPays Terminal | MISC Fixed Fees | *(no terms — value is the group's)* | — *(provisional)* | | **group member** |
| 16 | Accept Blue Monthly | MISC Fixed Fees | `m:gateway_monthly_mav` | — *(provisional)* | | |
| 17 | Card Brand Fees | Card Brand Fees | — | **−**`net_revenue` | | mirror; ≠ #11 |
| 18 | Website Monitoring Fee | MISC Fixed Fees | — | — | | billed directly to merchant |
| 19 | IRS Annual Fee | MISC Fixed Fees | — | — | | billed directly to merchant |
| 20 | EBT Authorization Fee | EBT | count × `m:vmd_auth_fee` | count × **$0.02** | | reads VMD rates deliberately |

30 terms across 20 rules. Rule #2 appears exactly once, on `additional_income` —
the only rule in the registry whose sole term is on that side.

### Rule shapes worth calling out

**Mirror (#9, #10, #11, #17).** One term: `one × net_revenue`, sign `−1`. The
sign correction lives in *data*, visible to anyone reading the registry, rather
than buried in a branch of the engine.

**Cross-row conditional (#7).** Income is suppressed when the same
`(period, mid)` carries a Cash Disc/Surcharge Program row — **9 of 21 sample
MIDs**, so common rather than exotic. It is a within-partition *existence*
test, never a dependency on another row's computed value, so the registry stays
evaluable in one SQL pass with a `PARTITION BY (period_id, mid)` window.

The engine must never be handed a filtered subset of a merchant's rows, or the
existence test reads the wrong sibling set.

**Monthly + Online combine (#2) — removed, and worth knowing why.** It was
modelled as #7's shape with opposite polarity: `t:monthly_fee` when a Monthly
Online Access Fee row is *present*, `t:monthly_fee_combined` when *absent*. It
was **not** "add the online rate to the monthly rate" — the observed low-tier
combined value is **7.50** against a monthly + online of 4.00 + 6.50 =
**10.50**, so the combined figure is its own rate, not a sum. It was verified
**4-for-4**: every sample MID lacking a Monthly Online Access Fee row has a
Monthly Fee buy rate of exactly 7.50, and every MID having one has 4.00, 5.00
or 7.00.

It was removed because monthly fees are being taken off Maverick's template
altogether (§6.2). The combine existed **only** to choose the right *buy* rate,
and with no Maverick monthly buy rate left to choose between it has no
forward-looking purpose. It describes historical months only — and those need a
predecessor registry regardless (§6.2, parked).

> **If that predecessor is ever seeded, the combine belongs in it**, together
> with the `monthly_fee_combined` fee item (7.50 at low tier) and rule #2's
> pre-changeover income term reading `m:monthly_fee_maverick`. All three are
> pieces of one pre-changeover picture and should be re-seeded as one, not
> reconstructed separately. That is why `monthly_fee_maverick` stays on
> `residual_merchant_rates` — its justification is unchanged.

**The predecessor registry was seeded (R5d 1c) and the combine went into it —
and then `20260903120000` removed it again**, this time from the model rather
than from a forward-looking rule set. `monthly_fee_combined` is soft-deleted:
the fee item, its single low-tier rate, and both conditional buy terms. Rule
#2's predecessor buy side is now one unconditional `1 × template.monthly_fee`.
See §6.10 for what that costs and how to reverse it.

**Consequence for `applies_when`:** it is used by exactly one rule (#7), and
**this is the second time its second justifying case has been removed.**

The vocabulary was designed against two cases and lives on the **term** rather
than the rule *because of the second one* — rule #2, where only one of two buy
terms was conditional. That case was removed once when monthly fees came off
Maverick's template (§6.2), came back when the predecessor registry was seeded,
and has now been removed again by retiring the combine outright.

**The shape is still right, but for one reason rather than two.** #7 genuinely
needs a per-term condition: its income side has four conditional terms and a
rule-level flag could not express that. `sibling_present` also stays reachable
in the CHECK. But a future reader should not be told the design rests on two
cases — it rests on #7, and "it must be on the term because #2 needs it" is not
an argument available here. If #7 were ever restructured, nothing else would
justify the placement.

**Many-to-one (#14 / #15).** Computed once, reconciled against the **sum** of
both rows' stated nets. The value lives on `residual_line_groups`, never on a
member line, because splitting it invents an allocation the source does not
specify and putting it on one member leaves the other looking unexplained.
Member lines get 0.00 in their engine columns, so NULL keeps meaning "not
computed".

The anchor is not an arbitrary choice: the calc sheet puts the formula on iPOS
Spin Fee and leaves iPOSPays Terminal's income cell **empty** (not "$0").

**Billed-directly items (#6, #18, #19).** No terms on any side. The seeded
template rates — `pci_fee` 5.00, `website_monitoring_fee` 15.00,
`irs_annual_fee` 1.95 — are reference data and are referenced by **no term**.
That is stronger than a runtime flag check: an unreferenced rate cannot leak
into a total by any code path, whereas a runtime check is one forgotten branch
away from booking ~$5 per merchant per month of phantom PCI cost. The flag is
made load-bearing as a **constraint** (`tg_residual_formula_terms_validate`),
which rejects any term referencing such an item at write time.

**The two $0.02 literals (#5, #20).** Kept as literals rather than seeded as a
fee item. The workbook says "ALWAYS $0.02" — explicitly tier-invariant — while
`residual_buy_rates` is keyed `(schedule, risk_tier, fee_item_key)` and would
force the same number to be stored four times, maintaining the fiction that it
varies and creating four places for three of them to drift. Dating is not lost:
**the registry is itself dated**, so a change from $0.02 is a new registry
version, which is the honest description of what such a change is.

**Composite (#7, #13).** Four terms mixing merchant-month *volumes* with *this
line's* own `item_count`. Intended: the count in #7 is the BIN row's and in #13
the Cash Disc row's — different numbers (489 vs 544 on the one MID carrying
both). Nothing averages or shares them.

**Dependency graph.** No rule reads another rule's output. #7 reads a sibling's
*existence*; #14/#15 share an *input*, not an output. The graph is edgeless and
one pass suffices.

---

## 6. Decisions of record

Each of these changes the money. They are recorded here because none of them is
derivable from the code.

### 6.1 The tier share applies per line

Confirmed. Rounded 2dp per line; merchant totals are `SUM()` of stored values.
See §1.

### 6.2 Monthly fees are now billed directly by TapDash

Maverick no longer collects the merchant's monthly fee, **and the fee is being
removed from Maverick's template altogether**, so there will be no Maverick buy
rate for it either. Rule #2 therefore reads: income **$0**, buy rate **$0**, and
the merchant's monthly fee becomes **Additional Income Directly to TapDash** —
the rule's only term.

One consequence for a reader of `residual_buy_rates`: the seeded `monthly_fee`
rates (0 / 4 / 4 / 7) are now referenced by no term, joining `chargeback` as
reference data the live registry does not read. They are deliberately not
deleted; a predecessor registry would read them again.

> **⚠ The May 2026 sample only partly agrees, and this is the largest known
> open item.**
>
> Of 21 Monthly Fee rows, 10 carry Agent Income of 0 (the −4.00 / −7.00 / −7.50
> nets the decision cites) but **11 carry non-zero Agent Income** — 99.00 (×6),
> 50.00, 35.00, 30.00, and 9.95 (×2) — and each reconciles as income minus
> expense (99 − 4 = 95; 30 − 7 = 23; 9.95 − 4 = 5.95). Six merchants whose
> drawer snapshot shows a monthly fee report income of 0 for it; five report the
> drawer's exact value. **That is a migration in progress, not a completed one.**
>
> Under the current registry those 11 rows compute Total Income 0.00 against a
> stated net that assumes otherwise, and **May 2026 will show 11 mismatches**.
> That is correct behaviour for a registry saying the fee is no longer
> collected — not a defect for the engine to paper over.
>
> **The fix, if May must reconcile, is one INSERT and no schema change:** seed a
> predecessor registry (effective through the changeover month) whose rule #2
> income reads `m:monthly_fee_maverick`, and move the current registry's
> `effective_from` forward. The changeover date is the one missing fact.

This is the entire reason `residual_merchant_rates.monthly_fee_maverick` exists
and the entire reason the registry is effective-dated.

### 6.3 The "For the moment $0" placeholders

Rules #14, #15 and #16 compute as **0.00**, flagged `is_provisional = true`. A
computed 0.00 that came from an admitted unknown and one that came from a
decision must stay distinguishable, or the day the real rate arrives nobody can
find the rows it should have applied to.

### 6.4 Batch Fee — the seeded template is correct

**The seeded Batch Fee rates (0 / 0.01 / 0.025 / 0.04) are right. Do not create
a dated successor schedule and do not edit the seed.** The workbook cell that
appeared to say `0.03` displays rounded to two decimals but holds `0.025`; the
newly attached workbook was diffed against the original and the Template Buy
Rates sheet is byte-identical apart from one blank cell.

The residual variance is recorded as an **observation** in §8 (gap 5), not acted
on. It is a reconciliation variance, which is what reconciliation is for: the
engine will surface it when it runs.

### 6.5 Merchant rates are imported from the .xlsx, never a CSV

Measured, not assumed. In the source workbook the volume-rate cells hold the
unscaled fraction already — but they carry the number format `0.00%`, and
**Excel's CSV export writes the displayed text, not the underlying value**:

| Cell value | CSV export | 
|---|---|
| `0.0385` | `3.85%` |
| `0.033816` | `3.38%` |

Two independent hazards, both silent:

- **A 100× scale error.** Anything that strips `%` and parses gets `3.85`, a
  hundredfold overstatement of every volume-driven income figure.
- **Precision loss even when parsed correctly.** `0.033816` → `3.38%` →
  `0.0338` discards four significant digits, on a rate multiplied by six-figure
  monthly volumes.

The importer therefore reads the `.xlsx` (self-hosted `xlsx@0.20.3`, the R4a
precedent) and takes the cell *value*. The percent-scale guard in
`commit_residual_merchant_rates_import` stays anyway as a backstop — it
**rejects** a suspect file rather than dividing by 100, because auto-scaling
would make a wrong file load cleanly and would half-correct a file that mixed
both conventions. A guard that never fires is cheap; the day someone
hand-builds an input file it earns its place.

### 6.6 Three cell states, not two

The source sheet distinguishes three things, and the calc table needs all
three kept apart:

| Sheet cell | Stored | Meaning at calc time |
|---|---|---|
| a number | the value | the rate |
| `"$ -"` | `0.000000` | a **recorded decision**: we don't charge this |
| blank | `NULL` | an **absence**: no arrangement recorded — must fail loud |

> **A trap worth recording, because it misled both author and reviewer once.**
> Counting "populated" cells as *number OR `"$ -"`* badly overstates how much
> real rate data exists. `vmd_transaction_fee` reads as 20 of 33 populated and
> is **4 of 33 numbers** — the other 16 are `"$ -"`. Likewise `avs_fee` 22 → 9,
> `vmd_auth_fee` 20 → 10, `batch_fee` 23 → 13. Always split the three states
> before drawing a conclusion about coverage.

Because the `"$ -"` → `0.000000` reading is inferential and load-bearing, the
import wizard shows **all three counts per column as a prominent preview
panel** — not a footnote — and the operator confirms before commit.

### 6.7 `monthly_fee_tapdash` is never auto-zeroed

The sheet's "Fees Charged Directly by TapDash to Merchant / Monthly Fee"
column exists with a header and is **empty for all 33 merchants**. It is rule
#2's only term, and every May MID has a Monthly Fee row, so after a perfect
import **rule #2 raises for every merchant and the engine computes nothing**.

It would be tempting to seed `0.00` across the board on the grounds that an
empty column means "TapDash bills nobody". **We do not.** The changeover is
mid-flight, so the likelier reading is that the column was added for the new
regime and has not been filled in. Auto-zeroing would convert *"nobody has
told us"* into *"we checked, it is zero"* — silently, in a money path. That is
the same principle as R5a's NULL-not-partial volume buckets and the fail-loud
rate lookups, and this arc has consistently refused it.

The consequence is accepted deliberately: **the panel, not the importer, is
what unblocks the engine.** The value is entered by hand, per merchant, as a
recorded decision.

### 6.8 The changeover was staged per merchant — the boundary is not tuned

In May 2026 six merchants had already stopped being billed by Maverick while
five were still being billed. Both groups are in one statement month, so no
boundary date explains both: moving the June boundary earlier makes the five
mismatch, later leaves the six mismatching.

**The mismatches stand.** Tuning the boundary would fit a global parameter to
a per-merchant fact — a better-looking number bought by making the model less
true, which the next month's data would break somewhere else. A first engine
run reproducing exactly the predicted **5 reconcile / 6 mismatch / 1 raise**
split validates the registry, the rate table and the sign convention together;
a run that reconciles because somebody adjusted a date validates nothing.

If a per-merchant changeover date is ever wanted, it belongs on
`residual_merchant_rates` — using the effective dating that table already has.
A merchant who stopped being billed in March gets a dated successor at
`2026-03-01` with `monthly_fee_maverick = 0.00` (a recorded decision, not a
NULL), while merchants still billed keep their standing version. Rule #2 then
reads the same column for everyone and lands on the right number per merchant,
because the date lives with the merchant rather than with the rule. The
predecessor registry stays exactly as seeded and its boundary never moves.

### 6.9 Out of scope / parked

- **Orlando Baking (201100169797)** — parked. Its actuals match no template
  tier on any fee item. Nothing is designed around it.
- **Partner splits, vendor costs, offsets** — the Partner Residual
  Reconciliation stage. R6. No R5d rule reads
  `residual_merchant_vendor_costs`; its being empty does **not** block R5d.
- **`residual_buy_rates.chargeback`** — seeded (10/15/20/25) but referenced by
  no rule, and "Chargeback" never appears as a fee item name in the sample.
  `residual_merchant_rates.chargeback_fee` exists so that a future Chargeback
  rule is a dated registry INSERT rather than a schema migration.
- **`lease_payments_tapdash`** — excluded from income by its own label
  ("not income"). Settled, not open.

---

### 6.10 `monthly_fee_combined` is retired — what it costs, and how to undo it

`20260903120000` soft-deletes the fee item, its single low-tier rate (7.50), and
both conditional buy terms on the predecessor rule #2, replacing them with one
unconditional `1 × template.monthly_fee`.

**What it costs.** Four May merchants carry a Monthly Fee line and no Monthly
Online Access Fee line — three named in the change request and one found while
checking it:

| MID | Merchant | Tier |
|---|---|---|
| `201100216416` | Julianas | low |
| `201100250209` | Monte Carlo | low |
| `30119900929` | House Of Tacos | low |
| `30119926551` | — | **no rate row at all** |

The first three resolved their pre-June Monthly Fee buy rate to 7.50 and now
resolve to 4.00 — **understated by 3.50 per merchant per pre-June month**.
Understating a cost overstates the margin, so the net is overstated by
3.50 × 0.9 = **3.15**. Calc-engine test 12 pins exactly that delta.

**The understatement is a low-tier fact, and the change cuts the other way
elsewhere.** `monthly_fee_combined` was seeded at the **low tier only** — one
cell of four. A medium- or high-tier merchant with no Online Access line hit the
`sibling_absent` term, found no template rate at its tier, and the engine
reported `missing_template_rate`: the line did not compute at all. It now
computes at the plain rate. So the trade is a 3.50 understatement at low against
turning a hard failure into a number at medium and high.

**It is invisible today and will not stay invisible.** All three named merchants
fail on `monthly_fee_tapdash` before the buy side is evaluated — first failure
per line — so the May recompute is byte-identical across the change. Entering
those monthly fees makes the 3.50 real.

**A lone conditional term would have been far worse.** Removing only the
`monthly_fee_combined` term would leave rule #2's buy side holding one term
still marked `sibling_present`. For a merchant with no Online Access line that
condition is false, every term is skipped, and a side with no active terms is
**$0.00** by design — no failure, no warning, the whole monthly fee booked as
margin. Test 6b asserts against that shape, and case 23d asserts no rule side
anywhere is left holding only `sibling_present` terms.

**How to reverse it.** Everything is a soft delete, so this is data, not
schema:

1. Clear `deleted_at` on the `residual_fee_items` row for `monthly_fee_combined`.
2. Clear `deleted_at` on its `residual_buy_rates` row (low, 7.500000).
3. Clear `deleted_at` on the two conditional buy terms.
4. Soft-delete the unconditional term the migration inserted — otherwise all
   three evaluate and double-count.

**Step 1 must precede step 3.** `tg_residual_formula_terms_validate` fires on
UPDATE as well as INSERT and requires a template `rate_ref` to name a *live*
fee item, so un-deleting a term while its item is still deleted raises `23503`.
The migration navigates the same trap in the other direction, which is why it
retires the terms *before* the fee item.

### 6.11 The four vendor rate cards (R5e)

Source: "Tab - Template Buy Rates", the vendor blocks right of the Maverick
grid. **Five schedules**, because Paya is two.

| Payer | Rates |
|---|---|
| `ACCEPT_BLUE` | Monthly 15.00 · Auth 0.05 · Payment page 5.00 **capped at 25.00** |
| `TUZO` | Volume 0.001 · Monthly 5.00 |
| `RICHARD` | Monthly 95.00 |
| `PAYA_ACH_PPD` | Transaction 0.15 · Returned item 2.00 · Batch 0.15 · Monthly service 10.00 · Over $25,000 0.20 |
| `PAYA_ACH_WEB` | as PPD except **Transaction 0.20** |

**Deja Voo is not imported**, and that is recorded rather than forgotten: the
sheet has a header and a "Fee item" label and *no rows*. An empty card would
assert the vendor charges nothing, which is a different claim from "we do not
have their rates" — the same distinction the rate editor draws between 0 and
NULL. Columns 26–28 (partner names, splits, emails) are not imported either;
partners live in `residual_partners`, and no email address appears in any
migration, comment or spec text.

**Why a vendor card belongs in the template at all.** R5c already stores
per-merchant vendor costs in `residual_merchant_vendor_costs`, and the
workbook's merchant rows carry Accept.blue at Gateway Monthly 15 / Gateway Auth
0.05 — matching this card exactly. So the per-merchant rows *derive* from the
card. Without it there is no way to tell a merchant on standard pricing from one
that negotiated something, and no way to reprice the standard without touching
every merchant row.

#### The share that is not a share

`residual_buy_rate_tiers.tapdash_share` is NOT NULL and `residual_buy_rates`
carries a composite FK to `(schedule_id, risk_tier)`, so a rate cannot exist
without a tier and a tier cannot exist without a share. **A vendor has no
share** — TapDash pays these vendors; the money runs the other way.

Rejected: a **separate table pair** (cleanest — no share to mistake — but the
cards must resolve through `residual_buy_rates_for_month`, and a second dated
mechanism is a second thing to keep correct, whose first divergence would be
silent); **nullable `tapdash_share`** (weakens a live NOT NULL for five rows,
and NULL *propagates* — `round(before × share, 2)` yields NULL, which reads as
"not computed" and is indistinguishable from a real failure); **reusing
`no_program`** (a real tier with a real 0.9 share).

Chosen: one non-risk tier, **`vendor_flat`, share 1.000000**. 1.0 is the
arithmetic **identity** in the only place a share is used, so a vendor schedule
reaching the chain would scale nothing — the safe failure mode, unlike 0.0
(silently zeroes) or NULL (silently un-computes). It is not a claim that TapDash
keeps 100% of anything.

**The blocker the request could not have known about.** The instruction was to
add the tier with a NULL `statement_code`. That column is nullable — but
`drawer_option` is **NOT NULL, UNIQUE**: every row in `residual_risk_tiers` must
be a pickable option on a merchant record. That is what the table *is*. So
`drawer_option` became nullable, **paired to a new `is_risk_tier` flag by a
CHECK** — a real risk tier must still have one, a non-risk tier must not. The
invariant that mattered is preserved and now enforced rather than implied, and
the R5c count-equality test keeps its meaning by scoping to `is_risk_tier`.

A trigger on `residual_merchant_rates` refuses any tier with
`is_risk_tier = false`: without it, `vendor_flat` — carrying share 1.0 — would
become assignable to a merchant, who would then book the entire net as TapDash's.

#### Paya is two cards, not two tiers (Q28 = A)

PPD/CCD/TEL and WEB are **ACH entry classes**, not risk levels. Modelling them
as pseudo-tiers would let the system say a merchant is "WEB risk" and would put
an entry class in the column that decides a residual split.

**No rule can read them yet.** Which entry class a line falls under is a
per-line fact nothing carries: `residual_lines` has no entry-class column and
the fee report supplies none. Seeding these stores a price; it does not enable a
calculation.

#### Card updater seeds with no rate (Q30 = A)

Accept.Blue lists "Card updater monthly" and "per update" with no values. Both
are fee items with **no rate row**, so a lookup finds nothing and the engine
reports `missing_template_rate` rather than guessing zero — the pattern
`monthly_fee_combined`'s missing tiers established.

#### The cap, and the grain it is NOT (Q29 = B)

**It lives on `residual_buy_rates.rate_cap`, beside the rate.** The cap is
Accept.Blue's pricing fact, not an opinion of whichever rule reads it. On the
term, two rules could disagree and one could omit it — and the one that omitted
it would compute a larger cost with nothing indicating anything was missing.

`residual_eval_side` applies `min(operand × rate, cap)` **to the magnitude,
before `term_sign`**. Applying it after the sign would turn a cap into a *floor*
for negative terms: `min(-35, 25) = -35`, capping nothing.

**The grain differs from the source's, and that is stated rather than papered
over.** "5.00 per payment page, capped at $25" means **per merchant per month**.
The engine caps **per term, within one line** — `residual_eval_side` sees one
line's `item_count` and the merchant's volumes, never the merchant's other
lines. The two coincide only while at most one line per merchant-month carries
the capped item; with two, this implementation allows 2 × 25 = 50 against a true
cap of 25. Understating a cost overstates the margin, so the error has a
direction.

A true per-merchant-month cap needs a **second pass** in
`compute_residual_period`, after every line for a merchant is evaluated, that
sums the capped item across them and reduces the total — and that pass must
answer **which line absorbs the reduction**, a question the source data does not
answer. It is not invented here. Nothing reads a capped rate today:
`ACCEPT_BLUE` has no formula registry.

#### The reader had to be widened too — a bug the suite caught

Teaching `compute_residual_period` to build `{rate, cap}` maps read
`b.rate_cap` from `residual_buy_rates_for_month`, whose `RETURNS TABLE` did not
carry it. Every call raised, so the engine raised for every period.

**It surfaced as eighteen SKIPPED tests, not eighteen failures** — the throw was
in a describe-level `beforeAll`, and vitest reports the block as skipped. A
sudden jump in skipped counts is a setup that threw, not a test anyone chose to
skip.

The cap arithmetic had been probed against a hand-built jsonb, which proved
`min()` correctly and proved nothing about where the map comes from — the probe
tested the half that was written and skipped the half that changed underneath
it.

#### Three things the browser pass found

**Vendor rates were hidden by a rule that does not apply to them.** The grid
moves fee items out when no template term in the month's registry references
them — right for Maverick, where an unreferenced rate like `chargeback` is an
anomaly worth seeing. The five vendor cards have **no registry at all**, so
`residual_template_rate_refs` returned nothing and *every* vendor rate fell into
the hidden set: five clearly-labelled cards with no rows.

The rule is now scoped by `residual_formula_registry_for_month`. With a
registry, "referenced by no rule" is an anomaly and goes behind the disclosure.
**Without one it is the normal state**, every rate shows plainly, and the
disclosure is **absent entirely rather than empty** — a "0 rates this month does
not price" toggle would invite the reader to look for an anomaly that cannot
exist there. Derived from the registry table, not from a list of processor
names.

**Fee items with no rate did not render at all.** Q30 = A seeded Accept.Blue's
two card-updater items with no rate so a lookup would raise — which worked, and
also made them invisible, since the grid builds rows from rate rows. That is the
opposite of what an operator needs in order to enter the missing price.

This **reverses a decision recorded in `20260901130000`**, which dropped NULL
rates on the grounds that "storing a NULL rate row would be a second way to say
the same thing". That held while absent and NULL meant the same thing. Q30 = A
created a case where they do not:

| state | meaning |
|---|---|
| no row | the item is not on this card |
| row, `rate` NULL | the item **is** on this card; nobody has recorded its price |

So `residual_buy_rates.rate` is nullable, the two items have rows, and a
successor now **stores** every cell it is sent rather than dropping the empty
ones — otherwise an operator opening a successor, seeing the unpriced row, and
leaving it blank because they still don't know the price would silently delete
it from the card. Nothing downstream changed to stay safe:
`residual_eval_side` already reports `missing_template_rate` for a NULL rate, so
NULL and absent fail identically at calculation time. Only the screen can tell
them apart. `Number(null)` is `0`, so the grid skips NULL rates when building
its lookup rather than printing `0.000000`.

**The only other collapse of this kind** was these same two items — no other
seeded fee item lacks a rate in its card.

#### A replayed migration stops being replayable

Case 19 replays the R5c migration file verbatim to prove its seed is idempotent.
Widening `residual_buy_rates_for_month` broke that: Postgres refuses "cannot
change return type of existing function" for a create-or-replace that changes
shape, so R5c's original eight-column version cannot install over the
nine-column one. The test now drops the function inside its rolled-back
transaction. **A migration replayed verbatim stops being replayable the moment a
later migration changes the signature of anything it declares.**

### 6.12 Merchant vendor costs (R5e)

`/admin/residuals/vendor-costs`. `residual_merchant_vendor_costs` had been in
the schema since R5c — per-MID, effective-dated, EXCLUDE-guarded, admin-gated —
**with no UI and zero rows**. It is where a merchant is attached to a vendor,
and it is what could not be found because it did not exist.

Built to the merchant rate editor's shape: one RPC assembles the form, one saves
the whole row, one opens a dated successor, and the same three-state legibility
(value / explicit `0` / empty) applies to every fee.

**No lock, and that is an argument rather than an omission.** The rate editor
refuses an in-place edit once a computed period read those rates. **Nothing
reads `residual_merchant_vendor_costs`** — `residual_formula_terms.rate_source`
is `merchant | template | literal | net_revenue`, and `merchant` resolves against
`residual_merchant_rates`, whose legal columns are pinned by a CHECK containing
none of these. So no computed period depends on a vendor-cost row, and a lock
keyed on "a computed period exists for this MID" would assert a dependency that
does not exist — **exactly the mistake `20260902130000` had to correct** for
buy-rate schedules, where an empty computed period locked the whole template on
behalf of nothing. The screen says plainly that no calculation reads these rows
yet. When something does, the lock question becomes live and should be answered
then, against the real dependency.

The dated successor is offered regardless, because effective dating is how
vendor pricing changes over time: a merchant who moves gateway in March should
not have February repriced.

#### The badge asserted a match nothing had compared

**Reported: the card's rate changed and an untouched merchant row still read
"matches card".**

Two findings, and neither is the one the report assumed.

**The rate was never populated.** `gateway_monthly_mav` on MID `201100207241`
is still NULL. The prefill fires on **blur** of the provider field; loading the
page and reading it runs nothing.

**And there was no rate comparison on that screen at all.** The string was
`"Matched the ACCEPT_BLUE card."` — a note under the PROVIDER field saying the
typed *name* resolved to a card. It never looked at a rate. Sitting beside an
empty rate box, it read as "your rate agrees with the card".

*(The card itself was never changed either: `residual_buy_rates.updated_at` is
still the seed timestamp and no successor schedule exists. The buy-rate screen
offers no in-place edit — only dated successors — so a rate cannot be changed
there at all.)*

**Three states, not two.** A merchant row with no rate recorded does not match a
card carrying 15.00, and does not differ from it either — it has **nothing to
compare**, and that is the actionable state: somebody should either accept the
card's number or type their own.

| state | reads |
|---|---|
| card prices nothing here | *(silent — there is no second operand)* |
| **nothing recorded** | "nothing recorded here to compare — the X card holds 15" |
| matches | "matches the X card" |
| differs | "differs from the X card (15)" |

`cardMatch` is pure and unit-tested, including that an explicit `0` compares as
a real value rather than collapsing into "nothing recorded", and that the same
untouched merchant value flips from *matches* to *differs* when only the card
moves — the property that proves the comparison is derived rather than captured
at prefill time. Both screens now render the same component, so the states read
identically.

The provider note was reworded to say what it actually checks: the name
resolves, and each rate says separately whether it matches.

#### The prefill was built on the wrong screen

**Reported: setting Accept.Blue as the gateway provider changed nothing.**

`residual_merchant_vendor_costs` had zero rows and had never been used. The edit
landed on `residual_merchant_rates`: MID `201100207241`,
`gateway_provider_mav = 'accept.Blue'`, `gateway_monthly_mav` still NULL. That
field is **free text on the merchant rate editor**, which had no card lookup at
all — cause (a).

**And that is the right screen.** The engine reads `gateway_monthly_mav` (rule
"Accept Blue Monthly") and `terminal_monthly_mav` (rule "iPOS Spin Fee") from
`residual_merchant_rates`. **No term reads `residual_merchant_vendor_costs`**,
and `residual_formula_terms_merchant_ref_known` forbids one from trying. The
prefill had been built on the surface that feeds nothing.

**Cause (c) was real too, and is the design gap.** The card's items are named per
*vendor* (`vendor_monthly_fee`), the merchant's columns per *role*
(`gateway_monthly_fee`). Nothing connected them but a hardcoded map in one React
file — invisible to SQL, unavailable to the screen that needed it.

#### role × slot = column

The objection to a column on `residual_fee_items` looks fatal: the same item is
on several cards, so one global role cannot be right — Accept.Blue's monthly fee
is a *gateway* monthly, Richard's is not.

It dissolves once the target is decomposed. Every vendor-cost column is
`role_slot`. **The role is not a property of the vendor at all** — the merchant
chooses it by which provider field they put the vendor in. The fee item
contributes only the **slot**, and the slot *is* global: a monthly fee is a
monthly fee on every card.

So `residual_fee_items.vendor_cost_slot` holds the intrinsic half, the merchant
row holds the chosen half, and their product is the column. A **mapping table**
keyed by (vendor, item) would store that product redundantly and let the halves
disagree. **Convention over `fee_item_key`** was rejected for the usual reason:
it makes a rename a silent behaviour change, and it cannot distinguish "fills no
slot" from a typo.

Five items carry a slot; the rest carry NULL — Accept.Blue's payment page and
card-updater-monthly, all five of Paya's. **Items that fill no slot are the
normal case, not an error**, and the screen names them rather than dropping
them: a card whose items mostly vanish without explanation is how somebody
concludes the feature is broken, which is the report that led here.

#### What a provider is

**Free text, resolved by name — not a foreign key.** The loaded data already
holds `UsaEpay`, `IposPays` and `Valor`, none of which has a card. A reference
would make those merchants unrepresentable, and a merchant may legitimately use
a vendor nobody has transcribed.

`residual_vendor_provider_key` writes the normalization down once: upper-case,
runs of non-alphanumerics to a single underscore. `accept.Blue` and
`Accept Blue` both give `ACCEPT_BLUE`; `UsaEpay` gives `USAEPAY` and matches
nothing, which is a real answer rather than an error. The client never
reimplements it — it calls the server on blur, so there is one rule rather than
two that can drift.

**The cost, stated:** the link is by name, so renaming a schedule silently
unlinks every merchant row that named it. That is the price of letting a
merchant use a vendor with no card, and the screen makes it visible by saying
when a typed provider resolves to nothing.

#### Should picking a provider prefill its rates? Yes — visibly

**For:** the vendor-card migration already records the relationship — the
workbook's merchant rows carry Accept.blue at Gateway Monthly 15 / Gateway Auth
0.05, matching the card exactly. Retyping numbers the system holds invites
transcription errors into money data, and a hand-typed 15.00 is indistinguishable
from a negotiated one anyway.

**Against:** a prefilled value is stored as an ordinary number, and the merchant
row is **not bound** to the card — no FK, no derivation recorded. Once the card
changes, every row that merely agreed with it silently becomes one that
*disagrees*, while looking exactly like something somebody negotiated. That is
the stale-cached-fact problem, and it is worse than retyping.

**Resolution: prefill, and derive the comparison — never store it.** Each field
shows, live at render time, whether it currently matches the open card for the
selected provider:

- a prefilled value reads **"matches the card"** — until the card moves, when
  the same untouched row reads **"differs from card (15.00)"**, which is exactly
  the signal somebody needs;
- a negotiated value reads "differs" from the moment it is entered, and names
  what the card holds;
- nothing stored can go stale — the module's existing rule, the same reason R5b
  derives link staleness instead of flagging it.

A stored `derived_from_card` flag was rejected on those grounds: the flag itself
becomes a cached fact that can go stale, which is the failure being guarded
against.

Prefill only touches fields the card actually prices, so it can never blank
something already entered. A provider recorded on a row whose card has since
closed stays selectable, or saving would silently drop it.

## 7. Recompute safety

### `calculation_version`

A **monotonic per-period counter**, incremented by the engine RPC on a
successful *full-period* compute and written **last**. `NULL` means no standing
assertion that the stored outputs are current — covering both never-computed
and invalidated-since, which are not usefully different to a reader. Written by
the engine and nothing else: not by imports, not by the app, not by hand.

### The R4a hole, and how it is closed

The supersede sweep in `commit_residual_excel_import` soft-deletes prior lines
and inserts fresh ones with NULL engine columns, and does **not** touch
`residual_periods`. So after any re-import the period still claimed "computed"
while every live line had NULL outputs — exactly the ambiguity
`calculation_version` exists to prevent, inverted. **This is a live hole in
shipped code**; R5d only makes it visible by being the first thing to write a
non-NULL version.

It is closed with a trigger on `residual_lines` rather than by patching the
import RPCs. Attaching invalidation to the **fact** (the lines changed) instead
of to a caller covers the supersede sweep, manual entry, the PDF path and every
future import route, and cannot be forgotten by the author of the next one. The
trigger fires only on *stated* column changes, so the engine's own writes cannot
trip the invalidation it is about to satisfy.

### The write guard — a reconciled period is frozen

"Closed" was previously a label with nothing behind it: no trigger, no RLS
predicate and no application check referenced `status`. A reconciled month is
one somebody has signed off, so **neither its computed values nor its statement
data can be modified.** Reopening it is an explicit admin act — the guard blocks
the *write*, not the recompute.

**Re-imports are blocked too**, and that half matters most. Without it, a
re-import into a reconciled period inserts lines, the invalidation trigger
answers by setting the period back to `open`, and a sign-off is undone as a side
effect of a routine upload with nobody told. Freezing the outputs while leaving
the inputs writable protects the wrong half.

**The guarded set is exactly the invalidation set, plus the engine columns**,
and the symmetry is deliberate: *the changes that invalidate a calculation are
precisely the changes a reconciled period forbids.* A column added to one list
belongs in the other.

It lives in a trigger rather than in the two commit RPCs — the same answer as
invalidation, for the same reason. Attaching to the fact covers every route
including manual line entry, which an RPC-only check would miss; hand-inserting
a line into a signed-off month is exactly as much a violation as re-importing
one. The "worse error from deep inside a bulk insert" worry does not materialise
here: every line in one import shares one `period_id`, so the trigger raises on
the *first* row rather than the 197th, the RPCs are atomic so nothing partial
survives, and the error raised is ours — naming the statement month and telling
the operator to reopen the period — rather than a bare constraint code.

Of the five defined statuses (`open`, `awaiting_volumes`, `ready`,
`reconciled`, `mismatch`), only `open` is currently ever written. The ladder
belongs to Part 2.

### Manual lines

`source = 'manual'` lines are **computed identically** to every other line.
`manual` describes the provenance of the *statement data* — a hand-entered
statement line — not of the result, and its `fee_item_name` resolves against the
registry like any other.

This is load-bearing because the supersede sweep deliberately **spares** manual
lines: an engine that skipped them would drop hand-entered corrections out of
the totals on the first re-import and never mention it.

A hand-entered *result* that the engine must not overwrite is a different
feature (an override column plus a reason) and is deliberately not in R5d.

---

## 8. Known gaps

Ordered by what blocks what. **Re-measured against the test project 2026-09-23;
each entry states what was true on that date.**

1. ~~**No merchant has rates.**~~ **Superseded — partly closed.** The rate
   importer and the per-merchant editor were built in R5d pt 1c / pt 3
   (`/admin/residuals/rates`), so the "needs the subtab-1 entry UI" half is done.
   As of 2026-09-23 there are **34 rate rows across 33 MIDs**.

   **What remains:** **9 of the 21 May MIDs still have no rate row** and fail at
   `scope = 'merchant'` with `no_merchant_rates` — they are billed but absent
   from the 33-merchant sheet. And separately, `monthly_fee_tapdash` is **NULL on
   all 34 rows**, so rule #2 raises for every merchant (§6.7 — it is never
   auto-zeroed, and the panel rather than the importer is what unblocks it).

   ```sql
   select count(distinct l.mid) from residual_lines l
    where l.deleted_at is null
      and not exists (select 1 from residual_merchant_rates r
                       where r.deleted_at is null and r.mid = l.mid);
   ```
2. **No merchant-month has both artifacts.** **Still fully open as of
   2026-09-23.** Volumes exist only for 2026-07, fee lines only for 2026-05 —
   **zero overlapping `(period, mid)` pairs**, confirmed by query.

   Rules #7, #12 and #13 — **40 of 197 rows** (15 BIN Sponsorship + 13 Cash Disc
   + 12 Amex OptBlue; the two composites alone are the 28 this entry previously
   cited) — have never been validated end to end and cannot be until one
   merchant-month has both.

   **Step 1 of the reconciliation has also never been evaluated once** for the
   same reason: `residual_verdicts` returns **zero step-1 rows** on May, which is
   why step 1's tolerance remains a placeholder (§2). The EBT bucket-membership
   conflict recorded in `20260907120000`'s seed header is waiting on the same
   overlap to arbitrate it.

   This is the highest-leverage gap in the list: one PDF statement for a May
   merchant that already has rates would exercise step 1, both composites, rule
   #12 and the volume join at once.
3. **The monthly-fee changeover date** (§6.2) — **still open.** Confirmed
   2026-09-23: of 21 May Monthly Fee rows, **11 carry non-zero Agent Income** and
   10 carry zero.
4. *(closed — the combine was removed in §5; no tier values are needed.)*
5. **Batch Fee variance — an observation, recorded so it is not re-derived.**
   The seeded template is correct (§6.4); this is about the May 2026 report
   disagreeing with it, which the engine will surface as a reconciliation
   variance. **Do not build a program dimension for it.**

   Two things are worth pinning down, because the raw report column misleads:

   - **The report's `Buy Rate Per Item` column is rounded to 2dp and cannot be
     read directly.** It shows `0.03` for medium-tier merchants. Dividing
     `Agent Expense` by `Count` recovers the true rate, and for every
     medium-tier merchant except parked Orlando that rate is **exactly 0.025**
     — the template value (10 × 0.025 = 0.25; 34 × 0.025 = 0.85; 61 × 0.025 =
     1.525 → reported 1.53). **Medium tier reconciles.** The apparent 0.03 is
     the same display-rounding artifact as the workbook cell in §6.4, and it is
     easy to record a variance here that does not exist.
   - **The only genuine variance is three low-tier merchants at 0.02 against a
     template of 0.01** — MIDs 30119900929, 201100250209 and 30119926551. High
     tier (0.04) and the remaining low-tier merchants match the template
     exactly.

   **The correlation, which is the part worth keeping:** those three are
   *exactly* the merchants with no Monthly Online Access Fee row — the same
   cohort that carried the combined 7.50 monthly buy rate (§5). The one
   low-tier merchant that *does* have an Online Access row (30119889981) sits
   at the template 0.01. So a single cohort of merchants differs from the
   template on both monthly and batch, which reads like a distinct pricing
   arrangement rather than a change over time — a dated successor schedule
   would have moved 30119889981 too, in the same month, and did not.

   This is recorded, not acted on. If the variance recurs across months once
   the engine runs, that is the evidence a structural answer is needed.
6. **Buy rates that match no tier.** **Still open; one clause superseded.** At
   least five sample MIDs have actuals matching no template tier on any fee item.
   Until settled, "the merchant's rate" is resolved by the new table but its
   *correctness* is unverified.

   The original entry also cited the **drawer snapshot** failing to reproduce the
   income side. That evidence is no longer available in that form: the 25
   subtab-1 drawer fields were retired on 2026-09-09 (§9), so the comparison must
   now be made against `residual_merchant_rates` itself. The stored `column_data`
   written before retirement still exists and `residual_risk_tiers.drawer_option`
   still exists to interpret it, so the check is reproducible — but it is
   archaeology rather than a live read.
7. **MID 201100169797's BIN row** — the cross-row conditional forces income to
   $0 while its stated net is +663.12. Irreconcilable as specified. (Same MID
   as the parked Orlando case.)
8. **Processor resolution for manual lines.** **Half closed.** The recommendation
   has been implemented: `compute_residual_period(p_period_id, p_processor)` takes
   the processor explicitly, as do `residual_grid_rows`, `residual_verdicts`,
   `residual_merchant_states` and the sign-off functions.

   **The underlying ambiguity stands.** `residual_lines` still has no `processor`
   column; it is carried by `residual_imports`, and manual lines have
   `import_id IS NULL` — so a manual line in a two-processor period cannot say
   which processor it belongs to. Harmless today (only MAVERICK exists) and a
   schema change the moment a second processor is added.

   A second, related normalization is also outstanding: `residual_imports.processor`
   is bare `text` with no CHECK. Measured 2026-09-23, imports carry `'Maverick'`
   while buy-rate schedules carry `'MAVERICK'`. Nothing joins them today, so
   nothing breaks; `residual_vendor_provider_key` (R5e) is the in-repo precedent
   for normalizing such a key.

---

## 9. The drawer's fate

`lead_gen_columns` carries 25 subtab-1 pricing fields (section
`Processor-TD Merchant Pricing`, seeded in R2). `residual_merchant_rates`
replaces them as the calc engine's input.

**Decided: retire them** (soft-delete), so there is one system of record. Two
systems of record is how they come to disagree, and here disagreement is a wrong
margin rather than a cosmetic drift. Drafted as a **separate migration**,
`20260828130000_retire_drawer_subtab1_r5d.sql`.

Measured before deciding:

- All 25 rows are `is_visible = false` — nothing renders them in the thread
  drawer today.
- **No file in the codebase references any of the 25 keys**, or the section
  string. The `section` mechanism itself is generic (R2) and used by other
  fields.
- Zero merchants have any of them populated — there is nothing to migrate and
  no dual-write window.

**What is lost:** the 25 rows disappear from the admin drawer-fields manager
(`app/(app)/admin/presets/drawer-fields/`), the only surface that still lists
them. Since they are invisible and unpopulated, that is a tidier list rather
than a lost capability. Re-adding a field there would not restore it as a calc
input in any case — the engine reads the typed table. The soft delete is
reversible: clearing `deleted_at` for the section restores every field with its
`type_config`, options and `display_order` intact, which matters because R2 pins
the Risk Level and Pricing Model option strings as calc join keys.

### The Pricing *tab* stays — checked, not assumed

The retire migration was to remove the `Pricing` drawer tab too **if nothing
else referenced it**. Something does, on two counts:

1. **The tab holds 26 live columns, not 25.** The 26th is `mid` (section NULL,
   `display_order` 1000), and it is load-bearing far beyond the pricing
   section: R3's merchant-uniqueness index is built directly on it, R5b's
   entire MID-to-record adjudication reads it, and `find_live_thread_by_mid()`
   queries it. Retiring the tab or the field would break merchant linking.
2. **The tab is a container for five sections, of which one is being retired.**
   R2's header states the boundary explicitly: only
   `Processor-TD Merchant Pricing` was seeded, with Vendor Pricing, One Time
   Charges, Other Vendor Payments and Equipment List deferred to the Tab-4
   phase. The tab was designed to outlive this section.

The migration therefore leaves the tab and `mid` alone, and encodes (1) as an
executable pre-flight check that **raises** if retiring the section would leave
the tab with no live fields — so that if `mid` is ever moved, the migration
stops rather than silently performing a different operation.

### Applied in R5d Part 3 — and the cost of having waited

The migration ran on 2026-09-09, after the entry path existed and had been used
to load 33 merchants. Its pre-flight reported what it was designed to report:

```
NOTICE: Pricing tab retains 1 live field(s) outside the retired section.
NOTICE: Retired 25 drawer field(s) from section 'Processor-TD Merchant Pricing' (R2 seeded 25).
```

After: the Pricing tab holds exactly `mid`; 25 rows soft-deleted; stored
`column_data` values untouched, because retiring a field definition is not the
same as deleting what anyone typed into it.

**The delay had a real cost, and it is worth recording rather than glossing.**
The prediction above — "all 25 rows are `is_visible = false`, nothing renders
them in the thread drawer today" — was **wrong**, and it was wrong in the way
that mattered. `is_visible` governs *grid columns*: `listDrawerLayoutAction`
(`app/(app)/lead-gen/actions.ts`) selects the flag but does **not** filter on
it, so every one of the 25 rendered in the drawer and accepted edits the whole
time. Somebody duly opened a merchant record, set **Risk Level** on the Pricing
tab, and nothing happened — because the engine resolves the tier from
`residual_merchant_rates.risk_tier` and has never read `column_data`. The
retirement was not a tidy-up; by then it was the fix for a live trap.

The lesson is narrow and checkable: **`is_visible = false` does not mean "not
rendered".** It means "not a grid column". Any future claim that a drawer field
is inert has to be made against the drawer's own query, not against the flag.

**Retirement also broke an R5c test, and the break was informative.** Case 14
pinned `residual_risk_tiers.drawer_option` against the **live** `risk_level`
options, on the stated grounds that a rename "would rewrite stored
`column_data` across every record and silently break the buy-rate join". Once
the field was retired the query found nothing and the test failed — which
exposed that its rationale had never been true of the shipped engine: the
buy-rate join goes through `residual_merchant_rates.risk_tier`, an **FK** to
`residual_risk_tiers.tier_key`. A constraint, not a test, and never
`column_data`.

`drawer_option` still has one job: interpreting the `column_data` values typed
before retirement and still stored on threads. So case 14 was repointed at the
**retired** definition — the thing those stored values were written against —
and now also asserts the field *is* retired, so un-retiring it fails the test
and says the live-rename hazard is back. Case 14b was added for the invariant
that actually decides whether a merchant is priceable: every `risk_tier` in use
must be a tier the standing buy-rate schedule prices.

### Ordering dependency

The retire migration **must not be applied** until
`20260828120000_residuals_calc_inputs_r5d.sql` is applied *and*
`residual_merchant_rates` is verified working. It removes the only other surface
through which this data can be entered; applied early, there is no way at all to
record a merchant's rates and the engine raises on every line. The two files
carry separate timestamps deliberately — Part 1 is additive and safe to apply on
its own schedule, while this one is a removal whose safety depends on a human
having checked something first.

### Which drawer fields became columns, and which did not

| Drawer field | On the new table? | Why |
|---|---|---|
| `risk_level` | ✅ as `risk_tier` FK | every buy-rate lookup |
| `vmd_auth_fee`, `pin_debit_auth_fee`, `avs_fee`, `batch_fee`, `vmd_transaction_fee` | ✅ | rules #1/#20, #5, #8, #3, #7/#13 |
| `amex_volume`, `vmd_volume`, `pin_debit_volume`, `amex_template_volume_fee` | ✅ | rules #7/#13, #12 |
| `gateway_monthly_mav`, `terminal_monthly_mav` | ✅ | rules #16, #14 |
| `gateway_provider_mav`, `terminal_provider_mav` | ✅ | annotate the amounts beside them; a name cannot be multiplied, so it carries none of the risk an unread *rate* would. Precedent: `residual_merchant_vendor_costs` |
| `monthly_fee_tapdash` | ✅ | rule #2 Additional Income |
| `monthly_fee` | ✅ as `monthly_fee_maverick` | **legacy.** Read by no live rule — that absence *is* the enforcement of §6.2. Retained only so a predecessor registry can reconcile pre-changeover months |
| `chargeback_fee` | ✅ | no rule yet, but its buy-side counterpart is seeded; makes a future rule an INSERT not a migration |
| `notes` | ✅ | operator context, every reference table has one |
| `pricing_model` | ❌ | descriptive (IC+/DP/FR), not a rate. Merchant attribute, not a calc input |
| `processor` | ❌ | an attribute of the **statement**, not the merchant — `residual_imports` already carries it. See gap 8 |
| `amex_auth_fee` | ❌ | no rule; #1 covers all auths via the VMD auth rate |
| `ebt_volume` | ❌ | no rule and no buy-side counterpart; the composite deliberately omits EBT volume. Including it would invite a wrong fifth term |
| `gateway_auth_fee_mav`, `terminal_auth_fee_mav` | ❌ | no rule, no counterpart. An unread **rate** is the dangerous kind to carry |
| `lease_payments_tapdash` | ❌ | "not income" by its own label; a cash-flow fact that must not be summable into income by accident |

---

## 10. Applying migrations — the `db push` trap

> **⚠ Do NOT run `supabase db push --include-all` while
> `20260828130000_retire_drawer_subtab1_r5d.sql` is pending.** It would apply
> it, and it must not be applied yet (§9).

That file is committed but deliberately unapplied. Because later migrations
*have* been applied, it now sorts **behind the remote head**, and the CLI
treats it as an out-of-order migration:

```
Found local migration files to be inserted before the last migration on
remote database.

Rerun the command with --include-all flag to apply these migrations:
supabase\migrations\20260828130000_retire_drawer_subtab1_r5d.sql
```

A plain `db push` then refuses to do anything at all — including applying the
migration you actually wanted. **Reaching for `--include-all` is the obvious
move and it is the wrong one**: it sweeps in the retire migration along with
your new one, silently removing the only surface through which merchant rates
can be entered.

**The procedure that works**, used for every push in this arc:

```bash
# 1. record the checksum so the restore is provable
sha256sum supabase/migrations/20260828130000_retire_drawer_subtab1_r5d.sql
#    -> c89974da939706b0868394fa11b80ef647f9989a2149a209b64525c10ab284ce

# 2. move it out of the migrations directory
mv supabase/migrations/20260828130000_retire_drawer_subtab1_r5d.sql "$SCRATCH/"

# 3. confirm the dry run now lists ONLY what you intend
npx supabase db push --dry-run

# 4. apply — plain push, no --include-all needed once the file is gone
npx supabase db push

# 5. move it back and re-verify the checksum matches step 1
mv "$SCRATCH/20260828130000_retire_drawer_subtab1_r5d.sql" supabase/migrations/
sha256sum supabase/migrations/20260828130000_retire_drawer_subtab1_r5d.sql
```

Then confirm it is still unapplied: `supabase migration list` shows it with an
**empty remote column** while everything around it has both.

**This became unnecessary in R5d Part 3**, when the retire migration was
legitimately applied — the entry path existed and had been used. At that point
`--include-all` is the correct flag rather than the dangerous one, but the
check still applies: **dry-run first and read what it lists.** The run that
applied it listed exactly one file and nothing else, which is the only evidence
that `--include-all` is safe on any given day.

### The MCP apply tool stamps its own timestamps

**If a migration is applied through the Supabase MCP `apply_migration` tool
rather than the CLI, it is recorded in `supabase_migrations.schema_migrations`
under a version derived from the current clock, not from the repo filename.**

This has now happened twice. It is invisible on the machine that did it —
everything works, the objects are there — and it surfaces later, somewhere
else: a fresh checkout runs `supabase db push`, the CLI compares repo filenames
against recorded versions, finds the repo files "missing" from the remote and
sorting *behind* the head that the clock-stamped rows created, and refuses,
demanding `--include-all`. Which lands you back in the trap above, now with
duplicate applications on the table.

It also splits: one repo file applied as two tool calls is recorded as **two**
rows with two different clock versions, when the repo has one file.

**Reconcile immediately, in the same session**, which is what
`supabase migration repair` writes:

```sql
-- rename the clock-stamped row to the repo filename's version
update supabase_migrations.schema_migrations
   set version = '20260901120000', name = 'residuals_calc_failure_rate_ref_r5d3'
 where version = '20260910002939';

-- and drop the extra row where one file was applied as several calls
delete from supabase_migrations.schema_migrations where version = '20260910003038';
```

Then prove it: `npx supabase db push --dry-run` must list only what is genuinely
pending. If it lists a migration you know is already applied, the bookkeeping is
still wrong.

**Prefer the CLI.** The MCP tool is the fallback for when the CLI is
unavailable, and using it incurs this reconciliation as a mandatory follow-up
step, not an optional tidy-up.

### A failed `sqlScript` used to poison the connection pool

`sqlScript` runs migration replays wrapped in `begin; … rollback;`. When a
statement inside one raised, the closing ROLLBACK never ran and the client was
released back to the pool still inside a failed transaction. Every later test
that drew that client died with *"current transaction is aborted, commands
ignored until end of transaction block"* — an error about nothing, attached to a
test that was fine.

Observed during R5d Part 3: **one** genuine failure produced **four**, three of
them meaningless, and the real one was the least visible of the four. `sqlScript`
now rolls back before releasing. ROLLBACK outside a transaction is a harmless
no-op, so it is unconditional rather than guessing at the state.

### A recompute run through the MCP connection carries a BORROWED actor

**`updated_by_id` on `residual_lines` may not name the person who caused the
change.** This has happened once, on 197 real lines.

`compute_residual_period` is `SECURITY DEFINER` and gates on
`auth_role() in ('admin','super_admin')`. Over the Supabase MCP connection the
session is `postgres` with `auth.uid()` NULL, so `auth_role()` is NULL and the
gate **fails closed** — correctly; that is the whole point of writing it as
`is null or not in`. The only way to run the engine from there is to borrow an
identity:

```sql
select set_config('request.jwt.claims',
                  json_build_object('sub','<a real user id>')::text, true);
select public.compute_residual_period('<period>'::uuid, 'MAVERICK');
```

The engine then reads `auth.uid()` from that claim and stamps it into
`updated_by_id` on every line it writes, and into `created_by_id` on every
`residual_calc_failures` row. **The audit trail records a person who did not
press anything.**

It happened on 2026-09-09: the May 2026 period was recomputed this way to
populate `rate_ref`, borrowing `izzy@tapdash.co`. The run was value-identical
(zero lines and zero groups changed any figure), so nothing about the *numbers*
is in question — but every one of those 197 rows now carries an `updated_by_id`
that means "authorised by", not "performed by".

**Two consequences worth holding onto:**

- Anyone auditing `updated_by_id` on `residual_lines` around that timestamp
  should not read it as a user action. The Compute button, added in the same
  phase, is the path that produces an honest actor — it runs as the signed-in
  user because the request genuinely carries their JWT.
- Do not reach for the claim-borrowing trick as a convenience. It is the
  fallback for when there is no other way to exercise a gated function, and
  each use puts a name on a change that person did not make. Prefer the UI, or
  the integration harness, which signs in a real ephemeral user of its own.

### May's lines are attributed to a REVOKED throwaway account

**A second, separate attribution caveat on the same 197 rows.** The one above is
about a *borrowed* identity; this one is about a *disposable* one.

On **2026-09-11** May 2026 was recomputed twice by short-lived super_admin
accounts created by a verification script — `r6a-verify-1789086589281@tapdash.co`
and `r6a-verify-1789086620578@tapdash.co`. The second is the `updated_by_id` on
**all 197 live `residual_lines`**, the `created_by_id` on **55
`residual_calc_failures`**, and the `updated_by_id` on the **May period** and its
**one line group**; both are `ran_by_id` on the **two `residual_calc_runs` rows**.
The figures those runs produced are the current state of record — 63 computed
lines, 12 merchants attempted, neither run stamped.

**Those accounts no longer function, and were deliberately NOT deleted.** On
2026-09-16 both were revoked in place: `auth.users.banned_until` set to 9999,
sessions and refresh tokens dropped, `profiles` role demoted to `marketer` with
`deleted_at` and `deactivated_at` set — so `auth_role()` returns NULL and every
RLS policy and `requireSuperAdmin()` check fails closed. The `auth.users` rows
survive on purpose.

**Why they were not deleted, which is the part worth keeping.** Every residual
audit column is a `NO ACTION` FK to `auth.users`, so a hard delete raises
`23503` unless the pointers are nulled first — and nulling them would make 197
rows say *nobody* ran that compute. The rows that record what the account did are
precisely what prevents erasing it. Rewriting `updated_by_id` to name a more
convenient person would be worse still: an audit trail that is merely awkward is
healthier than one that is tidy and false. So the pointer stays, and it resolves
to a real, permanently disabled identity rather than dangling.

**What a reader of provenance on May's lines should conclude:** the actor is
genuine and the work is genuine, but the identity was created for one run and
retired. It names a script, not a person, and it can never act again. See also
the two `r6a-verdicts-*` fixtures from the same day, which had no residual
references and were therefore hard-deleted outright — the difference between the
two pairs is entirely whether an audit row pointed at them.

**The recurrence is fixed at the source.** `purgeStaleTestUsers` in
`lib/test/db.ts` is now called first in every integration suite's `beforeAll`,
and fixture accounts are pinned to the reserved domains `@tapdash.test` /
`@test.local` — two suites had been minting them on the live `@tapdash.co`,
which is why the leftovers were indistinguishable from staff accounts in the
users table. The header comment on `vitest.integration.config.ts` records why
these suites must never be aimed at a project holding real data.

## 11. Rate entry — the importer and the panel

`residual_merchant_rates_for_month()` raises for any MID with no rates, so
nothing computes until rates exist. Two ways in, both under
`/admin/residuals/rates`.

### The importer

Reads the workbook's "Drawer tab Processor-TD Merchan" sheet **as `.xlsx`,
never CSV** (§6.5). Upload → preview → commit, with the preview being an
*exact* dry run: `residual_preview_merchant_rates_import` calls the real
commit inside a subtransaction and discards the writes, so the new /
unchanged / superseded counts it shows cannot disagree with what committing
does. That is deliberate — a preview that can diverge is a wrong number shown
at the moment the operator decides to trust the import.

The column map is **pinned by position in code**, not by header text, because
the sheet gives *two* columns the header "Monthly Fee": column O (the
processor-side fee → `monthly_fee_maverick`) and column AA (the fee TapDash
bills directly → `monthly_fee_tapdash`). Those are different fees at different
stages, and a header-keyed map would silently collapse them. Every mapped
column's header is verified anyway — including the six deliberately not
imported, since a wrong header there means the sheet has shifted under the
ones that are — and a mismatch fails naming the column letter, what was found
and what was expected.

**The three-state panel is the first thing in the preview, not a footnote.**
It shows, per column, how many cells are real numbers, how many are `"$ -"`
read as `0.000000`, and how many are blank read as "no arrangement". That
inference (§6.6) is where a wrong number would enter the system silently, and
the operator confirming it is the only check on it.

### The panel

Coverage comes from `residual_merchant_rate_coverage()` — one query, not a
second view of the same question. A row opens that merchant's full version
history, newest first, each marked `standing` and/or `locked`.

**A locked version renders read-only with its reason, and the successor form
stays available beside it.** Closing a locked version is legal — it is how a
used merchant is repriced — while editing its values is not, and the
difference is visible rather than discoverable by hitting a `42501`.

### The rate editor — the unit is a merchant, not a column

R5d 1c shipped a **compact editor**: `monthly_fee_tapdash` for every covered
merchant at once, a flat grid of inputs saving on blur. That was right for that
moment — the field was **0-of-33**, it is rule #2's only term, and it was the
single thing standing between the module and a number.

**R5d Part 3 replaced it, and the reason is in the May run.** The engine failed
on *six* different merchant rate columns — `monthly_fee_tapdash`,
`monthly_fee_maverick`, `vmd_auth_fee`, `batch_fee`, `avs_fee` and
`gateway_monthly_mav` — and it failed on them merchant by merchant. A screen
organised by column now means visiting six screens to finish one merchant, and
never being able to see whether a merchant is *done*. So the unit is a
merchant's whole rate card: fourteen rates, two provider names, and the risk
tier, one merchant at a time.

**Every field on the row is rendered, including the two provider names.**
`residual_update_merchant_rate_row` saves the whole row and an absent key means
SQL NULL, so a form that quietly omitted `gateway_provider_mav` would erase it
every time somebody corrected a fee.

It still edits the standing version **in place** rather than creating
successors, and the R5d 1c argument is unchanged: filling in a value the sheet
simply lacked, for a merchant whose version has never produced a number, is a
correction rather than a repricing. The moment a version *has* been used,
`tg_residual_merchant_rates_guard_locked` rejects the write and the UI points
at the successor form — enforced by the database, not by the component
remembering.

### The three states, made legible — the fix the browser pass found

The reported symptom was "blank fields show only *empty = no arrangement*, with
no way to enter an explicit 0". **The capability was never missing.** Typing `0`
always sent the number 0, the RPC always cast it to `0.000000`, and reading it
back always rendered `0`. The round trip was correct.

**What was missing was any way to know that**, and that is a real defect rather
than a misunderstanding. A blank box carried the placeholder
*"empty = no arrangement"* and nothing else, so an empty field read as "nobody
has filled this in yet" — the universal meaning of an empty form field — rather
than as a recorded claim about money. Nothing anywhere said that typing `0`
meant something different from leaving it blank.

The distinction is **live on real data**, not theoretical: across the loaded
merchants `avs_fee` is 13 explicit zeros and 11 NULLs, `batch_fee` is 10 and 10.
An operator who believed the two were the same could clear a legitimate zero and
turn a computed line into a failure, or leave a field blank meaning "we don't
charge for this" and never understand why the line kept failing.

**The interaction, argued.** The candidates were a tri-state control
(value / zero / not set), a per-field "record zero" button, and simply making
the states legible. A tri-state control is heavier than the problem *and worse
at the job*: typing is already the fastest way to enter a number and `0` is a
number, so a separate zero mode would make the common case and the zero case
behave differently for no reason, across sixteen fields. A per-field button is
the same cost for one value.

So: **no new control.** The input keeps accepting a plain `0`, and instead each
field always *says* which of the three states it is in, updating as you type —
`0` reads "Recorded zero — this rate is 0.00 and the line computes", empty reads
"No arrangement recorded — the calculation stops on this field", in the module's
attention amber because it is the state that halts a calculation.

**The placeholder prose was removed rather than reworded.** A placeholder
disappears the moment you type, so it can only ever describe the state you
*left*, never the one you are in. A state line that is always present can.

`rateState()` and `rateToInput()` are pure and unit-tested in both directions,
because what the box renders for a stored value and what the label calls it must
agree — otherwise a field describes itself as one thing and saves another.

The same collapse was checked everywhere a rate is displayed: the successor form
had the identical placeholder and now shares the same helpers (so carrying a
rate card forward cannot silently turn a recorded zero into "no arrangement");
the version history already rendered `not set` in amber versus `0`, and gained
tooltips saying what each means; the buy-rate grid already rendered `—` versus
`0.000000`.

### Per-field failure marks come from `rate_ref`, not from the registry

Each field carries whether **the last run actually stopped on it**, read from
`residual_calc_failures.rate_ref` — a column `20260901120000` added so this
screen would not have to guess.

The alternative was to ask the registry which merchant rates a failed line's
rule reads. That needs no engine change and is **wrong**: a rule can have
several merchant terms — "Monthly Fee" has both `monthly_fee_tapdash` and
`monthly_fee_maverick` — while the engine records the **first** failure per
line only. The registry join would light up both fields on a line that stopped
on one, telling the operator to fill in something that is blocking nothing.
Recorded fact and registry inference differ *precisely because* of
first-failure-wins.

`rate_ref` is NULL for every failure that is not about a rate (`no_volumes`,
`missing_line_input`, `unknown_fee_item`, `unusable_mid`, `no_merchant_rates`),
and that NULL is meaningful: it is what stops the editor marking a field over a
failure that had nothing to do with any field. Both halves are asserted —
tests 9b and 9c.

The reason and the rate reference are taken from the **same side** of the rule.
`coalesce(v_inc_r, v_buy_r, v_add_r)` picks the reason from the first side that
failed; a `coalesce` over the refs would not agree with it, because most
failures leave the ref NULL — a line whose income side failed on `no_volumes`
and whose buy_rate side failed on a missing template rate would get reason
`no_volumes` from income and a ref from buy_rate, a row claiming a volume
failure on a named rate. A `case` on which side failed keeps the row internally
consistent, or leaves the ref NULL.

**A merchant-scope failure is shown separately from the per-field ones**,
because it is a different claim: not "this field is missing" but "this merchant
has no rate row for the month, so nothing on this form is being read". Without
the distinction an operator fills in fourteen fields on a version the period
cannot see.

### The buy-rate template screen

`/admin/residuals/buy-rates`. The grid renders as the **workbook's** grid — fee
items down, the four risk tiers across — because the operator's source of truth
is a printed sheet in exactly that shape and every check they will do is "find
the row, run across to the tier".

**`tapdash_share` is a separate row, above the grid and visibly apart.** The
workbook prints it in the same block as the fee-item rates; R5c deliberately
did not store it that way. The share lives on `residual_buy_rate_tiers`, one
value per tier; the rates live on `residual_buy_rates`, one per (tier, fee
item). They are different things — a fee-item rate is subtracted from income
for one line, the share multiplies the whole net after every line is summed.
Rendering the share as another row of the grid would re-merge in the UI exactly
what the schema separated, and by then it is only pixels, so nothing can catch
it.

**An absent cell is not zero.** The supplied Maverick grid is genuinely ragged
— `low` carries 12 rates, the other three carry 11 — and the engine reports
`missing_template_rate` when a rule reads a missing one. A blank renders as a
muted em-dash with its own legend, never as `0.000000`.

**The three reasons the share is kept apart are now on the screen**, not only in
a migration comment — the question was asked directly, and this is the kind of
answer that has to travel with the number. It is not a per-item rate; it applies
to the net *after* the subtraction rather than being taken off the top; and it
moves the *opposite* way to every rate below it (0.9 / 0.9 / 0.8 / 0.7 falling
as risk and every buy rate rise). A reader who summed the tier column with the
share included would be adding a share to a cost, and the total would look
entirely plausible.

#### Rows the month does not price are moved out of the grid, never deleted

"Monthly Fee (combined with Online Access)" showed one populated cell of four,
because it belongs to the **predecessor** registry only — after the June
changeover no rule reads it, so it rendered as missing data rather than as
superseded data.

**It must not be deleted.** Three merchants (Julianas, Monte Carlo, House of
Tacos) carry no Online Access line and resolve their pre-June Monthly Fee buy
rate through exactly that item; deleting it makes every pre-June month report
`missing_template_rate` for them. So this is a display question, answered by
`residual_template_rate_refs(processor, month)` rather than by a hardcoded key:
set the month picker back to May and the row returns on its own, and a future
item that goes the same way drops out without anyone maintaining a list.

A buy rate is only ever read through a `residual_formula_terms` row with
`rate_source = 'template'`, so the registry in force for the month is the whole
answer.

**The rule removes more than the one row that prompted it**, and the hidden ones
are labelled with *why* rather than merged into one bucket:

| Fee item | Reason it leaves a 2026-09 grid |
|---|---|
| `monthly_fee`, `monthly_fee_combined` | **superseded** — the predecessor registry reads them, this month's does not |
| `pci_fee`, `website_monitoring_fee`, `irs_annual_fee` | **billed directly to the merchant** — permanent, since the terms validation trigger forbids a term referencing one |
| `chargeback` | **no rule in any registry reads it** — four real rates loaded and nothing resolving them |

That last row is why the hidden set is a collapsed disclosure under the grid
rather than silently dropped. A rate that exists and is invisible is how a
template quietly rots, and `chargeback` is a genuine gap worth somebody seeing
— not history.

Which schedule is in force comes from `residual_buy_rates_for_month` — **the
function the engine calls** — so the screen and the calculation cannot disagree
about the one thing this screen exists to answer.
`residual_buy_rate_coverage` is surfaced beside it: a statement month with no
schedule cannot be calculated at all, and the raise is fatal for the whole run
rather than per merchant.

#### An EMPTY period must not lock the template — a bug, found by real data

`residual_buy_rate_schedule_is_locked` shipped in `20260901130000` with no line
filter, and the header argued why: *"every computed line in a period reads the
schedule, so a computed period in range locks it outright."*

Every computed line does read the schedule. The unexamined step is the one that
broke: **a period can be computed and have no lines at all.** The 2026-07 period
holds a PDF import and no fee lines. Pressing Compute on it ran the engine over
an empty set, recorded zero failures, and therefore — correctly, by the engine's
own rule that version and `ready` and the lock engage together — stamped
`ready` and `calculation_version = 1`. A period with nothing in it is trivially
complete.

That vacuous run locked the **entire Maverick template** against in-place edits,
on behalf of zero lines reading zero rates. It surfaced weeks later as a
seed-idempotency test failing, which is a poor way to find out about a lock.

`20260902130000` restores the half of the merchant-rate predicate that
generalises. `residual_merchant_rate_is_locked` filters on the period carrying
lines *for that MID*, and its header states the principle: "a merchant boarded
but never billed has nothing depending on its rates". The **MID** half is
genuinely specific to merchant rates — every line reads the shared schedule, so
which merchant is irrelevant. The **existence** half is not specific at all, and
dropping it was the error: a period billed for nobody depends on the template
either way.

"Has lines" rather than "has computed lines", because `calculation_version` is
only stamped on a fully clean run — so a still-standing period with at least one
line is one where every line computed from this schedule.

Worth noting and not acting on: a period with no lines reaching `ready` with a
`calculation_version` is a vacuous truth the engine currently asserts. It is
harmless now that it cannot lock anything, but "these outputs are current and
complete" over zero outputs is a claim worth revisiting when R6 starts reading
that column.

**No in-place edit is offered, for locked or unlocked schedules alike.** This
is a deliberate asymmetry with merchant rates. A merchant rate edited in place
rewrites one merchant's basis; a schedule edited in place rewrites *every*
merchant's, because it is the shared half of every line in the period. "Nothing
depends on it yet" is a far weaker claim here, and the operator cannot see at
the moment of editing that it is still true. The merchant-rate table earns its
in-place edit because R5d 1c could name the exact population it applied to;
nothing comparable is true of the template.
`residual_supersede_buy_rate_schedule` is the only write path, and it is one
call because the EXCLUDE constraint forces close-before-insert and the
composite FK forces tiers-before-cells.

### The Compute button — closing the loop the editor opens

`computePeriodAction` → `gateAdmin()` → one call to `compute_residual_period`.

**The processor is derived, never defaulted.** `compute_residual_period` takes
`p_processor` with no default on purpose (§ the engine), so the caller must
say, and the honest source is the period's own imports. It is **case-folded**
because the two sides genuinely disagree: `residual_imports.processor` holds
`'Maverick'` as typed, while `residual_buy_rate_schedules.processor` is CHECKed
upper-case and holds `'MAVERICK'`.

**Exactly one distinct value is required.** Zero means nothing has been imported
for the period, so there is no evidence whose rate card applies. Many means the
period carries two processors' lines, which `residual_lines` cannot express —
it has no processor column, the engine's stated limitation — so computing would
price one processor's lines with the other's registry. Both are errors the
operator resolves; neither is guessed at.

**A reconciled period is refused before it is offered.** The Part 1 write guard
and the engine's own status check both block it, but the button is disabled
with the reason visible rather than accepting a click and surfacing a `42501`.
The guard remains the thing that cannot be bypassed; the disabled button is the
thing that does not waste the operator's time.

#### Why it lives on the rates screen

Argued rather than defaulted. A run writes the six engine-owned columns on
every line in the period — the most consequential write in the module — and
consequential writes usually belong where the period is managed.

It goes on the rates screen because of what the run *produces*:
`residual_calc_failures`, which is that screen's work queue and is what the
editor reads to mark a field as blocking. Elsewhere, the loop is run → read
failures → navigate → fix → navigate back → run. Here it is one screen: fix the
field the last run stopped on, press Compute, watch the mark clear. The marks
are stale between runs and the thing that un-stales them belongs beside them.
It is also the only place the period is already chosen — a button elsewhere
would need a second period selector, which is a second chance to compute the
wrong month.

**There is deliberately one door.** The module index links to the screen rather
than carrying its own Compute button. Two buttons in two places that both write
real money is the same shape of problem the retired Risk Level field turned out
to be: a surface that looks like the answer and is not.

The summary and a **bounded** failure list render through
`BoundedProblemList`, extracted in Part 3 from `ImportErrorPanel` so the
browser-verified `max-h-[40vh]` bound exists once rather than in two copies that
can drift. Its tone is a prop and defaults to destructive for imports: a
rejected import *is* an error, nothing was written and the file must be fixed,
while a run that recorded failures is the ordinary state of a period whose rates
are still being entered — a work list, in the module's amber.

### From a merchant record to its rates — one link

The drawer's Pricing tab gets a single link, `Rates for MID <mid>`, landing on
`/admin/residuals/rates?mid=…` with the editor already open on that merchant.

Three options were considered: this link, a coverage list on the merchant side
resolving names through R5b's thread link, and a "no rates yet" affordance.
**The link is the only one that addresses what actually went wrong.** Somebody
stood on a merchant record, wanted to set its risk level, found a "Risk Level"
field on the Pricing tab, set it — and nothing happened, because the engine
reads `residual_merchant_rates.risk_tier` and has never read `column_data`. The
failure was not that the rates were hard to *find*; it was that the merchant
record offered a field that looked like the answer. Retiring the 25 fields
removes the wrong door; the link adds the right one, where they were already
standing.

The coverage list would be a second surface answering a question the rates page
already answers, and would need R5b's link resolved for names. The "no rates
yet" affordance is this link plus a query to choose between two labels — the
link works whether or not rates exist, and the rates page says which far better
than a badge could.

The link is keyed on the presence of a **`mid` field on the active tab**, not
on the tab being named "Pricing": the tab is admin-renameable, while the field
key is pinned by R3's uniqueness index and by R5b's `find_live_thread_by_mid`.

### Load of record

The 33-merchant sheet was imported on the test project at
`effective_from = 2026-05-01` — the earliest statement month held, chosen over
`2000-01-01` so the rates claim nothing about months for which no data exists.
Result: **33 inserted, 0 unchanged, 0 closed**, and for May 2026
**12 covered / 9 uncovered / 21 idle**.

## 12. Module tabs

1. **Merchant dashboard** — not built
2. **Processor monthly reconciliation grid** — purpose-built typed financial
   tables, deliberately outside the EAV/drawer system. **Built in R6b**, at
   `/admin/residuals/reconcile`.

   Three decisions of record from that slice:

   - **The synopsis SUPPRESSES money on a partially-computed month rather than
     labelling it partial.** The mirror rules book costs and compute fine; the
     volume-driven income rules (#7, #13) fail for want of a statement, so a
     partial sum has the wrong SIGN, not merely the wrong magnitude. Measured on
     2026-05 the partial figure is **−$7,086.67**. A "partial" label is read as
     two true things — a loss, and some missing rows — and the first is false.
     The denominators always render; the money does not, until
     `calculation_version` stands.
   - **The "Note" column renders the ACKNOWLEDGMENT REASON, not a free-text
     note.** There is no notes column on `residual_lines` and R6b did not add
     one: the ack reason is already per-row, per-step, attributed and mandatory,
     and a second unattributed place to write down why a row is odd would win
     simply by being easier. A free-form note remains a **one-column
     migration** if it is ever wanted, and this column is where it would render.
   - **Volumes render on the merchant header, once, not on every line.** They
     live at `(period, mid)`; painting one fact down thirteen rows invites the
     by-hand version of the error `residual_merchant_volumes` was split out to
     prevent. Mapped rows carry a bucket CHIP naming what their Amount is
     compared against.
   - **`residual_calc_runs.merchants_computed` and the synopsis's
     `merchants_computed` ARE DIFFERENT NUMBERS AND BOTH ARE CORRECT.** On May
     2026 the run reports **12** and the synopsis reports **11 of 21**. They
     answer different questions:

     | | Question it answers | May 2026 |
     |---|---|---|
     | `residual_calc_runs.merchants_computed` | how many merchants were **not skipped whole** — the engine got past the merchant-level gate and attempted lines | 12 |
     | `residual_synopsis.merchants_computed` | how many MIDs have **at least one line with a summable `net_income`** | 11 |

     The gap is **MID `201100216416`**, whose single line failed at
     `scope = 'line'` with `missing_merchant_rate`. The engine attempted it, so
     it counts as computed; it produced no `net_income`, so it contributes
     nothing the synopsis could sum. The other nine uncovered merchants failed
     at `scope = 'merchant'` with `no_merchant_rates` — skipped whole, and
     counted as failed by both. 9 failed + 12 attempted = 21.

     **Recorded because it has now been rediscovered twice** and read as a
     defect both times. It is not one. The check that settles it in one query is
     whether the 12th merchant has any line with a non-NULL `net_income` — it
     does not, and if it ever does, the two numbers should agree and something
     really is wrong. Do not "fix" either count to match the other; a reader who
     wants "merchants that produced money" wants the synopsis, and a reader
     debugging why the engine skipped someone wants the run.
3. **Template buy rates** — **built in R5d Part 3**, at
   `/admin/residuals/buy-rates`, reached from the module index. It is an *admin*
   surface rather than a module tab: the grid is reference data an admin
   maintains, and every residuals table gates writes on
   `auth_role() in ('admin','super_admin')`. If the module ever grows a tab
   strip for operators, this page is what tab 3 links to rather than something
   to build again.
4. **Vendor payouts** — not built

---

## 13. Phase history

| Phase | Content |
|---|---|
| R1a | SheetJS migration to self-hosted `xlsx@0.20.3` |
| R1b | Schema foundation: periods, lines, volumes, imports, storage bucket |
| R2 | Pricing drawer: `section` column, 26 seeded fields, money precision |
| R3 | MID uniqueness: digits-only normalization at every write path |
| R4a | Excel fee-report import: `commit_residual_excel_import` |
| R4b | PDF statement parser: plan-code rollup to four volume buckets |
| R5a | Plan volumes + `residual_plan_code_buckets` |
| R5b | Merchant link: five-value verdict vocabulary, derived staleness |
| R5c | Reference data: risk tiers, fee items, buy rates, vendor costs, partners |
| **R5d pt 1** | **Merchant rate table, formula registry, sixth column, recompute safety** |
| R5d pt 1b | Retire the 25 drawer subtab-1 fields (separate migration; applies only after pt 1 is verified) |
| R5d pt 2 | The engine |
| **R5d pt 3** | **The admin surface: per-merchant rate editor, buy-rate template screen, `rate_ref` on failures, merchant-record link, drawer retirement** |
| R6 | Reconciliation / synopsis, partner payouts |
