/**
 * Header -> column, and the rows that come out of it.
 *
 * Two invariants are asserted here against the database rather than against
 * themselves: the fourteen targets must be the fourteen the CHECK constraint
 * allows, and every value handed to `jsonb_to_recordset` must be a string or
 * null. The first drifts silently if someone adds a column; the second turns a
 * figure into a float, which is the failure the whole module is shaped around.
 */
import { describe, expect, it } from 'vitest';
import {
  POISONED_TARGETS,
  TARGETS,
  NUMERIC_TARGETS,
  TARGET_LABEL,
  REQUIRED_TARGETS,
  buildRows,
  detectMonths,
  headerKey,
  suggestMapping,
  type Target,
} from './mapping';
import type { ParsedSheet } from './xlsxParser';

/**
 * `rowNumbers` defaults to the no-blank-rows case (header on row 1, data from
 * row 2), which is what most of these tests want. The drift test below passes
 * its own, because that is the case the field exists for.
 */
function sheet(
  headers: string[],
  rows: (string | number | boolean | null)[][],
  rowNumbers?: number[],
): ParsedSheet {
  return {
    name: 'Sheet1',
    headers,
    rows,
    rowNumbers: rowNumbers ?? rows.map((_, i) => i + 2),
    headerRow: 1,
  };
}

describe('the target vocabulary', () => {
  it('is the same fourteen the CHECK constraint allows', () => {
    /* Copied from residual_column_mappings.target_column in migration
       20260819009702, deliberately as a literal rather than imported, so a
       change on either side shows up here as a diff. */
    expect([...TARGETS].sort()).toEqual(
      [
        'agent',
        'agent_expense',
        'agent_income',
        'agent_owner',
        'amount',
        'branch',
        'buy_rate_per_item',
        'fee_category',
        'fee_item_name',
        'item_count',
        'merchant_name',
        'mid',
        'net_revenue',
        'root_agent',
      ].sort(),
    );
  });

  it('every target has a label, and only targets do', () => {
    expect(Object.keys(TARGET_LABEL).sort()).toEqual([...TARGETS].sort());
  });

  it('the numeric set is exactly the numeric columns of residual_lines', () => {
    expect([...NUMERIC_TARGETS].sort()).toEqual(
      ['agent_expense', 'agent_income', 'amount', 'buy_rate_per_item', 'item_count', 'net_revenue'].sort(),
    );
  });

  it('the required targets are the two the engine cannot work without', () => {
    expect([...REQUIRED_TARGETS]).toEqual(['mid', 'fee_item_name']);
  });
});

describe('headerKey', () => {
  it('collapses to something comparable', () => {
    expect(headerKey('  Net   Revenue ')).toBe('net revenue');
    expect(headerKey('Buy Rate / Item')).toBe('buy rate item');
    expect(headerKey('MID')).toBe('mid');
  });
});

describe('the display-rounded buy rate', () => {
  /*
   * -- THE TRAP THIS GUARDS -----------------------------------------------
   * The fee report's "Buy Rate Per Item" column is rounded to 2dp for display.
   * It shows 0.03 where the cell holds 0.025, and the handoff records that
   * this "has produced three wrong conclusions" — you compare the 0.03 to a
   * template 0.025 and record a variance that does not exist. The true rate is
   * Agent Expense / Count.
   *
   * The column stays importable, because it is attribution and the engine
   * costs from the template schedule regardless. What must never happen is the
   * importer PROPOSING it, because a suggestion is taken as a recommendation.
   */
  it('is never suggested from any header spelling', () => {
    for (const header of [
      'Buy Rate',
      'Buy Rate Per Item',
      'buy rate per item',
      'Cost Per Item',
      'BUY RATE',
    ]) {
      const s = suggestMapping(sheet([header], []), new Map());
      expect(s[0].suggested, header).not.toBe('buy_rate_per_item');
    }
  });

  it('but is still selectable, and carries a warning when selected', () => {
    expect(TARGETS).toContain('buy_rate_per_item');
    expect(POISONED_TARGETS.buy_rate_per_item).toMatch(/2dp|rounded/i);
    /* The warning has to name the real source of the number, or it is just a
       scold. */
    expect(POISONED_TARGETS.buy_rate_per_item).toMatch(/Agent Expense/i);
  });

  it('and a saved mapping for it is still honoured', () => {
    /* An operator who mapped it deliberately last month keeps that decision —
       the guard is against suggesting, not against choosing. */
    const saved = new Map<string, Target>([['Buy Rate', 'buy_rate_per_item']]);
    const s = suggestMapping(sheet(['Buy Rate'], []), saved);
    expect(s[0].saved).toBe('buy_rate_per_item');
  });

  it('nothing else is marked poisoned', () => {
    /* If this grows, each entry needs its own reason on screen — the list is
       not a severity flag, it is a set of specific measured traps. */
    expect(Object.keys(POISONED_TARGETS)).toEqual(['buy_rate_per_item']);
  });
});

describe('suggestMapping', () => {
  it('proposes a target for a header it recognises', () => {
    const s = suggestMapping(sheet(['MID', 'Fee Item', 'Net Revenue'], []), new Map());
    expect(s.map((x) => x.suggested)).toEqual(['mid', 'fee_item_name', 'net_revenue']);
  });

  it('proposes nothing for a header it does not recognise', () => {
    const s = suggestMapping(sheet(['Widget Code'], []), new Map());
    expect(s[0].suggested).toBeNull();
  });

  /* A saved mapping is a decision someone already made about this file. */
  it('a saved mapping wins over the alias table', () => {
    const saved = new Map<string, Target>([['Net Revenue', 'amount']]);
    const s = suggestMapping(sheet(['Net Revenue'], []), saved);
    expect(s[0].saved).toBe('amount');
    expect(s[0].suggested).toBeNull();
  });

  /*
   * Two columns cannot both feed net_revenue — the partial unique index on
   * (processor, target_column) refuses it. Proposing it anyway would hand the
   * operator a collision to discover at commit time.
   */
  it('never proposes a target twice', () => {
    const s = suggestMapping(sheet(['Net Revenue', 'Net'], []), new Map());
    expect(s[0].suggested).toBe('net_revenue');
    expect(s[1].suggested).toBeNull();
  });

  it('nor one a saved mapping already holds', () => {
    const saved = new Map<string, Target>([['Net Revenue', 'net_revenue']]);
    const s = suggestMapping(sheet(['Net Revenue', 'Net'], []), saved);
    expect(s[1].suggested).toBeNull();
  });
});

describe('buildRows', () => {
  const headers = ['MID', 'Fee Item', 'Item Count', 'Net Revenue'];
  const mapping = new Map<number, Target>([
    [0, 'mid'],
    [1, 'fee_item_name'],
    [2, 'item_count'],
    [3, 'net_revenue'],
  ]);

  it('produces one row per data row, with all fourteen keys', () => {
    const built = buildRows(
      sheet(headers, [['550000000101', 'Authorization Fee IP/SSL', 100, 8]]),
      mapping,
    );
    expect(built.rows).toHaveLength(1);
    expect(Object.keys(built.rows[0]).sort()).toEqual([...TARGETS].sort());
    expect(built.errors).toEqual([]);
  });

  /*
   * The invariant the module's arithmetic rests on. A JSON number has been
   * through a float; `jsonb_to_recordset`'s cast to numeric(14,2) must be
   * given the decimal text instead.
   */
  it('every value is a string or null — never a number', () => {
    const built = buildRows(
      sheet(headers, [['550000000101', 'Monthly Fee', 1, -4.5]]),
      mapping,
    );
    for (const [k, v] of Object.entries(built.rows[0])) {
      expect(v === null || typeof v === 'string', `${k} = ${String(v)}`).toBe(true);
    }
    expect(built.rows[0].net_revenue).toBe('-4.5');
    expect(built.rows[0].item_count).toBe('1');
  });

  it('an unmapped target comes out null', () => {
    const built = buildRows(sheet(headers, [['550000000101', 'x', 1, 2]]), mapping);
    expect(built.rows[0].branch).toBeNull();
    expect(built.rows[0].merchant_name).toBeNull();
  });

  /*
   * All of them in one pass, with the worksheet row number Excel shows, so
   * the operator fixes the file once rather than discovering one cell per
   * upload.
   */
  it('collects every unreadable numeric cell, naming the worksheet row', () => {
    const built = buildRows(
      sheet(headers, [
        ['550000000101', 'a', 'n/a', 1],
        ['550000000102', 'b', 2, '12%'],
      ]),
      mapping,
    );
    expect(built.errors).toHaveLength(2);
    expect(built.errors[0]).toEqual({
      sheetRow: 2,
      header: 'Item Count',
      target: 'item_count',
      raw: 'n/a',
    });
    expect(built.errors[1].sheetRow).toBe(3);
    expect(built.errors[1].target).toBe('net_revenue');
  });

  /* The RPC drops these silently; dropping them here keeps the count honest. */
  /*
   * The number has to be the one Excel shows. Derived from the array index it
   * is short by every blank row above, and an error naming row 41 when the
   * problem is on row 44 sends the operator to a line with nothing wrong
   * with it.
   */
  it('names the real worksheet row, not the position in the array', () => {
    const built = buildRows(
      /* Two blank rows sat between these in the file: worksheet rows 5 and 9. */
      sheet(headers, [
        ['550000000101', 'a', 'n/a', 1],
        ['550000000102', 'b', 2, 'n/a'],
      ], [5, 9]),
      mapping,
    );
    expect(built.errors.map((e) => e.sheetRow)).toEqual([5, 9]);
  });

  it('drops a row with no MID, and says how many', () => {
    const built = buildRows(
      sheet(headers, [
        ['550000000101', 'a', 1, 2],
        ['', 'Total', 999, 888],
        [null, 'Grand total', 1, 1],
      ]),
      mapping,
    );
    expect(built.rows).toHaveLength(1);
    expect(built.skippedNoMid).toBe(2);
  });

  it('a numeric MID becomes digits, not a float', () => {
    const built = buildRows(sheet(headers, [[550000000101, 'a', 1, 2]]), mapping);
    expect(built.rows[0].mid).toBe('550000000101');
  });

  it('accounting format survives into the row', () => {
    const built = buildRows(sheet(headers, [['550000000101', 'Interchange', 0, '($375.32)']]), mapping);
    expect(built.rows[0].net_revenue).toBe('-375.32');
    expect(built.errors).toEqual([]);
  });

  it('a blank numeric is null, not zero', () => {
    const built = buildRows(sheet(headers, [['550000000101', 'a', null, '']]), mapping);
    expect(built.rows[0].item_count).toBeNull();
    expect(built.rows[0].net_revenue).toBeNull();
  });
});

describe('detectMonths', () => {
  it('finds the month in a date column', () => {
    const months = detectMonths(
      sheet(['MID', 'Statement Date'], [
        ['1', '2026-05-31'],
        ['2', '2026-05-31'],
      ]),
    );
    expect(months).toEqual(['2026-05-01']);
  });

  it('reports both when a file spans two months', () => {
    const months = detectMonths(
      sheet(['MID', 'Date'], [
        ['1', '2026-05-31'],
        ['2', '2026-06-01'],
      ]),
    );
    expect(months).toEqual(['2026-05-01', '2026-06-01']);
  });

  /* No date column is not an error; the operator states the month anyway. */
  it('finds nothing when there is no date column', () => {
    expect(detectMonths(sheet(['MID', 'Amount'], [['1', 2]]))).toEqual([]);
  });
});
