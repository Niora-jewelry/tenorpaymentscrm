/**
 * Volume figures: the `awaiting_volumes` rung, and getting off it.
 *
 * ── THE CLAIM BEING TESTED ───────────────────────────────────────────────
 * A merchant whose fee items are assessed on VOLUME cannot be computed from
 * the fee report alone — the report carries counts, not the dollars that
 * passed through. The screen says so and offers a form. This proves the three
 * things that has to mean:
 *
 *   1. a missing volume row really does withhold the step-1 comparison, and
 *      shows as `awaiting_volumes` rather than as a mismatch or a zero;
 *   2. a NULL bucket is not a zero — a row that exists with a blank bucket is
 *      still awaiting, which is the distinction the form's "blank = unknown"
 *      note is about;
 *   3. entering the figures clears it, and the comparison can then be made.
 *
 * Rolled back. Scratch month, scratch MID.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const DB_URL = process.env.SUPABASE_DB_URL;
const suite = DB_URL ? describe : describe.skip;

const MID = '550000000701';
const MONTH = '2019-04-01';

let db: pg.Client;
let adminId: string;
let periodId: string;
let importId: string;

async function asAdmin<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: adminId, role: 'authenticated' }),
  ]);
  await db.query('set local role authenticated');
  const { rows } = await db.query(sql, params);
  return rows as T[];
}

async function asOwner<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  await db.query('reset role');
  const { rows } = await db.query(sql, params);
  return rows as T[];
}

const stateOf = async () => {
  const rows = await asAdmin<{ mid: string; state: string; awaiting_reason: string | null }>(
    `select * from residual_merchant_states($1::uuid)`,
    [periodId],
  );
  return rows.find((r) => r.mid === MID) ?? null;
};

type GridRow = {
  mid: string;
  fee_item_name: string | null;
  volume_buckets: string[] | null;
  verdicts: Record<string, { verdict: string; left: string | null; right: string | null }>;
};

const gridFor = async (item: string) => {
  const rows = await asAdmin<GridRow>(`select * from residual_grid_rows($1::uuid)`, [periodId]);
  return rows.find((r) => r.mid === MID && r.fee_item_name === item) ?? null;
};

const compute = () => asAdmin(`select compute_residual_period($1::uuid, 'MAVERICK')`, [periodId]);

suite('volume figures', () => {
  beforeAll(async () => {
    db = new pg.Client({
      connectionString: DB_URL,
      ssl: { rejectUnauthorized: false },
      statement_timeout: 120_000,
    });
    await db.connect();
    await db.query('BEGIN');

    const { rows: admins } = await db.query(
      `select p.id from profiles p join roles r on r.id = p.role_id
        where r.is_admin and p.deleted_at is null and p.status = 'active' limit 1`,
    );
    if (!admins.length) throw new Error('No active admin profile — cannot run this suite.');
    adminId = admins[0].id;

    const [{ id: pid }] = (
      await db.query(
        `insert into residual_periods (statement_month, status) values ($1,'open') returning id`,
        [MONTH],
      )
    ).rows;
    periodId = pid;

    const [{ id: iid }] = (
      await db.query(
        `insert into residual_imports (period_id, processor, source_type, status)
         values ($1,'MAVERICK','excel','completed') returning id`,
        [periodId],
      )
    ).rows;
    importId = iid;

    /*
     * Rates so the merchant is not `blocked` — blocked outranks
     * awaiting_volumes on the ladder, and would mask the rung under test.
     * `vmd_volume` is the rate the BIN rule applies to the volume.
     */
    await db.query(
      `insert into residual_merchant_rates
         (mid, effective_from, risk_tier, vmd_auth_fee, batch_fee, avs_fee,
          monthly_fee_tapdash, vmd_volume, amex_volume, pin_debit_volume,
          monthly_fee_maverick)
       values ($1,$2,'low',0.1,0.05,0.02,15,0.0001,0.0002,0.0001,0)`,
      [MID, MONTH],
    );

    const line = (item: string, count: number, net: number, amount: number) =>
      db.query(
        `insert into residual_lines
           (period_id, mid, fee_item_name, item_count, net_revenue, amount, agent_expense, source, import_id)
         values ($1,$2,$3,$4,$5,$6,0,'excel',$7)`,
        [periodId, MID, item, count, net, amount, importId],
      );

    /* One count-based item, and one assessed on volume. */
    await line('Authorization Fee IP/SSL', 100, 8, 8);
    await line('BIN Sponsorship Fees', 0, 5, 250_000);

    await compute();
  });

  afterAll(async () => {
    if (!db) return;
    await db.query('ROLLBACK');
    await db.end();
  });

  it('the volume-assessed item knows which buckets it wants', async () => {
    const row = await gridFor('BIN Sponsorship Fees');
    /*
     * The mapping is reference data, not a guess. BIN is assessed on VMD plus
     * debit and Amex is deliberately not in it — which is the reason a total
     * typed into the wrong bucket is not a small error.
     */
    expect(row?.volume_buckets?.sort()).toEqual(['debit_volume', 'vmd_volume']);
  });

  /*
   * `awaiting_reason` is a SENTENCE, not a code — one of "engine recorded
   * no_volumes", "a mapped row has no volume row for this merchant-month", or
   * "a needed volume bucket is NULL on the statement row". Asserted as the
   * real strings because the UI quotes them verbatim: this test is what stops
   * that quoting drifting, and it already caught the screen branching on a
   * `'no_row'` code that this function never returns.
   */
  it('with no volume row the merchant is awaiting volumes, not mismatched', async () => {
    const st = await stateOf();
    expect(st?.state).toBe('awaiting_volumes');
    expect(st?.awaiting_reason).toBe('engine recorded no_volumes');

    /* And the step-1 comparison is ABSENT, not failed. */
    const row = await gridFor('BIN Sponsorship Fees');
    expect(row?.verdicts['1']).toBeUndefined();
  });

  it('the count-based item computed anyway', async () => {
    /*
     * The half that matters for not over-reporting: a missing volume does not
     * stop the rest of the merchant computing, so the rung means "something
     * here is waiting", not "nothing here worked".
     */
    const rows = await asOwner<{ ti: string | null }>(
      `select total_income::text ti from residual_lines
        where period_id = $1 and mid = $2 and fee_item_name = 'Authorization Fee IP/SSL'
          and deleted_at is null`,
      [periodId, MID],
    );
    expect(rows[0].ti).toBe('10.00');
  });

  /* ── a blank bucket is not a zero ─────────────────────────────────── */

  it('a row with a blank bucket is STILL awaiting, which is the point', async () => {
    await db.query('savepoint partial');

    await asAdmin(
      `select residual_update_merchant_volumes($1::uuid, $2, $3::jsonb)`,
      [
        periodId,
        MID,
        JSON.stringify({
          vmd_volume: '250000.00',
          vmd_item_count: '4000',
          /* debit left out entirely: BIN needs VMD + debit, and one of the two
             being unknown is not the same as it being zero. */
        }),
      ],
    );

    const row = await asAdmin<{ has_row: boolean; any_bucket_null: boolean; source: string }>(
      `select * from residual_merchant_volume_row($1::uuid, $2)`,
      [periodId, MID],
    );
    expect(row[0].has_row).toBe(true);
    expect(row[0].any_bucket_null).toBe(true);
    /* No import behind it, so provenance says manual. */
    expect(row[0].source).toBe('manual');

    await compute();
    const st = await stateOf();
    expect(st?.state).toBe('awaiting_volumes');
    /* Whichever of the three sentences applies, it is one of them and it is a
       sentence — which is what the screen renders. */
    expect(st?.awaiting_reason).toMatch(/no_volumes|no volume row|bucket is NULL/);

    await db.query('rollback to savepoint partial');
    await compute();
  });

  /* ── and filling them in clears it ────────────────────────────────── */

  it('entering every bucket clears the rung and the comparison can be made', async () => {
    await asAdmin(
      `select residual_update_merchant_volumes($1::uuid, $2, $3::jsonb)`,
      [
        periodId,
        MID,
        JSON.stringify({
          merchant_name: 'Volume Fixture Diner',
          vmd_volume: '200000.00',
          amex_volume: '30000.00',
          debit_volume: '50000.00',
          ebt_volume: '0.00',
          vmd_item_count: '4000',
          amex_item_count: '400',
          debit_item_count: '900',
          ebt_item_count: '0',
        }),
      ],
    );

    const row = await asAdmin<{ any_bucket_null: boolean; merchant_name: string }>(
      `select * from residual_merchant_volume_row($1::uuid, $2)`,
      [periodId, MID],
    );
    expect(row[0].any_bucket_null).toBe(false);
    expect(row[0].merchant_name).toBe('Volume Fixture Diner');

    await compute();

    const st = await stateOf();
    expect(st?.state).not.toBe('awaiting_volumes');

    /*
     * And step 1 can now be made. It compares the line's stated Amount against
     * the SUM of its mapped buckets — 200,000 + 50,000 = 250,000, which is
     * what the fixture's Amount says, so it matches.
     */
    const grid = await gridFor('BIN Sponsorship Fees');
    expect(grid?.verdicts['1']).toBeDefined();
    expect(grid?.verdicts['1'].verdict).toBe('match');
    expect(Number(grid?.verdicts['1'].right)).toBeCloseTo(250_000, 2);
  });

  /* ── what cannot be typed in ──────────────────────────────────────── */

  /**
   * The RPC refuses a non-editable column BY NAME, and its hint says why:
   * "stated_total, reconciled and unmapped_volume are the PDF rollup's
   * conclusions, not observations."
   *
   * A conclusion typed in by hand is not a conclusion, and the refusal is what
   * keeps the reconciliation flag meaning something.
   */
  it('refuses to let a conclusion be typed in', async () => {
    for (const key of ['stated_total', 'reconciled', 'unmapped_volume']) {
      const name = `bad_${Math.random().toString(36).slice(2, 10)}`;
      await db.query(`savepoint ${name}`);
      let code: string | null = null;
      let message = '';
      try {
        await asAdmin(`select residual_update_merchant_volumes($1::uuid, $2, $3::jsonb)`, [
          periodId,
          MID,
          JSON.stringify({ [key]: '1' }),
        ]);
      } catch (e) {
        const err = e as { code?: string; message?: string };
        code = err.code ?? null;
        message = err.message ?? '';
      }
      await db.query(`rollback to savepoint ${name}`);
      expect(code, key).toBe('22023');
      expect(message).toContain(key);
    }
  });

  it('refuses a MID with no digits in it', async () => {
    const name = `nomid_${Math.random().toString(36).slice(2, 10)}`;
    await db.query(`savepoint ${name}`);
    let code: string | null = null;
    try {
      await asAdmin(`select residual_update_merchant_volumes($1::uuid, $2, '{}'::jsonb)`, [
        periodId,
        'not-a-mid',
      ]);
    } catch (e) {
      code = (e as { code?: string }).code ?? null;
    }
    await db.query(`rollback to savepoint ${name}`);
    expect(code).toBe('22004');
  });

  it('refuses a caller with no identity', async () => {
    await db.query(`select set_config('request.jwt.claims', '', true)`);

    for (const [sql, params] of [
      [`select * from residual_merchant_volume_row($1::uuid, null)`, [periodId]],
      [`select * from residual_volume_mapping_coverage($1::uuid)`, [periodId]],
      [`select residual_update_merchant_volumes($1::uuid, $2, '{}'::jsonb)`, [periodId, MID]],
    ] as [string, unknown[]][]) {
      const name = `anon_${Math.random().toString(36).slice(2, 10)}`;
      await db.query(`savepoint ${name}`);
      let code: string | null = null;
      try {
        await db.query(sql, params);
      } catch (e) {
        code = (e as { code?: string }).code ?? null;
      }
      await db.query(`rollback to savepoint ${name}`);
      expect(code, sql).toBe('42501');
    }
  });
});
