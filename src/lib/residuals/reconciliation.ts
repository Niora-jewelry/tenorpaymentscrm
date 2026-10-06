/**
 * The reconciliation vocabulary — types and labels, and nothing that runs.
 *
 * ── WHY THIS IS A SEPARATE FILE ──────────────────────────────────────────
 * The reconciliation grid is a client component, and it needs two things from
 * the server layer: the row types, and the words for a step and a merchant
 * state. Types erase at compile time, so importing those costs nothing. A
 * LABEL MAP DOES NOT ERASE — it is a runtime value, and importing one from
 * `lib/records/residualGrid.ts` drags that module's `import 'server-only'` and
 * its `next/headers` dependency into the browser bundle.
 *
 * That is not a lint opinion; it is a build failure, and it is the one that
 * caught this:
 *
 *   ./src/lib/records/residualGrid.ts
 *   Error: You're importing a module that depends on "server-only".
 *
 * So everything the client needs lives here, where there is nothing to leak:
 * no imports, no I/O, no secrets. `residualGrid.ts` re-exports these types so
 * server code has one place to look, and the client imports from this file
 * directly.
 */

/* ────────────────────────────────────────────────────────────────────────
 * Verdicts
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * One step's comparison on one row.
 *
 * `delta` is always RIGHT − LEFT, which is computed minus stated. Signed,
 * never absolute: the direction is the first thing an operator needs, and an
 * absolute delta throws it away. The tolerance test is on `|delta|`.
 */
export type Verdict = {
  verdict: 'match' | 'mismatch' | 'exempt';
  /** Computed minus stated, as text. */
  delta: string | null;
  /** What the statement said. */
  left: string | null;
  /** What the engine computed. */
  right: string | null;
  tolerance: string | null;
  /** Non-null when a human has forgiven this mismatch. */
  ack_id: string | null;
  /** True when an acknowledgment is currently suppressing it. */
  suppressed: boolean;
};

/**
 * Keyed by step as a string: '1', '2', '3'.
 *
 * A MISSING KEY means the comparison could not be made at all — an uncomputed
 * line, an unmapped fee item, a merchant with no volume row. That is why this
 * is a map and not an array of three: absence is a distinct meaning, and an
 * array would render it as a blank cell indistinguishable from an oversight.
 */
export type Verdicts = Partial<Record<'1' | '2' | '3', Verdict>>;

/** What each step compares, in the operator's words. */
export const STEP_LABEL: Record<1 | 2 | 3, { short: string; long: string }> = {
  1: {
    short: 'Volume',
    long: 'The statement’s Amount against the sum of the volume buckets the fee item is assessed on.',
  },
  2: {
    short: 'Buy rate',
    long: 'What the processor charged us against what the buy-rate schedule says it should have.',
  },
  3: {
    short: 'Net',
    long: 'The statement’s net revenue against the net the engine computed before the split.',
  },
};

/* ────────────────────────────────────────────────────────────────────────
 * The grid
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * One row of the grid: a statement line, or an engine-computed group total.
 *
 * Every money field is a `string`. Daniel's rule, stated in the grid migration
 * itself: *"MONEY LEAVES HERE AS text, NEVER numeric... a grid is exactly
 * where a float would get one. The surface right-aligns a string; it never
 * parses one."*
 */
export type GridRow = {
  scope: 'line' | 'group';
  rowId: string;
  mid: string;
  merchantName: string | null;
  feeCategory: string | null;
  feeItemName: string | null;
  groupKey: string | null;
  isGroupMember: boolean;
  isGroupAnchor: boolean;

  /* The statement's own figures. */
  itemCount: string | null;
  amount: string | null;
  buyRatePerItem: string | null;
  agentIncome: string | null;
  agentExpense: string | null;
  netRevenue: string | null;

  /* The engine's. */
  totalIncome: string | null;
  totalBuyRate: string | null;
  tapdashNetBeforeSplit: string | null;
  tapdashNetAfterSplit: string | null;
  additionalIncomeDirect: string | null;
  netIncome: string | null;

  /** False means the engine did not compute this row — see the merchant's state. */
  isComputed: boolean;
  /** Which volume buckets step 1 compares the Amount against. */
  volumeBuckets: string[] | null;
  verdicts: Verdicts;
  /** 'excel', 'pdf' or 'manual'. */
  source: string | null;
  sortOrder: number | null;
};

/* ────────────────────────────────────────────────────────────────────────
 * Merchant state
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Where one merchant in the period stands.
 *
 * The ladder is ORDERED and the first rung that applies wins:
 * `blocked` (the engine could not compute something) →
 * `awaiting_volumes` (no volume row, or a NULL bucket) →
 * `mismatch` (an unacknowledged comparison disagrees) →
 * `reconciled` (the month is signed off) → `ready`.
 *
 * The ordering matters to the UI: a merchant can be blocked AND missing
 * volumes, and showing it as "awaiting volumes" would send the operator to fix
 * the second thing while the first is what is stopping it.
 */
export type MerchantState = {
  mid: string;
  state: 'blocked' | 'awaiting_volumes' | 'mismatch' | 'reconciled' | 'ready';
  blockedCount: number;
  skippedWhole: number;
  blockedLines: number;
  /** Set only for 'awaiting_volumes', naming which half is missing. */
  awaitingReason: string | null;
  mismatchCount: number;
  /** Mismatches a human has acknowledged. Still counted, no longer blocking. */
  suppressedCount: number;
  lineCount: number;
  uncomputedCount: number;
};

export const STATE_LABEL: Record<MerchantState['state'], string> = {
  blocked: 'Blocked',
  awaiting_volumes: 'Awaiting volumes',
  mismatch: 'Mismatch',
  reconciled: 'Reconciled',
  ready: 'Ready',
};

/* ────────────────────────────────────────────────────────────────────────
 * The synopsis
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Net income, with the completeness denominators beside it.
 *
 * ── `netIncome` IS NULL UNTIL EVERY FIGURE COMPUTED ──────────────────────
 * Daniel's reasoning, and it is the sharpest argument in the module:
 *
 *   "A figure labelled 'Net Income: -7,086.67 (partial)' is read as two true
 *    things — a loss, and some missing rows. The first is false, and the label
 *    does not repair it; it licenses it. 'Partial' is the right word for a sum
 *    missing random rows and the wrong word for a sum missing one side of the
 *    ledger."
 *
 * So the function returns NULL rather than a number, because *"a component
 * cannot format what it did not receive"*. `disclosable` says which case it is,
 * and the denominators come back either way — they are facts about coverage,
 * and they are what makes the absence explicable rather than a blank.
 *
 * ── DISCLOSABLE IS NOT THE SAME AS RECONCILED ────────────────────────────
 * `disclosable` tracks `calculation_version`, which is stamped when nothing
 * was SKIPPED. A month can therefore carry a complete, trustworthy total while
 * every one of its comparisons still disagrees — because a mismatch is a
 * successful computation that differs from the statement, not a failure to
 * compute. Sign-off is the separate claim, and it needs the disagreements
 * resolved.
 */
export type Synopsis = {
  /** Null for the company-wide row. */
  mid: string | null;
  /** Null whenever `disclosable` is false. Never rendered as 0. */
  netIncome: string | null;
  rowsTotal: number;
  rowsComputed: number;
  merchantsTotal: number;
  merchantsComputed: number;
  periodsTotal: number;
  periodsComputed: number;
  /** False means the month carries no calculation version, so no total exists. */
  disclosable: boolean;
};

/* ────────────────────────────────────────────────────────────────────────
 * The period
 * ──────────────────────────────────────────────────────────────────────── */

export type PeriodHeader = {
  id: string;
  statementMonth: string;
  /** The column. Only ever 'open' or 'reconciled'. */
  storedStatus: string;
  /** Derived at merchant grain, which is the one worth showing. */
  derivedStatus: string;
  calculationVersion: number | null;
  merchantCount: number;
  blocked: number;
  awaitingVolumes: number;
  mismatch: number;
  ready: number;
  reconciled: number;
  /** At least one merchant, and every one of them clean. */
  signable: boolean;
  notes: string | null;
  processor: string | null;
  registryLabel: string | null;
};

/**
 * Four append-only sources on one ordered timeline: calculation runs, status
 * changes, acknowledgments and the audit log.
 */
export type HistoryEntry = {
  kind: string;
  occurredAt: string;
  actorId: string | null;
  detail: Record<string, unknown>;
};

/**
 * What each history entry is, in the operator's words.
 *
 * -- THE KEYS ARE residual_period_history's, NOT GUESSES ------------------
 * It emits exactly four: `calc_run`, `status_transition`, `acknowledgment`
 * and `manual_edit`. This map previously carried `status`, `ack`,
 * `ack_withdrawn` and `audit` — names taken from the tables each branch reads
 * rather than from the branch labels — so three of the four kinds rendered as
 * their raw code in the "What happened to this month" panel, and a fourth key
 * matched nothing at all.
 *
 * `manual_edit` could not have been seen either way: `tg_residual_audit` was
 * attached to no table, so that branch returned nothing until migration
 * 20260819009743. Both halves are asserted in `audit.integration.test.ts`.
 *
 * A withdrawn acknowledgment is NOT a fifth kind. The function emits
 * `acknowledgment` for both, and distinguishes them in the detail payload
 * (`retired_reason`, `note`) — so the renderer prints the detail rather than
 * splitting the label.
 */
export const HISTORY_KIND_LABEL: Record<string, string> = {
  calc_run: 'Calculated',
  status_transition: 'Status changed',
  acknowledgment: 'Mismatch acknowledged',
  manual_edit: 'Edited by hand',
};

/* ────────────────────────────────────────────────────────────────────────
 * Showing money
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * A decimal STRING, presented as currency — without ever becoming a number.
 *
 * ── WHY NOT `formatCurrency(Number(v))` ──────────────────────────────────
 * Because that is the one thing this module forbids. Every money value here
 * arrives from SQL as text precisely so no JavaScript float ever holds a
 * residual dollar amount, and `Number()` undoes that at the last step — the
 * step where somebody is reading the figure and believing it.
 *
 * So this groups the integer part and leaves the fractional part EXACTLY as
 * SQL produced it. `numeric(14,2)` already decided how many decimals the
 * figure has; re-rounding it here would be a second opinion about a number
 * that is not ours to round.
 *
 *   "633.78"     -> "$633.78"
 *   "-375.32"    -> "-$375.32"
 *   "1234567.5"  -> "$1,234,567.5"
 *   "0.00"       -> "$0.00"
 *
 * Anything that is not a plain decimal is returned untouched rather than
 * mangled — a value this cannot read is a value worth seeing verbatim.
 */
export function formatMoneyText(value: string | null): string | null {
  if (value === null) return null;

  const m = /^(-?)(\d+)(\.\d+)?$/.exec(value.trim());
  if (!m) return value;

  const [, sign, whole, fraction] = m;
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${grouped}${fraction ?? ''}`;
}
