/**
 * The test suite every residual calculator engine must pass.
 *
 * Not a test file itself: each engine has a small test file that calls
 * `runCalcContract` with its own engine, so the TypeScript and SQL engines are
 * held to exactly the same cases and the same expected answers.
 */
import { describe, expect, it } from 'vitest';
import {
  ACCEPT_BLUE_CHARGED_TOTAL,
  ACCEPT_BLUE_EXPECTED_ALERTS,
  ACCEPT_BLUE_EXPECTED_MERCHANTS,
  ACCEPT_BLUE_EXPECTED_MISSING,
  ACCEPT_BLUE_EXPECTED_TOTAL,
  ACCEPT_BLUE_INPUT,
} from './fixtures/acceptBlue';
import {
  ACH_EXPECTED_MIDS,
  ACH_EXPECTED_ROWS,
  ACH_EXPECTED_TOTAL,
  ACH_EXPECTED_UNMATCHED,
  ACH_INPUT,
} from './fixtures/ach';
import {
  ACQUIRING_EXPECTED_MIDS,
  ACQUIRING_EXPECTED_ROWS,
  ACQUIRING_EXPECTED_TOTAL,
  ACQUIRING_INPUT,
} from './fixtures/acquiring';
import { FLAG_CODES, type Flag, type FlagColor, type ResidualCalcEngine } from './types';

const codes = (flags: Flag[]) => flags.map((f) => f.code).sort();
const codesWithField = (flags: Flag[]) => flags.map((f) => (f.field ? `${f.code}:${f.field}` : f.code)).sort();

/** Every flag carries the colour FLAG_CODES gives its code. */
function expectKnownColours(flags: Flag[], table: Record<string, FlagColor | null>) {
  for (const f of flags) {
    expect(Object.keys(table), `unknown flag code ${f.code}`).toContain(f.code);
    expect(f.color, `${f.code} colour`).toBe(table[f.code]);
    expect(typeof f.message).toBe('string');
  }
}

export function runCalcContract(name: string, getEngine: () => ResidualCalcEngine) {
  describe(`${name}: Acquiring`, () => {
    it('reads only the chosen month and returns rows in report order', async () => {
      const out = await getEngine().acquiring(ACQUIRING_INPUT);
      expect(out.rows.map((r) => [r.mid, r.feeItemName])).toEqual(
        ACQUIRING_EXPECTED_ROWS.map((r) => [r.mid, r.feeItemName]),
      );
    });

    for (const exp of ACQUIRING_EXPECTED_ROWS) {
      it(`row ${exp.mid.slice(-2)} ${exp.feeItemName}`, async () => {
        const out = await getEngine().acquiring(ACQUIRING_INPUT);
        const row = out.rows.find((r) => r.mid === exp.mid && r.feeItemName === exp.feeItemName)!;
        expect(row, 'row present').toBeTruthy();
        expect({
          merchantPayment: row.merchantPayment,
          buyRate: row.buyRate,
          income: row.income,
          flags: codes(row.flags),
          color: row.color,
        }).toEqual({
          merchantPayment: exp.merchantPayment,
          buyRate: exp.buyRate,
          income: exp.income,
          flags: [...exp.flags].sort(),
          color: exp.color,
        });
        expectKnownColours(row.flags, FLAG_CODES.acquiring);
      });
    }

    for (const exp of ACQUIRING_EXPECTED_MIDS) {
      it(`MID ${exp.mid.slice(-2)} summary`, async () => {
        const out = await getEngine().acquiring(ACQUIRING_INPUT);
        const mid = out.mids.find((m) => m.mid === exp.mid)!;
        expect(mid, 'MID present').toBeTruthy();
        expect({ ...mid, flags: codes(mid.flags) }).toEqual({ ...exp, flags: [...exp.flags].sort() });
        expectKnownColours(mid.flags, FLAG_CODES.acquiring);
      });
    }

    it('MIDs in order of first appearance, and the final Acquiring number', async () => {
      const out = await getEngine().acquiring(ACQUIRING_INPUT);
      expect(out.mids.map((m) => m.mid)).toEqual(ACQUIRING_EXPECTED_MIDS.map((m) => m.mid));
      expect(out.total).toBe(ACQUIRING_EXPECTED_TOTAL);
    });

    it('proceeding without a statement calculates the MID, red, from the report Amount', async () => {
      // Only M5 (AVS 10 × 0.05 = 0.50 − 10 × 0.01 = 0.10 → 0.40; × 0.90 = 0.36).
      const input = {
        ...ACQUIRING_INPUT,
        proceedWithoutStatement: true,
        reportRows: ACQUIRING_INPUT.reportRows.filter((r) => r.mid === '900000000005'),
      };
      const out = await getEngine().acquiring(input);
      expect(out.rows[0]).toMatchObject({ merchantPayment: '0.50', buyRate: '0.10', income: '0.40', color: 'red' });
      expect(codes(out.rows[0].flags)).toEqual(['NO_STATEMENT']);
      expect(out.mids[0]).toMatchObject({ calculated: true, netIncome: '0.36' });
      expect(out.total).toBe('0.36');
    });
  });

  describe(`${name}: ACH`, () => {
    for (const exp of ACH_EXPECTED_ROWS) {
      it(`row ${exp.merchantName} ${exp.feeCategory}`, async () => {
        const out = await getEngine().ach(ACH_INPUT);
        const row = out.rows.find((r) => r.merchantName === exp.merchantName && r.feeCategory === exp.feeCategory)!;
        expect(row, 'row present').toBeTruthy();
        expect({
          mid: row.mid,
          merchantPayment: row.merchantPayment,
          buyRate: row.buyRate,
          net: row.net,
          split: row.split,
          flags: codes(row.flags),
          color: row.color,
        }).toEqual({
          mid: exp.mid,
          merchantPayment: exp.merchantPayment,
          buyRate: exp.buyRate,
          net: exp.net,
          split: exp.split,
          flags: [...exp.flags].sort(),
          color: exp.color,
        });
        expectKnownColours(row.flags, FLAG_CODES.ach);
      });
    }

    it('rows in report order, the chosen month only', async () => {
      const out = await getEngine().ach(ACH_INPUT);
      expect(out.rows.map((r) => [r.merchantName, r.feeCategory])).toEqual(
        ACH_EXPECTED_ROWS.map((r) => [r.merchantName, r.feeCategory]),
      );
    });

    it('per-MID totals, the unmatched-name worklist and the final ACH number', async () => {
      const out = await getEngine().ach(ACH_INPUT);
      expect(out.mids.map((m) => ({ ...m, flags: codes(m.flags) }))).toEqual(ACH_EXPECTED_MIDS);
      for (const m of out.mids) expectKnownColours(m.flags, FLAG_CODES.ach);
      expect(out.unmatchedNames).toEqual(ACH_EXPECTED_UNMATCHED);
      expect(out.total).toBe(ACH_EXPECTED_TOTAL);
    });
  });

  describe(`${name}: Accept.blue`, () => {
    for (const exp of ACCEPT_BLUE_EXPECTED_MERCHANTS) {
      it(exp.name, async () => {
        const out = await getEngine().acceptBlue(ACCEPT_BLUE_INPUT);
        const m = out.merchants.find((x) => x.name === exp.name)!;
        expect(m, 'merchant present').toBeTruthy();
        expect({ ...m, flags: codesWithField(m.flags) }).toEqual({ ...exp, flags: [...exp.flags].sort() });
        expectKnownColours(m.flags, FLAG_CODES.acceptBlue);
      });
    }

    it('merchants in report order, missing merchants, alerts and both totals', async () => {
      const out = await getEngine().acceptBlue(ACCEPT_BLUE_INPUT);
      expect(out.merchants.map((m) => m.name)).toEqual(ACCEPT_BLUE_EXPECTED_MERCHANTS.map((m) => m.name));
      expect(out.missingFromReport).toEqual(ACCEPT_BLUE_EXPECTED_MISSING);
      expect(codesWithField(out.alerts)).toEqual([...ACCEPT_BLUE_EXPECTED_ALERTS].sort());
      expectKnownColours(out.alerts, FLAG_CODES.acceptBlue);
      expect(out.expectedTotal).toBe(ACCEPT_BLUE_EXPECTED_TOTAL);
      expect(out.chargedTotal).toBe(ACCEPT_BLUE_CHARGED_TOTAL);
    });

    it('warns when the report month differs from the chosen month, and still runs', async () => {
      const out = await getEngine().acceptBlue({ ...ACCEPT_BLUE_INPUT, reportMonth: '2026-07' });
      expect(codes(out.alerts)).toContain('MONTH_MISMATCH');
      expect(out.expectedTotal).toBe(ACCEPT_BLUE_EXPECTED_TOTAL);
    });

    it('reads the Month cell as an Excel date serial (46082 = March 2026)', async () => {
      const out = await getEngine().acceptBlue({ ...ACCEPT_BLUE_INPUT, month: '2026-03', reportMonth: 46082 });
      expect(codes(out.alerts)).not.toContain('MONTH_MISMATCH');
    });
  });
}
