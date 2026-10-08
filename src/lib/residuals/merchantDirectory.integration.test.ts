/**
 * The merchant dashboard's identity source, and the rule its money obeys.
 *
 * Tab 1 of the module composes three reads and computes nothing:
 * `residual_merchant_directory` for who a MID is,
 * `residual_merchant_states` for the rung, `residual_synopsis` for the money.
 * This suite covers the new function and pins the one inherited rule the
 * screen would be most damaging to get wrong — that a partially-computed
 * month has NO total, rather than a negative one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const DB_URL = process.env.SUPABASE_DB_URL;
const suite = DB_URL ? describe : describe.skip;

const MONTH = '2019-04-01';
const MID = {
  oneName: '550000004001',
  twoNames: '550000004002',
  linked: '550000004003',
};

let db: pg.Client;
let adminId: string;
let periodId: string;
let recordId: string;
let savepoint = 0;

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

async function asOwner<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  await db.query('reset role');
  const { rows } = await db.query(sql, params);
  return rows as T[];
}

type DirRow = {
  mid: string;
  merchant_name: string | null;
  name_variants: string[];
  record_id: string | null;
  line_count: string;
};

async function directory(): Promise<Map<string, DirRow>> {
  const rows = await asAdmin<DirRow>(
    `select * from residual_merchant_directory($1::uuid)`,
    [periodId],
  );
  return new Map(rows.map((r) => [r.mid, r]));
}

/** A line, with a name and optionally a linked record. */
async function line(mid: string, feeItem: string, name: string | null, record?: string) {
  await asOwner(
    `insert into residual_lines
       (period_id, mid, fee_item_name, merchant_name, record_id,
        amount, item_count, source, created_by_id)
     values ($1, $2, $3, $4, $5, 10, 1, 'manual', $6)`,
    [periodId, mid, feeItem, name, record ?? null, adminId],
  );
}

suite('the merchant dashboard', () => {
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

    const [rec] = await asOwner<{ id: string }>(
      `select id from records where deleted_at is null limit 1`,
    );
    recordId = rec?.id ?? null as unknown as string;

    /* One steady name across three lines. */
    await line(MID.oneName, 'AVS Fee', 'Steady Diner LLC');
    await line(MID.oneName, 'Batch Fee', 'Steady Diner LLC');
    await line(MID.oneName, 'Chargeback Fee', 'Steady Diner LLC');

    /*
     * Two names on one MID, the second more often — which is what the real
     * Mastersheet does with 30119900929 ("House Of Tacos Llc" and "House Of
     * Tacos II") at two different volume rates.
     */
    await line(MID.twoNames, 'AVS Fee', 'Tacos One');
    await line(MID.twoNames, 'Batch Fee', 'Tacos Two');
    await line(MID.twoNames, 'Chargeback Fee', 'Tacos Two');

    if (recordId) await line(MID.linked, 'AVS Fee', 'Linked Merchant', recordId);
    else await line(MID.linked, 'AVS Fee', 'Linked Merchant');
  });

  afterAll(async () => {
    if (!db) return;
    await db.query('ROLLBACK');
    await db.end();
  });

  it('returns one row per MID with its line count', async () => {
    const d = await directory();
    expect(d.size).toBe(3);
    expect(Number(d.get(MID.oneName)?.line_count)).toBe(3);
    expect(Number(d.get(MID.linked)?.line_count)).toBe(1);
  });

  it('labels a MID with the name it carries most often', async () => {
    const d = await directory();
    expect(d.get(MID.oneName)?.merchant_name).toBe('Steady Diner LLC');
    /* Two of three lines say "Tacos Two". */
    expect(d.get(MID.twoNames)?.merchant_name).toBe('Tacos Two');
  });

  it('reports every name when a MID carries more than one', async () => {
    /*
     * The point of the column. Picking a label with max() and saying nothing
     * would hide a merchant whose two sites are priced differently, on the one
     * screen built to show where each merchant stands.
     */
    const d = await directory();
    expect(d.get(MID.twoNames)?.name_variants).toEqual(['Tacos One', 'Tacos Two']);
  });

  it('leaves variants empty for the ordinary case, so it reads as a signal', async () => {
    const d = await directory();
    expect(d.get(MID.oneName)?.name_variants).toEqual([]);
    expect(d.get(MID.linked)?.name_variants).toEqual([]);
  });

  it('carries the linked record through', async () => {
    const d = await directory();
    if (!recordId) return;
    expect(d.get(MID.linked)?.record_id).toBe(recordId);
    expect(d.get(MID.oneName)?.record_id).toBeNull();
  });

  it('withholds the money while the month is only partly computed', async () => {
    /*
     * THE RULE THE DASHBOARD INHERITS, and the one it would be most damaging
     * to get wrong. These lines have no engine output at all, so the month
     * carries no calculation_version — and `net_income` comes back NULL rather
     * than a sum of what happens to be present.
     *
     * The spec's reasoning: a partial month's figure has the wrong SIGN, not
     * merely the wrong magnitude, because the costs compute and the
     * volume-driven income does not. A dashboard that totalled it would show
     * every merchant at a loss and be believed. The denominators still come
     * back, which is what makes the absence explicable rather than a blank.
     */
    const rows = await asAdmin<{
      mid: string | null;
      net_income: string | null;
      disclosable: boolean;
      rows_total: number;
      rows_computed: number;
    }>(`select * from residual_synopsis($1::uuid)`, [periodId]);

    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.disclosable).toBe(false);
      expect(r.net_income).toBeNull();
      /* Coverage is still reported — that is the part that must not go blank. */
      expect(r.rows_total).toBeGreaterThan(0);
    }
  });

  it('refuses a period that does not exist, rather than returning nothing', async () => {
    /*
     * An empty list and a bad id must not look alike: the dashboard renders
     * "no merchants" from the first and would be wrong to render it from the
     * second.
     */
    await expect(
      asAdmin(`select * from residual_merchant_directory($1::uuid)`, [
        '00000000-0000-0000-0000-000000000000',
      ]),
    ).rejects.toMatchObject({ code: 'P0002' });
  });

  it('is admin-only', async () => {
    /* Definer function, so the explicit gate inside it is the only guard. */
    await db.query('savepoint anon_probe');
    await db.query(`select set_config('request.jwt.claims', '{}', true)`);
    await db.query('set local role authenticated');
    await expect(
      db.query(`select * from residual_merchant_directory($1::uuid)`, [periodId]),
    ).rejects.toMatchObject({ code: '42501' });
    await db.query('rollback to savepoint anon_probe');
    await db.query('reset role');
  });
});
