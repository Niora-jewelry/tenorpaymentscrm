/**
 * The Residuals tab on a merchant record, against the real database.
 *
 * ── WHAT IS BEING PROVED ─────────────────────────────────────────────────
 * The tab answers "what did THIS merchant earn", and its whole value is
 * telling five outcomes apart that all look like "no number":
 *
 *   admin only      the viewer may not see figures
 *   no MID          nothing can be keyed to the record
 *   no statements   a MID, but nothing imported mentions it
 *   not calculated  statements imported, no complete total
 *   figures         a complete total
 *
 * Four of the five would otherwise read as "this merchant earned nothing". So
 * the assertions below are mostly about which of them is produced, not about
 * arithmetic — the arithmetic is proved in the sibling suites.
 *
 * ── AND THAT THE TAB IS WIRED TO THE MODULE AT ALL ───────────────────────
 * A panel nobody can reach is not done. The configuration half is asserted
 * too: the tab exists with the right kind, is a system tab, accepts no fields,
 * and is assigned to the residuals module. Those are rows, not code, so a
 * migration that half-applied would leave a panel that renders for nobody.
 *
 * Rolled back. Scratch month, scratch MIDs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const DB_URL = process.env.SUPABASE_DB_URL;
const suite = DB_URL ? describe : describe.skip;

const MID = { EARNS: '550000000801', NO_RATES: '550000000809' };
const MONTH = '2019-05-01';

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

/** The synopsis for one MID, which is what the panel's figures come from. */
const synopsisFor = async (mid: string, lifetime = false) => {
  const rows = await asAdmin<{
    mid: string | null;
    net_income: string | null;
    disclosable: boolean;
    rows_total: number;
    rows_computed: number;
    periods_total: number;
    periods_computed: number;
  }>(`select * from residual_synopsis($1::uuid, $2, $3)`, [periodId, mid, lifetime]);
  return rows.find((r) => r.mid === mid) ?? null;
};

suite('the Residuals tab on a merchant record', () => {
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

    /* One merchant with rates, one without — the second is what makes the
       month incomplete, and therefore what withholds the totals. */
    await db.query(
      `insert into residual_merchant_rates
         (mid, effective_from, risk_tier, vmd_auth_fee, batch_fee, avs_fee, monthly_fee_tapdash)
       values ($1,$2,'low',0.1,0.05,0.02,15)`,
      [MID.EARNS, MONTH],
    );

    const line = (mid: string, count: number, net: number) =>
      db.query(
        `insert into residual_lines
           (period_id, mid, fee_item_name, item_count, net_revenue, amount, agent_expense, source, import_id)
         values ($1,$2,'Authorization Fee IP/SSL',$3,$4,$4,0,'excel',$5)`,
        [periodId, mid, count, net, importId],
      );

    await line(MID.EARNS, 100, 8);
    await line(MID.NO_RATES, 10, 1);

    await asAdmin(`select compute_residual_period($1::uuid, 'MAVERICK')`, [periodId]);
  });

  afterAll(async () => {
    if (!db) return;
    await db.query('ROLLBACK');
    await db.end();
  });

  /* ── the configuration half ───────────────────────────────────────── */

  it('the tab exists, as a system tab that accepts no fields', async () => {
    const rows = await asOwner<{
      key: string;
      label: string;
      kind: string;
      is_system: boolean;
      accepts_fields: boolean;
    }>(
      `select key::text key, label, kind::text kind, is_system, accepts_fields
         from tabs where key = 'residual_figures'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('residuals');
    expect(rows[0].label).toBe('Residuals');
    /*
     * Both flags matter. `is_system` keeps it out of the Presets delete/rename
     * path; `accepts_fields` false stops an admin dragging fields onto a
     * surface that renders computed output and cannot show them.
     */
    expect(rows[0].is_system).toBe(true);
    expect(rows[0].accepts_fields).toBe(false);
  });

  it('and is assigned to the residuals module, exactly once', async () => {
    const rows = await asOwner<{ slug: string; position: number }>(
      `select m.slug, o.position
         from module_tab_order o
         join modules m on m.id = o.module_id
         join tabs t on t.id = o.tab_id
        where t.key = 'residual_figures'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe('residuals');
  });

  /*
   * The convention this whole design is shaped by: no code may name a module,
   * so the renderer switches on the tab KIND and the module assignment is
   * data. The assertion is that the kind is unique — if a second tab ever
   * claimed it, `shows('residuals')` and `grantOfKind('residuals')` would both
   * pick an arbitrary one of the two.
   */
  it('nothing else claims the residuals kind', async () => {
    const rows = await asOwner<{ n: number }>(
      `select count(*)::int n from tabs where kind = 'residuals'`,
    );
    expect(rows[0].n).toBe(1);
  });

  /* ── the figures half ─────────────────────────────────────────────── */

  /*
   * -- ONE MERCHANT'S FIGURE DEPENDS ON THE WHOLE MONTH ------------------
   * This asserted the opposite first time round and failed, which is the
   * useful part. `disclosable` is `bool_or(calculation_version is not null)`
   * over the PERIOD, not a per-merchant test, and the engine stamps that
   * version only when it skipped nothing.
   *
   * So this merchant priced perfectly and still has no figure, because the
   * OTHER merchant in the month has no rates. Deliberate: the version is the
   * standing claim that the month is complete, and one skipped merchant means
   * the month's money is missing a piece.
   *
   * The consequence is what makes this worth a test. A panel explaining the
   * blank as "this merchant's lines are not all priced" would be flatly wrong
   * here, and would send the reader hunting for a fault in a merchant that has
   * none.
   */
  it('a merchant that priced perfectly still has no figure while the month is incomplete', async () => {
    const s = await synopsisFor(MID.EARNS);

    /* Its own lines are all priced... */
    expect(s?.rows_total).toBe(1);
    expect(s?.rows_computed).toBe(1);

    /* ...and the figure is withheld anyway, because the MONTH is not stamped. */
    expect(s?.disclosable).toBe(false);
    expect(s?.net_income).toBeNull();

    const v = await asOwner<{ v: number | null }>(
      `select calculation_version v from residual_periods where id = $1`,
      [periodId],
    );
    expect(v[0].v).toBeNull();
  });

  it('and once the month IS complete, the figure appears', async () => {
    await db.query('savepoint complete');

    /* Give the skipped merchant rates, so nothing in the month is skipped. */
    await asOwner(
      `insert into residual_merchant_rates
         (mid, effective_from, risk_tier, vmd_auth_fee, batch_fee, avs_fee, monthly_fee_tapdash)
       values ($1,$2,'low',0.1,0.05,0.02,15)`,
      [MID.NO_RATES, MONTH],
    );
    await asAdmin(`select compute_residual_period($1::uuid, 'MAVERICK')`, [periodId]);

    const v = await asOwner<{ v: number | null }>(
      `select calculation_version v from residual_periods where id = $1`,
      [periodId],
    );
    expect(v[0].v).not.toBeNull();

    const s = await synopsisFor(MID.EARNS);
    expect(s?.disclosable).toBe(true);
    expect(s?.net_income).not.toBeNull();
    /*
     * 100 x 0.10 income, 100 x 0.02 buy, 8.00 net, x 0.90 = 7.20.
     *
     * NOT 22.20. `monthly_fee_tapdash` is on the merchant's rate row, but it
     * only becomes `additional_income_direct` on the MONTHLY FEE line — rule
     * #2 is what reads it — and this fixture has no Monthly Fee row. The
     * direct fee rides on a specific line rather than being added to the
     * merchant, which is why the fee report's own row for it has to be
     * present for TapDash to book it.
     */
    expect(Number(s?.net_income)).toBeCloseTo(7.2, 2);

    await db.query('rollback to savepoint complete');
    await asAdmin(`select compute_residual_period($1::uuid, 'MAVERICK')`, [periodId]);
  });

  it('a merchant the engine skipped has no total, and says how far it got', async () => {
    const s = await synopsisFor(MID.NO_RATES);
    expect(s?.disclosable).toBe(false);
    expect(s?.net_income).toBeNull();
    /*
     * The denominators come back regardless, which is what lets the panel
     * explain the absence — "0 of 1 lines priced" is actionable, a blank is
     * not.
     */
    expect(s?.rows_total).toBe(1);
    expect(s?.rows_computed).toBe(0);
  });

  it('the lifetime figure is withheld while any month is incomplete', async () => {
    const s = await synopsisFor(MID.NO_RATES, true);
    expect(s?.disclosable).toBe(false);
    expect(s?.net_income).toBeNull();
    expect(s?.periods_total).toBeGreaterThan(0);
  });

  /* ── the MID is what keys it, not record_id ───────────────────────── */

  /**
   * The panel reads by MID rather than by `residual_lines.record_id`, which
   * looks backwards. Daniel's rule is why: *"Linking is a convenience for
   * humans; pricing never depends on it."*
   *
   * This asserts the consequence that makes the choice correct: the lines
   * exist and are costed with `record_id` still NULL, so a panel keyed on
   * `record_id` would show nothing for a merchant whose figures are right
   * there — correct figures, rendered as none.
   */
  it('lines are costed before any record is linked, which is why the MID is the key', async () => {
    const rows = await asOwner<{ n: number; linked: number; costed: number }>(
      `select count(*)::int n,
              count(record_id)::int linked,
              count(net_income)::int costed
         from residual_lines
        where period_id = $1 and mid = $2 and deleted_at is null`,
      [periodId, MID.EARNS],
    );
    expect(rows[0].n).toBeGreaterThan(0);
    /* Costed, and linked to no record. A panel keyed on `record_id` would show
       nothing for a merchant whose figures are right there. */
    expect(rows[0].costed).toBe(rows[0].n);
    expect(rows[0].linked).toBe(0);
  });

  /*
   * A MID is stored and matched as digits. A record whose Pricing tab carries
   * "55-0000-000801" has to resolve to the same merchant, which is what the
   * reader's `replace(/[^0-9]/g, '')` is for — asserted here against the
   * database's own normalisation so the two cannot disagree.
   */
  it('the MID normalisation matches the database’s', async () => {
    const rows = await asOwner<{ norm: string }>(
      `select regexp_replace($1::text, '[^0-9]', '', 'g') norm`,
      ['55-0000-000801'],
    );
    expect(rows[0].norm).toBe(MID.EARNS);
  });

  /* ── and not to a caller with no identity ─────────────────────────── */

  it('refuses the figures to a caller with no identity', async () => {
    await db.query(`select set_config('request.jwt.claims', '', true)`);

    for (const sql of [
      `select * from residual_synopsis($1::uuid, null, false)`,
      `select * from residual_merchant_states($1::uuid)`,
    ]) {
      const name = `anon_${Math.random().toString(36).slice(2, 10)}`;
      await db.query(`savepoint ${name}`);
      let code: string | null = null;
      try {
        await db.query(sql, [periodId]);
      } catch (e) {
        code = (e as { code?: string }).code ?? null;
      }
      await db.query(`rollback to savepoint ${name}`);
      /*
       * Which is why `residualsForRecord` returns `{ kind: 'admin_only' }`
       * rather than letting these raise: a 42501 on a tab somebody holds a
       * legitimate View grant on would render an error page instead of an
       * explanation.
       */
      expect(code, sql).toBe('42501');
    }
  });
});
