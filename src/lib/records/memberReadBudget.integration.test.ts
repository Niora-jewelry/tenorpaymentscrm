/**
 * A member's record read must stay well inside the statement timeout.
 *
 * ── WHAT THIS GUARDS ─────────────────────────────────────────────────────
 * On 15 Oct 2026 a member (not an admin) hit "This page didn't load" on the
 * Contacts table and every record drawer. The cause was
 *
 *   57014  canceling statement due to statement timeout
 *
 * `record_values_for` worked out the hidden-field list three times per record,
 * each time by walking all 134 fields through a function call per field: about
 * 0.6s a record. The `authenticated` role's statement_timeout is 8s, so it
 * failed at roughly a member's thirteenth record and got worse with every one
 * after. Migrations …9762 and …9763 compute the list once per module set, in
 * one pass.
 *
 * Nothing caught it beforehand because nothing measured it, and nothing ran
 * as a member: `auth_is_admin()` short-circuits the whole computation, and
 * every other check here signs in as an admin. So this runs as a MEMBER, over
 * a full page of records, and asserts on the time the database itself
 * reports (EXPLAIN ANALYZE), not wall-clock — the network to the database is
 * not what the timeout measures.
 *
 * ── BUILT INSIDE A TRANSACTION, ROLLED BACK ──────────────────────────────
 * The member is put on the team of up to 50 records and those records into a
 * display module, so they are genuinely visible — then all of it is undone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const DB_URL = process.env.SUPABASE_DB_URL;
const suite = DB_URL ? describe : describe.skip;

/** A full page is 50 rows. Before the fix, 13 took 7.8s in the database. */
const PAGE = 50;
const BUDGET_MS = 3000;

let db: pg.Client;

beforeAll(async () => {
  if (!DB_URL) return;
  db = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false }, statement_timeout: 120_000 });
  await db.connect();
});

afterAll(async () => {
  if (db) await db.end();
});

suite("a member's record read", () => {
  it(`stays under ${BUDGET_MS}ms for a full page of ${PAGE} visible records`, async () => {
    await db.query('BEGIN');
    try {
      const { rows: [member] } = await db.query(
        `select p.id from profiles p join roles r on r.id = p.role_id
          where not r.is_admin and p.deleted_at is null and p.status = 'active'
          order by p.email limit 1`);
      expect(member, 'a non-admin profile is needed — an admin would skip the very code under test').toBeTruthy();

      const { rows: [mod] } = await db.query(
        `select id from modules where not admin_only order by position limit 1`);

      const ids: string[] = (await db.query(
        `select id from records where deleted_at is null order by created_at limit $1`, [PAGE])).rows.map((r) => r.id);
      expect(ids.length, 'need records to read').toBeGreaterThan(5);

      // Visible to the member: on its team (through the field, which the
      // sync trigger turns into record_team_members) and in a display module.
      await db.query(
        `update records
            set "values" = coalesce("values", '{}'::jsonb)
                         || jsonb_build_object('team_members_assigned',
                              coalesce("values" -> 'team_members_assigned', '[]'::jsonb) || to_jsonb($2::text))
          where id = any($1)`, [ids, member.id]);
      await db.query(
        `insert into record_modules (record_id, module_id) select unnest($1::uuid[]), $2 on conflict do nothing`,
        [ids, mod.id]);
      // …and allowed into that module. Without a module grant the member sees
      // only what other grants already happen to expose, and the timing below
      // would be measured over a handful of rows.
      await db.query(
        `insert into user_grants (user_id, scope_kind, scope_id, grant_level)
         values ($1, 'module', $2, 'edit')
         on conflict (user_id, scope_kind, scope_id, module_id) do update set grant_level = 'edit'`,
        [member.id, mod.id]);

      await db.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: member.id, role: 'authenticated' }),
      ]);
      await db.query('set local role authenticated');

      const { rows } = await db.query(
        `explain (analyze, format json) select id from record_values_for($1::uuid[])`, [ids]);
      const plan = rows[0]['QUERY PLAN'][0];
      const ms = plan['Execution Time'] as number;

      // And it really read them — a budget met by returning nothing proves nothing.
      const { rows: got } = await db.query(`select count(*)::int n from record_values_for($1::uuid[])`, [ids]);
      expect(got[0].n, 'the member could not see the records — the timing below would be vacuous').toBe(ids.length);

      expect(ms, `record_values_for took ${ms.toFixed(0)}ms in the database for ${ids.length} records`).toBeLessThan(BUDGET_MS);
    } finally {
      await db.query('ROLLBACK');
    }
  }, 180_000);
});
