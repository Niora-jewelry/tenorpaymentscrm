/**
 * The two membership rules the client asked for on 16 Oct 2026, proven
 * against the live functions inside a transaction that is always rolled back.
 *
 *   Addition 3 — a record with an open case is in the module that shows open
 *                cases; with none, it is not; and nobody can set that by hand.
 *   Addition 2 — adding a record to / removing it from a module is governed
 *                by the Permissions spec's "Display / remove records from
 *                modules" setting (`action.modules`), and only in a module
 *                the person can open at all.
 *
 * ── WHY SQL-LEVEL, AS A MEMBER ───────────────────────────────────────────
 * `set_record_memberships` is the one writer every chip, Archive and bulk
 * action goes through, and `module_membership_allowed()` is what it asks.
 * Running them here as a real non-admin profile is the only way to exercise
 * the refusal path at all: an admin short-circuits both.
 *
 * Everything written here — the probe record, its case, the member's settings —
 * is created inside the transaction and discarded with it. The live data is
 * read, never changed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const DB_URL = process.env.SUPABASE_DB_URL;
const suite = DB_URL ? describe : describe.skip;

let db: pg.Client;

beforeAll(async () => {
  if (!DB_URL) return;
  db = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false }, statement_timeout: 120_000 });
  await db.connect();
});

afterAll(async () => {
  if (db) await db.end();
});

const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> =>
  (await db.query(sql, params)).rows[0] as T;

/** Run the rest of the transaction as this profile, through RLS and auth.uid(). */
const actAs = async (userId: string) => {
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })]);
  await db.query('set local role authenticated');
};
const actAsSuperuser = async () => {
  await db.query('reset role');
};

/**
 * A statement expected to be refused. In Postgres a failed statement aborts
 * the whole transaction, so the refusal is taken inside a savepoint and
 * rolled back to it — which also undoes `set local role`, hence the caller
 * re-asserting who it is afterwards.
 */
const expectRefusal = async (sql: string, params: unknown[], re: RegExp) => {
  await db.query('savepoint refusal');
  let message = '';
  try {
    await db.query(sql, params);
  } catch (e) {
    message = String((e as Error).message);
  }
  await db.query('rollback to savepoint refusal');
  expect(message, 'the statement was expected to be refused').toMatch(re);
};

suite('open cases place the record (Addition 3)', () => {
  it('a record is in the open-cases module exactly while it has an open case, and nobody can set that by hand', async () => {
    await db.query('BEGIN');
    try {
      const auto = await one<{ id: string; label: string }>(`select id, label from modules where shows_open_cases limit 1`);
      expect(auto, 'a module flagged shows_open_cases (Tickets) must exist').toBeTruthy();

      const admin = await one<{ id: string }>(
        `select p.id from profiles p join roles r on r.id = p.role_id where r.is_admin and p.deleted_at is null and p.status = 'active' order by p.email limit 1`);
      const other = await one<{ id: string }>(`select id from modules where kind = 'display' and not shows_open_cases order by position limit 1`);

      // A fresh probe record, placed in an ordinary module by its creator.
      const rec = await one<{ id: string }>(
        `insert into records (deal_name, creator_kind, creator_user_id, "values")
         values ('ZZ membership probe', 'user', $1, jsonb_build_object('team_members_assigned', jsonb_build_array($2::text)))
         returning id`, [admin.id, admin.id]);
      await actAs(admin.id);
      await db.query(`select set_record_memberships($1, $2::uuid[])`, [rec.id, [other.id]]);

      const inAuto = async () =>
        (await one<{ n: number }>(`select count(*)::int n from record_modules where record_id = $1 and module_id = $2`, [rec.id, auto.id])).n === 1;

      expect(await inAuto(), 'no case yet — not in the module').toBe(false);

      // Asking for it by hand is ignored, not obeyed.
      await db.query(`select set_record_memberships($1, $2::uuid[])`, [rec.id, [other.id, auto.id]]);
      expect(await inAuto(), 'a manual add to the open-cases module is ignored').toBe(false);

      // Opening a case places it.
      const c = await one<{ id: string }>(
        `insert into cases (record_id, title, issue, issue_author) values ($1, 'Probe', 'Probe issue', $2) returning id`, [rec.id, admin.id]);
      expect(await inAuto(), 'an open case puts the record in the module').toBe(true);

      // Archiving by hand leaves that membership in place.
      await db.query(`select set_record_memberships($1, '{}'::uuid[])`, [rec.id]);
      expect(await inAuto(), 'archive does not remove the automatic membership while a case is open').toBe(true);

      // Closing the last open case removes it.
      await db.query(`update cases set solution = 'done', solution_author = $2, solution_at = now(), state = 'closed' where id = $1`, [c.id, admin.id]);
      expect(await inAuto(), 'closing the last open case takes the record out').toBe(false);

      // Reopening puts it back; soft-deleting the case takes it out again.
      await db.query(`update cases set state = 'open' where id = $1`, [c.id]);
      expect(await inAuto()).toBe(true);
      await db.query(`update cases set deleted_at = now() where id = $1`, [c.id]);
      expect(await inAuto(), 'a deleted case is not an open case').toBe(false);

      const log = await one<{ n: number }>(
        `select count(*)::int n from record_activity where record_id = $1 and kind = 'membership' and summary like '%' || $2 || '%'`, [rec.id, auto.label]);
      expect(log.n, 'each automatic placement and removal is in the activity log').toBeGreaterThanOrEqual(4);
    } finally {
      await db.query('ROLLBACK');
    }
  }, 120_000);
});

suite('Display / remove from modules governs add / remove (Addition 2)', () => {
  it('needs the setting and a module the person can open — both ways', async () => {
    await db.query('BEGIN');
    try {
      const member = await one<{ id: string }>(
        `select p.id from profiles p join roles r on r.id = p.role_id where not r.is_admin and p.deleted_at is null and p.status = 'active' order by p.email limit 1`);
      expect(member, 'a non-admin profile is needed — an admin never reaches the refusal').toBeTruthy();

      const [a, b] = (await db.query(
        `select id, label from modules where kind = 'display' and not admin_only and not shows_open_cases order by position limit 2`)).rows as { id: string; label: string }[];
      expect(b, 'two ordinary display modules are needed').toBeTruthy();

      // The member's own settings, built from scratch for this test: both
      // modules at All records, and allowed to move records between them.
      const setting = async (key: string, value: string | null) => {
        await db.query(`delete from permission_settings where owner_kind = 'user' and owner_id = $1 and key = $2`, [member.id, key]);
        if (value !== null) {
          await db.query(`insert into permission_settings (owner_kind, owner_id, key, value) values ('user', $1, $2, $3)`, [member.id, key, value]);
        }
      };
      await setting(`module:${a.id}`, 'all');
      await setting(`module:${b.id}`, 'all');
      await setting('action.modules', 'yes');
      await setting('action.create', 'yes');

      const rec = await one<{ id: string }>(
        `insert into records (deal_name, creator_kind, creator_user_id, "values")
         values ('ZZ membership probe 2', 'user', $1, jsonb_build_object('team_members_assigned', jsonb_build_array($2::text)))
         returning id`, [member.id, member.id]);
      await actAs(member.id);
      await db.query(`select set_record_memberships($1, $2::uuid[])`, [rec.id, [a.id]]);

      const allowed = async (m: string) => (await one<{ ok: boolean }>(`select module_membership_allowed($1) ok`, [m])).ok;

      // Setting Yes, both modules open → both allowed.
      expect(await allowed(a.id)).toBe(true);
      expect(await allowed(b.id)).toBe(true);
      await db.query(`select set_record_memberships($1, $2::uuid[])`, [rec.id, [a.id, b.id]]);

      // Setting No → refused everywhere.
      await actAsSuperuser();
      await setting('action.modules', 'no');
      await actAs(member.id);
      expect(await allowed(a.id)).toBe(false);
      expect(await allowed(b.id)).toBe(false);
      await expectRefusal(`select set_record_memberships($1, $2::uuid[])`, [rec.id, [a.id]], /cannot add records to or remove them from/);

      // Setting Yes but module B Hidden → B refused, A still allowed.
      await actAsSuperuser();
      await setting('action.modules', 'yes');
      await setting(`module:${b.id}`, 'hidden');
      await actAs(member.id);
      expect(await allowed(b.id), 'a Hidden module → No even with the setting').toBe(false);
      expect(await allowed(a.id), 'A is untouched').toBe(true);

      // Only mine is still a module they can open.
      await actAsSuperuser();
      await setting(`module:${b.id}`, 'mine');
      await actAs(member.id);
      expect(await allowed(b.id), 'Only mine → allowed').toBe(true);

      // The settings table refuses a value the setting does not take.
      await actAsSuperuser();
      await expectRefusal(
        `insert into permission_settings (owner_kind, owner_id, key, value) values ('user', $1, 'action.modules', 'maybe')
         on conflict (owner_kind, owner_id, key) do update set value = excluded.value`,
        [member.id], /permission_settings|check|valid/i);
    } finally {
      await db.query('ROLLBACK');
    }
  }, 120_000);
});
