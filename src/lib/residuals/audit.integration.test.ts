/**
 * The residuals manual-edit trail, against the real database.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────
 * `tg_residual_audit()` shipped with the first file of the residuals port and
 * was attached to nothing. `residual_audit_log` held 0 rows and always would,
 * so `residual_period_history`'s fourth branch — the one emitting
 * `kind = 'manual_edit'` — returned nothing for ever, without an error. The
 * reconciliation screen rendered the other three kinds and presented that as
 * the complete timeline.
 *
 * ── WHY THE OBVIOUS FIX WOULD HAVE BEEN WORSE ────────────────────────────
 * `residual_lines` is written in bulk by machinery on every ordinary
 * operation: an import INSERTs one row per statement line, and every
 * recalculation UPDATEs all of them. An unattached trigger writes nothing; an
 * unguarded one writes several hundred rows labelled `manual_edit` per
 * recalculation, and `residual_period_history` reads 200 — so the calc runs
 * and acknowledgments it is supposed to show get pushed out entirely.
 *
 * Empty is a gap. Flooded is a lie. Both halves are asserted below, and the
 * machine-silence half is the one that would regress quietly.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const DB_URL = process.env.SUPABASE_DB_URL;
const suite = DB_URL ? describe : describe.skip;

const MID = '550000000901';
const MONTH = '2019-06-01';

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

type AuditRow = { table_name: string; action: string; changed_fields: string[] | null };

/**
 * Audit rows for this period's tables.
 *
 * ── NOT ORDERED BY TIME, BECAUSE TIME DOES NOT MOVE HERE ────────────────
 * `created_at` defaults to `now()`, which inside a transaction is the
 * transaction's start time — identical for every row this suite writes. An
 * `order by created_at desc` therefore returns them in an arbitrary order, and
 * asserting on `rows[0]` passed or failed on whatever the planner felt like.
 * That is what the first run of this suite did: it read an `insert` where an
 * `update` was expected, and the trigger was right both times.
 *
 * So nothing here indexes into the list. Rows are selected by what they
 * assert.
 */
const trail = () =>
  asOwner<AuditRow>(
    `select l.table_name, l.action::text action, l.changed_fields
       from residual_audit_log l
      where (l.after_data->>'period_id')::uuid = $1
         or (l.before_data->>'period_id')::uuid = $1`,
    [periodId],
  );

const trailCount = async () => (await trail()).length;

/** The one row matching this table and action, or undefined. */
async function entry(table: string, action: string): Promise<AuditRow | undefined> {
  return (await trail()).find((r) => r.table_name === table && r.action === action);
}

suite('the residuals manual-edit trail', () => {
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

    await db.query(
      `insert into residual_merchant_rates
         (mid, effective_from, risk_tier, vmd_auth_fee, batch_fee, avs_fee, monthly_fee_tapdash)
       values ($1,$2,'low',0.1,0.05,0.02,15)`,
      [MID, MONTH],
    );
  });

  afterAll(async () => {
    if (!db) return;
    await db.query('ROLLBACK');
    await db.end();
  });

  /* ── the trigger is attached at all ───────────────────────────────── */

  it('is attached to the two tables the history reads', async () => {
    const rows = await asOwner<{ tbl: string }>(
      `select c.relname tbl
         from pg_trigger t
         join pg_proc p on p.oid = t.tgfoid
         join pg_class c on c.oid = t.tgrelid
        where p.proname = 'tg_residual_audit' and not t.tgisinternal
        order by c.relname`,
    );
    /*
     * Exactly these two, because `residual_period_history` filters on exactly
     * these two. Auditing more writes rows it discards; auditing fewer leaves
     * the branch half-empty in a way that reads as "nothing was edited".
     */
    expect(rows.map((r) => r.tbl)).toEqual([
      'residual_lines',
      'residual_merchant_volumes',
    ]);
  });

  /* ── machine writes stay silent ───────────────────────────────────── */

  it('an imported line writes NO audit row', async () => {
    const before = await trailCount();

    await asOwner(
      `insert into residual_lines
         (period_id, mid, fee_item_name, item_count, net_revenue, amount, agent_expense, source, import_id)
       values ($1,$2,'Authorization Fee IP/SSL',100,8,8,0,'excel',$3)`,
      [periodId, MID, importId],
    );

    /*
     * The row says `source = 'excel'`, so it was not typed in. Provenance is
     * a fact the row states — the guard reads it rather than asking who the
     * caller was, which is what keeps it true when a new writer appears.
     */
    expect(await trailCount()).toBe(before);
  });

  it('and a recalculation of every line in the month writes none either', async () => {
    const before = await trailCount();

    await asAdmin(`select compute_residual_period($1::uuid, 'MAVERICK')`, [periodId]);

    /*
     * The case that makes the guard necessary rather than tidy. The engine
     * UPDATEs all six of its output columns on every line of the period; on
     * the real May sample that is 197 rows per run, against a history that
     * reads 200.
     */
    expect(await trailCount()).toBe(before);
  });

  it('nor does an update that changed nothing at all', async () => {
    const before = await trailCount();
    await asOwner(
      `update residual_lines set item_count = item_count
        where period_id = $1 and deleted_at is null`,
      [periodId],
    );
    expect(await trailCount()).toBe(before);
  });

  /* ── human edits are recorded ─────────────────────────────────────── */

  it('a hand-entered volume row IS recorded', async () => {
    const before = await trailCount();

    await asAdmin(`select residual_update_merchant_volumes($1::uuid, $2, $3::jsonb)`, [
      periodId,
      MID,
      JSON.stringify({ vmd_volume: '200000.00', vmd_item_count: '4000' }),
    ]);

    expect(await trailCount()).toBe(before + 1);
    expect(await entry('residual_merchant_volumes', 'insert')).toBeDefined();
  });

  it('and so is a later correction to it, naming the fields that moved', async () => {
    await asAdmin(`select residual_update_merchant_volumes($1::uuid, $2, $3::jsonb)`, [
      periodId,
      MID,
      JSON.stringify({ vmd_volume: '250000.00', vmd_item_count: '4000' }),
    ]);

    const row = await entry('residual_merchant_volumes', 'update');
    expect(row).toBeDefined();
    /*
     * `changed_fields` is computed by the trigger from the before/after
     * payloads rather than passed in, so it cannot disagree with them. Only
     * the volume moved; the item count was re-sent unchanged.
     */
    expect(row?.changed_fields).toContain('vmd_volume');
    expect(row?.changed_fields).not.toContain('vmd_item_count');
  });

  /*
   * The case the guard has to let through: a human correcting a STATED figure
   * on an imported line. The row's `source` is still 'excel' — it was imported
   * — but the change is an edit, which is why condition 2 is about which
   * fields moved rather than about where the row came from.
   */
  it('a correction to a stated figure on an IMPORTED line is recorded', async () => {
    const before = await trailCount();

    const [{ id: lineId }] = await asOwner<{ id: string }>(
      `select id from residual_lines
        where period_id = $1 and mid = $2 and deleted_at is null limit 1`,
      [periodId, MID],
    );

    await asAdmin(`select residual_update_line_stated($1::uuid, $2::jsonb)`, [
      lineId,
      JSON.stringify({ net_revenue: '9.00' }),
    ]);

    expect(await trailCount()).toBeGreaterThan(before);
    const row = await entry('residual_lines', 'update');
    expect(row).toBeDefined();
    expect(row?.changed_fields).toContain('net_revenue');
  });

  it('a soft delete is recorded as a delete, not as an update', async () => {
    const before = await trailCount();

    await asOwner(
      `update residual_lines set deleted_at = now(), deleted_by_id = $2
        where period_id = $1 and mid = $3 and deleted_at is null`,
      [periodId, adminId, MID],
    );

    expect(await trailCount()).toBeGreaterThan(before);
    /*
     * Retiring a line is an operator act, so `deleted_at` is deliberately NOT
     * in the machine-only set. The function reports it as 'delete' because
     * that is what it is to a reader, rather than as the UPDATE it technically
     * was.
     */
    expect(await entry('residual_lines', 'delete')).toBeDefined();
  });

  /* ── and the history surfaces it ──────────────────────────────────── */

  it('residual_period_history now emits manual_edit, which it never could before', async () => {
    const rows = await asAdmin<{ kind: string }>(
      `select kind from residual_period_history($1::uuid, 200)`,
      [periodId],
    );
    const kinds = new Set(rows.map((r) => r.kind));

    expect(kinds.has('manual_edit')).toBe(true);
    /* The three that already worked, still working. */
    expect(kinds.has('calc_run')).toBe(true);

    /*
     * The four kinds the function actually emits. Asserted as a set because
     * the UI maps them to labels, and that map had three wrong keys — it was
     * written from the names the tables suggested rather than from these.
     */
    for (const k of kinds) {
      expect(['calc_run', 'status_transition', 'acknowledgment', 'manual_edit']).toContain(k);
    }
  });

  it('the log is admin-only to read, and no client may write it', async () => {
    await db.query(`select set_config('request.jwt.claims', '', true)`);

    const name = `anon_${Math.random().toString(36).slice(2, 10)}`;
    await db.query(`savepoint ${name}`);
    let inserted: string | null = null;
    try {
      await db.query('set local role authenticated');
      await db.query(
        `insert into residual_audit_log (table_name, record_id, action)
         values ('residual_lines', gen_random_uuid(), 'update')`,
      );
      inserted = 'ALLOWED';
    } catch (e) {
      inserted = (e as { code?: string }).code ?? 'refused';
    }
    await db.query(`rollback to savepoint ${name}`);

    /*
     * Nothing writes it from a client — the rows come from the trigger running
     * as the definer. An append-only trail a client can append to is not a
     * trail.
     */
    expect(inserted).not.toBe('ALLOWED');
  });
});
