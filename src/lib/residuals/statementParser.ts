/**
 * Reading the plan-code summary off a merchant processing statement.
 *
 * This is where statement VOLUME comes from, and volume is the operand behind
 * the largest income terms in the registry — BIN Sponsorship, Amex OptBlue and
 * the Cash Discount/Surcharge programme all multiply a rate by a volume. No
 * volumes means those lines cannot be computed at all, which is why the engine
 * refuses them with `no_volumes` rather than treating absent volume as zero.
 *
 * ── WHY COORDINATES AND NOT `pdftotext -layout` ──────────────────────────
 * Not a preference. `-layout` reads this exact statement WRONG, and silently.
 *
 * The plan table's cells are vertically centred within rows of uneven height,
 * so a text-flow extractor assigns some cells to the neighbouring row. On
 * MID 201100272922 (August 2026) `-layout` produced:
 *
 *        -layout              truth (by coordinate)
 *   VB   (blank)              VB   59     7,451.51
 *   MC   59   7,451.51        MC   274    8,373.90
 *   AM   12     806.48        AM   86     3,593.57
 *
 * Every row from VB down was shifted by one. Amex volume would have been read
 * as 806.48 instead of 3,593.57 — a 4.5x error on a number that multiplies an
 * OptBlue rate, with no symptom anywhere. So rows are formed by clustering
 * text items on their Y coordinate, where the pairing is unambiguous: the row
 * pitch is ~10.5pt and the cluster tolerance is 2.5pt.
 *
 * ── THE STATEMENT CHECKSUMS ITSELF, SO THE PARSE IS PROVEN NOT TRUSTED ───
 * The table ends in a `**` totals row holding the sales count and gross amount
 * the processor itself printed. The plan rows must sum to it exactly, to the
 * cent and to the transaction.
 *
 * `verifyTotals` is therefore not a sanity check to log and move past — it is
 * the gate. A statement whose rows do not sum to its own total is refused and
 * nothing is written, because the failure mode being guarded against is a
 * misread row that looks completely plausible. Checked against all seven
 * statements delivered for August 2026: all seven sum exactly, on both the
 * amount and the count.
 *
 * ── MONEY IS TEXT ────────────────────────────────────────────────────────
 * Amounts leave here as decimal STRINGS, for `numeric(14,2)` to parse, exactly
 * as `xlsxParser` does. The checksum needs arithmetic, so it converts to
 * integer CENTS — exact for two-decimal money, which a float is not.
 *
 * ── PLAN CODES ARE NOT NAMED HERE ────────────────────────────────────────
 * This file recognises a plan row STRUCTURALLY — a two-character token in the
 * leftmost column of the table — and returns whatever code it finds. Which
 * bucket a code feeds is a row in `residual_plan_code_buckets`, so adding a
 * card type is configuration. The caller maps the codes and must REPORT any it
 * cannot place rather than dropping it, or volume silently understates.
 */

/** A text run with the position the PDF gave it. */
export type Positioned = { text: string; x: number; y: number };

/** One plan-code row of the summary table, values as decimal text. */
export type StatementPlanRow = {
  /** As printed: 'VS', 'AM', 'MD'. Never interpreted here. */
  planCode: string;
  /** Number of sales. Whole number as text, or null if the cell was blank. */
  itemCount: string | null;
  /** Amount of sales. Decimal text, or null. */
  amount: string | null;
  /** Number of credits (refunds). */
  creditCount: string | null;
  /** Amount of credits. */
  creditAmount: string | null;
  /** 1-based index within the table, for error messages that name a row. */
  tableRow: number;
};

export type StatementTotals = {
  itemCount: string | null;
  amount: string | null;
  creditCount: string | null;
  creditAmount: string | null;
};

export type ParsedStatement = {
  /** The merchant number, digits only, as printed after the `xxxx` mask. */
  mid: string | null;
  /** Processing month exactly as printed, e.g. '08-26'. Not reformatted. */
  processingMonth: string | null;
  planRows: StatementPlanRow[];
  /** The `**` row the processor printed. Null if the table had none. */
  printedTotals: StatementTotals | null;
  /** 1-based PDF page the table was found on, for messages. */
  page: number;
};

/* ────────────────────────────────────────────────────────────────────────
 * Numbers
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * A statement cell as decimal text, or null.
 *
 * `.00` and `00` both appear and both mean zero; the leading digit is simply
 * not printed. They are kept as given so the stored text matches the document.
 */
function cellNumber(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const s = raw.replace(/[$,\s]/g, '');
  if (s === '' || s === '-') return null;
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) return null;
  return s;
}

/**
 * Decimal text as an integer number of cents, for exact comparison.
 *
 * Deliberately not `Number(s) * 100`: 806.48 * 100 is 80647.99999999999 in
 * binary floating point, and a checksum that compares those is a checksum that
 * fails on correct input. The digits are shifted as text instead.
 */
export function toCents(value: string | null): number | null {
  if (value === null) return null;
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(value);
  if (!m) return null;
  const sign = m[1];
  const whole = m[2];
  const frac = m[3] ?? '';
  const n = Number(`${whole || '0'}${`${frac}00`.slice(0, 2)}`);
  if (!Number.isFinite(n)) return null;
  return sign === '-' ? -n : n;
}

/** Whole-number text as an integer, for the transaction-count checksum. */
function toCount(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/* ────────────────────────────────────────────────────────────────────────
 * Rows out of coordinates
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Y-tolerance for treating two text runs as the same row, in points.
 *
 * The plan table's pitch is ~10.5pt, so 2.5 is comfortably inside one row and
 * still absorbs the sub-point jitter of vertically centred cells.
 */
const ROW_TOLERANCE = 2.5;

/** The leftmost column, where a plan code sits. Beyond this is a data cell. */
const LEFT_COLUMN_X = 25;

/**
 * A plan code as the statement prints them: two upper-case letters or digits.
 *
 * Structural on purpose — see the file header. A code this matches but
 * `residual_plan_code_buckets` does not know is the caller's problem to
 * report, not this function's to silently discard.
 */
const PLAN_CODE = /^[A-Z0-9]{2}$/;
const TOTALS_CODE = '**';

export function clusterRows(items: Positioned[]): Positioned[][] {
  const buckets: { y: number; items: Positioned[] }[] = [];
  for (const item of items) {
    const hit = buckets.find((b) => Math.abs(b.y - item.y) <= ROW_TOLERANCE);
    if (hit) hit.items.push(item);
    else buckets.push({ y: item.y, items: [item] });
  }
  /* Top of page first, then left to right within a row. */
  buckets.sort((a, b) => b.y - a.y);
  for (const b of buckets) b.items.sort((a, c) => a.x - c.x);
  return buckets.map((b) => b.items);
}

/* ────────────────────────────────────────────────────────────────────────
 * The parse
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * The statement's own header fields.
 *
 * The merchant number prints masked — `xxxx201100272922` — and the mask is
 * stripped rather than the digits being taken from the filename, so a renamed
 * or mis-named file cannot attach volumes to the wrong merchant.
 */
function readHeader(rows: Positioned[][]): { mid: string | null; processingMonth: string | null } {
  let mid: string | null = null;
  let processingMonth: string | null = null;

  for (const row of rows) {
    const line = row.map((c) => c.text).join(' ');

    if (mid === null && /Merchant\s*Number/i.test(line)) {
      const m = /x*\s*(\d{8,})/.exec(line);
      if (m) mid = m[1];
    }
    if (processingMonth === null && /Processing\s*Month/i.test(line)) {
      const m = /(\d{2}-\d{2})/.exec(line);
      if (m) processingMonth = m[1];
    }
    if (mid !== null && processingMonth !== null) break;
  }
  return { mid, processingMonth };
}

/**
 * Pulls the plan table off one page's rows, or null if it has none.
 *
 * ── THE TABLE IS BOUNDED, NOT SNIFFED ────────────────────────────────────
 * A plan code is two characters in the left column — and so is a day number
 * in the deposit detail table printed directly below it (`02 90001730033 …`).
 * Recognising rows by shape alone therefore swallows the whole deposit table:
 * measured, it turned a 13-row parse into 40 rows and a sales count of
 * 2,430,046,390,605. The checksum caught it, which is the point of having one,
 * but the fix belongs here.
 *
 * So the table is read between its own delimiters:
 *
 *   Plan / Code      <- header, left column, starts it
 *   VS  529  …       <- plan rows
 *   **  3,433  …     <- the processor's total, ENDS it
 *   Day  Number  …   <- a different table, never reached
 *
 * The deposit table also has a `Plan` header, but at x≈154 rather than the
 * left column, so it cannot be mistaken for the start.
 *
 * One table per page is assumed, which holds for every statement seen. A
 * statement that continued its plan rows onto a second page would have a
 * second header, and the first complete table is returned — its own `**` total
 * would then disagree with its rows and the import would be refused rather
 * than halved, which is the right way round.
 */
function readPlanTable(
  rows: Positioned[][],
): { planRows: StatementPlanRow[]; printedTotals: StatementTotals | null } | null {
  const start = rows.findIndex(
    (row) => row[0] !== undefined && row[0].x <= LEFT_COLUMN_X && /^Plan$/i.test(row[0].text),
  );
  if (start === -1) return null;

  const planRows: StatementPlanRow[] = [];
  let printedTotals: StatementTotals | null = null;

  for (let i = start + 1; i < rows.length; i += 1) {
    const row = rows[i];
    const first = row[0];
    if (!first || first.x > LEFT_COLUMN_X) continue;

    const cells = row.slice(1).map((c) => c.text);
    const values = {
      itemCount: cellNumber(cells[0]),
      amount: cellNumber(cells[1]),
      creditCount: cellNumber(cells[2]),
      creditAmount: cellNumber(cells[3]),
    };

    /* The processor's own total. Ends the table. */
    if (first.text === TOTALS_CODE) {
      printedTotals = values;
      break;
    }

    if (!PLAN_CODE.test(first.text)) {
      /*
       * `Code`, the header's second line, falls here and is skipped. So does
       * any other prose. A row of neither shape does not end the table,
       * because the header spans two lines before the first plan row.
       */
      continue;
    }

    /*
     * A plan row always prints a sales count, even as `00`. A two-character
     * token in the left column with no numbers after it is some other part of
     * the page — a heading, an address line — and is not a plan row.
     */
    if (values.itemCount === null && values.amount === null) continue;

    planRows.push({ planCode: first.text, ...values, tableRow: planRows.length + 1 });
  }

  return planRows.length > 0 ? { planRows, printedTotals } : null;
}

/** What a PDF loader must hand back: text runs with positions, per page. */
export type LoadedPdf = { pages: Positioned[][] };

/**
 * Reads one statement.
 *
 * `load` is injected so this module does not choose how the PDF is opened —
 * the caller supplies a loader, which keeps the heavy dependency out of any
 * bundle that only needs the types, and lets the tests run without a PDF.
 */
export async function parseStatement(
  bytes: Uint8Array,
  load: (bytes: Uint8Array) => Promise<LoadedPdf>,
): Promise<ParsedStatement> {
  const { pages } = await load(bytes);

  let mid: string | null = null;
  let processingMonth: string | null = null;

  for (let i = 0; i < pages.length; i += 1) {
    const rows = clusterRows(pages[i]);

    if (mid === null || processingMonth === null) {
      const found = readHeader(rows);
      mid ??= found.mid;
      processingMonth ??= found.processingMonth;
    }

    const table = readPlanTable(rows);
    if (table) return { mid, processingMonth, ...table, page: i + 1 };
  }

  return { mid, processingMonth, planRows: [], printedTotals: null, page: 0 };
}

/* ────────────────────────────────────────────────────────────────────────
 * The gate
 * ──────────────────────────────────────────────────────────────────────── */

export type TotalsVerdict =
  | { ok: true; itemCount: number; amountCents: number }
  | { ok: false; problems: string[] };

/**
 * Proves the plan rows against the total the processor printed.
 *
 * Both sides are compared: the gross amount in cents and the sales count. A
 * row read off the wrong line changes one or both, and the whole reason this
 * exists is that such a row is otherwise indistinguishable from a correct one.
 *
 * An absent `**` row is a failure too. Without it there is nothing to prove
 * the parse against, and an unprovable volume is not one to write.
 */
export function verifyTotals(parsed: ParsedStatement): TotalsVerdict {
  const problems: string[] = [];

  if (parsed.planRows.length === 0) {
    return { ok: false, problems: ['No plan-code summary table was found in this statement.'] };
  }
  if (!parsed.printedTotals) {
    return {
      ok: false,
      problems: [
        'This statement has a plan table but no printed total row, so the figures read from it cannot be proved correct. Nothing was imported.',
      ],
    };
  }

  let amountCents = 0;
  let itemCount = 0;
  for (const row of parsed.planRows) {
    amountCents += toCents(row.amount) ?? 0;
    itemCount += toCount(row.itemCount) ?? 0;
  }

  const printedAmount = toCents(parsed.printedTotals.amount);
  const printedCount = toCount(parsed.printedTotals.itemCount);

  if (printedAmount === null) {
    problems.push('The printed total row has no amount to check the plan rows against.');
  } else if (printedAmount !== amountCents) {
    problems.push(
      `The plan rows add up to ${(amountCents / 100).toFixed(2)} but the statement prints a total of ` +
        `${(printedAmount / 100).toFixed(2)}. A row has been read off the wrong line; nothing was imported.`,
    );
  }

  if (printedCount === null) {
    problems.push('The printed total row has no sales count to check the plan rows against.');
  } else if (printedCount !== itemCount) {
    problems.push(
      `The plan rows add up to ${itemCount} sales but the statement prints ${printedCount}. ` +
        'A row has been read off the wrong line; nothing was imported.',
    );
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, itemCount, amountCents };
}
