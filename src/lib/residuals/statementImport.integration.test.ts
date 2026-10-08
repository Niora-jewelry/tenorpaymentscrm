/**
 * Importing statements, one merchant at a time, against the real database.
 *
 * ── WHAT THIS SUITE IS GUARDING ──────────────────────────────────────────
 * R5a built the PDF path on the assumption that a month holds ONE completed
 * statement import. It does not: a statement is one file per MERCHANT, and a
 * month is forty-seven of them. Migration 20260819009746 changed two things
 * together, and the second one is the dangerous half:
 *
 *   1. a PDF import is keyed on (processor, period, mid), not (processor,
 *      period, source_type);
 *   2. the supersede sweep gained a `mid` predicate.
 *
 * Without (2), (1) turns a loud 23505 into silent cross-merchant data loss —
 * importing merchant B soft-deletes merchant A's volumes, the import reports
 * success, and the only symptom is A's volume-based lines quietly reverting to
 * `no_volumes` at the next recompute. `leaves the other merchants alone` is
 * the test for that, and it is the reason this file exists.
 *
 * Everything runs inside one transaction that is rolled back, so the suite
 * leaves no rows behind.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const DB_URL = process.env.SUPABASE_DB_URL;
const suite = DB_URL ? describe : describe.skip;

/* Far enough from any real month that a stray row could not be mistaken for
   one, and in the past so no effective-dating resolver reaches past it. */
const MONTH = '2019-07-01';
const PROCESSOR = 'MAVERICK';
const MID = { A: '550000002001', B: '550000002002' };

let db: pg.Client;
let adminId: string;
let periodId: string;

let savepoint = 0;

/** As the table owner, with RLS bypassed — what the service role does. */
async function asOwner<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  await db.query('reset role');
  const { rows } = await db.query(sql, params);
  return rows as T[];
}

/**
 * One statement as the admin, inside its own savepoint.
 *
 * The savepoint is not tidiness — half this suite asserts that something is
 * REFUSED, and in PostgreSQL a raised statement aborts the whole transaction,
 * so the next query returns 25P02 "current transaction is aborted" instead of
 * the constraint it was meant to test. Without this, one expected rejection
 * silently turns every later assertion into a test of the wrong thing.
 */
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

/** The plan rows a statement hands over, as the RPC destructures them. */
function planRows(rows: [string, string, string][]) {
  return rows.map(([plan_code, amount, item_count]) => ({ plan_code, amount, item_count }));
}

/**
 * One statement import, the way the app does it: an import row of its own,
 * then the RPC.
 */
async function importStatement(
  mid: string,
  rows: [string, string, string][],
  statedTotal: string,
  statedCount: string,
) {
  const [imp] = await asAdmin<{ id: string }>(
    `insert into residual_imports
       (period_id, processor, source_type, status, original_filename, created_by_id)
     values ($1, $2, 'pdf', 'processing', $3, $4)
     returning id`,
    [periodId, PROCESSOR, `Statement-${mid}.pdf`, adminId],
  );

  const [out] = await asAdmin<{ r: Record<string, unknown> }>(
    `select commit_residual_pdf_import($1::uuid, $2::uuid, $3::jsonb, $4::jsonb) r`,
    [
      imp.id,
      periodId,
      JSON.stringify({
        mid,
        merchant_name: null,
        stated_total: statedTotal,
        stated_item_count: statedCount,
      }),
      JSON.stringify(planRows(rows)),
    ],
  );
  return { importId: imp.id, result: out.r };
}

async function liveVolumes(mid: string) {
  const rows = await asAdmin<{
    amex_volume: string | null;
    vmd_volume: string | null;
    debit_volume: string | null;
    reconciled: boolean | null;
  }>(
    `select amex_volume::text, vmd_volume::text, debit_volume::text, reconciled
       from residual_merchant_volumes
      where period_id = $1 and mid = $2 and deleted_at is null`,
    [periodId, mid],
  );
  return rows;
}

suite('statement import, per merchant', () => {
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
  });

  afterAll(async () => {
    if (!db) return;
    await db.query('ROLLBACK');
    await db.end();
  });

  it('rolls the plan codes into the four buckets', async () => {
    const { result } = await importStatement(
      MID.A,
      [
        ['VS', '1000.00', '10'],
        ['MD', '250.00', '5'],
        ['AM', '400.00', '4'],
      ],
      '1650.00',
      '19',
    );

    expect(result.reconciled).toBe(true);
    expect(result.plan_rows_inserted).toBe(3);
    expect(result.unmapped_volume).toBe('0.00');

    const [v] = await liveVolumes(MID.A);
    /* VS is V/MC/D, MD is debit, AM is Amex — three different buckets. */
    expect(v.vmd_volume).toBe('1000.00');
    expect(v.debit_volume).toBe('250.00');
    expect(v.amex_volume).toBe('400.00');
  });

  it('takes a second merchant in the same month', async () => {
    /*
     * This is what raised 23505 before migration 746: one completed PDF import
     * per (processor, period, source_type) meant a month could hold exactly
     * one statement.
     */
    const { result } = await importStatement(MID.B, [['VS', '900.00', '9']], '900.00', '9');
    expect(result.reconciled).toBe(true);

    const [a] = await liveVolumes(MID.A);
    const [b] = await liveVolumes(MID.B);
    expect(a.vmd_volume).toBe('1000.00');
    expect(b.vmd_volume).toBe('900.00');
  });

  it('refuses a second statement for a merchant that already has one', async () => {
    await expect(
      importStatement(MID.A, [['VS', '1.00', '1']], '1.00', '1'),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('leaves the other merchants alone when one is re-imported', async () => {
    /*
     * THE ONE THAT MATTERS. The sweep soft-deletes rows from other imports
     * sharing this (processor, period, source_type); without the `mid`
     * predicate added in 746 it would clear merchant B here, report success,
     * and show nothing wrong until the next recompute.
     */
    const [prior] = await asAdmin<{ id: string }>(
      `select id from residual_imports
        where period_id = $1 and mid = $2 and source_type = 'pdf'
          and status = 'completed' and deleted_at is null`,
      [periodId, MID.A],
    );

    /*
     * What the app does to free the unique index before replacing — and it
     * does it with the SERVICE ROLE, as `commitImport` already does for the
     * identical step on a fee report.
     *
     * That is not laziness. Measured here: an authenticated admin, with
     * `auth_is_admin()` returning true and a column-level UPDATE grant on
     * `deleted_at`, is still refused with
     *
     *   42501  new row violates row-level security policy
     *          for table "residual_imports"
     *
     * while the same statement setting `status` or `deleted_by_id` succeeds.
     * So retiring an import is a service-role operation by necessity, and a
     * test that did it as `authenticated` would be testing a path the app
     * never takes.
     */
    await asOwner(
      `update residual_imports set deleted_at = now(), deleted_by_id = $2 where id = $1`,
      [prior.id, adminId],
    );

    const { result } = await importStatement(
      MID.A,
      [
        ['VS', '1100.00', '11'],
        ['AM', '400.00', '4'],
      ],
      '1500.00',
      '15',
    );
    expect(result.reconciled).toBe(true);
    /* A's own previous row was superseded — one row swept, not two. */
    expect(result.swept).toBe(1);

    const a = await liveVolumes(MID.A);
    const b = await liveVolumes(MID.B);

    expect(a).toHaveLength(1);
    expect(a[0].vmd_volume).toBe('1100.00');

    /* B untouched, which is the whole point. */
    expect(b).toHaveLength(1);
    expect(b[0].vmd_volume).toBe('900.00');
  });

  it('lands an unreconciled statement with empty buckets rather than wrong ones', async () => {
    /*
     * The parser refuses such a file before it reaches here, so this is the
     * database's own second line: rows stored, buckets NULL, reconciled false.
     * NULL buckets are what keep the merchant on `awaiting_volumes` instead of
     * comparing a real amount against a fabricated zero.
     */
    const mid = '550000002003';
    const { result } = await importStatement(mid, [['VS', '500.00', '5']], '999.00', '5');

    expect(result.reconciled).toBe(false);
    expect(result.derived_total).toBe('500.00');
    expect(result.stated_total).toBe('999.00');

    const [v] = await liveVolumes(mid);
    expect(v.reconciled).toBe(false);
    expect(v.vmd_volume).toBeNull();
    expect(v.amex_volume).toBeNull();
  });

  it('will not reconcile while volume sits in a plan code no bucket claims', async () => {
    /*
     * An unmapped code is counted and named, never dropped — dropping it would
     * understate volume with nothing to show for it.
     *
     * It also BLOCKS reconciliation: `reconciled` requires
     * `unmapped_volume = 0`, so the four buckets land NULL and the merchant
     * stays on `awaiting_volumes`. That is the right way round. The bucket
     * totals would otherwise look complete while 300.00 of real volume was in
     * none of them, and the rate applied to them would quietly be applied to
     * too little money. A zero-volume unmapped code does not trip this, which
     * the R5a suite covers separately.
     */
    const mid = '550000002004';
    const { result } = await importStatement(
      mid,
      [
        ['VS', '700.00', '7'],
        ['ZZ', '300.00', '3'],
      ],
      '1000.00',
      '10',
    );

    expect(result.unmapped_volume).toBe('300.00');
    expect(result.reconciled).toBe(false);
    expect(JSON.stringify(result.unmapped_codes)).toContain('ZZ');

    const [v] = await liveVolumes(mid);
    /* Stored, and deliberately not rolled into buckets that would read as whole. */
    expect(v.reconciled).toBe(false);
    expect(v.vmd_volume).toBeNull();
  });

  it('will not record a completed PDF import with no merchant number', async () => {
    /*
     * Such a row would fall outside both unique indexes and so could be loaded
     * twice over. The CHECK makes that a guarantee of the schema rather than
     * of the caller.
     */
    await expect(
      asAdmin(
        `insert into residual_imports
           (period_id, processor, source_type, status, created_by_id)
         values ($1, $2, 'pdf', 'completed', $3)`,
        [periodId, PROCESSOR, adminId],
      ),
    ).rejects.toMatchObject({ constraint: 'residual_imports_completed_pdf_has_mid' });
  });

  it('will not put a merchant number on a whole-month artifact', async () => {
    await expect(
      asAdmin(
        `insert into residual_imports
           (period_id, processor, source_type, status, mid, created_by_id)
         values ($1, $2, 'excel', 'processing', '550000002009', $3)`,
        [periodId, PROCESSOR, adminId],
      ),
    ).rejects.toMatchObject({ constraint: 'residual_imports_mid_shape' });
  });
});
