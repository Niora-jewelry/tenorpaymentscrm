/**
 * Un-blocking a merchant on a PAST statement month, against the real database.
 *
 * ── THE CLAIM BEING TESTED, AND WHY IT NEEDED TESTING ────────────────────
 * The reconciliation screen tells an operator what to do about a blocked
 * merchant. It used to say "enter them on the merchant's Pricing tab and
 * re-calculate", which is true for the CURRENT month and false for every past
 * one — which is every month a real statement covers.
 *
 * `residual_sync_rates_from_record` writes `effective_from =
 * residual_rate_effective_month(now())`, i.e. `date_trunc('month', now())`. So
 * filling the Pricing tab opens a row starting THIS month, and
 * `residual_merchant_rates_for_month(mid, '<past month>')` still finds nothing.
 * An operator following that advice would do the thing, re-run the engine, see
 * no change, and have no way to tell which half had failed.
 *
 * This suite proves both halves of that, and proves the path that does work:
 * `residual_supersede_merchant_rate` with the month named explicitly.
 *
 * Everything runs in one transaction and is rolled back. The month and MIDs
 * are scratch values no real period uses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const DB_URL = process.env.SUPABASE_DB_URL;
const suite = DB_URL ? describe : describe.skip;

const MID = '550000000601';
/**
 * A genuinely PAST month, which is what every real statement is.
 *
 * ── THIS DATE IS THE TEST ────────────────────────────────────────────────
 * It was 2031-07 first time round — a scratch month picked far forward to
 * avoid colliding with real data, which inverted the whole suite: a rate row
 * the Pricing tab opens this month is open-ended, so it DOES cover a month in
 * 2031, and the assertion that the sync cannot reach the statement failed on a
 * month that was never in the past.
 *
 * 2019-03 is safely before the current month, safely inside the predecessor
 * registry's range (1999-12-31 → 2026-05-31), and not a month any real period
 * uses — `residual_periods` enforces one live period per month, and everything
 * here is rolled back regardless.
 */
const PAST = '2019-03-01';

let db: pg.Client;
let adminId: string;
let periodId: string;
let importId: string;
let recordId: string;

/**
 * Runs as the signed-in admin, which is what the gated functions require.
 *
 * The role is left set afterwards, because `set local role` is
 * transaction-scoped and resetting it between every call would be noise. Raw
 * table statements therefore go through `asOwner`, which resets it first —
 * `authenticated` has no table grant for them, and the failure is
 * "permission denied for table records", which is easy to misread as a bug in
 * the thing under test rather than in the harness.
 */
async function asAdmin<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: adminId, role: 'authenticated' }),
  ]);
  await db.query('set local role authenticated');
  const { rows } = await db.query(sql, params);
  return rows as T[];
}

/** Runs as the connection's own role, for fixture reads and writes. */
async function asOwner<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  await db.query('reset role');
  const { rows } = await db.query(sql, params);
  return rows as T[];
}

const stateOf = async () => {
  const rows = await asAdmin<{ mid: string; state: string; skipped_whole: string }>(
    `select * from residual_merchant_states($1::uuid)`,
    [periodId],
  );
  return rows.find((r) => r.mid === MID) ?? null;
};

type RateRow = { mid: string; vmd_auth_fee: string | null; risk_tier: string } & Record<
  string,
  string | null
>;

/**
 * The resolver, which RAISES when nothing covers the month rather than
 * returning zero rows.
 *
 * That is deliberate and it is the behaviour that makes a missing rate loud:
 * an empty result set would be silently multiplied by nothing downstream,
 * while a raise forces the caller to decide. So this returns `null` for
 * "refused" and the rows otherwise, and the raise is contained by a savepoint
 * — without one it aborts the transaction and every later test reports
 * "current transaction is aborted" instead of its own result.
 */
async function coversPast(): Promise<RateRow[] | null> {
  const name = `cov_${Math.random().toString(36).slice(2, 10)}`;
  await db.query(`savepoint ${name}`);
  try {
    const rows = await asAdmin<RateRow>(
      `select * from residual_merchant_rates_for_month($1, $2::date)`,
      [MID, PAST],
    );
    await db.query(`release savepoint ${name}`);
    return rows;
  } catch {
    await db.query(`rollback to savepoint ${name}`);
    return null;
  }
}

/** Rate rows on file for this MID at all, whatever month they cover. */
const rateRowsOnFile = () =>
  asOwner<{ ef: string; et: string | null; risk_tier: string }>(
    `select effective_from::text ef, effective_to::text et, risk_tier
       from residual_merchant_rates where mid = $1 and deleted_at is null
      order by effective_from`,
    [MID],
  );

suite('un-blocking a merchant on a past month', () => {
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
        [PAST],
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
      `insert into residual_lines
         (period_id, mid, fee_item_name, item_count, net_revenue, amount, agent_expense, source, import_id)
       values ($1,$2,'Authorization Fee IP/SSL',100,8,8,0,'excel',$3)`,
      [periodId, MID, importId],
    );

    /*
     * A merchant record carrying the same MID, so the Pricing-tab trigger has
     * something real to fire on.
     *
     * `records` has no module_id — a record's module comes from its
     * memberships, not a column. That is the no-code-may-name-a-module rule
     * showing up in the schema, and none of it matters here: the trigger is
     * `after update of values` and reads `values->>'mid'`.
     */
    const [{ id: rid }] = (
      await db.query(
        `insert into records (deal_name, values, creator_kind, creator_user_id)
         values ($1, '{}'::jsonb, 'user', $2) returning id`,
        [`Rate backdating fixture ${Date.now()}`, adminId],
      )
    ).rows;
    recordId = rid;

    await asAdmin(`select compute_residual_period($1::uuid, 'MAVERICK')`, [periodId]);
  });

  afterAll(async () => {
    if (!db) return;
    await db.query('ROLLBACK');
    await db.end();
  });

  it('starts blocked, because no rates exist for that month', async () => {
    const st = await stateOf();
    expect(st?.state).toBe('blocked');
    expect(Number(st?.skipped_whole)).toBe(1);
    expect(await rateRowsOnFile()).toHaveLength(0);
  });

  /*
   * Not an inconvenience — the reason the engine cannot quietly cost a
   * merchant at zero. A resolver returning an empty set would be multiplied by
   * nothing somewhere downstream and book the item as free.
   */
  it('the resolver refuses a month it has no rates for, rather than returning none', async () => {
    expect(await coversPast()).toBeNull();
  });

  /*
   * The sync does work — this is not a broken trigger. It writes rates for the
   * CURRENT month, which is the right thing for the month in progress and the
   * wrong thing for the statement being reconciled.
   */
  it('the Pricing tab writes rates — for the current month, not the past one', async () => {
    await db.query('savepoint pricing');

    await asOwner(
      `update records
          set values = jsonb_build_object(
                'mid', $2::text,
                'pricing_risk_level', 'Low risk',
                'td_vmd_auth_fee', '0.10',
                'td_batch_fee', '0.05',
                'td_monthly_fee_tapdash', '15'
              )
        where id = $1`,
      [recordId, MID],
    );

    /* A row WAS created. */
    const created = await asOwner<{ ef: string; risk_tier: string; vaf: string }>(
      `select effective_from::text ef, risk_tier, vmd_auth_fee::text vaf
         from residual_merchant_rates where mid = $1 and deleted_at is null`,
      [MID],
    );
    expect(created).toHaveLength(1);
    expect(created[0].risk_tier).toBe('low');

    /* And it starts in the CURRENT month, which is the whole point. */
    const nowRows = await asOwner<{ m: string }>(`select residual_rate_effective_month()::text m`);
    expect(created[0].ef).toBe(nowRows[0].m);

    /*
     * So the past month is still not covered. This is the assertion that makes
     * the old on-screen advice wrong: the operator did exactly as told and the
     * statement being reconciled is no better off.
     */
    expect(await coversPast()).toBeNull();

    await asAdmin(`select compute_residual_period($1::uuid, 'MAVERICK')`, [periodId]);
    const st = await stateOf();
    expect(st?.state).toBe('blocked');

    await db.query('rollback to savepoint pricing');
    await asAdmin(`select compute_residual_period($1::uuid, 'MAVERICK')`, [periodId]);
  });

  /* ── the path that works ──────────────────────────────────────────── */

  it('superseding with the month named does reach it', async () => {
    const [{ r }] = await asAdmin<{ r: { effective_from: string; closed_id: string | null } }>(
      `select residual_supersede_merchant_rate($1, $2::date, 'low', $3::jsonb, $4) r`,
      [
        MID,
        PAST,
        JSON.stringify({
          vmd_auth_fee: '0.10',
          batch_fee: '0.05',
          avs_fee: '0.02',
          monthly_fee_tapdash: '15',
        }),
        'Entered from the statement, backdated.',
      ],
    );
    expect(r.effective_from).toBe(PAST);

    const found = await coversPast();
    expect(found).not.toBeNull();
    expect(found).toHaveLength(1);
    expect(found?.[0].risk_tier).toBe('low');
    /* Text in, exact numeric out — no float in the path. */
    expect(Number(found?.[0].vmd_auth_fee)).toBeCloseTo(0.1, 6);
  });

  it('and the merchant computes once the engine is re-run', async () => {
    await asAdmin(`select compute_residual_period($1::uuid, 'MAVERICK')`, [periodId]);

    const st = await stateOf();
    expect(st?.state).not.toBe('blocked');
    expect(Number(st?.skipped_whole)).toBe(0);

    /* The arithmetic, against the same hand-computed chain as everywhere
       else: 100 x 0.10 income, 100 x 0.02 buy, 8.00 net, x 0.90. */
    const rows = await asOwner<Record<string, string>>(
      `select total_income::text ti, total_buy_rate::text tb,
              tapdash_net_before_split::text nb, tapdash_net_after_split::text na
         from residual_lines where period_id = $1 and mid = $2 and deleted_at is null`,
      [periodId, MID],
    );
    expect(rows[0].ti).toBe('10.00');
    expect(rows[0].tb).toBe('2.00');
    expect(rows[0].nb).toBe('8.00');
    expect(rows[0].na).toBe('7.20');
  });

  /* ── a blank is not a zero ────────────────────────────────────────── */

  /**
   * The contract the form's "blank = no such rate" note is about.
   *
   * "A merchant with no AVS arrangement has no AVS rate, and NULL says that;
   *  0.000000 would assert a rate of zero, which is a different claim and one
   *  the engine would multiply by a count and book as real."
   */
  it('an omitted rate is stored as NULL, not as zero', async () => {
    const found = await coversPast();
    /* Never passed, so never asserted. */
    expect(found?.[0]).toHaveProperty('pin_debit_auth_fee', null);
    expect(found?.[0]).toHaveProperty('vmd_transaction_fee', null);
  });

  /* ── the lock ─────────────────────────────────────────────────────── */

  /*
   * `residual_merchant_rate_is_locked` is true once a CALCULATED month reads
   * the row. The run above left failures (none now), so whether it stamped
   * decides the lock — which is exactly the dependency the editor's two
   * buttons are about. Asserted as the function's own answer rather than
   * inferred.
   */
  it('reports whether a calculated month depends on the row', async () => {
    const [{ v }] = await asOwner<{ v: number | null }>(
      `select calculation_version v from residual_periods where id = $1`,
      [periodId],
    );

    const [{ locked }] = await asAdmin<{ locked: boolean }>(
      `select residual_merchant_rate_is_locked($1, $2::date, null) locked`,
      [MID, PAST],
    );

    /*
     * The two have to agree: a stamped month reading this merchant's lines IS
     * the lock, and nothing else is. If they ever disagree, either the editor
     * offers an in-place edit that would restate a month somebody has read, or
     * it refuses one that was safe.
     */
    expect(locked).toBe(v !== null);
  });

  /* ── and none of it without an identity ───────────────────────────── */

  it('refuses the rate editor and the supersede to a caller with no identity', async () => {
    await db.query(`select set_config('request.jwt.claims', '', true)`);

    for (const [sql, params] of [
      [`select residual_merchant_rate_editor($1)`, [MID]],
      [`select residual_merchant_rate_versions($1)`, [MID]],
      [`select residual_merchant_rate_coverage($1::uuid)`, [periodId]],
      [
        `select residual_supersede_merchant_rate($1, $2::date, 'low', '{}'::jsonb, null)`,
        [MID, PAST],
      ],
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
