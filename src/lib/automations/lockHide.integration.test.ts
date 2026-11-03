/**
 * Lock, Hide, Unlock, Unhide and File uploaded, against the real database, as real
 * members of real teams. Rolled back. The spec's acceptance checklist, in order.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const DB_URL = process.env.SUPABASE_DB_URL;
const suite = DB_URL ? describe : describe.skip;
let db: pg.Client;

const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows as T[];
const one = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await q<T>(sql, p))[0]!;
const ROWS = ['Owner ID', 'Bank statements', 'Processing statements', 'Corp docs', 'Voided check'];

suite('Lock & Hide', () => {
  const team: Record<string, string> = {};
  let roleId: string;
  let admin: string;
  let uw: string; // Underwriting: the "can unlock" / "can see and unhide" group
  let cs: string; // Customer service: "can see only"
  let sales: string; // everyone else
  let contacts: string;
  let n = 0;

  const as = async <T>(user: string, fn: () => Promise<T>): Promise<T> => {
    await q(`select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`, [JSON.stringify({ sub: user, role: 'authenticated' })]);
    // On a refusal the transaction is aborted: `refused` rolls back and resets.
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
  const newUser = async (type: string) => {
    const id = randomUUID();
    const email = `zz-${id.slice(0, 8)}@tapdash.test`;
    await q(`insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')`, [id, email]);
    await q(`insert into profiles (id, email, full_name, role_id, status) values ($1, $2, $3, $4, 'active') on conflict (id) do update set role_id = excluded.role_id, status = 'active'`, [id, email, `Zz ${type}`, roleId]);
    await q(`insert into user_templates (user_id, template_id) values ($1, $2) on conflict (user_id) do update set template_id = excluded.template_id`, [id, team[type]]);
    await q(`insert into permission_settings (owner_kind, owner_id, key, value) values ('user', $1, $2, 'all') on conflict (owner_kind, owner_id, key) do update set value = 'all'`, [id, `module:${contacts}`]);
    // Full access underneath, so every difference below is the restriction's.
    await q(`insert into user_grants (user_id, scope_kind, scope_id, grant_level) select $1, 'tab', id, 'edit' from tabs where key in ('logins', 'files', 'statements', 'pricing', 'contact')`, [id]);
    return id;
  };
  const mids = new Map<string, string>();
  const record = async () => {
    // MID is unique across records.
    const mid = `9${randomUUID().replace(/\D/g, '').slice(0, 9)}`;
    const { id } = await one<{ id: string }>(`insert into records (deal_name, creator_user_id, values) values ($1, $2, $3) returning id`, [`ZZ lock ${++n}`, admin, { mid, legal_business_name: 'Zz Co' }]);
    mids.set(id, mid);
    await q(`insert into record_modules (record_id, module_id) values ($1, $2)`, [id, contacts]);
    await q(`select ensure_application_file_rows($1, $2, $3)`, [id, ROWS, [0, 10, 20, 30, 40]]);
    return id;
  };
  const run = (rec: string, name = 'ZZ Locker') => ({ automation_id: null, automation_name: name, record_id: rec });
  const act = (rec: string, step: Record<string, unknown>, name?: string) =>
    one<{ o: { outcome: string; detail: string } }>(`select automation_act(jsonb_populate_record(null::automation_runs, $1::jsonb), $2::jsonb) o`, [JSON.stringify(run(rec, name)), JSON.stringify(step)]).then((r) => r.o);
  const groups = (teams: string[] = [], users: string[] = []) => ({ teamIds: teams.map((t) => team[t]), userIds: users });
  const fieldGrant = (user: string, rec: string, key: string) => as(user, () => one<{ g: string }>(`select record_field_grant($1, $2) g`, [rec, key])).then((r) => r.g);
  const tabGrant = (user: string, rec: string, key: string) => as(user, () => one<{ g: string }>(`select record_tab_grant($1, $2) g`, [rec, key])).then((r) => r.g);
  const values = (user: string, rec: string) => as(user, () => one<{ v: Record<string, unknown> }>(`select "values" v from record_values_for(array[$1]::uuid[])`, [rec])).then((r) => r.v);
  const rowId = (rec: string, name: string) => one<{ id: string }>(`select id from file_rows where record_id = $1 and name = $2`, [rec, name]).then((r) => r.id);

  beforeAll(async () => {
    db = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
    await db.connect();
    await q('begin');
    roleId = (await one<{ id: string }>(`select id from roles where not is_admin order by name limit 1`)).id;
    contacts = (await one<{ id: string }>(`select id from modules where slug = 'contacts'`)).id;
    for (const r of await q<{ id: string; user_type: string }>(`select id, user_type from permission_templates where user_type is not null`)) team[r.user_type] = r.id;
    admin = (await one<{ id: string }>(`select id from profiles where email = 'admin@tapdash.test'`)).id;
    uw = await newUser('underwriter');
    cs = await newUser('customer_service');
    sales = await newUser('sales_agent');
  }, 60_000);

  // Each test on its own, so one refusal can't take the rest down with it.
  beforeEach(async () => {
    await q('savepoint t');
  });
  afterEach(async () => {
    await q('rollback to savepoint t');
    await q(`select set_config('request.jwt.claims', '', true), set_config('role', 'none', true)`);
  });

  afterAll(async () => {
    await q('rollback');
    await db.end();
  });

  it('the new tables leave "automations with their record" unambiguous to the API', async () => {
    // A link table between automations and records made every embed of one in the
    // other ambiguous (PGRST201), and the Automations pages stopped loading.
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return;
    for (const path of ['automations?select=id,records(deal_name)&limit=1', 'records?select=id,automations(id)&limit=1']) {
      const res = await fetch(`${url}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
      expect([path, res.status]).toEqual([path, 200]);
    }
  });

  it('only the spec\'s tabs can be locked or hidden, and only at their level', async () => {
    const t = await q<{ key: string; restriction_level: string }>(`select key, restriction_level from tabs where key in ('contact','overview','pricing','application','equipment','agreements','files','logins','statements','marketing','communication','updates','cases','residual_figures') order by key`);
    expect(Object.fromEntries(t.map((r) => [r.key, r.restriction_level]))).toEqual({
      agreements: 'field', application: 'field', cases: 'none', communication: 'none', contact: 'field', equipment: 'field',
      files: 'row', logins: 'tab', marketing: 'none', overview: 'field', pricing: 'field', residual_figures: 'none', statements: 'tab', updates: 'none',
    });
  });

  it('a locked field: everyone sees it, blocked users can\'t edit, the Can unlock group can', async () => {
    const rec = await record();
    expect((await act(rec, { type: 'lock', items: ['field:mid'], canLift: groups(['underwriter']), allowDownload: true })).outcome).toBe('done');
    expect(await fieldGrant(sales, rec, 'mid')).toBe('view');
    expect(await fieldGrant(cs, rec, 'mid')).toBe('view');
    expect(await fieldGrant(uw, rec, 'mid')).toBe('edit');
    expect(await fieldGrant(admin, rec, 'mid')).toBe('edit');
    expect((await values(sales, rec)).mid).toBe(mids.get(rec));
    const at = (await one<{ at: string }>(`select updated_at::text at from records where id = $1`, [rec])).at;
    await refused(() => as(sales, () => q(`select * from set_record_value($1, 'mid', '"999"'::jsonb, $2::timestamptz, 'x')`, [rec, at])), /edit|permission|access/i);
  });

  it('automations and system writes still change a locked field', async () => {
    const rec = await record();
    await act(rec, { type: 'lock', items: ['tab:contact', 'field:mid'], canLift: groups(), allowDownload: true });
    const next = `8${randomUUID().replace(/\D/g, '').slice(0, 9)}`;
    await q(`update records set values = values || jsonb_build_object('mid', $2::text) where id = $1`, [rec, next]);
    expect((await one<{ v: string }>(`select values ->> 'mid' v from records where id = $1`, [rec])).v).toBe(next);
  });

  it('a hidden field: gone for the can\'t-see group, present for both seeing groups, never sent', async () => {
    const rec = await record();
    await act(rec, { type: 'hide', items: ['field:mid'], canLift: groups(['underwriter']), canSee: groups(['customer_service']), allowDownload: true });
    expect(await fieldGrant(sales, rec, 'mid')).toBe('hidden');
    expect('mid' in (await values(sales, rec))).toBe(false);
    expect('mid' in (await as(sales, () => one<{ v: Record<string, unknown> }>(`select "values" v from records_filterable where id = $1`, [rec]))).v).toBe(false);
    expect((await as(sales, () => one<{ s: string }>(`select search_text s from records_filterable where id = $1`, [rec]))).s).not.toContain(mids.get(rec));
    expect(await fieldGrant(cs, rec, 'mid')).toBe('edit');
    expect((await values(cs, rec)).mid).toBe(mids.get(rec));
    expect(await fieldGrant(uw, rec, 'mid')).toBe('edit');
  });

  it('a hidden field can\'t be @mentioned, and those users aren\'t in the picker for it', async () => {
    const rec = await record();
    await act(rec, { type: 'hide', items: ['field:mid'], canLift: groups(['underwriter']), canSee: groups(), allowDownload: true });
    const picked = await one<{ ids: string[] }>(`select array(select user_record_field_grant(u, $1, 'mid')::text from unnest(array[$2, $3]::uuid[]) u) ids`, [rec, sales, uw]);
    expect(picked.ids).toEqual(['hidden', 'edit']);
  });

  it('a lock or hide never loosens a normal permission', async () => {
    const rec = await record();
    const mid = await one<{ id: string }>(`select id from fields where key = 'mid'`);
    await q(`insert into user_grants (user_id, scope_kind, scope_id, grant_level) values ($1, 'field', $2, 'hidden')`, [uw, mid.id]);
    await act(rec, { type: 'hide', items: ['field:mid'], canLift: groups(['underwriter']), canSee: groups(), allowDownload: true });
    expect(await fieldGrant(uw, rec, 'mid')).toBe('hidden');
    await q(`delete from user_grants where user_id = $1 and scope_id = $2`, [uw, mid.id]);
    await q(`insert into user_grants (user_id, scope_kind, scope_id, grant_level) values ($1, 'field', $2, 'view')`, [uw, mid.id]);
    expect(await fieldGrant(uw, rec, 'mid')).toBe('view');
    await act(rec, { type: 'unhide', items: ['field:mid'] });
    expect(await fieldGrant(uw, rec, 'mid')).toBe('view');
    await q(`delete from user_grants where user_id = $1 and scope_id = $2`, [uw, mid.id]);
  });

  it('super admins always see and edit everything', async () => {
    const rec = await record();
    await act(rec, { type: 'hide', items: ['tab:pricing', 'field:mid'], canLift: groups(), canSee: groups(), allowDownload: false });
    expect(await fieldGrant(admin, rec, 'mid')).toBe('edit');
    expect(await tabGrant(admin, rec, 'pricing')).toBe('edit');
  });

  it('a tab or sub-tab covers every field inside it, those added later included', async () => {
    const rec = await record();
    await act(rec, { type: 'lock', items: ['tab:pricing'], canLift: groups(), allowDownload: true });
    const pricing = await one<{ id: string }>(`select id from tabs where key = 'pricing'`);
    const f = await one<{ key: string }>(`insert into fields (key, label, type, tab_id, position) values ('zz_later', 'ZZ later', 'text', $1, 999) returning key`, [pricing.id]);
    expect(await fieldGrant(sales, rec, f.key)).toBe('view');
    const sub = await one<{ id: string }>(`select id from subtabs where tab_id = $1 limit 1`, [pricing.id]);
    expect((await as(sales, () => one<{ g: string }>(`select record_scope_grant($1, 'subtab', $2) g`, [rec, sub.id]))).g).toBe('view');
  });

  it('Unlock returns each item to exactly where it was: a lock under a hide stays', async () => {
    const rec = await record();
    await act(rec, { type: 'lock', items: ['field:mid'], canLift: groups(), allowDownload: true }, 'A');
    await act(rec, { type: 'hide', items: ['field:mid'], canLift: groups(), canSee: groups(), allowDownload: true }, 'B');
    expect(await fieldGrant(sales, rec, 'mid')).toBe('hidden');
    await act(rec, { type: 'unhide', items: ['field:mid'] });
    expect(await fieldGrant(sales, rec, 'mid')).toBe('view');
    await act(rec, { type: 'unlock', items: ['field:mid'] });
    expect(await fieldGrant(sales, rec, 'mid')).toBe('edit');
  });

  it('nothing to lift: the step is skipped, and so the run stops and the builder hears', async () => {
    const rec = await record();
    expect((await act(rec, { type: 'unlock', items: ['field:mid'] })).outcome).toBe('skipped');
    expect((await act(rec, { type: 'unhide', items: ['tab:pricing'] })).outcome).toBe('skipped');
  });

  it('two automations on one item: either group can lift, and one lift takes both off', async () => {
    const rec = await record();
    await act(rec, { type: 'lock', items: ['field:mid'], canLift: groups(['underwriter']), allowDownload: true }, 'A');
    await act(rec, { type: 'lock', items: ['field:mid'], canLift: groups(['customer_service']), allowDownload: true }, 'B');
    expect(await fieldGrant(cs, rec, 'mid')).toBe('edit');
    expect(await fieldGrant(uw, rec, 'mid')).toBe('edit');
    await refused(() => as(sales, () => q(`select lift_restrictions($1, array['field:mid'], 'lock')`, [rec])), /can.t lift/);
    await as(cs, () => q(`select lift_restrictions($1, array['field:mid'], 'lock')`, [rec]));
    expect(await fieldGrant(sales, rec, 'mid')).toBe('edit');
  });

  it('a lift by hand takes off what was chosen, and the rest stays (Izzy, 3 Nov)', async () => {
    const rec = await record();
    await act(rec, { type: 'lock', items: ['field:mid', 'field:legal_business_name'], canLift: groups(['underwriter']), allowDownload: true });
    const offered = await as(uw, () => q<{ item: string; label: string; can_lift: boolean }>(`select item, label, can_lift from viewer_restrictions($1) order by item`, [rec]));
    expect(offered.map((o) => [o.item, o.can_lift])).toEqual([['field:legal_business_name', true], ['field:mid', true]]);
    expect(offered.every((o) => o.label)).toBe(true);

    await as(uw, () => q(`select lift_restrictions($1, array['field:mid'], 'lock')`, [rec]));
    expect(await fieldGrant(sales, rec, 'mid')).toBe('edit');
    expect(await fieldGrant(sales, rec, 'legal_business_name')).toBe('view');
  });

  it('you can only choose what you may lift, and one refused item refuses the lot', async () => {
    const rec = await record();
    await act(rec, { type: 'lock', items: ['field:mid'], canLift: groups(['underwriter']), allowDownload: true }, 'A');
    await act(rec, { type: 'lock', items: ['field:legal_business_name'], canLift: groups(['customer_service']), allowDownload: true }, 'B');
    await refused(() => as(uw, () => q(`select lift_restrictions($1, array['field:mid', 'field:legal_business_name'], 'lock')`, [rec])), /can.t lift/);
    expect(await fieldGrant(sales, rec, 'mid')).toBe('view');
  });

  it('Re-lock puts back what was lifted, with the same groups, while the rest is still on', async () => {
    const rec = await record();
    await act(rec, { type: 'lock', items: ['field:mid', 'field:legal_business_name'], canLift: groups(['underwriter']), allowDownload: true });
    await as(uw, () => q(`select lift_restrictions($1, array['field:mid'], 'lock')`, [rec]));
    const seen = await as(uw, () => q<{ item: string; batch_id: string; lifted: boolean }>(`select item, batch_id, lifted from viewer_restrictions($1)`, [rec]));
    const lifted = seen.filter((b) => b.lifted);
    expect(lifted.map((b) => b.item)).toEqual(['field:mid']);
    expect(await as(sales, () => q(`select 1 from viewer_restrictions($1) where lifted`, [rec]))).toHaveLength(0);
    await as(uw, () => q(`select reapply_restriction($1, $2)`, [rec, lifted[0]!.batch_id]));
    expect(await fieldGrant(sales, rec, 'mid')).toBe('view');
    expect(await fieldGrant(uw, rec, 'mid')).toBe('edit');
  });

  it('someone who can lift but can\'t see a field isn\'t told its name', async () => {
    const rec = await record();
    const mid = await one<{ id: string }>(`select id from fields where key = 'mid'`);
    await q(`insert into user_grants (user_id, scope_kind, scope_id, grant_level) values ($1, 'field', $2, 'hidden')`, [uw, mid.id]);
    await act(rec, { type: 'lock', items: ['field:mid', 'field:legal_business_name'], canLift: groups(['underwriter']), allowDownload: true });
    const rows = await as(uw, () => q<{ item: string; label: string | null; batch_items: string[] }>(`select item, label, batch_items from viewer_restrictions($1)`, [rec]));
    expect(rows.find((r) => r.item === 'field:mid')?.label).toBeNull();
    expect(rows.flatMap((r) => r.batch_items)).not.toContain('MID');
  });

  it('a viewer hidden from an item learns nothing of it but its key', async () => {
    const rec = await record();
    await act(rec, { type: 'hide', items: ['field:mid'], canLift: groups(), canSee: groups(), allowDownload: true }, 'ZZ Secret name');
    const rows = await as(sales, () => q<Record<string, unknown>>(`select * from viewer_restrictions($1)`, [rec]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ item: 'field:mid', effect: 'hide', automation_name: null, batch_items: null, can_lift: false });
    await refused(() => as(sales, () => q(`select * from record_restrictions`)), /permission denied/);
    await refused(() => as(sales, () => q(`select restriction_effect($1, $2, array['field:mid'])`, [uw, rec])), /permission denied/);
  });

  it('Updates names each item only to someone who can see it, and says who did it', async () => {
    const rec = await record();
    await act(rec, { type: 'hide', items: ['field:mid', 'tab:pricing'], canLift: groups(), canSee: groups(['customer_service']), allowDownload: true }, 'ZZ Hider');
    const read = (u: string) => as(u, async () => ({
      u: await q<{ body: string; automation_name: string }>(`select body, automation_name from updates where record_id = $1 and is_log`, [rec]),
      d: await q<{ body: string; part: string }>(`select body, part from update_details where record_id = $1`, [rec]),
    }));
    const salesSees = await read(sales);
    expect(salesSees.u).toEqual([{ body: 'Hid items.', automation_name: 'ZZ Hider' }]);
    expect(salesSees.d).toEqual([]);
    const csSees = await read(cs);
    expect(csSees.d.map((d) => d.body).sort()).toEqual(['MID', 'Pricing'].sort());
  });

  it('a deleted item is skipped and the rest still applies', async () => {
    const rec = await record();
    const out = await act(rec, { type: 'lock', items: ['field:not_a_field', 'field:mid', 'subtab:00000000-0000-0000-0000-000000000000'], canLift: groups(), allowDownload: true });
    expect(out.outcome).toBe('done');
    expect(await fieldGrant(sales, rec, 'mid')).toBe('view');
    expect((await act(rec, { type: 'lock', items: ['field:not_a_field'], canLift: groups(), allowDownload: true })).outcome).toBe('done');
  });

  it('Tab notes: locked can be read and not added to; hidden can\'t be read', async () => {
    const rec = await record();
    const pricing = await one<{ id: string }>(`select id from tabs where key = 'pricing'`);
    await q(`insert into permission_settings (owner_kind, owner_id, key, value) values ('user', $1, 'items.notes', 'all') on conflict (owner_kind, owner_id, key) do update set value = 'all'`, [sales]);
    await as(sales, () => q(`insert into notes (record_id, scope_kind, scope_id, author_id, body) values ($1, 'tab', $2, $3, 'before')`, [rec, pricing.id, sales]));
    await act(rec, { type: 'lock', items: ['notes:pricing'], canLift: groups(), allowDownload: true });
    expect(await as(sales, () => q(`select body from notes where record_id = $1`, [rec]))).toHaveLength(1);
    await refused(() => as(sales, () => q(`insert into notes (record_id, scope_kind, scope_id, author_id, body) values ($1, 'tab', $2, $3, 'x')`, [rec, pricing.id, sales])), /row-level security/);
    await act(rec, { type: 'hide', items: ['notes:pricing'], canLift: groups(), canSee: groups(), allowDownload: true });
    expect(await as(sales, () => q(`select body from notes where record_id = $1`, [rec]))).toHaveLength(0);
    expect((await fieldGrant(sales, rec, 'mid'))).toBe('edit');
  });

  it('a locked Files row: see the files, add to it, can\'t delete or move them, and download obeys the setting', async () => {
    const rec = await record();
    const bank = await rowId(rec, 'Bank statements');
    const before = (await as(admin, () => one<{ id: string }>(`select record_file_upload($1, $2, 'early.pdf', 1) id`, [bank, `${rec}/application/${bank}/a.pdf`]))).id;
    await act(rec, { type: 'lock', items: ['row:Bank statements'], canLift: groups(['underwriter']), allowDownload: false });
    await as(sales, () => q(`select record_file_upload($1, $2, 'mine.pdf', 1)`, [bank, `${rec}/application/${bank}/b.pdf`]));
    const seen = await as(sales, () => q<{ name: string }>(`select name from files where file_row_id = $1 order by name`, [bank]));
    expect(seen.map((f) => f.name)).toEqual(['early.pdf', 'mine.pdf']);
    await refused(() => as(sales, () => q(`select delete_file($1)`, [before])), /edit access/);
    const corp = await rowId(rec, 'Corp docs');
    await refused(() => as(sales, () => q(`select move_file($1, $2)`, [before, corp])), /edit access/);
    expect((await as(sales, () => one<{ a: boolean }>(`select file_download_allowed($1) a`, [before]))).a).toBe(false);
    expect((await as(sales, () => one<{ l: string }>(`select storage_object_access($1) l`, [`${rec}/application/${bank}/a.pdf`]))).l).toBe('add_only');
    expect((await as(uw, () => one<{ a: boolean }>(`select file_download_allowed($1) a`, [before]))).a).toBe(true);
    await as(uw, () => q(`select delete_file($1)`, [before]));
  });

  it('a hidden Files row: gone from view, still named for adding, and what\'s added stays hidden', async () => {
    const rec = await record();
    const bank = await rowId(rec, 'Bank statements');
    await act(rec, { type: 'hide', items: ['row:Bank statements'], canLift: groups(), canSee: groups(), allowDownload: true });
    expect(await as(sales, () => q(`select id from file_rows where id = $1`, [bank]))).toHaveLength(0);
    const rows = await as(sales, () => q<{ row_name: string; can_see: boolean }>(`select row_name, can_see from file_rows_for_adding($1, $2, $3)`, [rec, ROWS, [0, 10, 20, 30, 40]]));
    expect(rows.find((r) => r.row_name === 'Bank statements')?.can_see).toBe(false);
    expect(rows.find((r) => r.row_name === 'Owner ID')?.can_see).toBe(true);
    await as(sales, () => q(`select record_file_upload($1, $2, 'h.pdf', 1)`, [bank, `${rec}/application/${bank}/h.pdf`]));
    expect(await as(sales, () => q(`select id from files where file_row_id = $1`, [bank]))).toHaveLength(0);
    expect((await as(sales, () => one<{ l: string }>(`select storage_object_access($1) l`, [`${rec}/application/${bank}/h.pdf`]))).l).toBe('add_only');
  });

  it('a hidden or locked Files tab: add only, or view and add', async () => {
    const rec = await record();
    await act(rec, { type: 'hide', items: ['tab:files'], canLift: groups(), canSee: groups(), allowDownload: true });
    expect(await tabGrant(sales, rec, 'files')).toBe('add_only');
    await as(sales, () => q(`select add_file_row($1, 'ZZ later row')`, [rec]));
    expect(await as(sales, () => q(`select id from file_rows where record_id = $1`, [rec]))).toHaveLength(0);
    const rec2 = await record();
    await act(rec2, { type: 'lock', items: ['tab:files'], canLift: groups(), allowDownload: true });
    expect(await tabGrant(sales, rec2, 'files')).toBe('view');
    await as(sales, () => q(`select add_file_row($1, 'ZZ locked row')`, [rec2]));
    const row = await one<{ id: string }>(`select id from file_rows where record_id = $1 and name = 'ZZ locked row'`, [rec2]);
    await refused(() => as(sales, () => q(`select rename_file_row($1, 'X')`, [row.id])), /edit access/);
    await refused(() => as(sales, () => q(`select delete_file_row($1)`, [row.id])), /edit access/);
  });

  it('a lock leaves marking files required open; a hide closes it', async () => {
    const rec = await record();
    const bank = await rowId(rec, 'Bank statements');
    await act(rec, { type: 'lock', items: ['row:Bank statements'], canLift: groups(), allowDownload: true });
    await as(sales, () => q(`select set_file_row_required($1, true, 2)`, [bank]));
    await act(rec, { type: 'hide', items: ['row:Bank statements'], canLift: groups(), canSee: groups(), allowDownload: true });
    await refused(() => as(sales, () => q(`select set_file_row_required($1, true, 3)`, [bank])), /not found/);
    // It still shows in the column, whatever the row.
    expect((await as(sales, () => one<{ n: number }>(`select files_required_count n from records_filterable where id = $1`, [rec]))).n).toBe(1);
  });

  it('a locked Logins tab: see, add, and the new login is locked; hidden: add only, nothing seen', async () => {
    const rec = await record();
    await act(rec, { type: 'lock', items: ['tab:logins'], canLift: groups(), allowDownload: true });
    await as(sales, () => q(`select add_login($1, 'Gateway', null, 'u', null, 'pw', 'k')`, [rec]));
    const l = await as(sales, () => q<{ id: string }>(`select id from logins where record_id = $1`, [rec]));
    expect(l).toHaveLength(1);
    expect((await as(sales, () => db.query(`update logins set username = 'x' where id = $1`, [l[0]!.id]))).rowCount).toBe(0);
    const rec2 = await record();
    await act(rec2, { type: 'hide', items: ['tab:logins'], canLift: groups(), canSee: groups(), allowDownload: true });
    expect(await tabGrant(sales, rec2, 'logins')).toBe('add_only');
    await as(sales, () => q(`select add_login($1, 'Portal', null, 'u', null, 'pw', 'k')`, [rec2]));
    expect(await as(sales, () => q(`select id from logins where record_id = $1`, [rec2]))).toHaveLength(0);
  });

  it('a hide on Logins never opens adding to someone who only had View', async () => {
    const rec = await record();
    const logins = await one<{ id: string }>(`select id from tabs where key = 'logins'`);
    await q(`update user_grants set grant_level = 'view' where user_id = $1 and scope_id = $2`, [cs, logins.id]);
    await act(rec, { type: 'hide', items: ['tab:logins'], canLift: groups(), canSee: groups(), allowDownload: true });
    expect(await tabGrant(cs, rec, 'logins')).toBe('hidden');
    await refused(() => as(cs, () => q(`select add_login($1, 'X', null, 'u', null, 'pw', 'k')`, [rec])), /do not have access/);
    await q(`update user_grants set grant_level = 'edit' where user_id = $1 and scope_id = $2`, [cs, logins.id]);
  });

  it('Add only keeps Add only under a lock or hide', async () => {
    const rec = await record();
    const logins = await one<{ id: string }>(`select id from tabs where key = 'logins'`);
    await q(`update user_grants set grant_level = 'add_only' where user_id = $1 and scope_id = $2`, [sales, logins.id]);
    await act(rec, { type: 'lock', items: ['tab:logins'], canLift: groups(), allowDownload: true });
    expect(await tabGrant(sales, rec, 'logins')).toBe('add_only');
    await as(sales, () => q(`select add_login($1, 'X', null, 'u', null, 'pw', 'k')`, [rec]));
    await q(`update user_grants set grant_level = 'edit' where user_id = $1 and scope_id = $2`, [sales, logins.id]);
  });

  it('a locked Statements tab: the list, uploads in, nothing out; hidden: gone, uploads too', async () => {
    const rec = await record();
    const period = await one<{ id: string }>(`select id from statement_periods limit 1`);
    await act(rec, { type: 'lock', items: ['tab:statements'], canLift: groups(), allowDownload: true });
    expect(await tabGrant(sales, rec, 'statements')).toBe('view');
    const { id } = await as(sales, () => one<{ id: string }>(`select statement_file_upload($1, $2, $3, 's.pdf', 1) id`, [rec, period.id, `${rec}/statements/2026-01/s.pdf`]));
    await refused(() => as(sales, () => q(`select delete_statement_file($1)`, [id])), /tab|access/i);
    expect((await as(sales, () => one<{ l: string }>(`select storage_object_access($1) l`, [`${rec}/statements/2026-01/s.pdf`]))).l).toBe('add_only');
    const rec2 = await record();
    await act(rec2, { type: 'hide', items: ['tab:statements'], canLift: groups(), canSee: groups(), allowDownload: true });
    expect(await tabGrant(sales, rec2, 'statements')).toBe('hidden');
    await refused(() => as(sales, () => q(`select statement_file_upload($1, $2, $3, 's.pdf', 1)`, [rec2, period.id, `${rec2}/statements/2026-01/t.pdf`])), /edit access/);
  });

  it('a locked Agreements tab: void refused for blocked users only', async () => {
    const rec = await record();
    const key = (await one<{ k: string }>(`select agreements_tab_key() k`)).k;
    await act(rec, { type: 'lock', items: [`tab:${key}`], canLift: groups(['underwriter']), allowDownload: true });
    expect((await as(sales, () => one<{ l: boolean }>(`select item_locked_for_viewer($1, $2) l`, [rec, `tab:${key}`]))).l).toBe(true);
    expect((await as(uw, () => one<{ l: boolean }>(`select item_locked_for_viewer($1, $2) l`, [rec, `tab:${key}`]))).l).toBe(false);
  });

  it('a record restored from the bin keeps its locks', async () => {
    const rec = await record();
    await act(rec, { type: 'lock', items: ['field:mid'], canLift: groups(), allowDownload: true });
    await q(`update records set deleted_at = now() where id = $1`, [rec]);
    await q(`update records set deleted_at = null where id = $1`, [rec]);
    expect(await fieldGrant(sales, rec, 'mid')).toBe('view');
  });

  it('only admins delete and restore a case (Izzy, 3 Nov), whatever pages someone holds', async () => {
    const rec = await record();
    const { id } = await one<{ id: string }>(`insert into cases (record_id, title, issue, issue_author) values ($1, 'ZZ', 'x', $2) returning id`, [rec, admin]);
    await q(`insert into permission_settings (owner_kind, owner_id, key, value) values ('user', $1, 'admin.recycle_bin', 'full') on conflict (owner_kind, owner_id, key) do update set value = 'full'`, [cs]);
    await refused(() => as(cs, () => q(`select delete_case($1)`, [id])), /Only an admin/);
    await as(admin, () => q(`select delete_case($1)`, [id]));
    await refused(() => as(cs, () => q(`select restore_case($1)`, [id])), /Only an admin/);
    const typed = await newUser('admin');
    await as(typed, () => q(`select restore_case($1)`, [id]));
    expect((await one<{ gone: boolean }>(`select deleted_at is not null gone from cases where id = $1`, [id])).gone).toBe(false);
  });

  describe('File uploaded', () => {
    let a: string;
    const save = async (frequency: string, flow: unknown[]) => {
      const steps = { triggers: [{ id: 't', type: 'file_uploaded', rows: ['Bank statements'], frequency }], conditions: { join: 'and', groups: [] }, flow };
      const { id } = await one<{ id: string }>(`select automation_save(null, $1, $2, '{}', '{}', false, $3) as id`, [`ZZ files ${randomUUID().slice(0, 6)}`, steps, admin]);
      await q(`select automation_set_status($1, 'on', null, $2)`, [id, admin]);
      return id;
    };
    const queued = async (auto: string) => (await one<{ n: number }>(`select count(*)::int n from automation_queue where automation_id = $1`, [auto])).n;

    beforeAll(async () => {
      a = await save('every', [{ id: 'f1', type: 'lock', items: ['tab:pricing'], canLift: { teamIds: [], userIds: [] }, allowDownload: true }]);
    });

    it('fires for a chosen preset row, by a person, once per batch', async () => {
      const rec = await record();
      const bank = await rowId(rec, 'Bank statements');
      await as(sales, () => q(`select record_file_upload($1, $2, 'a.pdf', 1)`, [bank, `zz/${randomUUID()}`]));
      await as(sales, () => q(`select record_file_upload($1, $2, 'b.pdf', 1)`, [bank, `zz/${randomUUID()}`]));
      expect(await queued(a)).toBe(1);
    });

    it('waits for the uploads to stop, so conditions read the finished row (Izzy, 3 Nov)', async () => {
      // The spec's own example: Bank statements needs 3, and "only if Files Required is empty".
      const auto = await save('every', [{ id: 'f1', type: 'lock', items: ['tab:pricing'], canLift: { teamIds: [], userIds: [] }, allowDownload: true }]);
      const steps = await one<{ s: Record<string, unknown> }>(`select v.steps s from automations x join automation_versions v on v.id = x.current_version_id where x.id = $1`, [auto]);
      await q(`update automation_versions set steps = $2 where id = (select current_version_id from automations where id = $1)`, [auto, {
        ...steps.s,
        conditions: { join: 'and', groups: [{ id: 'g', join: 'and', conditions: [{ id: 'c', type: 'files_required_empty' }] }] },
      }]);
      const rec = await record();
      const bank = await rowId(rec, 'Bank statements');
      await as(sales, () => q(`select set_file_row_required($1, true, 3)`, [bank]));

      await as(sales, () => q(`select record_file_upload($1, $2, 'a.pdf', 1)`, [bank, `zz/${randomUUID()}`]));
      const first = await one<{ not_before: Date }>(`select not_before from automation_queue where automation_id = $1`, [auto]);
      expect(first.not_before.getTime()).toBeGreaterThan(Date.now() - 5000);

      // Not due yet: the worker leaves it.
      await q(`select * from automation_work(50)`);
      await q(`select set_config('tapdash.automation', '', true), set_config('tapdash.event_actor', '', true)`);
      expect(await q(`select 1 from automation_runs where automation_id = $1`, [auto])).toHaveLength(0);

      await as(sales, () => q(`select record_file_upload($1, $2, 'b.pdf', 1)`, [bank, `zz/${randomUUID()}`]));
      await as(sales, () => q(`select record_file_upload($1, $2, 'c.pdf', 1)`, [bank, `zz/${randomUUID()}`]));
      const held = await q<{ not_before: Date }>(`select not_before from automation_queue where automation_id = $1`, [auto]);
      expect(held).toHaveLength(1);
      expect(held[0]!.not_before.getTime()).toBeGreaterThanOrEqual(first.not_before.getTime());

      // Due: one run, and the condition sees all three files.
      await q(`update automation_queue set not_before = now() - interval '1 second' where automation_id = $1`, [auto]);
      await q(`delete from automation_queue where automation_id <> $1`, [auto]);
      await q(`select * from automation_work(50)`);
      await q(`select set_config('tapdash.automation', '', true), set_config('tapdash.event_actor', '', true)`);
      const runs = await q<{ status: string }>(`select status from automation_runs where automation_id = $1`, [auto]);
      expect(runs).toEqual([{ status: 'completed' }]);
    });

    it('someone else uploading to the row is their own upload', async () => {
      const rec = await record();
      const bank = await rowId(rec, 'Bank statements');
      await as(sales, () => q(`select record_file_upload($1, $2, 'a.pdf', 1)`, [bank, `zz/${randomUUID()}`]));
      await as(uw, () => q(`select record_file_upload($1, $2, 'b.pdf', 1)`, [bank, `zz/${randomUUID()}`]));
      expect(await queued(a)).toBe(2);
    });

    it('a later upload, once the first has run, fires again', async () => {
      const rec = await record();
      const bank = await rowId(rec, 'Bank statements');
      await as(sales, () => q(`select record_file_upload($1, $2, 'a.pdf', 1)`, [bank, `zz/${randomUUID()}`]));
      await q(`update automation_queue set done_at = now() where automation_id = $1`, [a]);
      await as(sales, () => q(`select record_file_upload($1, $2, 'b.pdf', 1)`, [bank, `zz/${randomUUID()}`]));
      expect((await one<{ n: number }>(`select count(*)::int n from automation_queue where automation_id = $1 and done_at is null`, [a])).n).toBe(1);
    });

    it('never for another row, a user-added row, or a system save', async () => {
      const rec = await record();
      const corp = await rowId(rec, 'Corp docs');
      await as(sales, () => q(`select record_file_upload($1, $2, 'a.pdf', 1)`, [corp, `zz/${randomUUID()}`]));
      await as(sales, () => q(`select add_file_row($1, 'Bank statements 2')`, [rec]));
      const added = await rowId(rec, 'Bank statements 2');
      await as(sales, () => q(`select record_file_upload($1, $2, 'a.pdf', 1)`, [added, `zz/${randomUUID()}`]));
      // A system save: no person signed in.
      await q(`select automation_fire_file(fr, null) from file_rows fr where fr.id = $1`, [await rowId(rec, 'Bank statements')]);
      expect((await one<{ n: number }>(`select count(*)::int n from automation_queue where automation_id = $1 and record_id = $2`, [a, rec])).n).toBe(0);
    });

    it('a move in fires; a move out doesn\'t', async () => {
      const rec = await record();
      const corp = await rowId(rec, 'Corp docs');
      const bank = await rowId(rec, 'Bank statements');
      const { id } = await as(sales, () => one<{ id: string }>(`select record_file_upload($1, $2, 'a.pdf', 1) id`, [corp, `zz/${randomUUID()}`]));
      await as(sales, () => q(`select move_file($1, $2)`, [id, bank]));
      expect((await one<{ n: number }>(`select count(*)::int n from automation_queue where automation_id = $1 and record_id = $2`, [a, rec])).n).toBe(1);
    });

    it('First upload only fires once per row per record, ever', async () => {
      const first = await save('first', [{ id: 'f1', type: 'mark_file_required', rows: [{ name: 'Owner ID', needed: 1 }] }]);
      const rec = await record();
      const bank = await rowId(rec, 'Bank statements');
      await as(sales, () => q(`select record_file_upload($1, $2, 'a.pdf', 1)`, [bank, `zz/${randomUUID()}`]));
      await q(`delete from automation_queue where automation_id = $1`, [first]);
      await as(uw, () => q(`select record_file_upload($1, $2, 'b.pdf', 1)`, [bank, `zz/${randomUUID()}`]));
      expect((await one<{ n: number }>(`select count(*)::int n from automation_queue where automation_id = $1`, [first])).n).toBe(0);
    });

    it('First upload, again after unlock: not while its lock is on, again once it\'s lifted', async () => {
      const auto = await save('first_after_unlock', [{ id: 'f1', type: 'lock', items: ['tab:pricing'], canLift: { teamIds: [], userIds: [] }, allowDownload: true }]);
      const rec = await record();
      const bank = await rowId(rec, 'Bank statements');
      await as(sales, () => q(`select record_file_upload($1, $2, 'a.pdf', 1)`, [bank, `zz/${randomUUID()}`]));
      expect((await one<{ n: number }>(`select count(*)::int n from automation_queue where automation_id = $1`, [auto])).n).toBe(1);
      await q(`delete from automation_queue where automation_id = $1`, [auto]);
      await q(`insert into record_restrictions (record_id, batch_id, kind, item, automation_id, automation_name) values ($1, gen_random_uuid(), 'lock', 'tab:pricing', $2, 'ZZ')`, [rec, auto]);
      await as(uw, () => q(`select record_file_upload($1, $2, 'b.pdf', 1)`, [bank, `zz/${randomUUID()}`]));
      expect((await one<{ n: number }>(`select count(*)::int n from automation_queue where automation_id = $1`, [auto])).n).toBe(0);
      await q(`update record_restrictions set lifted_at = clock_timestamp() where record_id = $1`, [rec]);
      await as(cs, () => q(`select record_file_upload($1, $2, 'c.pdf', 1)`, [bank, `zz/${randomUUID()}`]));
      expect((await one<{ n: number }>(`select count(*)::int n from automation_queue where automation_id = $1`, [auto])).n).toBe(1);
    });

    it('the whole way through: upload → run → the item is locked, logged and in the run history', async () => {
      const rec = await record();
      const bank = await rowId(rec, 'Bank statements');
      await as(sales, () => q(`select record_file_upload($1, $2, 'go.pdf', 1)`, [bank, `zz/${randomUUID()}`]));
      await q(`delete from automation_queue where record_id <> $1`, [rec]);
      await q(`update automation_queue set not_before = now() - interval '1 second' where record_id = $1`, [rec]);
      await q(`select * from automation_work(50)`);
      await q(`select set_config('tapdash.automation', '', true), set_config('tapdash.event_actor', '', true)`);
      const runRow = await one<{ status: string; id: string }>(`select status, id from automation_runs where automation_id = $1 and record_id = $2`, [a, rec]);
      expect(runRow.status).toBe('completed');
      expect(await tabGrant(sales, rec, 'pricing')).toBe('view');
      const step = await one<{ detail: string }>(`select detail from automation_run_steps where run_id = $1 order by at desc limit 1`, [runRow.id]);
      expect(step.detail).toBe('Locked: Pricing.');
    });
  });
});
