/**
 * The list search (`records_filterable.search_text`, migration 9797).
 *
 * The promise: a search matches the record's name and every string value the
 * viewer may see — including names inside repeating groups — and NOTHING the
 * viewer may not see. A member whose grant hides a field must get no hit on
 * that field's value, while an admin does. Rolled back; nothing is committed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { likePattern } from './search';

const DB_URL = process.env.SUPABASE_DB_URL;
const suite = DB_URL ? describe : describe.skip;

const SECRET = `ZZSEARCHSECRET${Date.now()}`;
const CONTACT = `Zelda Quintrell ${Date.now()}`;

let db: pg.Client;
let admin: string;
let member: string;
let rec: string;
let savepoint = 0;

async function as<T = Record<string, unknown>>(userId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const sp = `sp${(savepoint += 1)}`;
  await db.query(`savepoint ${sp}`);
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })]);
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
const owner = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => {
  await db.query('reset role');
  return (await db.query(sql, params)).rows as T[];
};
const hits = async (who: string, q: string) =>
  (await as<{ n: number }>(who, `select count(*)::int n from records_filterable where id = $1 and search_text ilike $2`, [rec, likePattern(q)]))[0].n;

suite('list search — records_filterable.search_text', () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false }, statement_timeout: 120_000 });
    await db.connect();
    await db.query('BEGIN');
    const people = await owner<{ id: string; email: string; is_admin: boolean }>(
      `select p.id, p.email::text, r.is_admin from profiles p join roles r on r.id = p.role_id where p.deleted_at is null and p.status = 'active'`,
    );
    admin = people.find((p) => p.email === 'admin@tapdash.test')!.id;
    // demo.rep if it exists, otherwise any active non-admin test account.
    member = (people.find((p) => p.email === 'demo.rep@tapdash.test') ??
      people.filter((p) => !p.is_admin && p.email.endsWith('@tapdash.test')).sort((x, y) => x.email.localeCompare(y.email))[0])!.id;
    const [leads] = await owner<{ id: string }>(`select id from modules where slug = 'leads'`);
    const [ein] = await owner<{ id: string; tab_id: string; subtab_id: string | null }>(`select id, tab_id, subtab_id from fields where key = 'ein'`);
    const [r] = await owner<{ id: string }>(
      `insert into records (deal_name, creator_kind, creator_user_id, "values")
       values ('ZZ search probe', 'user', $1, jsonb_build_object(
         'team_members_assigned', jsonb_build_array($2::text),
         'ein', $3::text,
         'legal_business_name', 'Quintrell Holdings',
         'contacts', jsonb_build_array(jsonb_build_object('name', $4::text, 'email', 'z@q.example'))
       )) returning id`,
      [admin, member, SECRET, CONTACT],
    );
    rec = r.id;
    await owner(`insert into record_modules (record_id, module_id, added_by) values ($1, $2, $3)`, [rec, leads.id, admin]);
    // The member may open Leads; the EIN (and its tab chain) is hidden for them.
    await owner(
      `insert into user_grants (user_id, scope_kind, scope_id, grant_level) values ($1, 'module', $2, 'edit')
       on conflict (user_id, scope_kind, scope_id, module_id) do update set grant_level = 'edit'`, [member, leads.id]);
    await owner(
      `insert into user_grants (user_id, scope_kind, scope_id, grant_level, module_id) values ($1, 'field', $2, 'hidden', $3)
       on conflict (user_id, scope_kind, scope_id, module_id) do update set grant_level = 'hidden'`, [member, ein.id, leads.id]);
  });
  afterAll(async () => {
    if (!db) return;
    await db.query('ROLLBACK');
    await db.end();
  });

  it('matches the name, a company field and a contact inside a repeating group, case-insensitively', async () => {
    expect(await hits(admin, 'search probe')).toBe(1);
    expect(await hits(admin, 'quintrell holdings')).toBe(1);
    expect(await hits(admin, CONTACT.toUpperCase())).toBe(1);
    expect(await hits(admin, 'z@q.example')).toBe(1);
    expect(await hits(member, CONTACT)).toBe(1);
  });

  it('never matches a JSON key', async () => {
    expect(await hits(admin, 'legal_business_name')).toBe(0);
    expect(await hits(admin, 'team_members_assigned')).toBe(0);
  });

  it('a hidden field cannot be found by its value', async () => {
    expect(await hits(admin, SECRET)).toBe(1);
    expect(await hits(member, SECRET)).toBe(0);
  });

  it('a record the person cannot see is not searchable at all', async () => {
    await owner(`update records set "values" = "values" || '{"team_members_assigned": []}'::jsonb where id = $1`, [rec]);
    expect(await hits(member, 'search probe')).toBe(0);
    await owner(`update records set "values" = "values" || jsonb_build_object('team_members_assigned', jsonb_build_array($2::text)) where id = $1`, [rec, member]);
    expect(await hits(member, 'search probe')).toBe(1);
  });

  it('LIKE metacharacters in the search are literal', async () => {
    expect(likePattern('100%')).toBe('%100\\%%');
    expect(await hits(admin, '%')).toBe(0);
    expect(await hits(admin, '_')).toBe(0);
    expect(await hits(admin, 'z@q.example')).toBe(1);
  });
});
