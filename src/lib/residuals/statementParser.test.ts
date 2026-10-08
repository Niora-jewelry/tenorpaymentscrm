/**
 * The statement reader.
 *
 * Every case here is one whose failure is a plausible-looking number rather
 * than an error. The row-shift case in particular is not hypothetical: it is
 * what `pdftotext -layout` actually did to MID 201100272922's August 2026
 * statement, and the figures in `shiftedRowTrap` are that statement's.
 */
import { describe, expect, it } from 'vitest';
import {
  clusterRows,
  parseStatement,
  toCents,
  verifyTotals,
  type LoadedPdf,
  type Positioned,
} from './statementParser';

/** A page of text runs, built by hand so the test owns its fixture. */
function page(runs: Positioned[]): LoadedPdf {
  return { pages: [runs] };
}

const loader = (doc: LoadedPdf) => async () => doc;

/** One table row: a left-column label and its cells, at a given y. */
function row(y: number, label: string, cells: string[]): Positioned[] {
  const xs = [71, 117, 188, 253];
  return [
    { text: label, x: 18, y },
    ...cells.map((text, i) => ({ text, x: xs[i] ?? 300 + i * 40, y })),
  ];
}

/** The header the real statements print above the plan rows, over two lines. */
function planHeader(y: number): Positioned[] {
  return [
    { text: 'Plan', x: 18, y },
    { text: 'Number of', x: 53, y },
    { text: 'Amount of', x: 118, y },
    { text: 'Code', x: 18, y: y - 8.4 },
    { text: 'Sales', x: 67, y: y - 8.4 },
  ];
}

describe('toCents', () => {
  it('shifts the digits instead of multiplying, so no float rounds', () => {
    /* 806.48 * 100 is 80647.99999999999 in binary floating point. */
    expect(toCents('806.48')).toBe(80648);
    expect(toCents('108415.18')).toBe(10841518);
    expect(toCents('0.07')).toBe(7);
  });

  it('reads the statement spellings of zero', () => {
    expect(toCents('.00')).toBe(0);
    expect(toCents('00')).toBe(0);
    expect(toCents('0')).toBe(0);
  });

  it('keeps a single decimal place from being read as tens', () => {
    expect(toCents('25.7')).toBe(2570);
  });

  it('null stays null — it is not zero', () => {
    expect(toCents(null)).toBeNull();
  });
});

describe('clusterRows', () => {
  it('groups runs that share a line and orders them left to right', () => {
    const rows = clusterRows([
      { text: 'b', x: 100, y: 500 },
      { text: 'a', x: 18, y: 500.4 },
      { text: 'lower', x: 18, y: 480 },
    ]);
    expect(rows.map((r) => r.map((c) => c.text))).toEqual([['a', 'b'], ['lower']]);
  });

  it('keeps adjacent table rows apart at the real 10.5pt pitch', () => {
    const rows = clusterRows([
      { text: 'VS', x: 18, y: 508.8 },
      { text: 'VD', x: 18, y: 498.3 },
    ]);
    expect(rows).toHaveLength(2);
  });
});

describe('parseStatement', () => {
  it('reads the merchant number out of the document, past the mask', async () => {
    const parsed = await parseStatement(
      new Uint8Array(),
      loader(
        page([
          { text: 'Merchant Number:', x: 300, y: 700 },
          { text: 'xxxx201100272922', x: 450, y: 700 },
          { text: 'Processing Month:', x: 300, y: 720 },
          { text: '08-26', x: 450, y: 720 },
          ...planHeader(526),
          ...row(508, 'VS', ['529', '18,813.79', '00', '.00']),
          ...row(498, '**', ['529', '18,813.79', '00', '.00']),
        ]),
      ),
    );
    expect(parsed.mid).toBe('201100272922');
    expect(parsed.processingMonth).toBe('08-26');
  });

  it('pairs each plan code with its OWN row', async () => {
    /*
     * The shifted-row trap. These are the real figures: a text-flow extractor
     * put 7,451.51 on MC and 806.48 on AM, one row above where each belongs.
     */
    const parsed = await parseStatement(
      new Uint8Array(),
      loader(
        page([
          ...planHeader(526),
          ...row(508.8, 'VS', ['529', '18,813.79', '00', '.00']),
          ...row(498.3, 'VD', ['2,019', '57,111.10', '03', '91.98']),
          ...row(487.8, 'VB', ['59', '7,451.51', '00', '.00']),
          ...row(477.3, 'MC', ['274', '8,373.90', '00', '.00']),
          ...row(435.3, 'AM', ['86', '3,593.57', '00', '.00']),
          ...row(372.3, '**', ['2,967', '95,330.07', '03', '91.98']),
        ]),
      ),
    );
    const byCode = Object.fromEntries(parsed.planRows.map((r) => [r.planCode, r.amount]));
    expect(byCode.VB).toBe('7451.51');
    expect(byCode.MC).toBe('8373.90');
    expect(byCode.AM).toBe('3593.57');
  });

  it('stops at the totals row and never reads the deposit table below it', async () => {
    /*
     * The deposit detail table starts with a two-digit DAY in the same left
     * column, so shape alone cannot tell it from a plan code. Unbounded, this
     * swallowed 27 extra rows and summed a count of 2,430,046,390,605.
     */
    const parsed = await parseStatement(
      new Uint8Array(),
      loader(
        page([
          ...planHeader(526),
          ...row(508.8, 'VS', ['529', '18,813.79', '00', '.00']),
          ...row(372.3, '**', ['529', '18,813.79', '00', '.00']),
          { text: 'Day', x: 18, y: 324.6 },
          ...row(315.6, '02', ['90001730033', '1,582.14']),
          ...row(306.3, '03', ['90001110084', '2,432.72']),
        ]),
      ),
    );
    expect(parsed.planRows.map((r) => r.planCode)).toEqual(['VS']);
    expect(verifyTotals(parsed)).toMatchObject({ ok: true, itemCount: 529 });
  });

  it('is not fooled by the deposit table having a Plan header of its own', async () => {
    /* It prints `Plan` too, but at x≈154 rather than the left column. */
    const parsed = await parseStatement(
      new Uint8Array(),
      loader(
        page([
          { text: 'Reference', x: 53, y: 333 },
          { text: 'Plan', x: 154, y: 333 },
          ...row(315.6, '02', ['90001730033', '1,582.14']),
        ]),
      ),
    );
    expect(parsed.planRows).toEqual([]);
  });
});

describe('verifyTotals', () => {
  const good = [
    ...planHeader(526),
    ...row(508.8, 'VS', ['529', '18,813.79', '00', '.00']),
    ...row(498.3, 'VD', ['2,019', '57,111.10', '03', '91.98']),
    ...row(372.3, '**', ['2,548', '75,924.89', '03', '91.98']),
  ];

  it('passes a statement that adds up to its own printed total', async () => {
    const parsed = await parseStatement(new Uint8Array(), loader(page(good)));
    expect(verifyTotals(parsed)).toEqual({ ok: true, itemCount: 2548, amountCents: 7592489 });
  });

  it('refuses a statement whose rows do not sum to the printed amount', async () => {
    const parsed = await parseStatement(
      new Uint8Array(),
      loader(
        page([
          ...planHeader(526),
          ...row(508.8, 'VS', ['529', '18,813.79', '00', '.00']),
          /* One cent out — the smallest misread there is. */
          ...row(372.3, '**', ['529', '18,813.80', '00', '.00']),
        ]),
      ),
    );
    const verdict = verifyTotals(parsed);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.problems[0]).toContain('18813.79');
    expect(verdict.ok === false && verdict.problems[0]).toContain('18813.80');
  });

  it('refuses when the counts disagree even though the money agrees', async () => {
    const parsed = await parseStatement(
      new Uint8Array(),
      loader(
        page([
          ...planHeader(526),
          ...row(508.8, 'VS', ['529', '18,813.79', '00', '.00']),
          ...row(372.3, '**', ['530', '18,813.79', '00', '.00']),
        ]),
      ),
    );
    const verdict = verifyTotals(parsed);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.problems.join(' ')).toContain('529 sales');
  });

  it('refuses a statement with no totals row, because nothing can prove it', async () => {
    const parsed = await parseStatement(
      new Uint8Array(),
      loader(
        page([...planHeader(526), ...row(508.8, 'VS', ['529', '18,813.79', '00', '.00'])]),
      ),
    );
    const verdict = verifyTotals(parsed);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.problems[0]).toContain('cannot be proved correct');
  });

  it('refuses a document with no plan table at all', async () => {
    const parsed = await parseStatement(new Uint8Array(), loader(page([])));
    expect(verifyTotals(parsed)).toEqual({
      ok: false,
      problems: ['No plan-code summary table was found in this statement.'],
    });
  });

  it('a statement of all zeros is valid — a dormant merchant is not an error', async () => {
    const parsed = await parseStatement(
      new Uint8Array(),
      loader(
        page([
          ...planHeader(526),
          ...row(508.8, 'VS', ['00', '.00', '00', '.00']),
          ...row(372.3, '**', ['00', '.00', '00', '.00']),
        ]),
      ),
    );
    expect(verifyTotals(parsed)).toEqual({ ok: true, itemCount: 0, amountCents: 0 });
  });
});
