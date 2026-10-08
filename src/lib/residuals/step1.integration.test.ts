/**
 * Step 1 — the comparison `residuals.md` called "the highest-leverage gap".
 *
 * The spec recorded it as never once evaluated: `residual_verdicts` returned
 * zero step-1 rows, which is why its tolerance stayed a placeholder. August
 * 2026 was the first month with a statement and a fee report for the same
 * merchants, and migration 747 is what those sixteen comparisons measured.
 *
 * Each case below is one where the comparison looks right and is wrong by a
 * specific amount, so each is pinned as arithmetic rather than as a shape.
 * The figures mirror real merchants, named in the comments.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const DB_URL = process.env.SUPABASE_DB_URL;
const suite = DB_URL ? describe : describe.skip;

const MONTH = '2019-05-01';
const MID = { onCashDisc: '550000003001', notOnCashDisc: '550000003002' };

let db: pg.Client;
let adminId: string;
let periodId: string;
let savepoint = 0;

/** One statement as the admin, inside its own savepoint. See the sibling suite. */
async function asAdmin<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const sp = `sp${(savepoint += 1)}`;
  await db.query(`savepoint ${sp}`);
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: adminId, role: 'authenticated' }),
  ]);
  await db.query('set local role authenticated');
  try {
    const { rows } = await db.query(sql, params);
    await db.query('reset role');
    await db.query(`release savepoint ${sp}`);
    return rows as T[];
  } catch (e) {
    await db.query(`rollback to savepoint ${sp}`);
    await db.query('reset role');
    throw e;
  }
}

/** As the table owner, RLS bypassed — what the service role does. */
async function asOwner<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  await db.query('reset role');
  const { rows } = await db.query(sql, params);
  return rows as T[];
}

type Step1Row = {
  mid: string;
  fee_item_name: string;
  step: number;
  left_value: string | null;
  right_value: string | null;
  delta: string | null;
  verdict: string;
};

/** This period's step-1 verdicts, keyed by merchant and fee item. */
async function step1(): Promise<Map<string, Step1Row>> {
  /*
   * The processor is the THIRD parameter; the second is p_mid. Passing it
   * positionally as the second argument makes it a merchant filter, which
   * then normalises to no digits and silently behaves as "no filter" — the
   * right answer for the wrong reason. Named here so it cannot drift.
   */
  const rows = await asAdmin<Step1Row>(
    `select * from residual_verdicts(p_period_id => $1::uuid, p_processor => 'MAVERICK')`,
    [periodId],
  );
  return new Map(
    rows.filter((r) => Number(r.step) === 1).map((r) => [`${r.mid}|${r.fee_item_name}`, r]),
  );
}

async function statedAmount(mid: string, feeItem: string, amount: string) {
  await asOwner(
    `update residual_lines set amount = $4::numeric
      where period_id = $1 and mid = $2 and fee_item_name = $3`,
    [periodId, mid, feeItem, amount],
  );
}

suite('step 1 — what the volume is compared against', () => {
  beforeAll(async () => {
    db = new pg.Client({
      connectionString: DB_URL,
      ssl: { rejectUnauthorized: false },
      statement_timeout: 120_000,
    });
    await db.connect();
    await db.query('BEGIN');

    const { rows } = await db.query(
      `select p.id from profiles p join roles r on r.id = p.role_id
        where r.is_admin and p.deleted_at is null and p.status = 'active' limit 1`,
    );
    if (!rows.length) throw new Error('No active admin profile — cannot run this suite.');
    adminId = rows[0].id;

    const [period] = await asAdmin<{ id: string }>(
      `insert into residual_periods (statement_month, status, created_by_id)
       values ($1, 'open', $2) returning id`,
      [MONTH, adminId],
    );
    periodId = period.id;

    /*
     * A completed fee-report import, because that is how a period comes to
     * name a processor: `residual_period_context` reads it from the period's
     * imports, and without one `residual_verdicts` refuses with "Period
     * 2019-05 names no processor, so no registry or tolerance set applies."
     * The fixture has to look like a month somebody actually loaded.
     */
    await asOwner(
      `insert into residual_imports
         (period_id, processor, source_type, status, original_filename,
          processed_at, created_by_id)
       values ($1, 'MAVERICK', 'excel', 'completed', 'fixture.xlsx', now(), $2)`,
      [periodId, adminId],
    );

    /*
     * Two merchants differing in ONE respect: the first carries a Cash
     * Discount line and the second does not. That is what the conditional
     * Amex bucket turns on, and nothing else here differs.
     */
    const lines: [string, string][] = [
      [MID.onCashDisc, 'BIN Sponsorship Fees'],
      [MID.onCashDisc, 'Cash Disc/Surcharge Program'],
      [MID.notOnCashDisc, 'BIN Sponsorship Fees'],
    ];
    for (const [mid, feeItem] of lines) {
      /*
       * `source = 'manual'` because these lines have no import behind them,
       * which `residual_lines_provenance_consistent` states as an
       * equivalence: source = 'manual' IFF import_id IS NULL. The column
       * defaults to 'excel', so leaving it out is a 23514.
       */
      await asOwner(
        `insert into residual_lines
           (period_id, mid, fee_item_name, amount, item_count, source, created_by_id)
         values ($1, $2, $3, 0, 1, 'manual', $4)`,
        [periodId, mid, feeItem, adminId],
      );
    }

    /*
     * Identical volumes for both, with 30.00 of credits in the VMD bucket so
     * the net basis has something to subtract and gross and net differ.
     */
    for (const mid of [MID.onCashDisc, MID.notOnCashDisc]) {
      await asOwner(
        `insert into residual_merchant_volumes
           (period_id, mid, amex_volume, vmd_volume, debit_volume, ebt_volume,
            amex_credits, vmd_credits, debit_credits, ebt_credits,
            stated_total, reconciled, source, created_by_id)
         values ($1, $2, 400, 1000, 250, 0, 0, 30, 0, 0, 1650, true, 'manual', $3)`,
        [periodId, mid, adminId],
      );
    }
  });

  afterAll(async () => {
    if (!db) return;
    await db.query('ROLLBACK');
    await db.end();
  });

  it('subtracts that bucket’s credits where the basis is net', async () => {
    /*
     * BIN on the Cash Discount merchant: Amex drops out, so the comparison is
     * vmd + debit NET — 1000 − 30 + 250 = 1220.
     *
     * Real equivalent: MID 201100272922's BIN was 91.98 out, exactly its
     * credits, until the basis was applied.
     */
    await statedAmount(MID.onCashDisc, 'BIN Sponsorship Fees', '1220');

    const v = (await step1()).get(`${MID.onCashDisc}|BIN Sponsorship Fees`);
    expect(v?.right_value).toBe('1220.00');
    expect(v?.delta).toBe('0.0000');
    expect(v?.verdict).toBe('match');
  });

  it('counts Amex towards BIN only when there is no Cash Discount line', async () => {
    /*
     * The other merchant carries no Cash Discount line, so Amex IS in the sum:
     * 400 + 1000 − 30 + 250 = 1620.
     *
     * Real equivalent: MID 30119889965's BIN exceeded vmd+debit by exactly its
     * 10,777.00 of Amex volume.
     */
    await statedAmount(MID.notOnCashDisc, 'BIN Sponsorship Fees', '1620');

    const v = (await step1()).get(`${MID.notOnCashDisc}|BIN Sponsorship Fees`);
    expect(v?.right_value).toBe('1620.00');
    expect(v?.verdict).toBe('match');
  });

  it('compares Cash Discount on GROSS, off the same volume row', async () => {
    /*
     * The distinction that makes the basis a property of the FEE ITEM rather
     * than of the month: on the identical volume row, Cash Discount spans all
     * three buckets gross — 400 + 1000 + 250 = 1650 — while BIN above is net.
     * Both are real, measured on the same August statements.
     */
    await statedAmount(MID.onCashDisc, 'Cash Disc/Surcharge Program', '1650');

    const v = (await step1()).get(`${MID.onCashDisc}|Cash Disc/Surcharge Program`);
    expect(v?.right_value).toBe('1650.00');
    expect(v?.verdict).toBe('match');
  });

  it('reports a real difference instead of absorbing it', async () => {
    /*
     * The 1.34 case: MID 201100241497's BIN is genuinely that much out on
     * 430,881.10 after both corrections. The tolerance is five cents precisely
     * so a difference like it is still seen, which is why the measurement did
     * not become a reason to widen it.
     */
    await statedAmount(MID.notOnCashDisc, 'BIN Sponsorship Fees', '1621.34');

    const v = (await step1()).get(`${MID.notOnCashDisc}|BIN Sponsorship Fees`);
    expect(v?.verdict).toBe('mismatch');
    expect(v?.delta).toBe('-1.3400');
  });

  it('exposes the rule for each bucket, so a difference can be read', async () => {
    const rows = await asAdmin<{
      fee_item_name: string;
      basis: string | null;
      bucket_detail: {
        bucket: string;
        basis: string;
        applies_when: string;
        sibling: string | null;
      }[];
    }>(`select * from residual_volume_mapping_coverage($1::uuid) where is_mapped`, [periodId]);

    const bin = rows.find((r) => r.fee_item_name === 'BIN Sponsorship Fees');
    expect(bin?.basis).toBe('net');
    expect(bin?.bucket_detail).toContainEqual({
      bucket: 'amex_volume',
      basis: 'net',
      applies_when: 'sibling_absent',
      sibling: 'Cash Disc/Surcharge Program',
    });

    const cash = rows.find((r) => r.fee_item_name === 'Cash Disc/Surcharge Program');
    expect(cash?.basis).toBe('gross');
    expect(cash?.bucket_detail.every((d) => d.applies_when === 'always')).toBe(true);
  });

  it('leaves EBT out of both sums, because no statement has settled it', async () => {
    /*
     * `residuals.md` expected the first overlapping merchant-month to settle
     * whether EBT belongs inside the BIN and Cash Disc sums. It did not: none
     * of August's seven statements carries any EBT volume. The mapping is
     * therefore untouched, and this says so out loud rather than letting a
     * later reader assume it was decided.
     */
    const rows = await asAdmin<{ fee_item_name: string; bucket_detail: { bucket: string }[] }>(
      `select * from residual_volume_mapping_coverage($1::uuid) where is_mapped`,
      [periodId],
    );
    for (const name of ['BIN Sponsorship Fees', 'Cash Disc/Surcharge Program']) {
      const r = rows.find((x) => x.fee_item_name === name);
      expect(r?.bucket_detail.map((d) => d.bucket)).not.toContain('ebt_volume');
    }
  });

  it('withholds the comparison when a bucket is NULL rather than guessing', async () => {
    /*
     * An unreconciled statement writes all four buckets NULL by design. A sum
     * treating them as zero would compare a real stated Amount against a
     * fabricated 0.00 and call it a mismatch — which reads as a money problem
     * rather than as a statement nobody has imported yet.
     *
     * Last, because it destroys the fixture's volume row.
     */
    await asOwner(
      `update residual_merchant_volumes set vmd_volume = null
        where period_id = $1 and mid = $2`,
      [periodId, MID.onCashDisc],
    );

    const v = (await step1()).get(`${MID.onCashDisc}|BIN Sponsorship Fees`);
    expect(v).toBeUndefined();
  });
});
