/**
 * Add only, as a real signed-in member against the real policies. Rolled back.
 *
 * The rule under test: the level opens the tab and lets someone add, and every
 * read underneath still refuses them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const DB_URL = process.env.SUPABASE_DB_URL;
const suite = DB_URL ? describe : describe.skip;
let db: pg.Client;

const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows as T[];
const one = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await q<T>(sql, p))[0]!;
const ROWS = ['Owner ID', 'Bank statements', 'Processing statements', 'Corp docs', 'Voided check'];
const POSITIONS = [0, 10, 20, 30, 40];

suite('Add only', () => {
  let member: string;
  let rec: string;
  let logins: string;
  let files: string;

  const as = async <T>(user: string, fn: () => Promise<T>): Promise<T> => {
    await q(`select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`, [JSON.stringify({ sub: user, role: 'authenticated' })]);
    const out = await fn();
    await q(`select set_config('request.jwt.claims', '', true), set_config('role', 'none', true)`);
    return out;
  };
  const refused = async (fn: () => Promise<unknown>, pattern: RegExp) => {
    await q('savepoint s');
    await expect(fn()).rejects.toThrow(pattern);
    await q('rollback to savepoint s');
    await q(`select set_config('request.jwt.claims', '', true), set_config('role', 'none', true)`);
  };
  const setGrant = async (tab: string, level: string) => {
    await q(`delete from user_grants where user_id = $1 and scope_id = $2`, [member, tab]);
    await q(`insert into user_grants (user_id, scope_kind, scope_id, grant_level) values ($1, 'tab', $2, $3)`, [member, tab, level]);
  };
  const addLogin = (type: string) =>
    q(`select add_login($1, $2, 'https://x.test', 'u', null, 'pw', 'k')`, [rec, type]);
  const rowsForAdding = () =>
    q<{ row_id: string; row_name: string; has_file: boolean }>(`select * from file_rows_for_adding($1, $2, $3)`, [rec, ROWS, POSITIONS]);

  beforeAll(async () => {
    db = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
    await db.connect();
    await q('begin');
    const role = await one<{ id: string }>(`select id from roles where not is_admin order by name limit 1`);
    const tpl = await one<{ id: string }>(`select id from permission_templates where user_type = 'sales_agent'`);
    const contacts = await one<{ id: string }>(`select id from modules where slug = 'contacts'`);
    member = randomUUID();
    const email = `zz-${member.slice(0, 8)}@tapdash.test`;
    await q(`insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')`, [member, email]);
    await q(`insert into profiles (id, email, full_name, role_id, status) values ($1, $2, 'Zz Add', $3, 'active') on conflict (id) do update set role_id = excluded.role_id, status = 'active'`, [member, email, role.id]);
    await q(`insert into user_templates (user_id, template_id) values ($1, $2) on conflict (user_id) do update set template_id = excluded.template_id`, [member, tpl.id]);
    await q(`insert into permission_settings (owner_kind, owner_id, key, value) values ('user', $1, $2, 'all') on conflict (owner_kind, owner_id, key) do update set value = 'all'`, [member, `module:${contacts.id}`]);
    await q(`insert into permission_settings (owner_kind, owner_id, key, value) values ('user', $1, 'items.updates', 'all') on conflict (owner_kind, owner_id, key) do update set value = 'all'`, [member]);
    rec = (await one<{ id: string }>(`insert into records (deal_name, creator_user_id, values) values ('ZZ add only', $1, '{}') returning id`, [member])).id;
    await q(`insert into record_modules (record_id, module_id) values ($1, $2)`, [rec, contacts.id]);
    logins = (await one<{ id: string }>(`select id from tabs where key = 'logins'`)).id;
    files = (await one<{ id: string }>(`select id from tabs where key = 'files'`)).id;
    await setGrant(logins, 'add_only');
    await setGrant(files, 'add_only');
  }, 60_000);

  afterAll(async () => {
    await q('rollback');
    await db.end();
  });

  it('defaults: Sales and Reconcilers on Add only for Logins, everyone else Edit, all Edit on Files', async () => {
    const rows = await q<{ user_type: string; key: string; grant_level: string }>(
      `select pt.user_type, t.key, g.grant_level from template_grants g
         join permission_templates pt on pt.id = g.template_id
         join tabs t on t.id = g.scope_id
        where g.scope_kind = 'tab' and t.key in ('logins', 'files') and pt.user_type is not null`,
    );
    for (const r of rows) {
      const addOnly = r.key === 'logins' && ['sales_agent', 'accounting'].includes(r.user_type);
      expect([r.user_type, r.key, r.grant_level]).toEqual([r.user_type, r.key, addOnly ? 'add_only' : 'edit']);
    }
    expect(rows).toHaveLength(10);
  });

  it('ranks between Hidden and View, and the guardrail agrees', async () => {
    const o = await one<{ a: boolean; b: boolean; h: number; ao: number; v: number; e: number }>(`
      select 'hidden'::permission_level < 'add_only' a, 'add_only'::permission_level < 'view' b,
             permission_value_rank('hidden') h, permission_value_rank('add_only') ao,
             permission_value_rank('view') v, permission_value_rank('edit') e`);
    expect([o.a, o.b]).toEqual([true, true]);
    expect(o.h).toBeLessThan(o.ao);
    expect(o.ao).toBeLessThan(o.v);
    expect(o.v).toBeLessThan(o.e);
  });

  it('only Logins and Files take it, and only at the tab', async () => {
    const statements = await one<{ id: string }>(`select id from tabs where key = 'statements'`);
    await refused(() => setGrant(statements.id, 'add_only'), /Add only is for the Logins and Files tabs/);
    const sub = await one<{ id: string }>(`select s.id from subtabs s join tabs t on t.id = s.tab_id where t.key = 'files' limit 1`);
    await refused(
      () => q(`insert into user_grants (user_id, scope_kind, scope_id, grant_level) values ($1, 'subtab', $2, 'add_only')`, [member, sub.id]),
      /Add only is for the Logins and Files tabs/,
    );
    const field = await one<{ id: string }>(`select id from fields where key = 'mid'`);
    await refused(
      () => q(`insert into user_grants (user_id, scope_kind, scope_id, grant_level) values ($1, 'field', $2, 'add_only')`, [member, field.id]),
      /Add only is a tab level/,
    );
  });

  it('a login can be added and then cannot be seen, listed, revealed, changed or deleted', async () => {
    await as(member, () => addLogin('Gateway'));
    const { id } = await one<{ id: string }>(`select id from logins where record_id = $1`, [rec]);
    expect(await as(member, () => q(`select id from logins where record_id = $1`, [rec]))).toHaveLength(0);
    await refused(() => as(member, () => q(`select reveal_password($1, 'k')`, [id])), /do not have access/);
    await as(member, async () => {
      expect((await db.query(`update logins set username = 'x' where id = $1`, [id])).rowCount).toBe(0);
      expect((await db.query(`delete from logins where id = $1`, [id])).rowCount).toBe(0);
    });
    await refused(() => as(member, () => q(`select store_login_password($1, 'x', 'k')`, [id])), /tab/);
  });

  it('the password is stored, whoever adds it', async () => {
    const row = await one<{ s: boolean; p: string }>(`select password_enc is not null s, position p from logins where record_id = $1`, [rec]);
    expect(row.s).toBe(true);
    await as(member, () => addLogin('Portal'));
    const positions = await q<{ position: number }>(`select position from logins where record_id = $1 order by position`, [rec]);
    expect(positions.map((p) => p.position)).toEqual([0, 1]);
  });

  it('the Files tab gives row names and a check, and no file data', async () => {
    const rows = await as(member, rowsForAdding);
    expect(rows.map((r) => r.row_name)).toEqual(ROWS);
    expect(rows.every((r) => !r.has_file)).toBe(true);
    expect(Object.keys(rows[0]!).sort()).toEqual(['has_file', 'row_id', 'row_kind', 'row_name']);
    expect(await as(member, () => q(`select id from file_rows where record_id = $1`, [rec]))).toHaveLength(0);
  });

  it('a file can be added, then the row shows the check and nothing else', async () => {
    const owner = (await as(member, rowsForAdding)).find((r) => r.row_name === 'Owner ID')!;
    await as(member, () => q(`select record_file_upload($1, 'zz/path', 'secret-name.pdf', 10)`, [owner.row_id]));
    expect((await as(member, rowsForAdding)).find((r) => r.row_name === 'Owner ID')!.has_file).toBe(true);
    expect(await as(member, () => q(`select id from files where file_row_id = $1`, [owner.row_id]))).toHaveLength(0);
    const { id } = await one<{ id: string }>(`select id from files where file_row_id = $1`, [owner.row_id]);
    await refused(() => as(member, () => q(`select delete_file($1)`, [id])), /edit access/);
    await as(member, async () => {
      expect((await db.query(`update files set name = 'x' where id = $1`, [id])).rowCount).toBe(0);
    });
  });

  it('a new row keeps its name and takes files, and shows no check on a user row', async () => {
    await as(member, () => q(`select add_file_row($1, 'Extra docs')`, [rec]));
    let extra = (await as(member, rowsForAdding)).find((r) => r.row_name === 'Extra docs')!;
    expect(extra.has_file).toBe(false);
    await as(member, () => q(`select record_file_upload($1, 'zz/path2', 'b.pdf', 10)`, [extra.row_id]));
    extra = (await as(member, rowsForAdding)).find((r) => r.row_name === 'Extra docs')!;
    expect(extra.has_file).toBe(false);
    expect((await as(member, rowsForAdding)).at(-1)!.row_name).toBe('Extra docs');
  });

  it('Updates shows the entry, without the login details or the file name', async () => {
    const bodies = await as(member, async () => {
      const u = await q<{ id: string; body: string }>(`select id, body from updates where record_id = $1`, [rec]);
      const d = await q<{ body: string }>(`select body from update_details where record_id = $1`, [rec]);
      return { u, d };
    });
    const all = JSON.stringify(bodies);
    expect(bodies.u.map((u) => u.body).sort()).toEqual(['Added a file row.', 'Added a login.', 'Added a login.', 'Uploaded a file.', 'Uploaded a file.'].sort());
    expect(all).not.toContain('secret-name');
    expect(all).not.toContain('Gateway');
    // The row name isn't secret here: they can see it.
    expect(bodies.d.map((d) => d.body)).toEqual(['Added file row Extra docs.']);
  });

  it('someone with View reads the details', async () => {
    await setGrant(logins, 'view');
    await setGrant(files, 'view');
    const d = await as(member, () => q<{ body: string }>(`select body from update_details where record_id = $1`, [rec]));
    const text = d.map((x) => x.body).join(' | ');
    expect(text).toContain('Added a login: Gateway.');
    expect(text).toContain('Uploaded secret-name.pdf to Owner ID.');
    await setGrant(logins, 'add_only');
    await setGrant(files, 'add_only');
  });

  it('activity on these tabs is not readable by someone on Add only', async () => {
    const rows = await as(member, () => q(`select summary from record_activity where record_id = $1 and kind in ('file', 'credential')`, [rec]));
    expect(rows.map((r) => r.summary)).toEqual(['Added file row Extra docs.']);
  });

  it('a log entry can be neither edited nor deleted, even by its author', async () => {
    const { id } = await one<{ id: string }>(`select id from updates where record_id = $1 and is_log limit 1`, [rec]);
    await refused(() => as(member, () => q(`select edit_update_with_mentions($1, 'x', '{}')`, [id])), /cannot be edited/);
    await refused(() => as(member, () => q(`select delete_update($1)`, [id])), /cannot be deleted/);
  });

  it('Hidden still means no adding', async () => {
    await setGrant(logins, 'hidden');
    await setGrant(files, 'hidden');
    await refused(() => as(member, () => addLogin('X')), /do not have access/);
    await refused(() => as(member, rowsForAdding), /do not have access/);
    await refused(() => as(member, () => q(`select add_file_row($1, 'Y')`, [rec])), /do not have access/);
    await setGrant(logins, 'add_only');
    await setGrant(files, 'add_only');
  });

  it('the tab opens, and every read gate treats it as not visible', async () => {
    const o = await as(member, () => one<{ g: string; v: boolean }>(`select record_tab_grant($1, 'logins') g, tab_visible($1, 'logins') v`, [rec]));
    expect(o).toEqual({ g: 'add_only', v: false });
    expect(await as(member, () => q(`select id from notes where record_id = $1`, [rec]))).toHaveLength(0);
  });
});
