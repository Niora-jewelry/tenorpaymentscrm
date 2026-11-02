/**
 * Files Required, end to end in the database, as real signed-in members. Each
 * row of the spec's "When files arrive" table has a test. Rolled back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { readFileSync } from 'node:fs';

const DB_URL = process.env.SUPABASE_DB_URL;
const suite = DB_URL ? describe : describe.skip;
let db: pg.Client;

const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows as T[];
const one = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await q<T>(sql, p))[0]!;
const ROWS = ['Owner ID', 'Bank statements', 'Processing statements', 'Corp docs', 'Voided check'];

type Item = { id: string; name: string; have: number; need: number };

suite('Files Required', () => {
  let member: string;
  let reconciler: string;
  let rec: string;
  let contacts: string;
  let bank: string;
  let voided: string;
  let filesTab: string;
  let n = 0;

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
  const mark = (row: string, required: boolean, needed: number) =>
    as(member, () => q(`select set_file_row_required($1, $2, $3)`, [row, required, needed]));
  const upload = async (row: string, name = `f${++n}.pdf`) => {
    const { id } = await as(member, () => one<{ id: string }>(`select record_file_upload($1, $2, $3, 10) id`, [row, `zz/${randomUUID()}`, name]));
    return id;
  };
  const chips = async () => (await one<{ c: Item[] }>(`select files_required c from records where id = $1`, [rec])).c;
  const text = async () => (await chips()).map((c) => `${c.name} (${c.have} of ${c.need})`);
  const received = async (row: string) => (await one<{ r: boolean }>(`select received r from file_rows where id = $1`, [row])).r;
  const logged = async () => (await q<{ body: string }>(`select body from update_details where record_id = $1 order by id`, [rec])).map((d) => d.body);
  const newRec = async (name: string) => {
    const r = await one<{ id: string }>(`insert into records (deal_name, creator_user_id, values) values ($1, $2, '{}') returning id`, [name, member]);
    await q(`insert into record_modules (record_id, module_id) values ($1, $2)`, [r.id, contacts]);
    await q(`select ensure_application_file_rows($1, $2, $3)`, [r.id, ROWS, [0, 10, 20, 30, 40]]);
    return r.id;
  };
  const makeUser = async (type: string) => {
    const id = randomUUID();
    const role = await one<{ id: string }>(`select id from roles where not is_admin order by name limit 1`);
    const tpl = await one<{ id: string }>(`select id from permission_templates where user_type = $1`, [type]);
    const email = `zz-${id.slice(0, 8)}@tapdash.test`;
    await q(`insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')`, [id, email]);
    await q(`insert into profiles (id, email, full_name, role_id, status) values ($1, $2, 'Zz', $3, 'active') on conflict (id) do update set role_id = excluded.role_id, status = 'active'`, [id, email, role.id]);
    await q(`insert into user_templates (user_id, template_id) values ($1, $2) on conflict (user_id) do update set template_id = excluded.template_id`, [id, tpl.id]);
    await q(`insert into permission_settings (owner_kind, owner_id, key, value) values ('user', $1, $2, 'all') on conflict (owner_kind, owner_id, key) do update set value = 'all'`, [id, `module:${contacts}`]);
    return id;
  };
  const setFiles = async (user: string, level: string) => {
    await q(`delete from user_grants where user_id = $1 and scope_id = $2`, [user, filesTab]);
    await q(`insert into user_grants (user_id, scope_kind, scope_id, grant_level) values ($1, 'tab', $2, $3)`, [user, filesTab, level]);
  };

  beforeAll(async () => {
    db = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
    await db.connect();
    await q('begin');
    contacts = (await one<{ id: string }>(`select id from modules where slug = 'contacts'`)).id;
    // The Add only spec's defaults (Files = Edit for everyone), applied at deploy.
    await q(readFileSync('supabase/migrations/20260819009890_add_only_defaults.sql', 'utf8'));
    filesTab = (await one<{ id: string }>(`select id from tabs where key = 'files'`)).id;
    member = await makeUser('sales_agent');
    reconciler = await makeUser('accounting');
    rec = await newRec('ZZ required');
    bank = (await one<{ id: string }>(`select id from file_rows where record_id = $1 and name = 'Bank statements'`, [rec])).id;
    voided = (await one<{ id: string }>(`select id from file_rows where record_id = $1 and name = 'Voided check'`, [rec])).id;
  }, 60_000);

  afterAll(async () => {
    await q('rollback');
    await db.end();
  });

  it('no row is required by default', async () => {
    expect((await q(`select 1 from file_rows where record_id = $1 and required`, [rec]))).toHaveLength(0);
    expect(await chips()).toEqual([]);
  });

  it('Mark files required: Yes for all but Reconcilers', async () => {
    const rows = await q<{ user_type: string; value: string }>(`
      select pt.user_type, s.value from permission_settings s join permission_templates pt on pt.id = s.owner_id
       where s.owner_kind = 'template' and s.key = 'action.mark_files_required' and pt.user_type is not null`);
    expect(rows).toHaveLength(6);
    for (const r of rows) expect([r.user_type, r.value]).toEqual([r.user_type, r.user_type === 'accounting' ? 'no' : 'yes']);
  });

  it('required with too few files: named, with the count', async () => {
    await mark(bank, true, 3);
    await upload(bank);
    expect(await text()).toEqual(['Bank statements (1 of 3)']);
    await upload(bank);
    expect(await text()).toEqual(['Bank statements (2 of 3)']);
  });

  it('the row reaching its number: Received, and the chip goes', async () => {
    await upload(bank);
    expect(await text()).toEqual([]);
    expect(await received(bank)).toBe(true);
  });

  it('a file deleted below the number: tag off, chip back; restored, the reverse', async () => {
    const { id } = await one<{ id: string }>(`select id from files where file_row_id = $1 and deleted_at is null limit 1`, [bank]);
    await as(member, () => q(`select delete_file($1)`, [id]));
    expect(await text()).toEqual(['Bank statements (2 of 3)']);
    expect(await received(bank)).toBe(false);
    await q(`update files set deleted_at = null where id = $1`, [id]);
    expect(await text()).toEqual([]);
    expect(await received(bank)).toBe(true);
  });

  it('a file replaced: nothing changes', async () => {
    const before = (await one<{ c: number }>(`select count(*)::int c from files where file_row_id = $1 and deleted_at is null`, [bank])).c;
    const { id, name } = await one<{ id: string; name: string }>(`select id, name from files where file_row_id = $1 and deleted_at is null limit 1`, [bank]);
    await as(member, () => q(`select replace_file($1, $2, 'new.pdf', 11)`, [id, `zz/${randomUUID()}`]));
    expect((await one<{ c: number }>(`select count(*)::int c from files where file_row_id = $1 and deleted_at is null`, [bank])).c).toBe(before);
    expect(await text()).toEqual([]);
    expect(await received(bank)).toBe(true);
    const f = await one<{ version: number; name: string }>(`select version, name from files where id = $1`, [id]);
    expect(f).toEqual({ version: 2, name: 'new.pdf' });
    const v = await as(member, () => q<{ name: string; version: number }>(`select name, version from file_versions where file_id = $1`, [id]));
    expect(v).toEqual([{ name, version: 1 }]);
  });

  it('files needed raised: tag off, chip back; lowered: the reverse', async () => {
    await mark(bank, true, 5);
    expect(await text()).toEqual(['Bank statements (3 of 5)']);
    expect(await received(bank)).toBe(false);
    await mark(bank, true, 2);
    expect(await text()).toEqual([]);
    expect(await received(bank)).toBe(true);
  });

  it('unticked: tag and chip cleared; ticked again: tag at once if there are enough', async () => {
    await mark(bank, false, 2);
    expect(await received(bank)).toBe(false);
    await mark(voided, true, 1);
    expect(await text()).toEqual(['Voided check (0 of 1)']);
    await mark(bank, true, 2);
    expect(await received(bank)).toBe(true);
    expect(await text()).toEqual(['Voided check (0 of 1)']);
  });

  it('a file moved: both rows update, and it keeps what it had', async () => {
    const f = await one<{ id: string; name: string; uploaded_by: string; uploaded_at: Date; version: number }>(
      `select id, name, uploaded_by, uploaded_at, version from files where file_row_id = $1 and deleted_at is null order by version desc limit 1`, [bank]);
    await as(member, () => q(`select move_file($1, $2)`, [f.id, voided]));
    expect(await received(voided)).toBe(true);
    expect(await text()).toEqual([]);
    const after = await one<typeof f>(`select id, name, uploaded_by, uploaded_at, version from files where id = $1`, [f.id]);
    expect(after).toEqual(f);
    await mark(bank, true, 3);
    expect(await text()).toEqual(['Bank statements (2 of 3)']);
    await as(member, () => q(`select move_file($1, $2)`, [f.id, bank]));
    expect(await text()).toEqual(['Voided check (0 of 1)']);
  });

  it('a full row refuses a move, with the spec\'s words, and a direct write can\'t get around it', async () => {
    const other = await one<{ id: string }>(`select id from file_rows where record_id = $1 and name = 'Corp docs'`, [rec]);
    for (let i = 0; i < 5; i++) await upload(other.id);
    const f = await one<{ id: string }>(`select id from files where file_row_id = $1 and deleted_at is null limit 1`, [bank]);
    await refused(() => as(member, () => q(`select move_file($1, $2)`, [f.id, other.id])), /That row already has 5 files\./);
    await refused(() => q(`update files set file_row_id = $2 where id = $1`, [f.id, other.id]), /at most 5 files/);
  });

  it('who may mark: the permission, not Edit, and only on rows they can see', async () => {
    await refused(() => as(reconciler, () => q(`select set_file_row_required($1, true, 2)`, [bank])), /do not have access to mark/);
    await setFiles(member, 'view');
    await mark(bank, true, 4);
    expect(await text()).toContain('Bank statements (3 of 4)');
    await setFiles(member, 'hidden');
    await refused(() => mark(bank, true, 1), /not found/);
    await setFiles(member, 'add_only');
    await refused(() => mark(bank, true, 1), /not found/);
    await setFiles(member, 'edit');
  });

  it('the number is 1 to 5, in the function and in the table', async () => {
    await refused(() => mark(bank, true, 6), /from 1 to 5/);
    await refused(() => mark(bank, true, 0), /from 1 to 5/);
    await refused(() => q(`update file_rows set files_needed = 9 where id = $1`, [bank]), /files_needed_range/);
  });

  it('Required can\'t be set around the function, on an update or an insert', async () => {
    await refused(() => as(member, () => q(`update file_rows set required = true where id = $1`, [voided])), /permission denied/);
    await refused(
      () => as(member, () => q(`insert into file_rows (record_id, kind, name, required) values ($1, 'application', 'X', true)`, [rec])),
      /permission denied/,
    );
    await refused(() => as(member, () => q(`update files set file_row_id = $1 where file_row_id = $2`, [voided, bank])), /permission denied/);
  });

  it('moving needs Edit: View and Add only can\'t', async () => {
    const f = await one<{ id: string }>(`select id from files where file_row_id = $1 and deleted_at is null limit 1`, [bank]);
    await setFiles(member, 'view');
    await refused(() => as(member, () => q(`select move_file($1, $2)`, [f.id, voided])), /edit access/);
    await setFiles(member, 'add_only');
    await refused(() => as(member, () => q(`select move_file($1, $2)`, [f.id, voided])), /edit access/);
    await setFiles(member, 'edit');
  });

  it('the column shows whatever the Files tab says, on the list view', async () => {
    const read = () => as(member, () => one<{ n: number; c: Item[] }>(`select files_required_count n, files_required c from records_filterable where id = $1`, [rec]));
    const open = await read();
    expect(open.n).toBeGreaterThan(0);
    await setFiles(member, 'hidden');
    expect(await read()).toEqual(open);
    await setFiles(member, 'add_only');
    expect(await read()).toEqual(open);
    await setFiles(member, 'edit');
  });

  it('filter and sort work on what the list reads', async () => {
    const empty = await newRec('ZZ required empty');
    const rows = await as(member, () => q<{ id: string }>(`
      select id from records_filterable where id = any($1) and files_required_count > 0`, [[rec, empty]]));
    expect(rows.map((r) => r.id)).toEqual([rec]);
    const byName = await as(member, () => q<{ id: string }>(`
      select id from records_filterable where id = any($1) and files_required_names && $2`, [[rec, empty], ['Bank statements']]));
    expect(byName.map((r) => r.id)).toEqual([rec]);
  });

  it('a row someone added: renamed, the new name shows; deleted, it drops off; restored, it comes back', async () => {
    await as(member, () => q(`select add_file_row($1, 'Lease')`, [rec]));
    const row = await one<{ id: string }>(`select id from file_rows where record_id = $1 and name = 'Lease'`, [rec]);
    await mark(row.id, true, 2);
    expect(await text()).toContain('Lease (0 of 2)');
    await as(member, () => q(`select rename_file_row($1, 'Lease 2026')`, [row.id]));
    expect(await text()).toContain('Lease 2026 (0 of 2)');
    await as(member, () => q(`select delete_file_row($1)`, [row.id]));
    expect((await text()).join()).not.toContain('Lease');
    const admin = await one<{ id: string }>(`select id from profiles where email = 'admin@tapdash.test'`);
    await as(admin.id, () => q(`select restore_file_row($1)`, [row.id]));
    expect(await text()).toContain('Lease 2026 (0 of 2)');
    expect((await one<{ r: boolean; n: number }>(`select required r, files_needed n from file_rows where id = $1`, [row.id]))).toEqual({ r: true, n: 2 });
  });

  it('a preset row can be neither renamed nor deleted', async () => {
    await refused(() => as(member, () => q(`select rename_file_row($1, 'X')`, [bank])), /preset rows/);
    await refused(() => as(member, () => q(`select delete_file_row($1)`, [bank])), /preset rows/);
  });

  it('every mark, unmark, number change, completion, reopening and move is logged', async () => {
    const log = await logged();
    for (const text of [
      'Marked Bank statements required (3 files).',
      'Changed files needed on Bank statements from 3 to 5.',
      'Unmarked Bank statements.',
      'Bank statements received (3 of 3).',
      'Bank statements is missing files again (2 of 3).',
      'Renamed file row Lease to Lease 2026.',
      'Deleted file row Lease 2026.',
      'Restored file row Lease 2026.',
    ]) expect(log, text).toContain(text);
    expect(log.some((l) => /^Moved f?.* from Bank statements to Voided check\.$/.test(l) || /from Bank statements to Voided check/.test(l))).toBe(true);
  });

  it('someone who can\'t see the row sees the entry without its name', async () => {
    await setFiles(member, 'hidden');
    const seen = await as(member, async () => ({
      updates: await q<{ body: string }>(`select body from updates where record_id = $1 and is_log`, [rec]),
      details: await q<{ body: string }>(`select body from update_details where record_id = $1`, [rec]),
    }));
    expect(seen.updates.map((u) => u.body)).toContain('A file row was marked required.');
    expect(JSON.stringify(seen)).not.toMatch(/Bank statements|Voided check/);
    await setFiles(member, 'edit');
  });

  it('a move reads for each viewer with only the rows they can see', async () => {
    const d = await q<{ rank: number; body: string }>(`select rank, body from update_details where record_id = $1 and body like 'Moved%from%to%' limit 1`, [rec]);
    const same = await q<{ rank: number; body: string }>(
      `select rank, body from update_details where update_id = (select update_id from update_details where record_id = $1 and body = $2 limit 1) order by rank`,
      [rec, d[0]!.body],
    );
    expect(same.map((x) => x.rank)).toEqual([1, 2, 3]);
    expect(same[0]!.body).toMatch(/^Moved .* to /);
    expect(same[1]!.body).toMatch(/^Moved .* out of /);
  });

  it('the automation action and conditions', async () => {
    const r = await newRec('ZZ required auto');
    const run = { automation_id: null, automation_name: 'ZZ Auto', record_id: r };
    const act = (rows: unknown) => one<{ o: { outcome: string; detail: string } }>(
      `select automation_act(jsonb_populate_record(null::automation_runs, $1::jsonb), $2::jsonb) o`,
      [JSON.stringify(run), JSON.stringify({ type: 'mark_file_required', rows })],
    );
    const cond = async (c: unknown) => (await one<{ v: boolean }>(`select automation_condition($1::jsonb, $2, null) v`, [JSON.stringify(c), r])).v;

    expect(await cond({ type: 'files_required_empty' })).toBe(true);
    expect((await act([{ name: 'Owner ID', needed: 1 }, { name: 'Bank statements', needed: 3 }])).o.outcome).toBe('done');
    const items = (await one<{ c: Item[] }>(`select files_required c from records where id = $1`, [r])).c;
    expect(items.map((i) => `${i.name} ${i.need}`)).toEqual(['Owner ID 1', 'Bank statements 3']);
    expect(await cond({ type: 'files_required_empty' })).toBe(false);
    expect(await cond({ type: 'files_required_filled', fileRow: '' })).toBe(true);
    expect(await cond({ type: 'files_required_filled', fileRow: 'Owner ID' })).toBe(true);
    expect(await cond({ type: 'files_required_filled', fileRow: 'Corp docs' })).toBe(false);

    // Already required: the number updates, and it isn't skipped.
    const again = await act([{ name: 'Bank statements', needed: 2 }]);
    expect(again.o.outcome).toBe('done');
    expect((await one<{ n: number }>(`select files_needed n from file_rows where record_id = $1 and name = 'Bank statements'`, [r])).n).toBe(2);

    const entry = await one<{ automation_name: string; author_id: string | null }>(
      `select automation_name, author_id from updates where record_id = $1 and is_log order by created_at desc limit 1`, [r]);
    expect(entry).toEqual({ automation_name: 'ZZ Auto', author_id: null });

    expect((await act([{ name: 'Not a preset', needed: 1 }])).o.outcome).toBe('skipped');
  });

  it('a change an automation makes starts no other automation', async () => {
    const triggers = await q(`select tgname from pg_trigger where tgrelid = 'file_rows'::regclass and not tgisinternal and tgname like 'automation%'`);
    expect(triggers).toHaveLength(0);
  });

  it('every change tells open screens', async () => {
    const before = await one<{ at: Date }>(`select at from record_pings where record_id = $1`, [rec]);
    await mark(voided, false, 1);
    const after = await one<{ at: Date }>(`select at from record_pings where record_id = $1`, [rec]);
    expect(after.at.getTime()).toBeGreaterThanOrEqual(before.at.getTime());
    const pub = await q(`select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'record_pings'`);
    expect(pub).toHaveLength(1);
  });
});
