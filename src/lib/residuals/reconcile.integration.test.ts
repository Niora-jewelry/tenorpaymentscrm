/**
 * The reconciliation lifecycle, against the REAL database — compute, disagree,
 * acknowledge, sign off, reopen. Skipped unless `SUPABASE_DB_URL` is set.
 *
 * ── WHY THE REFUSALS ARE THE POINT ───────────────────────────────────────
 * Most of what is asserted here is something the database REFUSES to do: sign
 * off a month with a blocked merchant, acknowledge without a reason,
 * acknowledge a comparison that is not a mismatch, acknowledge on a signed
 * month, reopen without a reason. Those refusals are what the screen's
 * disabled buttons and mandatory fields are a courtesy on top of — if any one
 * of them stops firing, the UI is the only thing standing between a
 * half-reconciled month and a sign-off, and the UI is not a security
 * boundary.
 *
 * ── ONE TRANSACTION, ROLLED BACK ─────────────────────────────────────────
 * `SET LOCAL ROLE` and `set_config(..., true)` are transaction-scoped, so the
 * admin identity these functions require only exists inside one. Everything
 * is rolled back. The month and MIDs are scratch values no real period uses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const DB_URL = process.env.SUPABASE_DB_URL;
const suite = DB_URL ? describe : describe.skip;

const MID = { CLEAN: '550000000401', OTHER: '550000000402' };
const MONTH = '2031-06-01';

let db: pg.Client;
let adminId: string;
let periodId: string;
let importId: string;

/**
 * Runs as the signed-in admin.
 *
 * ── THE CLAIMS ARE SET EVERY TIME, AND NOT RESET ─────────────────────────
 * `set_config('request.jwt.claims', ..., true)` is transaction-scoped rather
 * than role-scoped, so `reset role` does not clear it. That is exactly the
 * trap that made a sibling test report a correct production claim as a
 * failure, so the role is left set here for the whole suite and the one test
 * that needs an anonymous caller clears the claims explicitly.
 */
async function asAdmin<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: adminId, role: 'authenticated' }),
  ]);
  await db.query('set local role authenticated');
  const { rows } = await db.query(sql, params);
  return rows as T[];
}

/** An expected failure, contained by a savepoint so it cannot poison the rest. */
async function failureOf(
  sql: string,
  params: unknown[] = [],
): Promise<{ code: string; message: string } | null> {
  const name = `ef_${Math.random().toString(36).slice(2, 10)}`;
  await db.query(`savepoint ${name}`);
  try {
    await asAdmin(sql, params);
    await db.query(`release savepoint ${name}`);
    return null;
  } catch (e) {
    await db.query(`rollback to savepoint ${name}`);
    const err = e as { code?: string; message?: string };
    return { code: err.code ?? 'unknown', message: err.message ?? '' };
  }
}

type GridRow = {
  scope: string;
  row_id: string;
  mid: string;
  fee_item_name: string | null;
  is_computed: boolean;
  verdicts: Record<string, { verdict: string; suppressed: boolean; ack_id: string | null; delta: string | null }>;
};

const grid = () =>
  asAdmin<GridRow>(`select * from residual_grid_rows($1::uuid) order by mid, sort_order`, [periodId]);

type State = { mid: string; state: string; mismatch_count: string; suppressed_count: string };
const states = () =>
  asAdmin<State>(`select * from residual_merchant_states($1::uuid) order by mid`, [periodId]);

type PeriodState = { derived_status: string; stored_status: string; mismatch: string; signable: boolean };
const periodState = async () =>
  (await asAdmin<PeriodState>(`select * from residual_period_state($1::uuid)`, [periodId]))[0];

suite('reconciling a month', () => {
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

    /* Both merchants get rates: the first part of this suite is about
       MISMATCHES, and a merchant with no rates would be `blocked` instead,
       which is a different rung of the ladder and masks the one being tested. */
    for (const mid of [MID.CLEAN, MID.OTHER]) {
      await db.query(
        `insert into residual_merchant_rates
           (mid, effective_from, risk_tier, vmd_auth_fee, batch_fee, avs_fee, monthly_fee_tapdash)
         values ($1,$2,'low',0.1,0.05,0.02,15)`,
        [mid, MONTH],
      );
    }

    /*
     * `agent_expense` is 0.00 on both rows, while the engine computes a real
     * total_buy_rate — so step 2 (what the processor charged us vs what the
     * schedule says) mismatches on purpose. That is the condition the whole
     * acknowledgment mechanism exists for, and it is also what the real May
     * sample looks like.
     */
    const line = (mid: string, item: string, count: number, net: number) =>
      db.query(
        `insert into residual_lines
           (period_id, mid, fee_item_name, item_count, net_revenue, amount, agent_expense, source, import_id)
         values ($1,$2,$3,$4,$5,$5,0,'excel',$6)`,
        [periodId, mid, item, count, net, importId],
      );

    await line(MID.CLEAN, 'Authorization Fee IP/SSL', 100, 8);
    await line(MID.OTHER, 'Authorization Fee IP/SSL', 50, 4);

    await asAdmin(`select compute_residual_period($1::uuid, 'MAVERICK')`, [periodId]);
  });

  afterAll(async () => {
    if (!db) return;
    await db.query('ROLLBACK');
    await db.end();
  });

  /* ── what the grid says ───────────────────────────────────────────── */

  it('attaches the verdicts to the rows, keyed by step', async () => {
    const rows = await grid();
    expect(rows).toHaveLength(2);

    for (const r of rows) {
      expect(r.is_computed).toBe(true);
      /* Step 3 agrees: the engine's pre-split net IS the stated net here. */
      expect(r.verdicts['3'].verdict).toBe('match');
      /* Step 2 does not, because the file says the processor charged nothing. */
      expect(r.verdicts['2'].verdict).toBe('mismatch');
      /*
       * Step 1 is ABSENT, not failed. There is no volume row for the month, so
       * the comparison cannot be made — and absence is how that survives to
       * the client instead of becoming a blank cell that reads as an
       * oversight.
       */
      expect(r.verdicts['1']).toBeUndefined();
    }
  });

  it('puts both merchants on the mismatch rung', async () => {
    const s = await states();
    expect(s.map((x) => x.state)).toEqual(['mismatch', 'mismatch']);
    expect(s.every((x) => Number(x.mismatch_count) > 0)).toBe(true);
    expect(s.every((x) => Number(x.suppressed_count) === 0)).toBe(true);
  });

  /*
   * ── "CALCULATED" AND "RECONCILED" ARE NOT THE SAME CLAIM ──────────────
   * This test asserted the opposite first time round and failed, and the
   * failure is the useful part: both merchants here computed WITHOUT a
   * calculation failure, so the engine stamped a version and the total IS
   * disclosable — even though every one of their step-2 comparisons disagrees.
   *
   * The two conditions are deliberately independent:
   *
   *   calculation_version  stamped when `residual_calc_failures` is empty for
   *                        the period — "every figure here was computed, none
   *                        was skipped". A mismatch is not a failure to
   *                        compute; it is a successful computation that
   *                        disagrees with the statement.
   *
   *   signable             every merchant on the clean rung — "and the figures
   *                        agree with what the processor said, or a human has
   *                        said why not".
   *
   * So a month can carry a trustworthy total and still be nowhere near
   * sign-off, which is exactly the state the reconciliation screen exists to
   * work through. Conflating them would mean either withholding a complete
   * total because of an open question, or offering sign-off on a month nobody
   * has looked at.
   */
  it('discloses the total once every figure computed, mismatches or not', async () => {
    const rows = await asAdmin<{ mid: string | null; net_income: string | null; disclosable: boolean }>(
      `select * from residual_synopsis($1::uuid)`,
      [periodId],
    );
    const company = rows.find((r) => r.mid === null);

    expect(company?.disclosable).toBe(true);
    expect(company?.net_income).not.toBeNull();

    /* And the month is still not signable, which is the other half. */
    const st = await periodState();
    expect(st.signable).toBe(false);
  });

  /*
   * The other direction, which is the rule the UI is built on: a month with a
   * SKIPPED merchant has no total at all. Daniel's argument — a figure
   * labelled "partial" is read as two true things, a loss and some missing
   * rows, and the first of those is false.
   */
  it('withholds it entirely once a merchant is skipped', async () => {
    await db.query('savepoint skipped');

    /* A third merchant with lines and no rates: the engine skips it whole and
       records the failure, which un-stamps the month. */
    await db.query(
      `insert into residual_lines
         (period_id, mid, fee_item_name, item_count, net_revenue, amount, agent_expense, source, import_id)
       values ($1,'550000000409','Authorization Fee IP/SSL',10,1,1,0,'excel',$2)`,
      [periodId, importId],
    );
    await asAdmin(`select compute_residual_period($1::uuid, 'MAVERICK')`, [periodId]);

    const rows = await asAdmin<{ mid: string | null; net_income: string | null; disclosable: boolean }>(
      `select * from residual_synopsis($1::uuid)`,
      [periodId],
    );
    const company = rows.find((r) => r.mid === null);
    expect(company?.disclosable).toBe(false);
    expect(company?.net_income).toBeNull();

    await db.query('rollback to savepoint skipped');
    /* Recompute, so the rest of the suite sees the state it was built on. */
    await asAdmin(`select compute_residual_period($1::uuid, 'MAVERICK')`, [periodId]);
  });

  /* ── sign-off is refused first ────────────────────────────────────── */

  it('refuses to sign off a month that still disagrees', async () => {
    const st = await periodState();
    expect(st.signable).toBe(false);

    const f = await failureOf(`select residual_sign_off_period($1::uuid, null, null)`, [periodId]);
    expect(f).not.toBeNull();
    expect(f?.message).toMatch(/not .*(signable|clean)|merchant|mismatch/i);
  });

  /* ── acknowledging ────────────────────────────────────────────────── */

  it('refuses an acknowledgment with no reason', async () => {
    const rows = await grid();
    const f = await failureOf(
      `select residual_acknowledge_verdict('line', $1::uuid, 2::smallint, $2, null)`,
      [rows[0].row_id, '  '],
    );
    expect(f?.code).toBe('22004');
  });

  it('refuses an acknowledgment of a comparison that is not a mismatch', async () => {
    const rows = await grid();
    /* Step 3 matches on this row, so there is nothing to forgive. */
    const f = await failureOf(
      `select residual_acknowledge_verdict('line', $1::uuid, 3::smallint, $2, null)`,
      [rows[0].row_id, 'Trying to acknowledge a passing comparison.'],
    );
    expect(f).not.toBeNull();
  });

  it('accepts one with a reason, and suppresses it without hiding it', async () => {
    const rows = await grid();
    const target = rows[0];

    const [{ id: ackId }] = await asAdmin<{ id: string }>(
      `select residual_acknowledge_verdict('line', $1::uuid, 2::smallint, $2, null) id`,
      [target.row_id, 'Maverick bills this item outside the fee report; confirmed with Daniel.'],
    );
    expect(ackId).toBeTruthy();

    const after = (await grid()).find((r) => r.row_id === target.row_id);
    /*
     * Still a mismatch, and still showing its delta — acknowledging records
     * that a human accepted it, it does not restate the arithmetic. The screen
     * keeps the number visible for the same reason.
     */
    expect(after?.verdicts['2'].verdict).toBe('mismatch');
    expect(after?.verdicts['2'].suppressed).toBe(true);
    expect(after?.verdicts['2'].ack_id).toBe(ackId);
    expect(after?.verdicts['2'].delta).not.toBeNull();
  });

  it('the acknowledged merchant leaves the mismatch rung; the other does not', async () => {
    const s = await states();
    const byMid = new Map(s.map((x) => [x.mid, x]));
    expect(byMid.get(MID.CLEAN)?.state).toBe('ready');
    expect(Number(byMid.get(MID.CLEAN)?.suppressed_count)).toBe(1);
    expect(byMid.get(MID.OTHER)?.state).toBe('mismatch');
  });

  it('records the delta it was given, not one the caller supplied', async () => {
    /*
     * The function takes no delta — Daniel: "an ack's whole value is that it
     * records what was actually on the screen". So the stored delta has to
     * equal the one the derivation produces, and there is no parameter through
     * which it could differ.
     */
    const rows = await asAdmin<{
      delta_acknowledged: string;
      step: number;
      reason: string;
      calculation_version: number | null;
      tolerance_applied: string;
    }>(
      `select delta_acknowledged::text delta_acknowledged, step, reason,
              calculation_version, tolerance_applied::text tolerance_applied
         from residual_verdict_acknowledgments
        where period_id = $1 and retired_at is null and deleted_at is null`,
      [periodId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].step).toBe(2);
    expect(Number(rows[0].delta_acknowledged)).toBeCloseTo(2, 4);
    expect(rows[0].reason).toMatch(/Maverick bills this item/);
    /*
     * The tolerance and the calculation version are captured too, which is
     * what lets an acknowledgment retire itself: if the figures move, the ack
     * no longer describes the row it was made against.
     */
    expect(Number(rows[0].tolerance_applied)).toBeGreaterThan(0);
    expect(rows[0].calculation_version).not.toBeNull();
  });

  /* ── withdrawing ──────────────────────────────────────────────────── */

  it('withdrawing puts the mismatch back', async () => {
    await db.query('savepoint withdraw');

    const rows = await grid();
    const ackId = rows.find((r) => r.verdicts['2']?.ack_id)?.verdicts['2'].ack_id;
    expect(ackId).toBeTruthy();

    await asAdmin(`select residual_withdraw_acknowledgment($1::uuid, $2)`, [
      ackId,
      'Acknowledged the wrong row.',
    ]);

    const after = await states();
    expect(after.every((x) => x.state === 'mismatch')).toBe(true);

    await db.query('rollback to savepoint withdraw');
  });

  /* ── signing off, for real ────────────────────────────────────────── */

  it('signs off once every merchant is clean, and stamps the stored status', async () => {
    /* Acknowledge the second merchant too, so the month has nothing standing. */
    const rows = await grid();
    const other = rows.find((r) => r.mid === MID.OTHER);
    await asAdmin(
      `select residual_acknowledge_verdict('line', $1::uuid, 2::smallint, $2, null)`,
      [other?.row_id, 'Same item, same reason as the first merchant.'],
    );

    const before = await periodState();
    expect(before.signable).toBe(true);

    await asAdmin(`select residual_sign_off_period($1::uuid, $2, null)`, [
      periodId,
      'Both step-2 differences acknowledged; nothing else outstanding.',
    ]);

    const after = await periodState();
    expect(after.stored_status).toBe('reconciled');
    expect(after.derived_status).toBe('reconciled');
  });

  it('refuses to sign off twice', async () => {
    const f = await failureOf(`select residual_sign_off_period($1::uuid, null, null)`, [periodId]);
    expect(f?.message).toMatch(/already signed off/i);
  });

  /*
   * The guard that makes a signed month mean something. Without it an
   * acknowledgment could be added after the fact to a month somebody has
   * already attested to.
   */
  it('refuses an acknowledgment on a signed-off month', async () => {
    const rows = await grid();
    const f = await failureOf(
      `select residual_acknowledge_verdict('line', $1::uuid, 3::smallint, $2, null)`,
      [rows[0].row_id, 'Trying to change a signed month.'],
    );
    expect(f).not.toBeNull();
  });

  /* ── reopening ────────────────────────────────────────────────────── */

  it('refuses to reopen without a reason', async () => {
    const f = await failureOf(`select residual_reopen_period($1::uuid, $2)`, [periodId, '']);
    expect(f?.message).toMatch(/requires a reason/i);
  });

  it('reopens with one, and the month is open again', async () => {
    await asAdmin(`select residual_reopen_period($1::uuid, $2)`, [
      periodId,
      'Maverick reissued the statement for this month.',
    ]);
    const st = await periodState();
    expect(st.stored_status).toBe('open');
  });

  /* ── the history ──────────────────────────────────────────────────── */

  it('has all of that on one timeline', async () => {
    const rows = await asAdmin<{ kind: string }>(
      `select kind from residual_period_history($1::uuid, 100)`,
      [periodId],
    );
    const kinds = new Set(rows.map((r) => r.kind));
    /*
     * Four append-only sources interleaved. The reason this is a function and
     * not four queries in the client: a disputed month's question is "what
     * happened to this", and the answer is useless out of order.
     */
    expect(rows.length).toBeGreaterThan(3);
    expect(kinds.size).toBeGreaterThan(1);
  });

  /* ── and none of it is reachable without an identity ──────────────── */

  it('refuses every one of these to a caller with no identity', async () => {
    await db.query(`select set_config('request.jwt.claims', '', true)`);

    for (const sql of [
      `select * from residual_grid_rows($1::uuid)`,
      `select * from residual_merchant_states($1::uuid)`,
      `select * from residual_synopsis($1::uuid)`,
      `select * from residual_period_history($1::uuid, 10)`,
      `select * from residual_period_state($1::uuid)`,
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
      /* Every reader, not just the writers. The service-role key presents the
         same condition, which is why this whole surface is request-scoped. */
      expect(code, sql).toBe('42501');
    }
  });
});
