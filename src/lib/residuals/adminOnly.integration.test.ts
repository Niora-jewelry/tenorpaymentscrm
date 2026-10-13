/**
 * The residuals module is admin-only IN THE DATABASE, not just in the app.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM THE ACTION GUARDS ────────────────────
 * `actions.guards.test.ts` asserts that every Server Action under Admin →
 * Residuals checks `ctx.isAdmin`. That check is a courtesy: it turns a
 * refusal into a sentence on screen instead of an error page. It is not the
 * boundary, and CLAUDE.md is explicit that UI-level hiding never is.
 *
 * This asserts the boundary itself. Residuals is the money path — buy rates,
 * merchant rates, computed lines, signed-off months — and the whole access
 * rule for it is "admins only". There is no per-module grant that opens it to
 * anyone else, so a non-admin reaching any of it is a breach, not a
 * mis-rendered screen.
 *
 * ── THE VACUOUS-PASS TRAP, AND HOW IT IS CLOSED ──────────────────────────
 * "A non-admin reads no rows" passes just as well against an empty database,
 * which is how a test like this rots into decoration. So every read is
 * checked TWICE: once as an admin, who must see rows, and once as a member,
 * who must see none. If the admin read comes back empty the test fails rather
 * than quietly agreeing with itself.
 *
 * ── ONE TRANSACTION, ROLLED BACK ─────────────────────────────────────────
 * `set local role` and `set_config(..., true)` are transaction-scoped, which
 * is the only way to borrow an identity here. Nothing is committed, and the
 * one write attempted is expected to be refused anyway.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const DB_URL = process.env.SUPABASE_DB_URL;
const suite = DB_URL ? describe : describe.skip;

let db: pg.Client;

/** Tables a non-admin must never read a single row from. */
const READABLE_BY_ADMIN_ONLY = [
  'residual_lines',
  'residual_merchant_rates',
  'residual_buy_rates',
  'residual_periods',
  'residual_imports',
  'residual_calc_failures',
];

beforeAll(async () => {
  if (!DB_URL) return;
  db = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
});

afterAll(async () => {
  if (db) await db.end();
});

async function asUser(id: string, fn: () => Promise<void>) {
  await db.query('BEGIN');
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: id, role: 'authenticated' }),
  ]);
  await db.query('set local role authenticated');
  try {
    await fn();
  } finally {
    await db.query('ROLLBACK');
  }
}

suite('residuals are admin-only in the database', () => {
  let adminId: string;
  let memberId: string;

  beforeAll(async () => {
    const { rows } = await db.query(`
      select p.id, r.is_admin
        from profiles p join roles r on r.id = p.role_id
       where p.deleted_at is null and p.status = 'active'
       order by r.is_admin desc, p.email`);
    adminId = rows.find((r) => r.is_admin)?.id;
    memberId = rows.find((r) => !r.is_admin)?.id;
    expect(adminId, 'an active admin is needed to prove the reads are not vacuous').toBeTruthy();
    expect(memberId, 'an active non-admin is needed to attempt the reads').toBeTruthy();
  });

  it('an admin can read the residual tables, so the comparison below is real', async () => {
    const counts: Record<string, number> = {};
    await asUser(adminId, async () => {
      for (const table of READABLE_BY_ADMIN_ONLY) {
        const { rows } = await db.query(`select count(*)::int n from ${table}`);
        counts[table] = rows[0].n;
      }
    });
    // At least the tables that carry this project's imported August data.
    expect(counts.residual_lines, 'no residual lines — the member check below would pass on an empty table').toBeGreaterThan(0);
    expect(counts.residual_merchant_rates).toBeGreaterThan(0);
    expect(counts.residual_periods).toBeGreaterThan(0);
  });

  it('a non-admin reads nothing from any of them', async () => {
    const leaked: string[] = [];
    await asUser(memberId, async () => {
      for (const table of READABLE_BY_ADMIN_ONLY) {
        const { rows } = await db.query(`select count(*)::int n from ${table}`);
        if (rows[0].n > 0) leaked.push(`${table} (${rows[0].n} rows)`);
      }
    });
    expect(leaked, `a non-admin can read residual data from: ${leaked.join(', ')}`).toEqual([]);
  });

  it('a non-admin cannot write a merchant rate', async () => {
    let code: string | null = null;
    await asUser(memberId, async () => {
      try {
        await db.query(`
          insert into residual_merchant_rates (mid, effective_from, risk_tier)
          values ('550000000999', date_trunc('month', now())::date, 'low')`);
      } catch (e) {
        code = (e as { code?: string }).code ?? 'unknown';
      }
    });
    // 42501 insufficient_privilege, or 42P01 if the grant is withheld entirely.
    expect(code, 'a non-admin was allowed to insert a merchant rate').not.toBeNull();
  });

  it('a non-admin cannot change a period, even one it cannot see', async () => {
    let affected = -1;
    await asUser(memberId, async () => {
      try {
        const r = await db.query(`update residual_periods set status = 'reconciled'`);
        affected = r.rowCount ?? 0;
      } catch {
        affected = 0; // refused outright is also correct
      }
    });
    expect(affected, 'a non-admin updated residual_periods rows').toBe(0);
  });

  it('every residual table has row-level security enabled, with at least one policy', async () => {
    const { rows } = await db.query(`
      select c.relname,
             c.relrowsecurity as enabled,
             (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
        from pg_class c
       where c.relnamespace = 'public'::regnamespace
         and c.relkind = 'r' and c.relname like 'residual%'`);
    expect(rows.length, 'no residual tables found — the pattern may have changed').toBeGreaterThan(20);
    const unprotected = rows
      .filter((r) => !r.enabled || r.policies === 0)
      .map((r) => `${r.relname} (rls=${r.enabled}, policies=${r.policies})`);
    expect(unprotected, `unprotected residual tables: ${unprotected.join(', ')}`).toEqual([]);
  });
});
