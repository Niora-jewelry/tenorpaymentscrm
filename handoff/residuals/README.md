# Residuals — handoff

**For:** Patrick, taking over the Residuals module.
**Written:** 16 October 2026, from the code, the database and the spec as they are on that day. Where this document and the code disagree, the code is right and this document is stale — please fix it here.
**Repo:** `tapdash-new-crm`, branch `main`. Everything below is relative to the repo root unless it says otherwise.

This folder is the one place the residuals knowledge lives *inside git*. Everything else — `docs/`, `HANDOVER/`, every other `*.md` — is gitignored on purpose and will not be on your machine after a clone. The three files in `spec/` are the original specification the code cites by section number (`residuals.md §6.6` and so on); they were written by Daniel Weissman, who built the first version in a separate codebase, and they are **the** reference. Read them.

---

## 0. Read this first — the ten things that matter most

1. **What the module does.** Each month the processor (Maverick) sends a *fee item report* (Excel, one row per merchant per fee). The module recomputes what TapDash should have earned on every row from TapDash's own rate tables, compares it to what the processor paid, and produces what TapDash banks. `spec/residuals.md §1` has the chain; §0 of this document has the short version.
2. **Everything is admin-only.** Every table, every RPC, every screen, every server action. The one exception is read access to `residual_plan_code_buckets`. A non-admin sees "admin only" on the record tab. Widening this is a client decision nobody has made (migration `…009742` header).
3. **Money is computed in SQL, never in TypeScript.** The engine is one function, `compute_residual_period`. The app sends inputs and receives decimal *text*. No client code does arithmetic on money. Keep it that way.
4. **Fail loud, never zero.** A missing rate is a recorded *failure*, not a 0. The engine's failure counts are the module working correctly, not a bug (§4 below). Before you "fix" a failure count, find out which of the three documented causes it is.
5. **The live state today: August 2026, 293 of 397 lines computed, 86 refused.** Of the refusals, 59 are statements Izzy has not sent, 28 are genuinely empty cells on his pricing sheet, 3 are MIDs missing from the sheet. None is a code defect.
6. **The database is live and shared with production.** Izzy and his staff work in it every day. The residual tables are the same ones the client will be paid from. Probe only with scratch data you create and remove; every existing verify script does exactly that.
7. **Migrations are applied by script and must be recorded** (`CLAUDE.md § Database`). `node --env-file=.env scripts/apply-migration.mjs supabase/migrations/<file>.sql` does both halves. File count must always equal `select count(*) from supabase_migrations.schema_migrations` (165 = 165 today). Never `supabase db push`, never the dashboard SQL editor — `spec/residuals.md §10` explains the trap.
8. **The specification is partly outside the repo.** Daniel's spec is copied into `spec/` here. The client's original Word documents, Izzy's written answers and the real data files are on brimesh's machine, not in git (§8 below — ask for them).
9. **The in-repo docs are wrong about Residuals.** `HANDOVER/WHATS-REMAINING.md`, `remaining-plan.md`, `docs/BUILD-STATUS.md`, `docs/PROTOTYPE.md` and the prototype code all still say "Residuals is frozen, do not build". That was true until 29 September 2026. It has been built since. Ignore those sentences.
10. **The next real piece of work is Tab 4, vendor payouts / partner splits**, which was deliberately never built (§6). Everything it needs in the schema exists and is empty.

---

## 1. The model in one page

### 1.1 The chain (`spec/residuals.md §1`)

For every fee line on the processor's report, six values, in order:

```
Total Income           what TapDash charges the merchant for this item      (merchant rate × operand)
Total Buy Rate         what the processor charges TapDash for it            (template rate × operand, capped)
Pre-split net          Income − Buy Rate                                    ← the number RECONCILED against the processor
TapDash net after split  pre-split net × tapdash_share                      (0.90 / 0.90 / 0.80 / 0.70 by risk tier)
Additional Income Direct  things TapDash bills itself (e.g. the monthly fee)
Net Income             after-split + additional income                      ← what TapDash banks
```

Every value is rounded to 2dp per line (`§6.1`). `tapdash_share` is **not** the partner split — the partner stage (Tab 4) comes after Net Income and is unbuilt.

### 1.2 Where each input comes from

| Input | Table | Entered how |
|---|---|---|
| Fee lines (`item_count`, `amount`, `net_revenue`…) | `residual_lines` | Excel fee-report import (`/admin/residuals` → Import) |
| Merchant volumes (VMD / Amex / Debit / EBT buckets) | `residual_merchant_volumes` + `residual_plan_volumes` | PDF statement import (→ Statements) or typed by hand |
| Merchant sell rates (what TapDash charges), effective-dated | `residual_merchant_rates` | Rates-sheet import (→ Merchant rates), the per-merchant Rate editor, or the record's **Pricing tab** (synced automatically) |
| Processor buy rates (what Maverick charges), by risk tier | `residual_buy_rates` + `_schedules` + `_tiers` | Seeded; admin screen (→ Buy rates) |
| Which formula each fee item uses | `residual_formula_registries` → `_rules` → `_terms` | Seeded by migration. 47 rules across 2 registries (live Maverick + the pre-changeover predecessor), 13 of them `is_provisional` |
| Risk tier per merchant | `residual_risk_tiers`, `residual_merchant_rates.risk_tier` | From the Pricing tab's Risk Level, or the rates sheet |
| Tolerances for match/mismatch | `residual_verdict_tolerances` | Seeded, 0.05 all three steps |

### 1.3 The three reconciliation steps (`spec/residuals.md §12`, migration `…009730`)

- **Step 1** — statement volumes vs fee-report volumes (do the two documents agree about how much the merchant processed?). *Measured for the first time on 8 Oct: 14 match, 2 mismatch.*
- **Step 2** — computed pre-split net vs the processor's `net_revenue` per line.
- **Step 3** — the same at group level (lines that must be read together, e.g. Cash Discount groups).

A difference inside tolerance is `match`; outside is `mismatch`; a mismatch an admin has explained is `acknowledged` (with a reason, append-only). When every merchant is clean the month is `signable`; sign-off sets `residual_periods.status = 'reconciled'` and locks every input that fed it.

### 1.4 Merchant and period states

`residual_merchant_states` ladder: `blocked` (no rates) → `awaiting_volumes` → `mismatch` → `ready` → `reconciled`. `residual_period_state` is the minimum over merchants. The period `status` column only ever holds `open` or `reconciled`; everything else is derived.

### 1.5 How a merchant on the CRM connects to a MID on a report

Residual rows carry the **MID as text** (digits only), never a foreign key. `records.values->>'mid'` is unique per live record (migration `…009701`). A link kernel (`residual_resolve_mid`, `…009706`) matches by exact MID, then by suffix, and stamps `record_id` + `thread_match` (`exact | suffix | manual | ambiguous | unmatched`) on lines and volumes. Saving a MID on a record re-links automatically (trigger on `records`). The admin "Links" tab is the worklist for the rest.

---

## 2. Where everything is

### 2.1 Screens

| URL | File | What it is |
|---|---|---|
| `/admin/residuals` | `src/app/(app)/admin/residuals/page.tsx` + `ResidualsTabs.tsx` | The admin home. Eight tabs: **Merchants** (per-merchant queue for the latest month), **Import** (fee report wizard + history), **Statements** (batch PDF upload), **Merchant rates** (sheet import, dry run then commit), **Periods** (compute button, coverage check), **Calculation** (rules, splits, outstanding items), **Buy rates** (processor template), **Links** (MID ↔ record worklist). |
| `/admin/residuals/<periodId>` | `…/[periodId]/page.tsx` + `Reconciliation.tsx` | One month's reconciliation grid: verdicts per step, acknowledge / withdraw, sign-off / reopen, timeline. Opens `RateEditor.tsx` and `VolumeEditor.tsx`. `?mid=` focuses one merchant. |
| Record drawer → **Residuals** tab | `src/app/(app)/[module]/ResidualsPanel.tsx`, data from `src/lib/records/recordResiduals.ts` | Figures for *this* merchant: per month and lifetime. Only on the Residuals module (tab `residual_figures`, migration `…009742`). Admin-only. |
| Record drawer → **Pricing** tab | generic field tab | 16 of its 50 fields are the merchant's sell rates and feed `residual_merchant_rates` through `residual_sync_rates_from_record` (`…009739`). |
| Sidebar "Residuals admin" | `src/app/(app)/Sidebar.tsx:301-315` | Entry point (admins only). |

### 2.2 Data layer (`src/lib/`), all `server-only`, all take `ctx: AuthContext`

| File | Role |
|---|---|
| `records/adminResiduals.ts` | Admin home data: periods, reference summary, link worklist, buy rates, processors |
| `records/residualImport.ts` | Excel fee-report import: saved column mappings, preview, commit (`commit_residual_excel_import`), `ensurePeriod`, `computePeriod` |
| `records/residualStatements.ts` | PDF statement import: parse + verify totals, commit per file (`commit_residual_pdf_import`) |
| `records/residualRates.ts` | Rate editor, versions, supersede, update row, coverage, sheet import preview/commit |
| `records/residualVolumes.ts` | Manual volume entry, mapping coverage. *Header comment is stale: it predates the PDF parser.* |
| `records/residualGrid.ts` | Grid rows, merchant states, synopsis, history, period header, merchant dashboard |
| `records/recordResiduals.ts` | The drawer tab's figures (keyed by MID, not record_id) |
| `residuals/mapping.ts` | Fee-report column → `residual_lines` column mapping (14 targets; `buy_rate_per_item` is poisoned on purpose) |
| `residuals/xlsxParser.ts` | SheetJS wrapper; finds the header row; `readNumeric` accepts `$`, `,`, `(x)`, refuses junk |
| `residuals/statementParser.ts` | Maverick PDF plan-code table parser by **x/y coordinate** (text flow is unreliable); `verifyTotals` must sum exactly to the `**` row |
| `residuals/pdfLoader.ts` | `pdfjs-dist` text positions (no `pdftotext` binary on Vercel) |
| `residuals/rateImport.ts` | The rates sheet: 20 keys, two-row header, **three-state cells** (`§6.6`: number = rate, `"$ -"` = declined → stored 0, blank = absent → NULL, must fail loud) |
| `residuals/rates.ts`, `volumes.ts`, `reconciliation.ts` | Client-safe field lists, labels, types |

Two Supabase clients, deliberately: `supabaseAdmin()` (service role, after an in-code `assertAdmin`) for plain table reads/writes; `createSupabaseServerClient()` (the signed-in user) for every SECURITY DEFINER RPC, because those check `auth.uid()` + `auth_is_admin()` and refuse the service role.

### 2.3 Server actions

All under `src/app/(app)/admin/residuals/`: `actions.ts` (links), `importActions.ts`, `rateImportActions.ts`, `statementImportActions.ts`, `[periodId]/actions.ts` (verdicts, sign-off), `[periodId]/rateActions.ts`, `[periodId]/volumeActions.ts`. Every one Zod-parses its input and refuses a non-admin; `actions.guards.test.ts` fails the build if a new one doesn't.

### 2.4 Database

Migrations `supabase/migrations/20260819009699` → `…009749`, plus `…009754`. Daniel's raw originals are in `docs/residuals-port/*.sql` (gitignored; on brimesh's machine) with the porting script `port_residuals.py`. The full table-by-table and function-by-function reference is §9 of this document.

### 2.5 Scripts (`scripts/`, none in `package.json`, all need `SUPABASE_DB_URL` in `.env`)

| Script | What | Run |
|---|---|---|
| `import-august-2026.mjs` | The real August fee report → `commit_residual_excel_import` → compute | `node --env-file=.env scripts/import-august-2026.mjs [--remove]` |
| `import-merchant-rates.mjs` | `Merchant Mastersheet.xlsx` → rates effective 2026‑08‑01; derives tier from the report's `Agent %` | `… scripts/import-merchant-rates.mjs` (dry run) / `--commit` |
| `import-statements.mjs` | A folder of PDF statements → one `commit_residual_pdf_import` each → compute. Skips a file whose totals don't sum | `node --import tsx --env-file=.env scripts/import-statements.mjs <dir> [--commit]` |
| `seed-residuals-demo.mjs` | Demo month on four real records; tagged, idempotent | `… [--remove]` |
| `verify-residuals-engine.mjs` | Engine vs Daniel's hand-computed figures, all six values | `node --env-file=.env scripts/verify-residuals-engine.mjs` |
| `verify-residuals-link.mjs` | Link kernel ungated+unreachable; six operator entry points admin-gated | same pattern |
| `verify-residuals-rate-sync.mjs` | Pricing tab → rates; a change today never changes a computed month | same pattern |

File paths default to `C:/Users/brime/Downloads/Response_to_Residual_Request/` and can be overridden with `RESIDUAL_DIR` / `FEE_REPORT`.

### 2.6 Tests

Unit (`npm test`): `src/lib/residuals/{mapping,xlsxParser,statementParser,rateImport,money}.test.ts`, `src/app/(app)/admin/residuals/actions.guards.test.ts`.
Integration (real DB, skipped without `SUPABASE_DB_URL`; run by `npm run verify`): `src/lib/residuals/{adminOnly,audit,import,merchantDirectory,rateImport,rates,reconcile,recordTab,statementImport,step1,volumes}.integration.test.ts`. Each creates scratch data inside a transaction or tagged rows and removes them.

`npm run verify` (typecheck + lint + all tests) and `npm run build` before any PR.

---

## 3. How to run it end to end on your machine

1. Clone, `npm install`, get `.env` from brimesh (Supabase URL, anon key, service role key, `SUPABASE_DB_URL`). Note `.env` points at the **live** database; there is no staging copy.
2. `npm run dev -- -p 3221`, sign in as an admin (brimesh will give you one; `admin@tapdash.test` is the test admin the verify scripts use — they reset its password).
3. `/admin/residuals` → **Periods**: August 2026 is there, `open`, with 7 calc runs. Press **Compute** and watch the run appear in the history (nothing changes: same inputs, same 293/86).
4. Open the month → the grid. Filter `?mid=201100241497` to see a real step‑1 mismatch (1.34 out, left visible on purpose).
5. Open any Contacts record with a MID → **Residuals** tab → its figures. Change a rate on its **Pricing** tab → a new dated row appears in `residual_merchant_rates` (today's month only; August is locked).
6. To re-import from the files (ask for the folder first): `node --env-file=.env scripts/import-merchant-rates.mjs` (dry run), then `node --import tsx --env-file=.env scripts/import-statements.mjs <dir>` (dry run). Both print exactly what they would do.

Expect each page to take 2–5 s on dev: the database is remote and every residual page runs several SECURITY DEFINER RPCs.

---

## 4. The live state on 16 October 2026 — and why the numbers are what they are

| | |
|---|---|
| Periods | 1: **August 2026**, status `open`, `calculation_version` NULL (not clean) |
| Imports | 8 completed: 1 Excel fee report (397 rows) + 7 PDF statements |
| Lines | 397; **293 computed, 86 refused** across 44 merchants computed / 3 failed |
| Merchant rates | 68 live rows across 51 MIDs: 48 effective 2026‑08‑01 (the Mastersheet import) and **20 effective 2026‑10‑01** — successor rows opened automatically by Pricing-tab edits staff made this month (`…009739`). August still reads the August rows; that is the lock working |
| Volumes | 7 merchant-volume rows, all from the 7 PDF statements (`source = 'pdf'`) |
| Partners | 6 rows seeded; `residual_mid_partners` and `residual_merchant_vendor_costs` **empty, read by nothing** |
| Audit log | 656 rows |

**The 86 refusals** (`residual_calc_failures`, latest run):

| Reason | Count | Cause | Who fixes it |
|---|---|---|---|
| `no_volumes` | 59 | Volume exists only on the statement; Izzy sent **7 of 47** statements | Izzy sends the PDFs → Statements tab, or `import-statements.mjs` |
| `missing_merchant_rate` | 28 (27 line + 1 group) | Genuinely empty cells on the pricing sheet. 18 are `monthly_fee_tapdash`, which `§6.7` says must never be auto-zeroed | Izzy fills the sheet → re-import, or the Rate editor |
| `no_merchant_rates` | 3 | MIDs absent from the Mastersheet pricing tab, incl. the held-back duplicate (§6, item 7) | Izzy |

These are **the engine refusing to invent money**. Don't code around them.

**Known-correct non-reconciliations** (leave visible): MID `201100241497` step 1 is 1.34 out and its Interchange row states 0.00 volume; one PCI row is billed 9.95 directly and stays a step‑3 mismatch; the `Monthly Fee` rule reads income 0 post-changeover (registry note on 2026‑06); Orlando Baking `201100169797` is parked (`§6.9`, `§8` gap 7).

---

## 5. Decisions already made — do not reopen without the client

Each has a source; the migration headers carry the reasoning in full.

**From the spec (`spec/residuals.md §6`, "Decisions of record")**
- §6.1 tier share per line, 2dp per line. §6.2 the monthly fee is billed by TapDash itself: rule #2 income 0 / buy 0, fee becomes Additional Income. §6.3 rules #14‑16 are "$0 for the moment", `is_provisional`. §6.4 the Batch Fee template (0 / 0.01 / 0.025 / 0.04) is correct, don't edit. §6.5 merchant rates come from the **.xlsx**, never the CSV (CSV = 100× scale error). §6.6 three cell states. §6.7 `monthly_fee_tapdash` never auto-zeroed. §6.8 changeover boundary not tuned; per-merchant dates live on `residual_merchant_rates`. §6.9 Orlando parked; `lease_payments_tapdash` is not income. §6.10 `monthly_fee_combined` retired (`…009721`). §6.11‑12 vendor rate cards: Paya is two cards, card updater has no rate, cap grain per item.

**From the handoff (`spec/residuals-handoff.md §3, §5`)**
- Fail loud, never zero. `tapdash_share` ≠ partner split. MID is text, not an FK. Money crosses to the client as text. Q35: a chargeback reversal (Tran Code B) does not refund the fee. Q36=B: steps 2 and 3 use ±0.05.

**Made in this repo (commit → migration)**
- `ef044d3` port: Daniel's R2 and R5d‑1b drawer migrations were not ported; `tapdash_share` lives on `residual_buy_rate_tiers`.
- `cb4d15b` / `…009739`: **Izzy's Option A** — the Pricing tab is the source of truth for rates; an edit opens a dated successor row; a change today must not change what a computed month says. 28 of the 50 Pricing fields are vendor costs for the unbuilt partner stage.
- `7759c2e`: admin vs super-admin mismatch closed — route, RLS and functions all use `auth_is_admin()`.
- `77a24c1` / `…009745`: **PCI settled** (Izzy: "works just like the others, disregard 'merchant pays it directly'"). Rule #6 gets a buy term at `template.pci_fee`, no income term. Seven August fee items mirrored as provisional rules. `Buy Rate Per Item` deliberately not mapped (the report rounds it to 2dp).
- `96ad4e3` / `…009746`: a PDF import is keyed on (processor, period, MID); statements parsed by Y coordinate; the `**` total must sum exactly.
- `73521e5`: `readRateCell` three states; `--fix-in-place` route on the import script.
- `b70d99d` / `…009747`: step 1 measured. BIN Sponsorship assessed **net of refunds** and includes Amex exactly when there is no Cash Discount line (`applies_when = 'sibling_absent'`). Tolerance stays 0.05, now measured not guessed.
- `586817f` / `…009749`: merchant dashboard composes existing data, computes nothing new; name conflicts are reported, not resolved; **Tab 4 deliberately not built**.
- `663915e`: 26 of 27 residual tables have RLS **enabled but not forced**; only `residual_audit_log` is forced. Intentional; the integration test asserts every table has RLS with a policy.
- `…009742`: who may see merchant figures is **deliberately not decided** — stays admin-only until the client says otherwise.
- Case deletion / user purge decisions are unrelated to residuals; see brimesh.

---

## 6. What is NOT built, and the open questions — your work queue

Ordered by what unblocks the most money.

1. **Tab 4 — Vendor payouts / partner splits.** The partner stage after Net Income. Schema exists and is empty: `residual_partners` (6 seeded: Gershy Tress .5, Chaim Birnhack .5, Mendy Blobstein .5, Hershel Laufer .3, TapDash 0, H&H 0), `residual_mid_partners` (MID × partner × split, effective-dated, EXCLUDE on overlap), `residual_merchant_vendor_costs` (effective-dated vendor fees per MID; the 28 Pricing-tab vendor fields are its natural source). **The formula is explicitly undecided** (`…009707` partners section: "Partners take their cut AFTER net revenue, and the exact formula is explicitly NOT decided"). First step is a written formula from Izzy, then an engine extension, then a screen. `spec/residuals-handoff.md §7 "Tab 4"` and `spec/residuals.md §13 "R6 … partner payouts"`.
2. **The other 40 statements** (47 merchants, 7 received). Not a code task; a request to Izzy. Each one received removes `no_volumes` lines. The Statements tab accepts a batch.
3. **Chargeback rule on the PDF statement.** `spec/r5f-chargeback-rule-pending.md`: count Tran Code `C` rows on the statement. Today the rule mirrors the fee-report row only (`…009745:79‑84` says the statement-based rule "remains the right implementation"). Izzy has sent a statement with a chargeback ("Attached" in his answers) — it is in the data folder. The parser (`statementParser.ts`) reads only the plan-code table today; the transaction list is a second table.
4. **EBT bucket membership** — does EBT belong inside the BIN and Cash Discount sums? Unarbitrated because none of the 7 statements carries EBT volume (`…009747:52‑56`). The first statement from an EBT merchant settles it; then adjust `residual_volume_row_mappings`.
5. **Monthly-fee changeover date** (`§6.2`, `§8` gap 3). The predecessor registry ends `2026‑06‑01` as a **placeholder** (`…009710`). Per-merchant effective dates go on `residual_merchant_rates`.
6. **House Of Tacos, MID `30119900929`** — listed twice in the Mastersheet with different volume rates (0.047619 vs 0.038462) and a note "We need to change to 4.76%". Held back in `scripts/import-merchant-rates.mjs` (`HELD_BACK`). Izzy decides; remove the entry and re-run. This is one of the 3 `no_merchant_rates`.
7. **Second processor.** Every line is computed under the given processor's registry — correct while there is one. `…009715:369`: a second processor needs a `processor` column on `residual_lines` and a filter (a migration). `residual_imports.processor` has already drifted in case (`'Maverick'` vs `'MAVERICK'`) — normalise when you touch it. `spec/residuals-handoff.md §7` lists the four requirements.
8. **Calculation version stays NULL** for August until every refusal is cleared or acknowledged; the synopsis and record tab withhold money on a partial month by design (`§12`). Nothing to build — know why the totals are blank.
9. **Access widening.** Record-tab figures for non-admins; a top-level sidebar module instead of `/admin/residuals`. Both client decisions (`…009742` header; handoff §7).
10. **Other `§8` gaps**: Batch Fee variance (observation only); buy rates matching no tier; MID 201100169797 BIN row irreconcilable; manual lines carry no processor.
11. **Deliberately excluded** (handoff §5): a manual-override column, a free-text Notes column on lines, a program dimension for Batch Fee. Don't add them without the client.

**Housekeeping you will trip over (safe, small, do them early):**
- Stale comments that predate the PDF parser: `src/lib/records/residualVolumes.ts:5‑13`, `src/app/(app)/admin/residuals/[periodId]/volumeActions.ts:5‑13`, `…/admin/residuals/page.tsx:5‑11`.
- `ReferenceSection.tsx:27‑28, 155‑161` still lists "the PCI question" as unresolved and always shows it as outstanding; PCI was settled in `77a24c1`.
- `…009743` header says the PDF importer is not yet writing `source = 'pdf'` rows; it is. The audit trigger's "condition 1" applies only to `residual_lines`; check whether statement imports should be exempt the same way.
- `records_relink_residuals_upd` and `records_sync_residual_rates` fire only on `UPDATE OF values`; soft-deleting a record does not relink its MID.
- In-repo docs saying "frozen": `HANDOVER/WHATS-REMAINING.md:77‑81`, `remaining-plan.md:658‑660`, `docs/BUILD-STATUS.md:558`, `docs/PROTOTYPE.md:41`, `src/proto/modules.ts:274‑284`. `modules.frozen` is still `true` on the Residuals row; it gates nothing (`adminPresets.ts:29‑33`), only shows a warning chip in Presets.

---

## 7. How to work on this safely

- **Permission in three places, always.** App (`assertAdmin` / `ctx.isAdmin`), SQL function (`auth_is_admin()` at the top of every DEFINER body), RLS policy. `adminOnly.integration.test.ts` and `actions.guards.test.ts` enforce the pattern — a new action or RPC that forgets will fail the suite.
- **Every `SECURITY DEFINER` function pins `set search_path = public, pg_temp`** (`CLAUDE.md §8`).
- **No code names a module** (`CLAUDE.md §1`). Residuals is a row in `modules`; there is no `if (slug === 'residuals')` anywhere and there must not be. Per-module behaviour is a column or a junction row.
- **Locks.** A computed month locks the merchant rates, buy-rate schedules and tolerances that fed it (`*_guard_locked` triggers). To change a past month's rate you *supersede*: a new dated row, old row closed. The Rate editor does this for you; the triggers refuse an in-place edit with 42501.
- **Reconciled months are immutable.** Every residual input table has `guard_reconciled` triggers. Reopen first (`residual_reopen_period`, needs a reason), change, recompute, sign off again. Acknowledgments survive a reopen.
- **Status changes go through a GUC token** (`residuals.status_transition = '<id>:<status>'`). You cannot `update residual_periods set status` directly; use `residual_sign_off_period` / `residual_reopen_period`.
- **Engine columns are machine-owned.** `total_income`, `total_buy_rate`, `tapdash_net_before_split`, `tapdash_net_after_split`, `additional_income_direct`, `net_income`. The audit trigger ignores changes to them; everything else a person edits is logged with before/after JSON.
- **Imports replace, with a sweep.** A second completed Excel import for the same (processor, period) soft-deletes the first's lines; a second PDF for the same (processor, period, MID) soft-deletes that merchant's volumes only. Unique partial indexes enforce one live completed import per key.
- **Vocabulary** (`CLAUDE.md`): Archive / Delete / Purge mean specific things. "Statements" is the month-grid file tab on every record (Module 2, `statement_files`); it is *not* the residual PDF import, which lives in `residual_imports`. Both exist; don't merge them.
- **Probing the live DB:** create scratch rows you can identify (`ZZ …` names, a tag), delete them at the end, compare counts before/after. The existing verify scripts are the template. Never delete or edit a client row to test.

---

## 8. Things that live outside git — ask brimesh for them

| What | Where today |
|---|---|
| Real August data: `Tapdash_LLC_Fee_Item_Report_August_2026.xlsx`, `Merchant Mastersheet.xlsx` (two-row header; **use the .xlsx, never the .csv**), 7 `Statement-<MID>-08-2026-001.pdf`, `Brimesh Residual Request.docx` (Izzy's written answers) | `C:\Users\brime\Downloads\Response_to_Residual_Request\` — contains merchant financial data, so it is not in git |
| Daniel's original residuals codebase (the port source, 38 migrations, his verify scripts) | `D:\updated-crm-main-old-izzy\updated-crm-phone-module\updated-crm-residuals\` |
| Daniel's raw SQL as ported + `port_residuals.py` | `docs/residuals-port/` (gitignored) |
| The client's original Word specs (`2 - Modules.docx` §4.6, `11 - READ FIRST OVERVIEW.docx`, `1 - Login page.docx`) and `CLIENT-SPEC-BY-MODULE.md` | `D:\CRM Updates-…\CRM Updates\` and `HANDOVER/` (gitignored) |
| Brimesh's working notes on data gaps and open client questions | brimesh's own notes; summarised in §4 and §6 here |

Izzy's role: client and the only person who can supply statements, fill the rates sheet, and decide items 1, 4, 5, 6 and 9 in §6. He has already said (commit `cb4d15b`) that the Pricing tab is the source of truth, and (Oct 2026) that PCI "works just like the others".

---

## 9. Reference — database

### 9.1 Tables (all `residual_*` rows: `id uuid pk`, audit columns `created_at/by`, `updated_at/by`, `deleted_at/by`, soft delete; RLS enabled; SELECT/INSERT/UPDATE policies `auth_is_admin()`; no DELETE policy)

| Table | Grain / purpose | Key columns & rules |
|---|---|---|
| `residual_periods` | one row per statement month | `statement_month` (day 1, unique live), `status` ∈ `open, reconciled` (GUC-guarded), `calculation_version` (NULL = not clean), `notes` |
| `residual_imports` | one row per uploaded file | `processor`, `source_type` ∈ `excel, pdf, rate_sheet…`, `status` ∈ `pending, processing, completed, failed`, `mid` (PDF only, digits), `row_count`, `error_message`. Unique live completed per `(processor, period, source_type≠pdf)` and per `(processor, period, mid)` for PDFs. `storage_path` unused |
| `residual_lines` | one fee line | `mid`, `fee_item_name`, `fee_category`, stated `item_count/amount/net_revenue/agent_*`, the 6 engine columns, `source` ∈ `excel, pdf, manual`, attribution `root_agent/agent_owner/agent/branch`, link `record_id/thread_match/thread_matched_at/thread_confirmed_by_id` |
| `residual_merchant_volumes` | MID × period volumes | 4 buckets `amex/vmd/debit/ebt_volume` + `_item_count` + `_credits`, `stated_total`, `stated_item_count`, `reconciled`, `unmapped_volume`, `source` ∈ `pdf, manual`; unique `(period, mid)` |
| `residual_plan_volumes` | MID × period × plan code | `plan_code`, `volume_bucket` (nullable), `amount`, `item_count`, `credit_amount/count`; unique `(period, mid, plan_code)` |
| `residual_plan_code_buckets` | plan code → bucket | seeded; **SELECT open to any authenticated user** |
| `residual_column_mappings` | saved Excel header → target | `processor`, `source_column_header`, `target_column` (14 allowed) |
| `residual_risk_tiers` | tier vocabulary | `tier_key` (`no_program, low, medium, high`, + `vendor_flat` pseudo-tier), `drawer_option`, `statement_code` 1‑3, `is_risk_tier` |
| `residual_fee_items` | fee item vocabulary | `fee_item_key`, `label`, `rate_kind` ∈ `amount, rate`, `billed_directly_to_merchant` (PCI now `false`), `vendor_cost_slot` |
| `residual_buy_rate_schedules` / `_tiers` / `_rates` | processor template, effective-dated | schedule per `(processor, daterange)` EXCLUDE; tier `(schedule, risk_tier) → tapdash_share`; rate `(schedule, tier, fee_item_key) → rate, rate_cap`. Locked once a computed month uses it |
| `residual_merchant_rates` | TapDash sell rates per MID, effective-dated | 14 rate columns (`vmd_auth_fee … chargeback_fee`), `risk_tier`, providers, EXCLUDE on `(mid, daterange)`; locked once computed; only real risk tiers allowed |
| `residual_formula_registries` / `_rules` / `_terms` | the 20(+7) rules | registry per `(processor, daterange)`; rule per `fee_item_name` with `group_key`, `is_group_anchor`, `is_provisional`; term = `side` ∈ `income, buy_rate, additional_income` × `operand` × `rate_source` ∈ `merchant, template, literal, net_revenue` × `applies_when` |
| `residual_line_groups` | group-level results | `(period, mid, group_key)`, 6 engine columns, `stated_net_revenue`, `member_line_count` |
| `residual_calc_failures` | why a line/merchant/group was refused | `scope`, `reason_code` ∈ `no_merchant_rates, missing_merchant_rate, missing_template_rate, no_volumes, missing_line_input, unknown_fee_item, group_no_anchor_line, unusable_mid`, `detail`, `rate_ref`. Rewritten every run |
| `residual_calc_runs` | append-only run log | counts, `failures_by_reason` jsonb, `summary` jsonb, `stamped` |
| `residual_verdict_tolerances` | per step, effective-dated | 0.05 × 3 seeded; locked by a reconciled month |
| `residual_volume_row_mappings` | which bucket a rule's volume compares to (step 1) | `rule_id`, `volume_bucket`, `applies_when`, `sibling_fee_item_name`, `basis` ∈ `gross, net` |
| `residual_verdict_acknowledgments` | append-only explanations of mismatches | `scope`, `step`, `delta_acknowledged`, `reason`, `retired_at/reason` ∈ `resolved, superseded, withdrawn`; one active per (line|group, step) |
| `residual_period_status_log` | append-only | `from_status`, `to_status`, `source` ∈ `engine, signoff, invalidation, reopen, system` |
| `residual_audit_log` | manual-edit trail (trigger-written) | `table_name`, `record_id`, `action`, `changed_fields`, `before_data`, `after_data`; **FORCE RLS** |
| `residual_partners`, `residual_mid_partners`, `residual_merchant_vendor_costs` | the unbuilt partner stage | see §6 item 1 |
| `statement_periods`, `statement_files` | Module 2 Statements tab (not residuals) | month grid Jul 2024–Dec 2032, ≤5 files/month, 25 MB |

Storage bucket `residual-files` (private, admin policies) exists but nothing writes to it.

### 9.2 Functions (all SECURITY DEFINER + admin gate + `search_path` pinned unless noted)

| Area | Functions |
|---|---|
| Import | `commit_residual_excel_import(import, period, rows jsonb)` → `{inserted, swept}`; `commit_residual_pdf_import(import, period, merchant jsonb, plan_rows jsonb)`; `residual_derive_plan_rollup` (invoker, pure) |
| Link | kernel `residual_resolve_mid`, `residual_reconcile_mid_links` (no gate, **service_role only**); trigger `tg_records_relink_residuals`; operator `residual_link_worklist`, `_preview_mid_link`, `_link_mid_to_record`, `_confirm_mid_link`, `_unlink_mid`, `_sweep_mid_links` |
| Rates | `residual_merchant_rates_for_month`, `_merchant_rate_coverage`, `_merchant_rate_is_locked` (no gate), `_supersede_merchant_rate`, `_merchant_rate_versions`, `_merchant_rate_editor`, `_update_merchant_rate_row`, `_standing_merchant_rates`, `commit_residual_merchant_rates_import` (all-or-nothing, ≥0.10 refused as percent-scaled), `residual_preview_merchant_rates_import` (dry run in a discarded subtransaction), `_merchant_rate_unchanged` |
| Buy rates | `residual_buy_rates_for_month` (raises if no schedule), `_buy_rate_coverage`, `_buy_rate_schedules_list`, `_supersede_buy_rate_schedule`, `_buy_rate_schedule_is_locked`, `_template_rate_refs`, `_buy_rate_processors`, `_formula_registry_for_month`, vendor: `_vendor_card_lookup`, `_merchant_vendor_costs_editor`, `_update_/_supersede_merchant_vendor_costs` |
| Engine | **`compute_residual_period(period, processor)`** → jsonb summary; `residual_eval_side` (invoker, pure, revoked from all roles) |
| Verdicts & state | `residual_verdicts(period, mid?, processor?)`, `_merchant_states`, `_period_state`, `_acknowledge_verdict`, `_withdraw_acknowledgment`, `_retire_resolved_acks`, `_sign_off_period`, `_reopen_period`, `_tolerances_for_month`, `_tolerance_is_locked`, `_volume_mapping_coverage` |
| Readers (R6b) | `residual_period_context`, `_grid_rows`, `_merchant_volume_row`, `_synopsis(period, mid?, lifetime)`, `_period_history`, `_merchant_directory` |
| Manual entry | `residual_insert_manual_line`, `_update_line_stated`, `_update_merchant_volumes` |
| Pricing sync | `residual_sync_rates_from_record(record, at)` (no gate; granted to authenticated — it runs from the `records` trigger), `tg_records_sync_residual_rates`, `residual_tier_from_pricing_choice`, `residual_rate_effective_month` |
| Triggers | `tg_residual_audit`, `tg_residual_lines_invalidate_calculation`, `tg_residual_guard_reconciled_period`, `tg_residual_merchant_rates_guard_locked`, `tg_residual_buy_rate_schedule_guard_locked`, `tg_residual_merchant_rates_real_tier`, `tg_residual_tolerance_guard_locked`, `tg_residual_periods_status_transition`, `tg_residual_periods_status_log`, `tg_residual_formula_terms_validate`, `tg_set_updated_at` |

Grant pattern ("std"): `revoke all from public, anon, authenticated, service_role; grant execute to authenticated`. Functions with no admin gate that are callable by `authenticated`: `residual_sync_rates_from_record`, `residual_tier_from_pricing_choice`, `residual_derive_plan_rollup`, `find_live_record_by_mid(_suffix)`, the three `*_is_locked`, `residual_vendor_provider_key`, `residual_merchant_rate_unchanged`. All are read-only or write only through a trigger path; know they exist.

### 9.3 The engine, in twelve lines

```
refuse if period reconciled
registry := the processor's live registry covering statement_month   (22023 if none)
buy map  := per tier {share, rates{key: {rate, cap}}} from residual_buy_rates_for_month
version  := max(version)+1; delete this period's calc_failures
for each distinct digits-only MID in the period's lines:
  rates := residual_merchant_rates_for_month(mid, month)              (P0002 → no_merchant_rates, lines nulled)
  share := buy map[tier].share                                       (missing → missing_template_rate)
  for each line: rule := registry rule for fee_item_name              (none → unknown_fee_item)
     income, buy, additional := residual_eval_side × 3  (Σ sign·min(operand·rate, cap), honouring applies_when)
     before := round(income,2) − round(buy,2);  after := round(before × share, 2);  net := after + round(additional,2)
  group anchors evaluated once → residual_line_groups
calculation_version := version only if no failures were recorded; insert residual_calc_runs; retire resolved acks
```

Verdicts are computed on read (`residual_verdicts`), never stored. A month's inputs changing (any insert/update/delete on lines or volumes) nulls `calculation_version` through `tg_residual_lines_invalidate_calculation`, so stale totals can never be shown.

---

## 10. Git history of the residuals work (oldest first)

| Hash | Date | Subject |
|---|---|---|
| `ef044d3` | 2026‑09‑29 | port the schema and the calculation engine (38 migrations) |
| `cb4d15b` | 09‑29 | the Pricing tab feeds the calculator, without rewriting history |
| `dd6df0a` | 10‑03 | the operator surface for merchant links |
| `7759c2e` | 10‑03 | the admin screen |
| `403326c` | 10‑03 | the engine computes, against Daniel's own hand-computed figures |
| `4823c91` | 10‑05 | the import path, and a silent permission bug |
| `c986537` | 10‑05 | the reconciliation screen |
| `df45063` | 10‑05 | entering a merchant's rates |
| `b1ab858` | 10‑05 | volume figures by hand |
| `98e1561` | 10‑05 | the merchant's own figures, on the merchant's record |
| `66b6c4b` | 10‑05 | attach the audit trigger |
| `1b9a774` | 10‑05 | three defects Daniel's handoff named, plus import history |
| `f3b9ad4` | 10‑05 | merchant-rates bulk import |
| `261a065` | 10‑05 | ask what a compute will skip |
| `342a8e4` | 10‑05 | risk tier never resolved, plus demo data |
| `a78a4bc` | 10‑05 | demo: put the four merchants in the Residuals module |
| `c6ba5a9` | 10‑05 | admin: say where things stand |
| `8fee3e8` | 10‑06 | admin: vendors were offered as processors |
| `77a24c1` | 10‑08 | the PCI decision, seven August fee items, real month imported |
| `9acee54` | 10‑08 | the rates workbook has a two-row header |
| `96ad4e3` | 10‑08 | statement volumes, read by coordinate |
| `73521e5` | 10‑08 | "$ -" is a decision, not a blank |
| `076055d` | 10‑08 | the statements screen (Step 2 UI) |
| `b70d99d` | 10‑08 | step 1 is measured |
| `586817f` | 10‑08 | the merchant dashboard (tab 1) |
| `97c5bce` | 10‑08 | verify scripts updated (PCI at 5.00) |
| `b3c7631` | 10‑10 | slow operations show that they started |
| `663915e` | 10‑13 | admin: cover the access rule, at both layers |

`git show --stat -s --format=%B <hash>` on any of these gives the full reasoning; the commit bodies in this repo are written as design notes.

---

## 11. Questions to put to Izzy, in order

1. The partner-split formula for Tab 4 (per MID? per partner default? before or after Additional Income? what about vendor costs?). Nothing can be built until this is written down.
2. The remaining 40 statement PDFs for August, and September's fee report + statements when they exist.
3. House Of Tacos (`30119900929`): which rate, which name.
4. A statement for an EBT merchant (to settle item 4 in §6).
5. The real changeover date for the monthly fee (the registry boundary is a placeholder).
6. Whether non-admin staff should ever see a merchant's residual figures, and whether Residuals should be a sidebar module rather than an admin page.

Everything else is answered in `spec/` or the migration headers — check there before asking; four of five earlier "questions for Izzy" turned out to be already answered in those files.
