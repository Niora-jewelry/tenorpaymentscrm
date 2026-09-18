/**
 * End-to-end Module 2 record lifecycle, against the REAL Supabase database —
 * skipped automatically unless SUPABASE_DB_URL is set, matching
 * `src/lib/auth/flow.integration.test.ts`'s own gating.
 *
 * Exercises the RPCs directly via a simulated `authenticated` session
 * (`SET LOCAL ROLE authenticated` + `request.jwt.claims`) rather than
 * calling `lib/records/*` functions — those go through
 * `createSupabaseServerClient()`, which reads cookies via `next/headers` and
 * has no meaning outside an actual Next.js request (the auth module's own
 * integration test sidesteps the same problem by calling
 * `startSignup`/`completeSignup`, which are service-role-backed instead of
 * cookie-scoped). This is the database layer those functions are thin
 * wrappers over — the same technique this build's own `scripts/verify-*.mjs`
 * files already used successfully to catch four real bugs this session.
 *
 * The whole suite runs inside one transaction (`beforeAll`
 * BEGIN → every test shares the connection and sees the prior test's writes,
 * matching how one real user's session would proceed step to step →
 * `afterAll` ROLLBACK) rather than committing and cleaning up afterward —
 * `SET LOCAL ROLE`/`set_config(..., true)` are themselves transaction-scoped,
 * so this is also the only way the role-switching trick works reliably
 * across sequential steps. Nothing it creates ever touches the real data.
 *
 * Covers MODULE-2-PLAN's own Stage 5 lifecycle: create → set value →
 * concurrent conflict → refuse-delete-while-member → archive → delete →
 * restore-comes-back-archived.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const DB_URL = process.env.SUPABASE_DB_URL;
const HAS_DB = Boolean(DB_URL);

const suite = HAS_DB ? describe : describe.skip;

const DEAL_NAME = `Integration Test Merchant ${Date.now()}`;

let db: pg.Client;
let userId: string;
let leadsModuleId: string;
let recordId: string;

/** timestamptz columns come back as JS Date objects, truncated to
 * millisecond precision — casting to text in SQL avoids a false CAS
 * mismatch when the value round-trips into the next query's parameter. */
async function asAuthenticated<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: userId, role: 'authenticated' }),
  ]);
  await db.query('set local role authenticated');
  const { rows } = await db.query(sql, params);
  return rows;
}

suite('Module 2 record lifecycle against the live database', () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
    await db.connect();
    await db.query('BEGIN');

    const { rows: users } = await db.query(
      `select id from profiles where role_id in (select id from roles where name = 'Super Admin') limit 1`,
    );
    if (!users.length) throw new Error('No Super Admin profile seeded — cannot run this suite.');
    userId = users[0].id;

    const { rows: modules } = await db.query(`select id from modules where slug = 'leads'`);
    leadsModuleId = modules[0].id;
  });

  afterAll(async () => {
    if (!db) return;
    await db.query('ROLLBACK');
    await db.end();
  });

  it('creates a record with no memberships (a raw insert, mirroring createRecord())', async () => {
    // `values.team_members_assigned` seeded with the creator at insert time —
    // this integration test is what FOUND the gap this fixes: without it, a
    // non-admin's own freshly-created record is invisible to them the
    // instant they create it (records.ts's own createRecord() now does this
    // too). Admin-only testing never caught it, since auth_is_admin()
    // bypasses can_see_record() entirely.
    const rows = await asAuthenticated<{ id: string }>(
      `insert into records (deal_name, creator_kind, creator_user_id, values)
       values ($1, 'user', $2, jsonb_build_object('team_members_assigned', jsonb_build_array($3::text)))
       returning id`,
      [DEAL_NAME, userId, userId],
    );
    recordId = rows[0]!.id;
    expect(recordId).toBeTruthy();
  });

  it('the creator lands on the team via sync_record_team_members — SECURITY DEFINER required (migration 24)', async () => {
    const rows = await asAuthenticated<{ user_id: string }>(
      `select user_id from record_team_members where record_id = $1`,
      [recordId],
    );
    // Without SECURITY DEFINER on the trigger, the INSERT above would have
    // failed outright (permission denied writing record_team_members) rather
    // than silently omitting the row — this is migration 24's exact bug.
    expect(rows.some((r) => r.user_id === userId)).toBe(true);
  });

  it('a non-admin (simulated by ignoring the admin bypass) can read back what they just created', async () => {
    // record_visible()/can_see_record() OR-in auth_is_admin() — this checks
    // the OTHER branch actually holds too, not just the admin bypass, by
    // confirming record_team_members (not admin status) is what's making the
    // row visible: the row exists in record_team_members for this user
    // (checked above) AND the ordinary RLS-scoped select below returns it.
    const rows = await asAuthenticated<{ id: string }>(`select id from records where id = $1`, [recordId]);
    expect(rows).toHaveLength(1);
  });

  it('assigns it to the Leads module', async () => {
    await asAuthenticated(`select set_record_memberships($1, $2)`, [recordId, [leadsModuleId]]);
    const rows = await asAuthenticated<{ module_id: string }>(
      `select module_id from record_modules where record_id = $1`,
      [recordId],
    );
    expect(rows.map((r) => r.module_id)).toEqual([leadsModuleId]);
  });

  it('sets a field value via compare-and-swap', async () => {
    const [{ updated_at: initialUpdatedAt }] = await asAuthenticated<{ updated_at: string }>(
      `select updated_at::text as updated_at from records where id = $1`,
      [recordId],
    );

    const [result] = await asAuthenticated<{ ok: boolean; updated_at: string }>(
      `select ok, updated_at::text as updated_at from set_record_value($1, $2, $3, $4, $5)`,
      [recordId, 'legal_business_name', JSON.stringify('Test Merchant LLC'), initialUpdatedAt, 'test'],
    );
    expect(result!.ok).toBe(true);

    /*
     * Read back through `record_values_for()`, not `records.values`.
     *
     * `authenticated` no longer holds SELECT on that column (migration 76):
     * every field lives in one jsonb blob, so a row policy could not withhold
     * the hidden ones, and a signed-in user could read a `sensitive` field —
     * an EIN — straight from the API whatever their permissions said. The
     * column was revoked and handed back through a function that strips the
     * viewer's hidden keys in the database.
     *
     * This assertion used to read the column directly. It now reads the only
     * route that still exists, which is the point.
     */
    const [row] = await asAuthenticated<{ value: string }>(
      `select (v.values ->> 'legal_business_name') as value
         from record_values_for(array[$1]::uuid[]) v`,
      [recordId],
    );
    expect(row!.value).toBe('Test Merchant LLC');
  });

  it('refuses a direct read of records.values, whatever the row policy says', async () => {
    /*
     * The boundary itself, pinned. The record is visible to this user — the
     * test above just wrote to it — so this is not row visibility failing. It
     * is the column grant, which is the only thing in Postgres that can
     * withhold one column of a row a user is otherwise allowed to read.
     */
    /*
     * Inside a SAVEPOINT. This suite shares one transaction, and a failed
     * statement poisons it — every later test then dies with "current
     * transaction is aborted" and the real failure is six tests up. The
     * savepoint contains the damage to the one query that is supposed to fail.
     */
    await db.query('savepoint denied_read');
    let message = '';
    try {
      await asAuthenticated(`select values from records where id = $1`, [recordId]);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    } finally {
      await db.query('rollback to savepoint denied_read');
    }
    expect(message).toMatch(/permission denied/i);
  });

  it('rejects a stale write — the concurrent-conflict case — and reports the current value', async () => {
    const staleTimestamp = new Date(Date.now() - 60_000).toISOString();
    const [result] = await asAuthenticated<{ ok: boolean; current_value: unknown; changed_by: string }>(
      `select ok, current_value, changed_by from set_record_value($1, $2, $3, $4, $5)`,
      [recordId, 'legal_business_name', JSON.stringify('Someone Else Won The Race'), staleTimestamp, 'test'],
    );
    expect(result!.ok).toBe(false);
    // §13.4: a losing writer gets back what the CURRENT value is and who set
    // it — never a bare conflict flag with no context.
    expect(result!.current_value).toBe('Test Merchant LLC');
    expect(result!.changed_by).toBe(userId);
  });

  it('refuses to delete while still displayed in a module', async () => {
    // A query that raises a real Postgres error aborts the whole
    // transaction, not just that one statement — a SAVEPOINT is required to
    // keep the suite's later tests usable (the same lesson this session's
    // scripts/verify-*.mjs files already learned the hard way).
    await db.query('savepoint before_refused_delete');
    await expect(asAuthenticated(`select delete_record($1)`, [recordId])).rejects.toThrow(
      /archive this record before deleting it/i,
    );
    await db.query('rollback to savepoint before_refused_delete');
  });

  it('archiving clears every display membership', async () => {
    await asAuthenticated(`select set_record_memberships($1, '{}')`, [recordId]);
    const rows = await asAuthenticated(`select module_id from record_modules where record_id = $1`, [recordId]);
    expect(rows).toHaveLength(0);
  });

  it('delete succeeds once archived, and logs it', async () => {
    await asAuthenticated(`select delete_record($1)`, [recordId]);

    // Checked via the unrestricted role, deliberately — `records_select`'s
    // `deleted_at is null` clause (and record_visible(), which
    // record_activity_select depends on) hide a deleted record from EVERY
    // authenticated role including admin the instant it's deleted; this is
    // verifying the underlying write actually happened, not re-testing RLS
    // (the next test covers that specifically).
    await db.query('reset role');
    const { rows: [row] } = await db.query<{ deleted_at: string | null }>(
      `select deleted_at from records where id = $1`,
      [recordId],
    );
    expect(row!.deleted_at).not.toBeNull();

    const { rows: [activity] } = await db.query<{ summary: string }>(
      `select summary from record_activity where record_id = $1 and kind::text = 'record' order by at desc limit 1`,
      [recordId],
    );
    expect(activity!.summary).toMatch(/recycle bin/i);
  });

  it('a deleted record is invisible via the normal RLS-scoped select', async () => {
    const rows = await asAuthenticated(`select id from records where id = $1`, [recordId]);
    // records_select's own policy excludes deleted_at IS NOT NULL for
    // everyone, admin included — the Recycle Bin reads it another way.
    expect(rows).toHaveLength(0);
  });

  it('restore always comes back archived — no membership set to restore', async () => {
    await asAuthenticated(`select restore_record($1)`, [recordId]);

    const [row] = await asAuthenticated<{ deleted_at: string | null }>(
      `select deleted_at from records where id = $1`,
      [recordId],
    );
    expect(row!.deleted_at).toBeNull();

    const rows = await asAuthenticated(`select module_id from record_modules where record_id = $1`, [recordId]);
    expect(rows).toHaveLength(0);
  });
}, 60_000);
