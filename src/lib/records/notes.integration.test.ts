/**
 * Notes as a real signed-in member, at every scope the drawer writes: a field's
 * key, a tab, and `tabId/subtabId`. Rolled back. Nothing covered these until a
 * member could not save a field note and no error said why.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const DB_URL = process.env.SUPABASE_DB_URL;
const suite = DB_URL ? describe : describe.skip;
let db: pg.Client;

const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows as T[];
const one = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await q<T>(sql, p))[0]!;

suite('Notes', () => {
  let member: string;
  let rec: string;
  let tab: string;
  let subtabScope: string;

  const as = async <T>(user: string, fn: () => Promise<T>): Promise<T> => {
    await q(`select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`, [JSON.stringify({ sub: user, role: 'authenticated' })]);
    const out = await fn();
    await q(`select set_config('request.jwt.claims', '', true), set_config('role', 'none', true)`);
    return out;
  };
  const add = (kind: string, scope: string) =>
    as(member, async () => {
      const { id } = await one<{ id: string }>(`insert into notes (record_id, scope_kind, scope_id, author_id, body) values ($1, $2, $3, $4, 'x') returning id`, [rec, kind, scope, member]);
      return (await q(`select 1 from notes where id = $1`, [id])).length;
    });

  beforeAll(async () => {
    db = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
    await db.connect();
    await q('begin');
    const admin = await one<{ id: string }>(`select id from roles where not is_admin order by name limit 1`);
    const tpl = await one<{ id: string }>(`select id from permission_templates where user_type = 'customer_service'`);
    const contacts = await one<{ id: string }>(`select id from modules where slug = 'contacts'`);
    member = randomUUID();
    const email = `zz-${member.slice(0, 8)}@tapdash.test`;
    await q(`insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')`, [member, email]);
    await q(`insert into profiles (id, email, full_name, role_id, status) values ($1, $2, 'Zz Notes', $3, 'active') on conflict (id) do update set role_id = excluded.role_id, status = 'active'`, [member, email, admin.id]);
    await q(`insert into user_templates (user_id, template_id) values ($1, $2) on conflict (user_id) do update set template_id = excluded.template_id`, [member, tpl.id]);
    await q(`insert into permission_settings (owner_kind, owner_id, key, value) values ('user', $1, $2, 'all') on conflict (owner_kind, owner_id, key) do update set value = 'all'`, [member, `module:${contacts.id}`]);
    await q(`insert into permission_settings (owner_kind, owner_id, key, value) values ('user', $1, 'items.notes', 'all') on conflict (owner_kind, owner_id, key) do update set value = 'all'`, [member]);
    rec = (await one<{ id: string }>(`insert into records (deal_name, creator_user_id, values) values ('ZZ notes', $1, '{}') returning id`, [member])).id;
    await q(`insert into record_modules (record_id, module_id) values ($1, $2)`, [rec, contacts.id]);
    tab = (await one<{ id: string }>(`select id from tabs where key = 'overview'`)).id;
    const sub = await one<{ tab: string; sub: string }>(`select t.id tab, s.id sub from tabs t join subtabs s on s.tab_id = t.id where t.key = 'pricing' limit 1`);
    subtabScope = `${sub.tab}/${sub.sub}`;
  }, 60_000);

  afterAll(async () => {
    await q('rollback');
    await db.end();
  });

  it('a field note, scoped by the field key the drawer sends', async () => {
    expect(await add('field', 'mid')).toBe(1);
  });

  it('a tab note', async () => {
    expect(await add('tab', tab)).toBe(1);
  });

  it('a note on a sub-tab', async () => {
    expect(await add('tab', subtabScope)).toBe(1);
  });

  it('a field on a hidden tab still refuses a note', async () => {
    const pricing = await one<{ id: string }>(`select id from tabs where key = 'pricing'`);
    await q(`insert into user_grants (user_id, scope_kind, scope_id, grant_level) values ($1, 'tab', $2, 'hidden')`, [member, pricing.id]);
    await q('savepoint s');
    await expect(add('tab', subtabScope)).rejects.toThrow(/row-level security/);
    await q('rollback to savepoint s');
    await q(`select set_config('request.jwt.claims', '', true), set_config('role', 'none', true)`);
    await q(`delete from user_grants where user_id = $1`, [member]);
  });

  it('activity on a hidden field can\'t be read directly', async () => {
    const f = await one<{ id: string }>(`select id from fields where key = 'mid'`);
    await q(`insert into record_activity (record_id, actor_id, kind, field_key, summary, to_value) values ($1, $2, 'field', 'mid', 'x', 'secret')`, [rec, member]);
    expect(await as(member, () => q(`select 1 from record_activity where record_id = $1 and field_key = 'mid'`, [rec]))).toHaveLength(1);
    await q(`insert into user_grants (user_id, scope_kind, scope_id, grant_level) values ($1, 'field', $2, 'hidden')`, [member, f.id]);
    expect(await as(member, () => q(`select 1 from record_activity where record_id = $1 and field_key = 'mid'`, [rec]))).toHaveLength(0);
  });
});
