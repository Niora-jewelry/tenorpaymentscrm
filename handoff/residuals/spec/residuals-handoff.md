# Residuals — handoff

**Purpose.** Enough to finish the module, integrate it, and know what was left
undone on purpose. Written for someone competent who was not here.

**Branch** `residuals`, at `8014826` (R6b-2) plus the cleanup commit that
follows it. **Target project `pcrthafqoxjiucujogae` only** — the test project.
Production is `wvbbyxmexsbolzhmuxcw` and nothing in this module has been applied
there.

**Companion documents.** [`residuals.md`](./residuals.md) is the product spec and
the in-repo form of the calculation registry — it carries the twenty rules, the
decisions of record and the known gaps, and it is the authority where this file
and it disagree. [`r5f-chargeback-rule-pending.md`](./r5f-chargeback-rule-pending.md)
carries the one unseeded rule. This file carries what neither does: the shape of
the whole thing, how to run it, and what an inheritor will trip over.

**Every number below was measured against `pcrthafqoxjiucujogae` on
2026-09-23** and is labelled as-of. Re-measure before trusting any of them; the
queries are given so you can. Where a fact lives only in a migration header, the
header is quoted and the file named. Where something is true but I could not
find it written down anywhere in the repo, it says so explicitly rather than
asserting it.

---

## 1. What the module is

Residuals reconciles a payment processor's monthly fee report against what
TapDash believes it should have earned, and computes what TapDash banks.

### The four planned tabs

| # | Tab | State |
|---|---|---|
| 1 | Merchant dashboard | **not built** |
| 2 | Processor monthly reconciliation grid | **built (R6b)** — `/admin/residuals/reconcile` |
| 3 | Template buy rates | **built (R5d pt 3)** — `/admin/residuals/buy-rates`, as an admin surface rather than a tab |
| 4 | Vendor payouts | **never started** — see §7 |

Two further screens exist that are not tabs in the original plan: merchant rates
(`/admin/residuals/rates`) and merchant vendor costs
(`/admin/residuals/vendor-costs`).

### The chain

Six values per line, in order. This is the whole module in one place.

```
1. Total Income              merchant-facing rate x count or volume
2. Total Buy Rate            processor's template rate at the merchant's
                             risk tier x count or volume
3. pre-split net             = Total Income - Total Buy Rate
                             <-- RECONCILES against the processor's stated
                                 net_revenue for that line
4. TapDash Net after split   = pre-split net x tapdash_share(tier)
5. Additional Income Direct  a fee TapDash bills the merchant itself
6. Net Income                = TapDash Net after split + Additional Income
```

Value 3 is the reconciliation target. Value 6 is what TapDash keeps.
**Additional Income sits outside the split deliberately** — the processor is not
party to a fee TapDash bills the merchant directly, so it is added after the
multiplication, never inside it.

The share is `tapdash_share` from `residual_risk_tiers`: `no_program` 0.90,
`low` 0.90, `medium` 0.80, `high` 0.70. It applies **per line, rounded to 2dp
per line**. A merchant's month is `SUM(residual_lines) + SUM(residual_line_groups)`
— **both terms**, or any merchant with a grouped rule is silently under-reported.

Per-line and per-merchant rounding are not interchangeable: measured on the May
2026 sample they differ by a penny on 3 of 12 merchants (`residuals.md` §1).

### The sign convention

> **Total Income − Total Buy Rate ≡ Net Revenue**, where Total Income is money
> in and Total Buy Rate is a cost carried as a **positive** number.

Verified across all 197 rows of the May sample. Two consequences that look like
bugs and are not:

- **The mirror rules (#9, #10, #11, #17) are implemented as `−net_revenue`, not
  `net_revenue`.** The source workbook says "Buy Rate = Net Revenue", and taken
  literally that inverts the sign of a cost: `0 − (−375.32) = +375.32`. Storing
  the negation makes the identity hold on all 40 mirror rows. The correction
  lives in *data* — `residual_formula_terms.term_sign = -1` — visible to anyone
  reading the registry, rather than in a branch of the engine.
- **There is no `CHECK (total_buy_rate >= 0)` and there must not be.** Two
  Interchange rows in the sample have *positive* net revenue, which under the
  mirror rule yields a legitimately negative buy rate — a rebate. The signed
  identity is the invariant; non-negativity is merely the usual case.

### The registry

Twenty rules stored as **data** (`residual_formula_rules` +
`residual_formula_terms`) inside a dated `residual_formula_registries` row, not
as code. A side's value is `Σ (term_sign × operand × rate)`. **A side with no
terms is $0.00** — that one rule removes an entire opcode, because the workbook's
"Always $0" (19 of 20 Additional Income cells) needs no representation when
absence already means it.

Matching is on **exact** `fee_item_name` and nothing else. There is deliberately
no category fallback: a category maps to many rules, so there is no single answer
to fall back *to*. The name set measured closed — 20 names, 20 rules, exact
correspondence both ways — so an unrecognised name is news, and **an unmatched
fee item name raises**.

---

## 2. The phases

Forty-one migration files carry this module. Read in order they explain why the
schema looks the way it does.

**R1a — SheetJS.** Migration off the abandoned `xlsx` npm package to a
self-hosted `xlsx@0.20.3`. No migration file; it is a dependency change that
every later spreadsheet path depends on.

**R1b — schema foundation.** `20260820120000_residuals_foundation_r1b.sql`.
`residual_periods`, `residual_lines`, `residual_merchant_volumes`,
`residual_imports`, and the storage bucket. Establishes the conventions the rest
inherits: `numeric(14,2)` money, soft delete everywhere, audit columns, and NULL
on a derived column meaning "not computed".

**R2 — pricing drawer.** `20260821120000_residuals_pricing_drawer_r2.sql`. Adds
a `section` column to `lead_gen_columns` and seeds 26 fields on a Pricing tab —
25 pricing fields plus `mid`. This is the EAV approach that R5d later abandons
for a typed table; the 25 are retired in R5d pt 1b and the `mid` field survives
as load-bearing (§7).

**R3 — MID uniqueness.** `20260822120000_residuals_mid_unique_r3.sql`.
Digits-only normalization at every write path, with a uniqueness index built on
the drawer's `mid` field. Every later MID comparison in the module is pinned
character-for-character to this normalization.

**R4a — Excel fee-report import.** `20260823120000_residuals_excel_import_r4a.sql`.
`commit_residual_excel_import`, which supersedes prior lines for a period and
inserts fresh ones. Its supersede sweep is the source of the recompute-safety
hole that R5d closes (§3, *guards attach to the fact*).

**R4b — PDF statement parser.** `20260824120000_residuals_pdf_import_r4b.sql`.
Parses processor statements and rolls plan codes up to four volume buckets
(amex / vmd / debit / ebt). A fifth bucket, `paypal_volume`, was built during
development and removed.

**R5a — plan volumes.** `20260825120000_residuals_plan_volumes_r5a.sql`. Moves
the plan-code map out of TypeScript into `residual_plan_code_buckets` (16 codes,
as-of 2026-09-23) so SQL can `GROUP BY` it and an admin can resolve an unmapped
code without a deploy. Volume buckets are NULL rather than partial when the
statement does not reconcile — the first statement of the absence-means-absent
rule.

**R5b — merchant link.** `20260826120000_residuals_merchant_link_r5b.sql`. The
largest single migration. Adds four link columns to three tables, the
`residual_resolve_mid` decision function, the `residual_reconcile_mid_links`
re-adjudication engine, a relink trigger on `lead_gen_threads`, and six
admin-facing link functions. Its header states the verdict vocabulary:

> ```
> --   exact      digits-only equality against a live merchant record.
> --   suffix     no exact candidate; exactly one live record's MID ENDS WITH
> --              this one. Lower confidence by construction.
> --   manual     a human picked the record.
> --   ambiguous  2+ candidates. thread_id stays NULL — never guessed.
> --   unmatched  no candidate.
> --   NULL       never adjudicated.
> ```

and why that vocabulary is a CHECK rather than a lookup table:

> ```
> --      An admin adding a sixth resolution status would mean nothing: no code
> --      branches on it, and the five values are determined by the ALGORITHM,
> --      not by data. A vocabulary that can only change when the code changes
> --      belongs where the code is.
> ```

**R5c — reference data.** `20260827120000_residuals_reference_data_r5c.sql`.
`residual_risk_tiers`, `residual_fee_items`, `residual_buy_rate_schedules` /
`_tiers` / `residual_buy_rates`, `residual_merchant_vendor_costs`,
`residual_partners`. Introduces the effective-dating idiom (§3) and the fail-loud
lookup. **`residual_merchant_vendor_costs` is created here and read by nothing,
then and now** (§7).

**R5d pt 1 — calc inputs.** `20260828120000_residuals_calc_inputs_r5d.sql`.
`residual_merchant_rates` (the sell side), the formula registry tables, the sixth
engine column `tapdash_net_before_split`, and recompute safety. Its header fixes
the key namespace for the whole module:

> ```
> -- MID IS THE STATEMENT MID, normalized digits-only per R3 — NOT the mutable
> -- record MID that R5b adjudicates. Same argument as R5c section 6: an
> -- immutable key cannot orphan when a merchant record changes, and the join
> -- from residual_lines is a plain equality on one side only.
> ```

**R5d pt 1b — retire the drawer fields.**
`20260828130000_retire_drawer_subtab1_r5d.sql`. Soft-deletes the 25 subtab-1
pricing fields so there is one system of record. Deliberately a separate file
with its own timestamp, because it is a *removal* whose safety depends on a human
having verified the replacement first. It sat unapplied for eleven days and was
applied 2026-09-09; §8 carries the `db push` trap that created.

**R5d pt 1c — rate entry.** Six migrations, `20260829120000` through
`20260830130000`: the merchant-rate importer, the predecessor registry, import
idempotency, an exact dry-run preview, `residual_standing_merchant_rates`, and
bounded import errors.

**R5d pt 2 — the engine.** `20260831120000_residuals_calc_engine_r5d2.sql`.
`compute_residual_period(p_period_id, p_processor)` and `residual_eval_side`.
Evaluates the registry in one SQL pass with a `PARTITION BY (period_id, mid)`
window for rule #7's cross-row existence test. The dependency graph is edgeless
— no rule reads another rule's output — so one pass suffices.

**R5d pt 3 — the admin surface.** Six migrations, `20260901120000` through
`20260903120000`: `rate_ref` on failures, the buy-rate template screen, the
per-merchant rate editor, template rate refs, a lock fix, and the retirement of
`monthly_fee_combined` from the model.

**R5e — vendor rate cards and merchant vendor costs.** Eight migrations,
`20260904120000` through `20260906120000`. Five vendor schedules
(`ACCEPT_BLUE`, `TUZO`, `RICHARD`, `PAYA_ACH_PPD`, `PAYA_ACH_WEB`) alongside
`MAVERICK`, a capped-rate evaluation, the vendor-costs editor, and
`vendor_cost_slot` on `residual_fee_items`. Deja Voo is deliberately **not**
imported: its sheet block has a header and no rows, and an empty card would
assert the vendor charges nothing.

**R6a — the verdict layer.** Six migrations, `20260907120000` through
`20260907170000`. `residual_verdict_tolerances` (per step, effective-dated),
`residual_verdict_acknowledgments`, `residual_verdicts`, sign-off and audit
guards, `residual_calc_runs` and engine status, and merchant-state scope. Three
comparison steps, four outcomes (`match` / `mismatch` / `exempt` / no row).

**R6b — the reconciliation surface.** Three migrations, `20260908120000`
through `20260908140000`, plus the route at `/admin/residuals/reconcile`.
`residual_grid_rows`, `residual_synopsis`, `residual_merchant_volume_row`,
`residual_period_history`, manual entry, and a data correction clearing the
standing version on a period that computed nothing.

---

## 3. The standing design principles

These are not slogans; each is enforced somewhere specific, and the citation is
the point. If you change one, change it where it is enforced.

### All currency arithmetic happens in SQL; money crosses to the client as text

Every computed money value is produced by a SQL function and serialised with an
explicit `::text` cast. See `20260908120000_residuals_grid_and_synopsis_r6b.sql`
lines 468–474 and 500–509, where delta, left, right, tolerance and item_count all
cast to text before entering the JSON payload.

The reason is that JavaScript has one numeric type and it is a float.
`numeric(14,2)` survives a round trip as a string and does not survive one as a
`number`. The client formats; it never computes.

### Effective dating on every reference table, with EXCLUDE + `*_for_month`

Reference tables carry `(effective_from, effective_to)` as a half-open range
starting on the 1st, a GiST `EXCLUDE` constraint preventing overlap, and a
`*_for_month(...)` resolver. Six such constraints exist across
`20260827120000` (3), `20260828120000` (2) and `20260907120000` (1).

The resolvers: `residual_buy_rates_for_month`, `residual_merchant_rates_for_month`,
`residual_tolerances_for_month`, `residual_formula_registry_for_month`,
`residual_vendor_card_lookup`.

Changing a rate opens a **dated successor**; it never edits history. That is what
makes a recomputed historical month reproduce its original answer.

### A missing rate must never read as a zero rate — the lookups raise

`residual_buy_rates_for_month` and `residual_merchant_rates_for_month` **raise**
rather than return an empty set. `residuals.md` §3 states why:

> an empty rate set is indistinguishable from a genuinely free month, and
> computing income of 0.00 against a real buy rate books the entire cost as a
> loss — a number that looks like an answer.

Enforced further at the column level: every rate on `residual_merchant_rates` is
nullable with **no default**, and `20260828120000_residuals_calc_inputs_r5d.sql`
pins the contract:

> ```
> -- EVERY RATE IS NULLABLE WITH NO DEFAULT. A merchant with no AVS arrangement
> -- has no AVS rate, and NULL says that; 0.000000 would assert a rate of zero,
> -- which is a different claim and one the engine would multiply by a count and
> -- book as real.
> ```

The corollary is the three-cell-state rule (`residuals.md` §6.6): a number is a
rate, `"$ -"` is a **recorded decision** stored as `0.000000`, and blank is an
**absence** stored as NULL. The import wizard shows all three counts per column
as a prominent panel and the operator confirms before commit, because the
`"$ -"` → 0 reading is inferential and load-bearing.

### Derived facts are not stored; human assertions are

The distinction is the module's sharpest, and it is applied consistently:

| Derived — computed at read time | Asserted — stored with an actor |
|---|---|
| verdicts (`residual_verdicts`) | acknowledgments (`residual_verdict_acknowledgments`) |
| link staleness (join and test `deleted_at`) | the link itself (`thread_id` + `thread_match`) |
| "matches the card" on a vendor cost | the vendor cost row |
| `is_residual_split` on a schedule | sign-off (`residual_sign_off_period`) |

`CLAUDE.md` records the reasoning for staleness:

> There is no stored `stale` flag, because a stored flag is itself a cached fact
> that can go stale — the exact failure being guarded against.

`residuals.md` §6.12 records the same argument rejecting a `derived_from_card`
flag, and `20260907140000_residuals_verdicts_r6a.sql` rejects a step-2 exemption
flag on the grounds that it would be

> ```
> -- a second, hand-maintained statement of something the terms already
> -- say — and the day the two disagreed, the flag would win silently.
> ```

### Absence means absent — no named "unknown" state

A fact already expressed by absence does not get a name. Applied in at least
four places:

- A registry side with **no terms** is $0.00. There is no ZERO opcode.
- A verdict that cannot be computed produces **no row**, not a fifth outcome.
  `20260907140000` calls it out directly: naming it "makes two ways to say one
  thing".
- `calculation_version` NULL covers both never-computed and invalidated-since,
  which "are not usefully different to a reader" (`residuals.md` §7).
- R5a's volume buckets are NULL rather than partial when a statement does not
  reconcile.

The one deliberate exception is step 2's **`exempt`**, which *is* a named
outcome — because "this comparison does not apply to this row by rule shape" is a
different claim from "this comparison could not be made", and the grid needs to
say which.

### Guards attach to the fact, not to the caller

Recompute invalidation is a trigger on `residual_lines`, not a patch to the
import RPCs. The write guard on a reconciled period is likewise a trigger.
`residuals.md` §7:

> Attaching invalidation to the **fact** (the lines changed) instead of to a
> caller covers the supersede sweep, manual entry, the PDF path and every future
> import route, and cannot be forgotten by the author of the next one.

And the symmetry that falls out of it, worth preserving:

> **The guarded set is exactly the invalidation set, plus the engine columns** […]
> *the changes that invalidate a calculation are precisely the changes a
> reconciled period forbids.* A column added to one list belongs in the other.

The same principle explains why `residual_resolve_mid` and
`residual_reconcile_mid_links` have **no internal `auth_role()` gate**: they must
also run from the relink trigger under a service-role connection where
`auth.uid()` is NULL. Gating happens at the six admin-facing entry points
instead, and the kernels are granted to no client role at all.

---

## 4. How to run it end to end

The operator's path, in order. Everything is under `/admin/residuals` and the
admin layout calls `requireSuperAdmin()`.

### Step 0 — reference data must exist first

Buy-rate schedules, fee items and risk tiers are seeded by R5c and R5e
migrations. Check coverage before anything else:

```sql
select * from residual_buy_rate_coverage('MAVERICK');
select * from residual_reference_coverage('<period_id>');
```

### Step 1 — import the fee report → `/admin/residuals`

The module index. Upload the processor's monthly fee report as `.xlsx`; the
wizard previews and then calls `commit_residual_excel_import(import_id, period_id, rows)`.
One statement month per file. This creates `residual_lines` with stated columns
populated and all six engine columns NULL.

The page also lists the last 20 imports with their `error_message`, so a failed
import is visible without a DB query.

### Step 2 — import PDF statements → `/admin/residuals`

Same screen. `commit_residual_pdf_import` parses a statement, rolls plan codes to
the four volume buckets and writes `residual_merchant_volumes` +
`residual_plan_volumes`. **Volumes are what rules #7, #12 and #13 need.** Without
them those rules fail and the month cannot compute cleanly — which is the state
the project is in today (§6).

### Step 3 — enter merchant rates → `/admin/residuals/rates`

Two ways in, both on this screen:

- **The importer** reads the workbook's "Drawer tab Processor-TD Merchan" sheet
  **as `.xlsx`, never CSV** (§8 has the reason). Upload → preview → commit, where
  the preview is an *exact* dry run: `residual_preview_merchant_rates_import`
  calls the real commit inside a subtransaction and discards the writes.
- **The per-merchant editor** (`residual_merchant_rate_editor`) is where a rate
  is entered by hand. The unit is a merchant, not a column. It refuses an
  in-place edit once a computed period has read those rates, and offers a dated
  successor instead (`residual_supersede_merchant_rate`).

`monthly_fee_tapdash` **must be entered here** — it is never auto-zeroed, and
rule #2 raises without it for every merchant (§6).

### Step 4 — compute → the Compute button on `/admin/residuals/rates`

Calls `compute_residual_period(period_id, processor)`. It writes the six engine
columns, `residual_line_groups` for grouped rules, `residual_calc_failures` for
everything that could not be computed, one `residual_calc_runs` summary row, and
— **last, and only on a clean full-period run** — `calculation_version`.

Check coverage first rather than discovering a raise mid-run:

```sql
select * from residual_merchant_rate_coverage('<period_id>');
```

The button lives on the rates screen rather than the reconcile screen because
the rates screen is where the thing that blocks a compute gets fixed
(`residuals.md` §11).

### Step 5 — reconcile → `/admin/residuals/reconcile`

The surface the module exists to produce. Per statement month, every fee line
with three comparison steps beside it:

| Step | Compares | Against |
|---|---|---|
| 1 | the statement's volume | the report's Amount |
| 2 | `agent_expense` | `total_buy_rate` |
| 3 | `net_revenue` | `tapdash_net_before_split` |

Outcomes are `match`, `mismatch`, `exempt` (step 2 only, by rule shape), or no
row. Tolerances come from `residual_verdict_tolerances`, per step and
effective-dated.

**The synopsis suppresses money on a partially-computed month** rather than
labelling it partial. Three independent gates enforce it: `residual_synopsis`
returns NULL unless a version stands, `mayShowMoney()` re-asks on the client,
and the suppressed branch does not render a figure at all. The denominators
always render, because they are facts about coverage rather than money.

URL state: `?month=`, `?mid=`, `?flagged=1`, `?view=lifetime`.

### Step 6 — acknowledge

A mismatch somebody has decided to accept is recorded with
`residual_acknowledge_verdict(scope, scope_id, step, reason, processor)`. The
reason is **mandatory and attributed**. An acknowledged mismatch stays amber and
stays on the row, struck through with a person marker — hiding it would make the
month look reconciled when what happened is that a human decided to live with a
difference.

`residual_withdraw_acknowledgment` reverses one;
`residual_retire_resolved_acks` clears those whose underlying mismatch is gone.

### Step 7 — sign off

`residual_sign_off_period(period_id, note, processor)` sets the period to
`reconciled` and **freezes it**: neither computed values nor statement data can
be modified, and re-imports are blocked too. `residual_reopen_period` is an
explicit admin act requiring a reason.

---

## 5. What is not done

### The chargeback rule — specified, waiting on one fact

`docs/spec/r5f-chargeback-rule-pending.md` carries a complete, runnable seed.
Both sides are already loaded and neither is read: `residual_buy_rates.chargeback`
has four tier rates (10 / 15 / 20 / 25) and `residual_merchant_rates.chargeback_fee`
carries a value for **34 of 34** merchants (as-of 2026-09-23).

**The rule is now fully specified. The blocker is data, not a decision:** a PDF
statement carrying a **Tran Code `C`** row. None of the sampled statements has
one.

The complete spec, recorded in that file:

1. Band the **Deposits section** columns of the PDF statement, using the
   right-edge banding idiom in `lib/residuals/pdf-layout.ts`.
2. Filter **`Tran Code = 'C'`**.
3. **Count the rows** — the fee is per occurrence, so the operand is the count,
   never the summed amount.
4. Buy side = `line_item_count` × `template.chargeback`.
5. Income side = `line_item_count` × `merchant.chargeback_fee`.
6. **Live registry only.**

**Decision of record — Q35: a reversal does NOT refund the fee.** Confirmed by
the user. The rule counts Tran Code `C` rows only and **never nets them against
Tran Code `B`** (chargeback reversal). A merchant charged back who then wins the
reversal still pays the fee — it buys the handling of the event, not its outcome.

Netting is the intuitive reading, so an implementer who is not told will
reasonably subtract the B rows and be wrong only for merchants who had
reversals: correct for most, quietly wrong for a subset, invisible without a
statement carrying both codes.

Note that the **count comes from the statement, not the fee report**. This
document's earlier framing — that the blocker was the fee item name on the fee
report — was wrong, and `r5f-chargeback-rule-pending.md` has been corrected.
That file also **reversed its registry scope on 2026-09-23**: live registry only,
where it previously seeded both. The consequence is that a recomputed pre-June
month carrying a chargeback row will not price it, and seeding the predecessor
is a separate dated decision if it is ever needed.

The document's survey confirms chargeback is the **only** item in this position
on either side.

### The PCI question — unresolved, and the grid shows it

Three facts that do not fit together:

1. The seeded template prices `pci_fee` at 5.00 and the registry marks PCI
   Program `billed_directly_to_merchant` — rule #6 has **no terms on any side**,
   so it computes 0.00.
2. The May fee report charges TapDash `agent_expense = 5.00` on **all 17 PCI
   rows** (measured 2026-09-23).
3. Two of those rows (`201100164707`, `30119889965`) also carry income 9.95.

So the template says the merchant pays it directly and the report says the
processor charged TapDash. **Until somebody settles which is true, the grid
renders nine PCI mismatches** at step 3 (measured 2026-09-23 — the largest single
mismatch group in the period).

`20260907140000_residuals_verdicts_r6a.sql` explains why step 3 is *not* exempted
for billed-directly items even though step 2 is:

> ```
> --   Website Monitoring Fee (3 rows)  income 15.00 = expense 15.00, net 0.00
> --   IRS Annual Fee         (2 rows)  income  1.95 = expense  1.95, net 0.00
> --   PCI Program           (17 rows)  expense 5.00 on EVERY row; 15 net -5.00,
> --                                    and two […] also carry income 9.95
> ```

Website Monitoring and IRS are genuine pass-throughs and already pass. PCI is
not, and exempting it would hide a real question.

**What would resolve it:** a decision on whether TapDash absorbs the 5.00. If it
does, rule #6 needs a buy-side term reading `template.pci_fee` and an income term
— but the terms-validation trigger currently *forbids* any term referencing a
`billed_directly_to_merchant` item, so the flag must come off the fee item first.

### Step 1's tolerance is a placeholder that has never been measured

`residual_verdict_tolerances` holds 0.05 for step 1. `residuals.md` §2 is explicit:

> **Step 1's 0.05 is a placeholder, not a measurement:** no statement/report pair
> has ever been compared, so the right number for it is unknown.

Confirmed as-of 2026-09-23: `residual_verdicts` on May returns **zero step-1
rows**. The comparison has never run once. Steps 2 and 3 use ±0.05 chosen
deliberately in R6a (Q36 = B), knowing it forgives one real 0.04 rate variance on
Orlando's Merchant Deposit row that ±0.01 would have caught.

### The EBT bucket-membership conflict — unresolved, and the first overlap arbitrates

**This is a step-1 volume-mapping question, not a pricing question.** It is
recorded in the seed header of
`20260907120000_residuals_verdict_reference_r6a.sql` — **not** in
`residuals.md`, which is why it is easy to miss when grepping the specs.

The step-1 mapping (`residual_volume_row_mappings`) says which statement volume
buckets a fee-report row should be compared against:

```
Amex OptBlue Fee            -> amex
BIN Sponsorship Fees        -> vmd + debit
Cash Disc/Surcharge Program -> amex + vmd + debit
Interchange                 -> amex + vmd + debit
EBT Authorization Fee       -> ebt
```

The conflict, quoted from that header:

> ```
> -- EBT IS DELIBERATELY OUTSIDE THE BIN AND CASH DISC SUMS, AND THE WORKBOOK
> -- DISAGREES. The user confirms EBT prices off VMD rates but reports on its own
> -- line; the workbook's data-entry marks read as though EBT belongs inside the
> -- bucket sums. The arithmetic in the sample supports exclusion: on MID
> -- 201100269662, BIN 23,500.68 + OptBlue 7,725.58 = Cash Disc 31,226.26 EXACTLY,
> -- and that identity breaks by 383.65 the moment EBT is folded into either side.
> -- Recorded here rather than resolved, because the sample settles the fee
> -- report's INTERNAL consistency and step 1 is a test against the STATEMENT.
> -- THE FIRST OVERLAPPING MERCHANT-MONTH ARBITRATES.
> ```

Verified against the data 2026-09-23 — the figures are exact:

| MID 201100269662 | Amount |
|---|---|
| BIN Sponsorship Fees | 23,500.68 |
| Amex OptBlue Fee | 7,725.58 |
| **sum** | **31,226.26** |
| Cash Disc/Surcharge Program | **31,226.26** |
| EBT Authorization Fee | 383.65 |

**The seed follows the arithmetic: EBT maps to its own row only.** The workbook's
"Volume - Pulled from statement" marks say otherwise. The sample cannot settle it
because it only establishes the fee report's *internal* consistency, and step 1
is a test against the *statement* — which is why **the first merchant-month
carrying both a fee report and a PDF statement arbitrates** (§6).

The same header records a related intentional overlap worth not "fixing":
Interchange and Cash Disc carry the **same three buckets** and each gets its own
step-1 verdict, because they are two independent assertions about the same
quantity. The sample shows them agreeing to the cent on 12 of the 13 MIDs
carrying both — the exceptions being 201100272922 (one cent) and the already
parked Orlando 201100169797.

### EBT pricing — a separate question, and settled

Distinct from the mapping conflict above, and true regardless of how that
resolves:

- `EB` maps to `ebt_volume` in `residual_plan_code_buckets`
  (`20260825120000`, seeded verbatim from `lib/residuals/pdf-layout.ts`).
- The term vocabulary includes the operand **`volume_ebt`**, and **zero live
  terms use it** (measured 2026-09-23).
- `ebt_volume` was deliberately **not** carried onto `residual_merchant_rates`.
  `residuals.md` §9: "no rule and no buy-side counterpart; the composite
  deliberately omits EBT volume. Including it would invite a wrong fifth term."
- Rule #20 (EBT Authorization Fee) reads the **VMD** rates deliberately —
  `m:vmd_auth_fee` on the income side and a `$0.02` literal on the buy side.

So EBT *volume* is parsed and stored but priced by nothing, while EBT
*authorizations* are priced at VMD rates. **That is confirmed, not an oversight**
— the R6a seed header records "The user confirms EBT prices off VMD rates but
reports on its own line", which is exactly the shape above: its own volume row,
somebody else's rates.

What remains open is only the mapping question in the previous section — whether
that volume row also belongs inside the BIN and Cash Disc sums.

### Deliberately excluded

- **A manual-edit override column.** `residuals.md` §7: a hand-entered *result*
  the engine must not overwrite "is a different feature (an override column plus
  a reason) and is deliberately not in R5d". Note that `source = 'manual'` lines
  are a different thing — they are hand-entered *statement data*, computed
  identically to every other line, and the supersede sweep deliberately spares
  them.
- **A free-text Notes column on the grid.** The "Note" column renders the
  *acknowledgment reason*. R6b did not add a notes column on `residual_lines`,
  on the grounds that the ack reason is already per-row, per-step, attributed and
  mandatory, and "a second unattributed place to write down why a row is odd
  would win simply by being easier". It remains a one-column migration if wanted,
  and that column is where it would render.
- **`monthly_fee_combined`.** Retired from the model by `20260903120000`.
  Everything is a soft delete, so reversal is data rather than schema —
  `residuals.md` §6.10 gives the four steps and warns that step 1 must precede
  step 3 or the terms-validation trigger raises `23503`.
- **A program dimension for the Batch Fee variance.** Recorded as an observation,
  not acted on.

### The fabricated figures, and what replaced them

`residuals.md` records a range of per-line deltas that was **not measured** and
should not be cited. The measured replacement lives in
`20260907140000_residuals_verdicts_r6a.sql`:

> ```
> -- Measured on the 63 computed May lines: 37 of 63 step-2 comparisons differ,
> -- and only 5 of those 37 are real.
> ```
> ```
> --   MIRROR RULES (22 rows). […] the deltas run to +3,323.74.
> ```

If you find a `0.34`–`3.74` range quoted anywhere, it is the fabrication; the
real numbers are 37-of-63 differing, 5 real, mirror deltas to +3,323.74.

### Everything else open in `residuals.md` §8

Gap 3 (the monthly-fee changeover date), gap 5 (Batch Fee variance — three
low-tier merchants at 0.02 against a template 0.01, correlating exactly with the
cohort lacking a Monthly Online Access Fee row), gap 6 (buy rates matching no
tier on at least five MIDs), gap 7 (MID 201100169797's BIN row, irreconcilable as
specified), gap 8 (processor resolution for manual lines — see §7).

**§8 was re-measured and corrected on 2026-09-23** in the same commit as this
document. Gap 1 ("No merchant has rates") was superseded and rewritten to the
measured state; gap 2's row count was corrected from 28 to 40; gap 6 lost a
clause that depended on the retired drawer; and gap 8 was marked half-closed.
Every entry now states what was true on that date, so the list can be trusted
again — but re-measure before relying on it.

---

## 6. Data gaps — what the module needs that no file supplies

All measured 2026-09-23 against `pcrthafqoxjiucujogae`.

### Nine May MIDs have no rate row at all

```sql
select count(distinct l.mid) from residual_lines l
 where l.deleted_at is null
   and not exists (select 1 from residual_merchant_rates r
                    where r.deleted_at is null and r.mid = l.mid);
-- 9
```

These nine fail at `scope = 'merchant'` with `no_merchant_rates` — skipped whole.
The 33-merchant rate sheet does not cover them; they are billed but absent from
it.

### `monthly_fee_tapdash` is empty for every merchant

**34 of 34 rate rows carry NULL.** The source sheet's column exists with a header
and is empty for all 33 merchants. It is rule #2's only term and every May MID has
a Monthly Fee row, so **rule #2 raises for every merchant**.

This is deliberate, not an import bug. `residuals.md` §6.7:

> Auto-zeroing would convert *"nobody has told us"* into *"we checked, it is
> zero"* — silently, in a money path.

The brief for this document cites "eleven merchants"; the measurable figure is
**11 of 21 May Monthly Fee rows carry non-zero Agent Income** (the merchants
still being billed by the processor), against 10 with zero. All 34 rate rows need
the value entered either way. **The panel, not the importer, is what unblocks
this** — it is entered by hand, per merchant, as a recorded decision.

### May has no PDF statements

Volumes exist for **2026-07 only** (1 `residual_merchant_volumes` row, 0
`residual_plan_volumes` rows); fee lines exist for **2026-05 only**.

### Zero merchant-months carry both artifacts — so step 1 has never run

This is the single most consequential gap and it follows from the one above:

```sql
select count(*) from residual_merchant_volumes v
  join residual_lines l on l.period_id = v.period_id and l.mid = v.mid
 where v.deleted_at is null and l.deleted_at is null;
-- 0
```

Consequences:

- **Rules #7, #12 and #13 have never been validated end to end** — **40 of 197
  rows** (15 BIN Sponsorship + 13 Cash Disc + 12 Amex OptBlue; the two composites
  alone are 28).
- **Step 1 of the reconciliation has never been evaluated once**, which is why
  its tolerance is a placeholder (§5).
- **The EBT bucket-membership conflict cannot be arbitrated** (§5). The seed
  header is explicit that the first overlapping merchant-month settles it.
- The May period computes 63 of 197 lines and **all 21 merchants sit in state
  `blocked`** (`residual_merchant_states`, measured 2026-09-23).

**What would fix it:** one merchant-month with both a fee report and a statement.
A single PDF statement for a May merchant that already has rates would exercise
step 1, both composites, rule #12, the volume join and the EBT question in one
go. It is the highest-leverage missing artifact in the module.

### Current state, for reference

| | as-of 2026-09-23 |
|---|---|
| Periods | 2 (2026-05, 2026-07), both `open`, both `calculation_version` NULL |
| Live lines / computed | 197 / 63 |
| Distinct MIDs | 21 |
| Line groups | 1 |
| Live imports | 19 |
| Merchant rate rows / MIDs | 34 / 33 |
| Merchant vendor cost rows | **0** |
| Merchant volume rows / plan volumes | 1 / 0 |
| Calc runs / failures | 2 / 55 |
| Acknowledgments | 0 |
| Registries / live rules / live terms | 2 / 40 / 62 |
| Fee items / buy-rate schedules / buy rates | 22 / 6 / 62 |
| Partners / MID-partner links | 6 / **0** |
| May verdicts | step 1: none · step 2: 77 exempt, 25 match, 4 mismatch · step 3: 47 match, 15 mismatch |

---

## 7. Integration into the CRM

### Where the module is reachable from today

- **`components/admin/admin-tabs.tsx:26`** — `{ href: "/admin/residuals", label: "Residuals", icon: Receipt }`. This is the only navigation entry.
- **`components/lead-gen/details-tab.tsx:198` and `:208`** — from a merchant
  record's drawer, deep links to `/admin/residuals/rates?mid=…` and
  `/admin/residuals/vendor-costs?mid=…`. This is the one place the CRM and the
  residuals module actually meet in the UI.

There is **no sidebar module** for Residuals. `CLAUDE.md` lists six sidebar
modules and Residuals is not among them.

### Whether `/admin` is the permanent home

Today every residuals screen sits under `app/(app)/admin/`, whose layout calls
`requireSuperAdmin()`. The module index records the reasoning:

> ```
> // Lives under /admin because every residuals table's RLS write policy is
> // auth_role() in ('admin','super_admin') and the residual-files bucket is
> // admin-gated; a top-level sidebar module would render a dead page for
> // marketers. Note the admin layout calls requireSuperAdmin(), so in practice
> // this page is super-admin only — stricter than the RLS underneath it.
> ```

**That last sentence is the open question.** The RLS underneath admits `admin`
and `super_admin`; the route admits only `super_admin`. So an `admin` user has
database permission to do everything in this module and no way to reach any of
it. Nothing in the repo records a decision that super-admin-only is the intended
permanent state — it is a consequence of where the pages were put.

Resolving it is a small change either way: move the module out from under the
admin layout and gate it with its own `requireAdmin()`-equivalent, or narrow the
RLS policies to match the route. **Do not leave them disagreeing**; the mismatch
is the kind that surfaces as "why can't this admin see the thing they can
obviously write to".

`residuals.md` §12 notes that if the module ever grows an operator-facing tab
strip, the existing buy-rates page is what tab 3 should link to rather than
something to build again.

### The 25 retired drawer fields — do not re-create them

`lead_gen_columns` section `Processor-TD Merchant Pricing` held 25 pricing
fields, seeded in R2 and soft-deleted by
`20260828130000_retire_drawer_subtab1_r5d.sql` on 2026-09-09. Measured
2026-09-23: **25 retired, 0 live in that section.**

They were replaced by the typed table `residual_merchant_rates`. Re-adding one in
the admin drawer-fields manager **would not restore it as a calc input** — the
engine reads the typed table and has never read `column_data`.

`residuals.md` §9 carries the full field-by-field mapping. The ones that did
*not* become columns, and why, are the part worth knowing before someone
"restores" them: `pricing_model` (descriptive, not a rate), `processor` (an
attribute of the statement, not the merchant), `amex_auth_fee` (no rule),
`ebt_volume` (no rule, no counterpart), `gateway_auth_fee_mav` /
`terminal_auth_fee_mav` (unread *rates*, the dangerous kind to carry), and
`lease_payments_tapdash` ("not income" by its own label).

**Two things survive on that tab and must not be touched:**

1. **`mid`** (section NULL, `display_order` 1000) — R3's uniqueness index is
   built on it, R5b's entire MID adjudication reads it, and
   `find_live_thread_by_mid()` queries it. The retire migration encodes a
   pre-flight that **raises** if retiring the section would leave the tab with no
   live fields, so that if `mid` is ever moved the migration stops rather than
   silently doing something else.
2. **The Pricing tab itself**, which is a container for five sections of which
   only one was retired. Vendor Pricing, One Time Charges, Other Vendor Payments
   and Equipment List were deferred to the Tab-4 phase.

One lesson from that migration is worth carrying forward verbatim, because it
was wrong in the prediction and right in the correction:

> **`is_visible = false` does not mean "not rendered".** It means "not a grid
> column". Any future claim that a drawer field is inert has to be made against
> the drawer's own query, not against the flag.

`listDrawerLayoutAction` selects the flag and does not filter on it, so all 25
rendered in the drawer and accepted edits for the whole period they were
supposedly inert. Somebody set **Risk Level** there and nothing happened, because
the engine resolves the tier from `residual_merchant_rates.risk_tier`.

### `residual_merchant_vendor_costs` is not wired into anything

**This is the single most likely wrong assumption an inheritor will make.**

The table was created in R5c. It has an editor at `/admin/residuals/vendor-costs`,
a deep link from the merchant drawer, three RPCs, effective dating, an EXCLUDE
constraint and admin gating. It has **zero rows** (measured 2026-09-23).

**No calculation rule reads it, and none can.**
`residual_formula_terms.rate_source` is `merchant | template | literal |
net_revenue`, and `merchant` resolves against `residual_merchant_rates`, whose
legal columns are pinned by a CHECK containing none of the vendor-cost columns.

It belongs to the **partner-residual stage** — vendor costs and offsets are
subtracted before a referral partner's split, which is a stage after everything
built so far. `residuals.md` §6.9 lists it under out-of-scope and states that its
being empty does not block anything.

The editor deliberately has **no lock**, and that is an argument rather than an
omission: the rate editor locks because a computed period read those rates, and
since nothing reads vendor costs, a lock would assert a dependency that does not
exist. When something does read them, the lock question becomes live and should
be answered then, against the real dependency.

### The R5b merchant link — what it is and is not for

**What it is for:** attaching a residual row to the CRM merchant record it
belongs to, so the module can be navigated from the CRM and vice versa. Four
columns on each of three tables — the pointer (`thread_id`), how it was decided
(`thread_match`), when (`thread_matched_at`), and who vouched
(`thread_confirmed_by_id`).

**What it is NOT for: keying reference data.** This is the distinction to hold
onto, and it is why `residual_merchant_rates.mid` is a `text` MID and not an FK
to `lead_gen_threads`. From `20260828120000_residuals_calc_inputs_r5d.sql`:

> ```
> -- MID IS THE STATEMENT MID, normalized digits-only per R3 — NOT the mutable
> -- record MID that R5b adjudicates. […] an immutable key cannot orphan when a
> -- merchant record changes, and the join from residual_lines is a plain
> -- equality on one side only. The uncovered case is identical too — a merchant
> -- RE-BOARDING onto a new MID leaves its rates behind on the old one — and is
> -- surfaced the same way, by a coverage report rather than a constraint.
> ```

So there are two MID namespaces that look identical and are not: the **statement
MID** printed on the processor's report, which is immutable and is what all
reference data keys on, and the **record MID** typed into a merchant record,
which is mutable and is what R5b adjudicates against. Linking is a convenience
for humans; pricing never depends on it.

Two further properties worth not breaking:

- **A link survives the soft-delete of the merchant record it points at**, for
  machine and human links alike. Soft-deleting a record does not falsify a
  decision that was correct when it was made. A machine link is re-adjudicated
  only when the record is *hard*-deleted or its MID moves away.
- **`residual_*.thread_id` joins the NO ACTION FK list** that M12's permanent
  purge has to deal with, alongside `sequence_steps.conversion_method_id` and
  `sequence_variants.trigger_id`.

### What a second processor would require

Only `MAVERICK` exists today. Four things are needed, and the first is a schema
change:

1. **A `processor` column on `residual_lines`.** It does not have one; processor
   is carried by `residual_imports`, and manual lines have `import_id IS NULL`.
   `residuals.md` §8 gap 8 records that the engine RPC should therefore take
   `(period_id, processor)` explicitly — which it now does — but the underlying
   ambiguity stands: a manual line in a two-processor period cannot say which
   processor it belongs to. Harmless today; wrong the moment two processors share
   a period.
2. **Its own formula registry.** Rules are per-processor and dated. A second
   processor's fee item names will not match Maverick's, and exact-name matching
   means an unmatched name raises rather than guessing.
3. **Its own buy-rate schedule**, with its own tier structure. Note that
   `is_residual_split` is *derived* — it asks whether a schedule's tiers are real
   risk tiers — so a processor that pays a share of net is classified correctly
   without anyone updating a list.
4. **`residual_imports.processor` normalization, which was deferred.** The
   column is bare `text` with no CHECK and no normalization. Measured
   2026-09-23: imports carry `'Maverick'` while buy-rate schedules carry
   `'MAVERICK'`. Today nothing joins the two so nothing breaks; with two
   processors, a free-text column that has already drifted in case is a silent
   mis-join waiting to happen. `residual_vendor_provider_key` (R5e) is the
   in-repo precedent for how to normalize such a key — upper-case, runs of
   non-alphanumerics to one underscore — and should be applied here.

### Tab 4 — vendor payouts

**Never started.** Its scope is the partner-residual stage: vendor costs, offsets
and referral-partner splits, taken *after* everything the current engine
computes.

The pieces already in place for it are `residual_merchant_vendor_costs` (empty),
`residual_partners` (6 rows), `residual_mid_partners` (**0 rows**), the five
vendor rate cards from R5e, and `vendor_cost_slot` on `residual_fee_items` (5
items carry one).

Note the split vocabulary carefully, because conflating the two is a wrong-money
bug: **`tapdash_share`** (0.9 / 0.9 / 0.8 / 0.7) is the tier percentage applied
at value 4 of the chain and is in scope today; **`residual_partners.split`** is a
referral partner's cut, taken at this later stage, and is not.

---

## 8. Operational traps

Each with the symptom you will actually see.

### `supabase db push` refuses and demands `--include-all`

**Symptom:**

```
Found local migration files to be inserted before the last migration on
remote database.

Rerun the command with --include-all flag to apply these migrations:
supabase\migrations\20260828130000_retire_drawer_subtab1_r5d.sql
```

A plain `db push` then does nothing at all — including the migration you actually
wanted.

**Why `--include-all` is the wrong reflex.** It sweeps in every out-of-order file
along with yours. Historically that meant applying the drawer-retirement
migration before the replacement entry path existed, silently removing the only
surface through which merchant rates could be entered.

That specific file is now legitimately applied, so the trap is defused for it —
but the shape recurs any time a file is deliberately held back. **The rule that
survives: dry-run first and read what it lists.** The only evidence
`--include-all` is safe on any given day is a dry run listing exactly what you
intend and nothing else. `residuals.md` §10 carries the full
checksum-move-push-restore procedure for holding a file back.

### The MCP `apply_migration` tool stamps its own timestamps

**Symptom:** everything works on the machine that applied it; later, somewhere
else, a fresh checkout's `supabase db push` finds repo files "missing" from the
remote, sorting behind a head that clock-stamped rows created, and refuses —
demanding `--include-all`, which lands you in the trap above with duplicate
applications on the table.

It also **splits**: one repo file applied as two tool calls records as two rows
with two different clock versions.

**This has happened twice.** Reconcile immediately, in the same session:

```sql
update supabase_migrations.schema_migrations
   set version = '20260901120000', name = 'residuals_calc_failure_rate_ref_r5d3'
 where version = '20260910002939';

delete from supabase_migrations.schema_migrations where version = '20260910003038';
```

Then prove it with `npx supabase db push --dry-run`. **Prefer the CLI**; the MCP
tool is a fallback and using it incurs this reconciliation as a mandatory
follow-up.

### PowerShell corrupts type regeneration with a BOM — use bash

**Symptom:** after `npm run db:gen-types`, `lib/database.types.ts` fails to parse
or every import from it errors, often with a complaint about an unexpected
character at position 0.

**Cause:** the script is a shell redirect —
`supabase gen types typescript --linked --schema public > lib/database.types.ts`
— and PowerShell's `>` operator writes a **UTF-16 BOM** rather than clean UTF-8.
The TypeScript compiler does not accept it.

**Fix: regenerate types from bash, never PowerShell.** If a file has already been
written this way, regenerate it from bash rather than trying to strip the BOM.

> **A standing project convention that predates this repo**, carried over from
> the project's original handoff and not recorded anywhere else in this
> codebase — written down here for the first time. It is not a residuals
> finding; it applies to every `db:gen-types` run.

### **The fee report's `Buy Rate Per Item` column is display-rounded to 2dp — never read it directly**

**This has produced three wrong conclusions. Derive the true rate as
`Agent Expense ÷ Count`.**

**Symptom:** you read `0.03` in the report, compare it to a template `0.025`, and
record a variance that does not exist.

The column shows `0.03` for medium-tier merchants. Dividing Agent Expense by
Count recovers the true rate, and for every medium-tier merchant except parked
Orlando that rate is **exactly 0.025** — the template value (10 × 0.025 = 0.25;
34 × 0.025 = 0.85; 61 × 0.025 = 1.525 → reported 1.53). **Medium tier
reconciles.**

The **only** genuine batch-fee variance is three low-tier merchants at 0.02
against a template 0.01: MIDs `30119900929`, `201100250209`, `30119926551`.

The identical trap exists in the source workbook, where a cell displaying `0.03`
holds `0.025` (`residuals.md` §6.4), and in the merchant-rates sheet, where a
cell holding `0.033816` displays — and CSV-exports as — `3.38%`. **That is why
the importer reads `.xlsx` and takes the cell value, never a CSV** (§6.5): CSV
export writes the displayed text, giving both a 100× scale error and silent
precision loss.

The general rule: **in this module, no displayed number is a value.** Derive it.

### A truncated `.next/dev` cache presents as a `tsc` failure

**Symptom:**

```
.next/dev/types/validator.ts(5,79): error TS2306:
File '.next/dev/types/routes.d.ts' is not a module.
```

`tsc --noEmit` fails, `next build` fails at the type-check step with the same
error, and the pre-push hook blocks the push. **No source file is wrong.**

**Cause:** `tsconfig.json` includes `.next/dev/types/**/*.ts`, and a `next dev`
killed mid-write (a crash, a device restart) leaves `routes.d.ts` zero bytes.

**Fix:** `rm -rf .next/dev` and rebuild. `.next/` is gitignored and fully
regenerable, so this is safe. Observed once, after a device restart.

### The integration suites are local-only by construction

**Symptom if you ignore this:** the suites appear to pass against a remote
project and leave debris — on 2026-09-11 a remote run left four live
`super_admin` accounts behind.

The suites are **not read-only observers**. They create super-admin accounts,
seed fixtures, and delete rows by pattern in setup and teardown; `purgeScratch`
in the calc-engine suite deletes periods, lines, imports, calc runs and
status-log rows for its month *before* asserting anything.

The safety model is that every default in `vitest.integration.config.ts` resolves
to a local stack (`localhost:54321` / `54322`) and nothing loads `.env.local` into
vitest's `process.env`. That makes it **one exported shell variable away from
being false**, which is exactly how the 2026-09-11 leak happened.

Two of those four accounts **cannot be deleted at all**: every residual audit
column is a NO ACTION FK to `auth.users`, and one account is `updated_by_id` on
all 197 live lines. They were revoked in place instead (banned, sessions dropped,
role demoted, `deleted_at` set) — see `residuals.md`, "May's lines are attributed
to a REVOKED throwaway account". **Debris from a remote run is not always
reversible.**

`SUPABASE_TEST_DB_URL` has been removed from `.env.local` for this reason. It is
supplied legitimately by the `test:integration:local` script (from
`supabase status`) and by CI.

**Running them requires a container runtime.** There is none on the machine this
document was written on — no Docker, no WSL — so the suites have not been
executed since the R6b-2 commit, and the harness changes in the cleanup commit
are type- and lint-checked but **not run**.

---

## 9. Production security — NOT RESIDUALS

**These two items have nothing to do with this module.** They are here because
whoever inherits this document will need them, they are both open, and both
require access to the **production** project `wvbbyxmexsbolzhmuxcw` that was not
available when this was written. Everything measured below is from the **test**
project `pcrthafqoxjiucujogae`, which establishes the class of defect but is not
the production finding.

### Item 1 — views that run with owner rights

A view without `security_invoker = true` executes as its **owner** (`postgres`),
which **bypasses the RLS of every table it selects from**. Any caller who can
select from the view reads rows the underlying policies would have denied.

Measured on the test project, 2026-09-23:

```sql
select c.relname,
       coalesce((select option from unnest(c.reloptions) option
                  where option like 'security_invoker%'),
                '(not set = owner rights)') as security_setting,
       pg_get_userbyid(c.relowner) as owner
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'v'
 order by c.relname;
```

| view | setting |
|---|---|
| `recycle_bin_view` | **(not set = owner rights)** |
| `v_lead_gen_inbox_threads` | `security_invoker=true` |

So on test, `v_lead_gen_inbox_threads` is already fixed and **`recycle_bin_view`
is not**. The brief for this document reports that *both* were confirmed exposed
on production by catalog query — that confirmation is not reproducible from here
and is **not recorded anywhere in the repo**; it is stated on the authority of
whoever ran it.

**Fix:**

```sql
alter view public.recycle_bin_view set (security_invoker = true);
alter view public.v_lead_gen_inbox_threads set (security_invoker = true);
```

Then re-run the catalog query and confirm both read `security_invoker=true`.
**Test the recycle bin afterwards** — it is the surface most likely to have been
relying, unknowingly, on owner rights to show cross-user rows to an admin.

### Item 2 — `revoke ... from public` does not remove Supabase's default grants

`CLAUDE.md` documents this and it is repo-wide:

> Supabase's bootstrap runs `alter default privileges in schema public grant all
> on functions to postgres, anon, authenticated, service_role` […] so **every
> function is born with direct grants to all three client roles**, and
> `REVOKE ALL ... FROM PUBLIC` removes only the PUBLIC pseudo-role's implicit
> grant — it leaves those direct grants completely intact.

This matters most for `SECURITY DEFINER` functions, which bypass RLS by
definition. Measured on the test project, 2026-09-23:

```sql
select count(*) filter (where array_to_string(p.proacl,' ') like '%anon=X%')
         as anon_executable,
       count(*) filter (where p.prosecdef
                          and array_to_string(p.proacl,' ') like '%anon=X%')
         as secdef_anon_executable,
       count(*) as total
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public';
```

**318 of 392** public functions are executable by `anon`, and **32 of those are
`SECURITY DEFINER`**. Listing them:

```sql
select p.proname
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prosecdef
   and array_to_string(p.proacl,' ') like '%anon=X%'
 order by p.proname;
```

Most are `tg_*` trigger functions, which are hard to invoke usefully through
PostgREST. The callable ones are the concern, and include **`empty_recycle_bin`,
`purge_recycle_bin_entry`, `submit_campaign`, `update_campaign_status`,
`save_campaign_page_8`**, plus the `user_can_access_*` predicate helpers.

The residuals functions are **correct** here — sampled
`commit_residual_excel_import` and `residual_synopsis` grant `authenticated` only,
and `residual_resolve_mid` / `residual_reconcile_mid_links` grant no client role
at all. The `instantly_vault_*` and `outlook_vault_*` functions are the in-repo
reference implementation.

**The correct form names the roles:**

```sql
revoke all on function public.my_fn(args)
  from public, anon, authenticated, service_role;
grant execute on function public.my_fn(args) to authenticated;  -- only if needed
```

**Fix order.** Do these in sequence, because the second is noisy and the first is
not:

1. **The two views**, in one transaction. Small, self-contained, immediately
   verifiable, and the higher-severity of the two.
2. **Audit the 32 `SECURITY DEFINER` + `anon` functions** on production using the
   query above. For each, decide the intended caller and write an explicit
   `revoke`/`grant` pair naming the roles. Start with the callable non-trigger
   ones.
3. **Then the wider 318**, which is mostly trigger and helper functions and can
   be done as a sweep once the definer set is handled.
4. **Add a regression test.** `reference-data.integration.test.ts` case 9 ("anon
   cannot execute any of the three functions") is the pattern to copy.

**Do not run a blanket `grant all on all routines in schema public`** to fix a
test failure. `lib/test/global-setup.ts` used to, and its header explains at
length why it never will again: it silently reverses every deliberate revoke in
the repository, including the vault secret readers and
`residual_reconcile_mid_links` — an ungated writer of three tables whose entire
safety rests on being unreachable from any client role.

---

## 10. Testing

### Unit tests — `npm run test`

**385 tests across 17 files** (measured 2026-09-23), co-located with their
sources. The residuals ones cover the pure functions: `mapping`,
`merchant-rates-parse`, `pdf-parser`, `xlsx-parser`, `verdict-display`, and
`rate-state`.

### Integration suites — `npm run test:integration`

**223 tests across six suites**, all requiring a local Supabase stack.

| Suite | Tests | Covers |
|---|---|---|
| `lib/residuals/reference-data.integration.test.ts` | 62 | R5c: risk tiers, fee items, buy rates, the `*_for_month` resolvers, EXCLUDE overlap, function grants |
| `lib/residuals/verdicts.integration.test.ts` | 68 | R6a: three steps, exemptions, tolerances, acknowledgments, status derivation, sign-off/reopen, volume guards, grants |
| `lib/residuals/grid-synopsis.integration.test.ts` | 38 | R6b: `residual_grid_rows`, the synopsis suppression rule, volume row, manual entry, period history, grants |
| `lib/residuals/calc-engine.integration.test.ts` | 26 | R5d pt 2: the engine, failure reasons, group rules, recompute safety |
| `lib/residuals/merchant-link.integration.test.ts` | 22 | R5b: resolution, re-adjudication, retention, the ungated kernels |
| `lib/marketing/campaigns.rls.integration.test.ts` | 7 | not residuals — campaign RLS |

### Fixture discipline

Four rules, all enforced by tests rather than convention:

**1. Every scratch MID lives in one `MID` registry object.** Never introduce one
inline — the guard cannot check what it cannot see.

**2. Every MID is exactly twelve digits and distinct.** The reasoning, quoted
from `grid-synopsis.integration.test.ts`:

> ```
> // SHAPE RULE: every value is exactly TWELVE digits and distinct. Two distinct
> // strings of equal length cannot be suffixes of one another, so accidental
> // suffix collision against R5b's resolver is arithmetically impossible.
> ```

This matters because R5b suffix-matches against `lead_gen_threads`, so a
collision would surface as a confusing failure in a **different** suite.

**3. Guard tests are declared first.** `describe("fixture invariants", …)` is the
first block in both R6 suites. Three guards: no accidental suffix relation among
scratch MIDs (with an explicit `INTENTIONAL_SUFFIX_PAIRS` allowlist that is empty
where none are intended), the twelve-digit shape rule, and — the important one —
**no scratch MID collides with data the suite did not create**, checked in both
directions against live `residual_lines` and `residual_merchant_volumes` outside
the suite's own period.

**4. The period-month axis is partitioned, and months are claimed.** Each suite
owns months no other uses, and this is written down where someone adding a suite
will read it:

> ```
> // Months no other suite uses. 2097/2098/2099 are taken by the R5b and reference
> // suites, 2026-03 by the calc-engine suite, and 2026-05/07 are real data.
> const MONTH_MAIN = "2094-01-01";
> const MONTH_SIGN = "2095-01-01";
> const MONTH_EMPTY = "2096-01-01";
> const MONTH_UNCOVERED = "1999-01-01";
> ```

`MONTH_UNCOVERED` sits before the tolerance floor sentinel (2000-01-01)
deliberately, so the resolver has nothing to return — the only way to exercise
the raise without editing the live seed. Grid-synopsis takes 2093.

**Claim your months before adding a suite**, and add the stale-user purge:
`purgeStaleTestUsers(pattern)` in `lib/test/db.ts`, called first in `beforeAll`,
with a suite-specific prefix on a reserved domain (`@tapdash.test` or
`@test.local`). It refuses any other pattern shape.

### Two patterns that caught real defects

**`ctid` as a write detector inside a single transaction.** From
`merchant-link.integration.test.ts`:

> ```
> // WRITES ARE DETECTED WITH ctid, NOT thread_matched_at. The reconcile UPDATE
> // stamps thread_matched_at with now(), which is TRANSACTION-START time. Every
> // write inside one transaction therefore carries the same timestamp, and the
> // column reads identical whether a row was retained or rewritten. ctid changes
> // on every heap UPDATE and is the only reliable discriminator here.
> ```

This is what proves the no-op guard actually suppresses a write rather than
performing an identical one. A timestamp assertion would have passed either way.

**Asserting composition rather than counts.** From
`reference-data.integration.test.ts`:

> ```
> // Composition, not just a count: R5c's full 4 x 11 grid is present, and the
> // only rows beyond it are the ones a later migration deliberately added.
> ```

The test enumerates every `fee_item_key:risk_tier` pair the seed must contain,
then asserts that the **extras** are exactly the set a named later migration
added. A count assertion passes when one row is deleted and another added; this
one does not. Use it anywhere a seed's shape matters.

---

## Where to start

If you are picking this up cold:

1. Read `residuals.md` §1–§5 — the chain, the sign convention, the two rate
   tables, and the twenty rules. Nothing else makes sense without them.
2. Open `/admin/residuals/reconcile` on 2026-05 and look at the suppressed total
   and the 19 mismatches. That is the module doing its job.
3. Get **one merchant-month with both a fee report and a statement** (§6). It is
   the smallest change that unblocks the most: step 1, both composites, rule #12,
   the EBT bucket-membership conflict, and the first period that could compute
   cleanly enough to disclose a figure.
4. Enter `monthly_fee_tapdash` for the merchants that have one, and settle the
   PCI question. Those two account for most of the current mismatch surface.
