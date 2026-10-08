/**
 * The fee-report reader.
 *
 * The cases that matter here are the ones whose failure is a plausible-looking
 * number rather than an error: a MID Excel decided was numeric, a money cell
 * in accounting format, and a value that must NOT be read at all.
 */
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseWorkbook, readNumeric, readText } from './xlsxParser';

/** A workbook built in memory, so the test owns its own fixture. */
function book(rows: unknown[][], sheetName = 'Sheet1'): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName);
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

describe('readNumeric', () => {
  it('a blank cell is null, which is not zero', () => {
    expect(readNumeric(null)).toEqual({ ok: true, value: null });
    expect(readNumeric('')).toEqual({ ok: true, value: null });
    expect(readNumeric('   ')).toEqual({ ok: true, value: null });
  });

  /*
   * The whole reason this returns text. If it returned a number, this value
   * would reach JSON as a float and PostgreSQL would parse the float's
   * decimal expansion rather than the figure on the statement.
   */
  it('a number leaves as decimal text, not as a number', () => {
    const r = readNumeric(1234.56);
    expect(r).toEqual({ ok: true, value: '1234.56' });
    expect(typeof (r as { value: string }).value).toBe('string');
  });

  it('accounting negatives are read as negative', () => {
    expect(readNumeric('(375.32)')).toEqual({ ok: true, value: '-375.32' });
    expect(readNumeric(' ( 375.32 ) ')).toEqual({ ok: true, value: '-375.32' });
  });

  it('currency symbols and thousands separators are stripped', () => {
    expect(readNumeric('$1,234.56')).toEqual({ ok: true, value: '1234.56' });
    expect(readNumeric('($1,234.56)')).toEqual({ ok: true, value: '-1234.56' });
    expect(readNumeric('-$1,234.56')).toEqual({ ok: true, value: '-1234.56' });
  });

  it('a leading plus is harmless', () => {
    expect(readNumeric('+12.5')).toEqual({ ok: true, value: '12.5' });
  });

  it('a bare decimal point is read, and gets its leading zero back', () => {
    expect(readNumeric('.05')).toEqual({ ok: true, value: '0.05' });
    expect(readNumeric('(.05)')).toEqual({ ok: true, value: '-0.05' });
  });

  /*
   * The important half. Each of these would otherwise become a number — and a
   * cost booked as zero, or a rate off by a factor of a hundred, is not
   * distinguishable from a correct one once it is in the table.
   */
  it('refuses what it cannot read exactly', () => {
    for (const bad of ['n/a', 'N/A', '--', '1.2.3', '12%', 'abc', '12 34', '1e5', '0.', '-(5)']) {
      expect(readNumeric(bad), bad).toEqual({ ok: false, raw: bad });
    }
  });

  it('refuses a boolean', () => {
    expect(readNumeric(true)).toEqual({ ok: false, raw: 'true' });
  });

  it('a single dash is a blank, not a refusal — reports write it for nil', () => {
    expect(readNumeric('-')).toEqual({ ok: true, value: null });
    expect(readNumeric('—')).toEqual({ ok: true, value: null });
  });
});

describe('readText', () => {
  /*
   * The case that silently breaks every join in the module. A 12-digit MID in
   * a General-formatted column arrives as a number; `String(550000000101)` is
   * fine, but anything that routed through a float with a decimal would make
   * "550000000101" into "550000000101.0000001" or worse into exponent form,
   * and the resolver would then be matching a string the statement never had.
   */
  it('a numeric MID becomes the digit string, with no decimal point', () => {
    const mid = readText(550000000101);
    expect(mid).toBe('550000000101');
    /* Not redundant with the equality above: these are the two ways a float
       round trip corrupts a MID, and naming them is what keeps the assertion
       readable as the thing it guards. */
    expect(mid?.includes('.')).toBe(false);
    expect(mid?.includes('e')).toBe(false);
  });

  it('trims, and a blank is null', () => {
    expect(readText('  Acme Diner  ')).toBe('Acme Diner');
    expect(readText('')).toBeNull();
    expect(readText('   ')).toBeNull();
    expect(readText(null)).toBeNull();
  });
});

describe('parseWorkbook', () => {
  it('finds the header row and reads the rows below it', () => {
    const wb = parseWorkbook(
      book([
        ['MID', 'Fee Item', 'Item Count'],
        ['550000000101', 'Authorization Fee IP/SSL', 100],
      ]),
    );
    expect(wb.sheets).toHaveLength(1);
    expect(wb.sheets[0].headers).toEqual(['MID', 'Fee Item', 'Item Count']);
    expect(wb.sheets[0].headerRow).toBe(1);
    expect(wb.sheets[0].rows).toEqual([['550000000101', 'Authorization Fee IP/SSL', 100]]);
  });

  /* A vendor file that opens with a title block. */
  it('skips a title banner above the headers, and says which row it used', () => {
    const wb = parseWorkbook(
      book([
        ['Maverick Fee Item Report'],
        [],
        ['MID', 'Fee Item', 'Item Count'],
        ['550000000101', 'Monthly Fee', 1],
      ]),
    );
    expect(wb.sheets[0].headers).toEqual(['MID', 'Fee Item', 'Item Count']);
    expect(wb.sheets[0].rows).toHaveLength(1);
    /* Worksheet row 3 — the blank row counts, because Excel counts it. */
    expect(wb.sheets[0].headerRow).toBe(3);
    expect(wb.sheets[0].rowNumbers).toEqual([4]);
  });

  /*
   * Verbatim, including the trailing space. Trimming it here would mean the
   * mapping saved against " Net Revenue " stops matching next month's file.
   */
  it('keeps a header exactly as the workbook holds it', () => {
    const wb = parseWorkbook(
      book([
        ['MID', ' Net Revenue ', 'Agent  Income'],
        ['550000000101', 1.5, 2],
      ]),
    );
    expect(wb.sheets[0].headers).toEqual(['MID', ' Net Revenue ', 'Agent  Income']);
  });

  /*
   * Object mode would rename the second one "Fee Item_1", which is a header
   * no saved mapping can ever match. Array mode keeps both.
   */
  it('keeps duplicate headers rather than renaming them', () => {
    const wb = parseWorkbook(
      book([
        ['MID', 'Fee Item', 'Fee Item'],
        ['550000000101', 'a', 'b'],
      ]),
    );
    expect(wb.sheets[0].headers).toEqual(['MID', 'Fee Item', 'Fee Item']);
  });

  it('a date cell becomes a calendar date, not a serial number', () => {
    const wb = parseWorkbook(
      book([
        ['MID', 'Date', 'Amount'],
        ['550000000101', new Date(Date.UTC(2026, 4, 31)), 5],
      ]),
    );
    expect(wb.sheets[0].rows[0][1]).toBe('2026-05-31');
  });

  it('a currency-formatted cell arrives as its underlying number', () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['MID', 'Net Revenue'],
      ['550000000101', 1234.56],
    ]);
    ws['B2'].z = '$#,##0.00';
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const parsed = parseWorkbook(
      new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer),
    );
    expect(parsed.sheets[0].rows[0][1]).toBe(1234.56);
  });

  /*
   * Dropped from `rows`, but their position is kept — that is the whole job of
   * `rowNumbers`. Without it the second merchant below is reported as row 3
   * when Excel shows it on row 4.
   */
  it('drops blank rows but keeps the real row numbers of the rest', () => {
    const wb = parseWorkbook(
      book([
        ['MID', 'Fee Item'],
        ['550000000101', 'a'],
        [],
        ['550000000102', 'b'],
      ]),
    );
    expect(wb.sheets[0].rows).toHaveLength(2);
    expect(wb.sheets[0].rowNumbers).toEqual([2, 4]);
  });

  /* Not a guess: a sheet with no locatable header reports as having none. */
  it('a sheet with no header row comes back empty rather than guessed', () => {
    const wb = parseWorkbook(book([[1, 2, 3], [4, 5, 6]]));
    expect(wb.sheets[0].headers).toEqual([]);
    expect(wb.sheets[0].rows).toEqual([]);
  });

  /*
   * ── THE REAL MERCHANT-RATES WORKBOOK ──────────────────────────────────
   * Its header spans TWO rows: MID, Merchant Name and Processor are named on
   * row 1 beside merged group labels ("Authorization Fees", "Volume Fees"),
   * and the rate columns are named on row 2 — whose first cell is a sentence
   * of prose describing the tab.
   *
   * Neither row is the header on its own, so no heuristic reads it correctly.
   * The finder picks row 1, which labels the rate columns with group names.
   * That is why the override exists, and why the screen states the row it used
   * rather than deciding silently.
   */
  it('picks the wrong row on a two-row header, which is why the override exists', () => {
    const wb = parseWorkbook(
      book([
        ['MID', 'Merchant Name', 'Processor', 'Authorization Fees', '', 'Volume Fees'],
        ['This tab lists the fees the merchant pays.', '', '', 'Amex Auth Fee', 'VMD Auth Fee', 'VMD Volume'],
        ['201100230235', 'THE PURPLE POINT', 'Maverick', 0.1, 0.1, 0.0338],
      ]),
    );
    /* Row 1 wins, so the rate columns carry group labels and a blank. */
    expect(wb.sheets[0].headerRow).toBe(1);
    expect(wb.sheets[0].headers).toContain('Authorization Fees');
    expect(wb.sheets[0].headers).not.toContain('VMD Auth Fee');
  });

  it('and the override reads that same sheet correctly', () => {
    const bytes = book([
      ['MID', 'Merchant Name', 'Processor', 'Authorization Fees', '', 'Volume Fees'],
      ['This tab lists the fees the merchant pays.', '', '', 'Amex Auth Fee', 'VMD Auth Fee', 'VMD Volume'],
      ['201100230235', 'THE PURPLE POINT', 'Maverick', 0.1, 0.1, 0.0338],
    ]);
    const wb = parseWorkbook(bytes, { headerRows: { Sheet1: 2 } });

    expect(wb.sheets[0].headerRow).toBe(2);
    expect(wb.sheets[0].headers).toContain('VMD Auth Fee');
    expect(wb.sheets[0].headers).toContain('VMD Volume');

    /* One data row, at its real worksheet position. */
    expect(wb.sheets[0].rows).toHaveLength(1);
    expect(wb.sheets[0].rowNumbers).toEqual([3]);

    /*
     * And the rate arrives as the CELL VALUE, not the percentage it displays
     * as. This is the whole reason the sheet must be read as .xlsx: the same
     * cell CSV-exports as "3.38%", losing the digits beyond two decimals and
     * scaling it by a hundred.
     */
    expect(wb.sheets[0].rows[0][5]).toBe(0.0338);
  });

  it('ignores an override that is off the end of the sheet', () => {
    /* A stale value from a previous file must not produce an empty sheet that
       reads as a parse failure. */
    const wb = parseWorkbook(
      book([
        ['MID', 'Fee Item'],
        ['550000000101', 'a'],
      ]),
      { headerRows: { Sheet1: 99 } },
    );
    expect(wb.sheets[0].headers).toEqual(['MID', 'Fee Item']);
  });

  it('reads every sheet in the book', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['MID', 'A'], ['1', 2]]), 'Fees');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['MID', 'B'], ['2', 3]]), 'Notes');
    const parsed = parseWorkbook(
      new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer),
    );
    expect(parsed.sheets.map((s) => s.name)).toEqual(['Fees', 'Notes']);
  });
});
