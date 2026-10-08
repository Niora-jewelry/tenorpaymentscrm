/**
 * Reading a processor fee report.
 *
 * Ported from Daniel's `lib/residuals/xlsx-parser.ts`, which documents two
 * contracts that this file keeps because breaking either one is silent.
 *
 * ── HEADERS STAY VERBATIM ────────────────────────────────────────────────
 * A header string is the JOIN KEY against `residual_column_mappings`
 * (processor, source_column_header). Trimming, title-casing or collapsing
 * whitespace here would mean a saved mapping stops matching its own file next
 * month, and the symptom is not an error — it is a column that silently maps
 * to nothing and a residual_lines row with a NULL where a number should be.
 *
 * So `header` is the cell's text exactly as the workbook holds it. A separate
 * `headerKey` (trimmed, collapsed, lower-cased) exists only for suggesting a
 * default mapping to a human; it lives in `mapping.ts`, is never persisted and
 * is never used to look a mapping up.
 *
 * ── CELLS STAY TYPED ─────────────────────────────────────────────────────
 * Values travel to `jsonb_to_recordset(p_rows) as r(... item_count
 * numeric(14,4), amount numeric(14,2) ...)`, where PostgreSQL does the cast.
 * That is the point: `numeric` arithmetic happens in the database.
 *
 * A spreadsheet number therefore reaches JSON as a STRING of decimal digits,
 * not as a JSON number, so the value PostgreSQL parses is the decimal text
 * rather than a float's nearest representation. See `readNumeric`.
 *
 * ── WHY `raw: true` AND ALSO `cellDates` ─────────────────────────────────
 * `raw: true` hands back the underlying value rather than the formatted text,
 * so a currency-formatted cell arrives as 1234.56 rather than "$1,234.56".
 * Dates are the exception and are converted explicitly, because a date serial
 * read raw is an integer like 45809, indistinguishable from a count.
 */
import * as XLSX from 'xlsx';

/** A cell, as it left the workbook, in the types that survive JSON. */
export type CellValue = string | number | boolean | null;

export type ParsedSheet = {
  name: string;
  /** Exactly as the workbook holds them, in column order. Duplicates possible. */
  headers: string[];
  /** One entry per data row. Index-aligned with `headers`. */
  rows: CellValue[][];
  /**
   * 1-based worksheet row of each entry in `rows`, index-aligned with it.
   *
   * ── WHY THIS IS A LIST AND NOT `headerRow + 1 + i` ───────────────────
   * Blank rows are dropped from `rows`, and a vendor file has them — between
   * a title block and the headers, and between merchant groups. Deriving the
   * row number from the index therefore reports a number that drifts further
   * from the real one with every blank row above it. A cell error that names
   * row 41 when Excel shows row 44 is worse than no row number: the operator
   * looks at the wrong line, finds nothing wrong with it, and concludes the
   * importer is confused.
   */
  rowNumbers: number[];
  /** 1-based worksheet row of the header, for messages about the file itself. */
  headerRow: number;
};

export type ParsedWorkbook = { sheets: ParsedSheet[] };

/**
 * How far down the sheet to look for the header row.
 *
 * A fee report that opens with a title block puts its headers below row 1.
 * Scanning the whole sheet for "the row that looks most like headers" would be
 * a guess that silently picks a data row in a file with no header at all, so
 * the search is bounded and failing it is something the operator is told.
 */
const MAX_HEADER_SCAN_ROWS = 20;

/** Carries no information. */
function isBlank(v: CellValue): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/**
 * The header row is the first row with at least two non-blank text cells and
 * no numeric cells.
 *
 * Both halves matter. "At least two text cells" skips a merged title banner.
 * "No numbers" is what separates a header from the first data row, since a
 * fee-report data row always carries a count or an amount.
 */
function findHeaderRow(grid: CellValue[][]): number {
  const limit = Math.min(grid.length, MAX_HEADER_SCAN_ROWS);
  for (let i = 0; i < limit; i += 1) {
    const row = grid[i] ?? [];
    const texts = row.filter((c) => typeof c === 'string' && c.trim() !== '').length;
    const numbers = row.filter((c) => typeof c === 'number').length;
    if (texts >= 2 && numbers === 0) return i;
  }
  return -1;
}

/**
 * Parses an .xlsx/.xls/.csv buffer into sheets of verbatim headers and typed
 * cells.
 *
 * Throws on a workbook that cannot be read at all. A sheet whose header row
 * cannot be located comes back with zero headers rather than a guess, and the
 * caller says so by name.
 */
/**
 * Options for a sheet whose header the finder cannot be expected to locate.
 *
 * ── WHY AN OVERRIDE AND NOT A CLEVERER FINDER ───────────────────────────
 * The real merchant-rates workbook has a TWO-ROW header: `MID`, `Merchant
 * Name` and `Processor` are named on row 1 alongside merged group labels
 * ("Authorization Fees", "Volume Fees"), and the rate columns are named on
 * row 2 — whose first cell is a sentence of prose describing the tab.
 *
 * No heuristic reads that correctly, because neither row is the header on its
 * own. `findHeaderRow` picks row 1, which labels the rate columns with group
 * names and turns row 2 into a data row.
 *
 * Guessing harder would make the common case less predictable to fix a case
 * the operator can see at a glance. So the operator is given the control
 * instead: the screen says which row was used and lets them choose another.
 */
export type ParseOptions = {
  /** 1-based worksheet row to treat as the header, per sheet name. */
  headerRows?: Record<string, number>;
};

export function parseWorkbook(bytes: Uint8Array, options: ParseOptions = {}): ParsedWorkbook {
  const wb = XLSX.read(bytes, {
    type: 'array',
    // Underlying values, not display text. See the file header.
    raw: true,
    // Date cells become JS Dates; without this a date is a serial integer.
    cellDates: true,
    // None of this is needed, and parsing it is work and surface.
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    sheetStubs: false,
  });

  const sheets: ParsedSheet[] = [];

  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;

    /*
     * `header: 1` gives an array of arrays, which is what lets the header row
     * be located rather than assumed. `sheet_to_json`'s object mode would
     * de-duplicate repeated headers by appending _1, _2 — renaming the very
     * strings that are the join key.
     */
    /*
     * `blankrows: true` so a grid index IS a worksheet row (zero-based). With
     * them dropped, every row number this reports is short by however many
     * blank rows sat above it — see `rowNumbers`. Blank rows are discarded
     * below, after their position has been recorded.
     */
    const grid = XLSX.utils.sheet_to_json<CellValue[]>(ws, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: true,
    });

    /*
     * An override is 1-based and clamped to the grid, so a stale value from a
     * previous file cannot read past the end and produce an empty sheet that
     * looks like a parse failure.
     */
    const override = options.headerRows?.[name];
    const headerIdx =
      override !== undefined && override >= 1 && override <= grid.length
        ? override - 1
        : findHeaderRow(grid);

    if (headerIdx < 0) {
      sheets.push({ name, headers: [], rows: [], rowNumbers: [], headerRow: 0 });
      continue;
    }

    const headers = (grid[headerIdx] ?? []).map((c) => (c === null ? '' : String(c)));

    /* Trailing all-blank columns are an artefact of the grid, not columns. */
    let width = headers.length;
    while (width > 0 && headers[width - 1].trim() === '') width -= 1;

    const rows: CellValue[][] = [];
    const rowNumbers: number[] = [];
    for (let i = headerIdx + 1; i < grid.length; i += 1) {
      const src = grid[i] ?? [];
      const row: CellValue[] = [];
      for (let c = 0; c < width; c += 1) row.push(normaliseCell(src[c]));
      if (row.every(isBlank)) continue;
      rows.push(row);
      /* i is a zero-based worksheet row; Excel counts from 1. */
      rowNumbers.push(i + 1);
    }

    sheets.push({
      name,
      headers: headers.slice(0, width),
      rows,
      rowNumbers,
      headerRow: headerIdx + 1,
    });
  }

  return { sheets };
}

/**
 * One cell, from whatever SheetJS produced to the three types that survive
 * JSON — or null.
 *
 * A Date becomes an ISO calendar date, not a timestamp: a fee report's dates
 * are days, and carrying a time would invent a timezone the file never stated.
 */
function normaliseCell(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    /* getUTC*, because cellDates builds the Date in UTC from the serial. */
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, '0');
    const d = String(v.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v;
  /* An error cell ({ t: 'e' }) or anything else is not data. */
  return null;
}

/* ────────────────────────────────────────────────────────────────────────
 * Numerics
 * ──────────────────────────────────────────────────────────────────────── */

export type NumericRead = { ok: true; value: string | null } | { ok: false; raw: string };

/**
 * Reads a cell destined for a `numeric` column and returns the DECIMAL TEXT
 * PostgreSQL should parse — never a JavaScript number.
 *
 * ── WHY TEXT AND NOT A NUMBER ────────────────────────────────────────────
 * `JSON.stringify(0.1 + 0.2)` is "0.30000000000000004". Any value reaching
 * JSON as a number has been through a float. A cell holding 1234.56 arrives
 * from SheetJS as the float nearest to it, and `String(n)` gives the shortest
 * decimal that round-trips to that float — "1234.56" — which PostgreSQL then
 * parses exactly. The conversion to text happens here, once, and `numeric`
 * does the rest.
 *
 * ── WHAT IS NORMALISED, AND WHY THAT IS NOT GUESSING ─────────────────────
 * A vendor file writes money in accounting format. Three readings are
 * unambiguous and lossless, and all three are applied:
 *
 *   "$1,234.56"  ->  1234.56    currency symbol and thousands separators
 *   "(375.32)"   -> -375.32     accounting negative
 *   " 1,234.56 " ->  1234.56    surrounding whitespace
 *
 * Anything else — "n/a", "1.2.3", "12%" — is NOT read. It comes back
 * `{ ok: false }` with the raw text, and the caller surfaces it as a row error
 * before anything is committed. The module's standing posture is that it
 * refuses to guess rather than booking a cost as zero, and a numeric cell that
 * cannot be read is exactly that case.
 *
 * A blank cell is `null`, which is a different claim from zero and is what the
 * engine needs in order to skip rather than assume.
 */
export function readNumeric(v: CellValue): NumericRead {
  if (v === null || v === undefined) return { ok: true, value: null };
  if (typeof v === 'boolean') return { ok: false, raw: String(v) };

  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { ok: false, raw: String(v) };
    /* Exponent notation is legal decimal text to PostgreSQL's numeric parser,
       but String() only produces it beyond 1e21 — far outside numeric(14,n). */
    return { ok: true, value: String(v) };
  }

  const raw = v;
  let s = raw.trim();
  if (s === '' || s === '-' || s === '—') return { ok: true, value: null };

  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1).trim();
  }

  /* Currency symbols the report might use, and thousands separators. */
  s = s.replace(/[$£€]/g, '').replace(/,/g, '').trim();

  if (s.startsWith('-')) {
    /* One sign or the other. "-(5)" is not a reading anyone intended. */
    if (negative) return { ok: false, raw };
    negative = true;
    s = s.slice(1).trim();
  } else if (s.startsWith('+')) {
    s = s.slice(1).trim();
  }

  if (s === '') return { ok: false, raw };
  /* Plain decimal only. No exponents: a fee report has none, and accepting
     them would also accept "1e" style typos as 1. */
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) return { ok: false, raw };
  /* "0." and "-0." parse in PostgreSQL but are a typo, not a value. */
  if (s.endsWith('.')) return { ok: false, raw };
  /* ".05" is legal to PostgreSQL; the leading zero is for the human reading
     the preview, where a bare point is easy to misread as a thousands mark. */
  if (s.startsWith('.')) s = `0${s}`;

  return { ok: true, value: negative ? `-${s}` : s };
}

/** A cell destined for a `text` column. Trimmed; blank becomes null. */
export function readText(v: CellValue): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? null : t;
  }
  /*
   * A MID that Excel decided was a number comes back as 550000000101. It must
   * reach SQL as the digit string, with no exponent and no decimal point, or
   * the resolver is matching a different string than the one on the statement.
   */
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    return Number.isInteger(v) ? v.toFixed(0) : String(v);
  }
  return String(v);
}
