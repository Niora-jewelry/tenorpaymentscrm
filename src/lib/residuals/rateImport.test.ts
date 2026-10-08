/**
 * The rates-sheet reader, and the three cell states it has to keep apart.
 *
 * `residuals.md` §6.6 calls the `"$ -"` → `0.000000` reading "inferential and
 * load-bearing". These tests are what holds it in place, because collapsing
 * `"$ -"` into blank is invisible in every way that matters: the import
 * succeeds, the rate column reads as empty, and the engine then refuses a
 * charge the sheet had in fact decided. Measured when it happened: 38 of
 * August 2026's line failures.
 */
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { buildRateRows, readRateCell } from './rateImport';
import { parseWorkbook } from './xlsxParser';

describe('readRateCell — three states, not two', () => {
  it('a number is the rate', () => {
    expect(readRateCell(0.2)).toEqual({ state: 'number', value: '0.2' });
    expect(readRateCell('0.033816')).toEqual({ state: 'number', value: '0.033816' });
    expect(readRateCell('$39.95')).toEqual({ state: 'number', value: '39.95' });
  });

  it('a literal zero is a rate of zero, not a decision and not an absence', () => {
    expect(readRateCell(0)).toEqual({ state: 'number', value: '0' });
  });

  it('"$ -" is a recorded decision and stores 0', () => {
    /* The sheet's own spelling, with the space, as written. */
    expect(readRateCell('$ -')).toEqual({ state: 'declined', value: '0' });
    expect(readRateCell('-')).toEqual({ state: 'declined', value: '0' });
    expect(readRateCell(' $  —  ')).toEqual({ state: 'declined', value: '0' });
  });

  it('blank is an absence and stores NULL, so the engine fails loud', () => {
    expect(readRateCell(null)).toEqual({ state: 'absent', value: null });
    expect(readRateCell('')).toEqual({ state: 'absent', value: null });
    expect(readRateCell('   ')).toEqual({ state: 'absent', value: null });
  });

  it('declined and absent are never the same answer', () => {
    /* The whole point. If this ever passes with both null, §6.6 is broken. */
    expect(readRateCell('$ -').value).toBe('0');
    expect(readRateCell(null).value).toBeNull();
  });

  it('a value it cannot read is an error, not a quiet null', () => {
    expect(readRateCell('n/a').state).toBe('unreadable');
    expect(readRateCell('see notes').state).toBe('unreadable');
    expect(readRateCell(true).state).toBe('unreadable');
  });
});

/** A rates sheet built in memory, so the test owns its own fixture. */
function sheet(rows: unknown[][]) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Rates');
  const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
  const parsed = parseWorkbook(bytes).sheets[0];
  return parsed;
}

describe('buildRateRows', () => {
  const mapping = new Map([
    [0, 'mid'],
    [1, 'risk_code'],
    [2, 'avs_fee'],
  ]);

  it('carries all three states through to the row', () => {
    const built = buildRateRows(
      sheet([
        ['MID', 'Risk', 'AVS Fee'],
        ['201100272922', 1, 0.1],
        ['201100241497', 1, '$ -'],
        ['30119889965', 1, null],
      ]),
      mapping,
    );
    expect(built.errors).toEqual([]);
    expect(built.rows.map((r) => r.avs_fee)).toEqual(['0.1', '0', null]);
  });

  it('counts the three states per column for the operator to confirm', () => {
    const built = buildRateRows(
      sheet([
        ['MID', 'Risk', 'AVS Fee'],
        ['201100272922', 1, 0.1],
        ['201100241497', 1, '$ -'],
        ['30119889965', 1, '$ -'],
        ['30119963240', 1, null],
      ]),
      mapping,
    );
    expect(built.columnStates).toEqual([
      { key: 'avs_fee', header: 'AVS Fee', numbers: 1, declined: 2, absent: 1 },
    ]);
  });

  it('does not let the sheet footer inflate the absent count', () => {
    /*
     * A totals row has no MID and is dropped. Counting its empty rate cells as
     * absences would overstate how much is missing on the very panel the
     * operator uses to decide whether the file is complete.
     */
    const built = buildRateRows(
      sheet([
        ['MID', 'Risk', 'AVS Fee'],
        ['201100272922', 1, 0.1],
        ['Total', null, null],
      ]),
      mapping,
    );
    expect(built.skippedNoMid).toBe(1);
    expect(built.columnStates[0]).toMatchObject({ numbers: 1, absent: 0 });
  });

  it('reports an unreadable rate against its worksheet row', () => {
    const built = buildRateRows(
      sheet([
        ['MID', 'Risk', 'AVS Fee'],
        ['201100272922', 1, 'ask Izzy'],
      ]),
      mapping,
    );
    expect(built.errors).toEqual([
      { sheetRow: 2, header: 'AVS Fee', key: 'avs_fee', raw: 'ask Izzy' },
    ]);
  });
});
