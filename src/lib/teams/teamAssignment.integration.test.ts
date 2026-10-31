/**
 * Team Assignment — the database half, one test per rule of the client's spec,
 * each asked as a real signed-in viewer, inside one transaction that is always
 * rolled back. The viewers are made in that transaction, so nothing survives.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const DB_URL = process.env.SUPABASE_DB_URL;
const suite = DB_URL ? describe : describe.skip;
let db: pg.Client;

type Row = Record<string, unknown>;
const q = async <T = Row>(sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows as T[];
const one = async <T = Row>(sql: string, p: unknown[] = []) => (await q<T>(sql, p))[0]!;

type Entry = { teamId: string; label: string; open: boolean | null; people: string[]; canTake: boolean; canUnassign: boolean; canNameMember: boolean };
type View = { locked: boolean; writable: boolean; teams: Entry[] };

suite('Team Assignment', () => {
  const team: Record<string, string> = {};
  let member: string; // the role every viewer is made with
  let admin: string;
  let sales: string;
  let uw1: string;
  let uw2: string;
  let cs: string;
  let leads: string;
  let rec: string;

  /** Run as a signed-in viewer. A refused statement must go through `refused`. */
  const as = async <T>(user: string, fn: () => Promise<T>): Promise<T> => {
    await q(`select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`, [JSON.stringify({ sub: user, role: 'authenticated' })]);
    try {
      return await fn();
    } finally {
      await q(`select set_config('request.jwt.claims', '', true), set_config('role', 'none', true)`);
    }
  };
  const refused = async (user: string, sql: string, p: unknown[], code: string) => {
    await q('savepoint s');
    let got: string | undefined;
    await q(`select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`, [JSON.stringify({ sub: user, role: 'authenticated' })]);
    try {
      await q(sql, p);
    } catch (e) {
      got = (e as { code?: string }).code;
    }
    await q('rollback to savepoint s');
    await q(`select set_config('request.jwt.claims', '', true), set_config('role', 'none', true)`);
    expect(got).toBe(code);
  };
  const newUser = async (name: string, type: string) => {
    const id = randomUUID();
    const email = `zz-${id.slice(0, 8)}@tapdash.test`;
    await q(`insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')`, [id, email]);
    await q(
      `insert into profiles (id, email, full_name, role_id, status) values ($1, $2, $3, $4, 'active')
       on conflict (id) do update set full_name = excluded.full_name, role_id = excluded.role_id, status = 'active'`,
      [id, email, name, member],
    );
    await q(`insert into user_templates (user_id, template_id) values ($1, $2) on conflict (user_id) do update set template_id = excluded.template_id`, [id, team[type]]);
    // Only mine: nothing here is visible through a module's All.
    await q(`insert into permission_settings (owner_kind, owner_id, key, value) values ('user', $1, $2, 'mine')`, [id, `module:${leads}`]);
    return id;
  };
  const setting = (user: string, key: string, value: string) =>
    q(`insert into permission_settings (owner_kind, owner_id, key, value) values ('user', $1, $2, $3)
       on conflict (owner_kind, owner_id, key) do update set value = excluded.value`, [user, key, value]);
  const clearSetting = (user: string, key: string) => q(`delete from permission_settings where owner_kind = 'user' and owner_id = $1 and key = $2`, [user, key]);
  const view = async (user: string, id = rec): Promise<View | undefined> =>
    as(user, async () => (await q<View>(`select locked, writable, teams from team_assignment_view($1)`, [[id]]))[0]);
  const entry = async (user: string, label: string) => (await view(user))?.teams.find((t) => t.label === label);
  const field = async (id = rec) => (await one<{ v: string[] | null }>(`select values -> 'team_members_assigned' as v from records where id = $1`, [id])).v ?? [];
  const row = (id = rec, t = team.underwriter) => q<{ taken_by: string | null }>(`select taken_by from record_team_assignments where record_id = $1 and team_id = $2`, [id, t]);
  const updates = (id = rec) => q<{ body: string }>(`select body from updates where record_id = $1 order by created_at, body`, [id]);
  const freshRecord = async (name: string) => {
    const r = (await one<{ id: string }>(`insert into records (deal_name, creator_user_id, values) values ($1, $2, '{}'::jsonb) returning id`, [name, admin])).id;
    await q(`insert into record_modules (record_id, module_id) values ($1, $2)`, [r, leads]);
    return r;
  };

  beforeAll(async () => {
    db = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false }, statement_timeout: 120_000 });
    await db.connect();
    await db.query('BEGIN');
    admin = (await one<{ id: string }>(`select id from profiles where email = 'admin@tapdash.test'`)).id;
    member = (await one<{ id: string }>(`select id from roles where not is_admin order by name limit 1`)).id;
    leads = (await one<{ id: string }>(`select id from modules where slug = 'leads'`)).id;
    for (const t of await q<{ id: string; user_type: string }>(`select id, user_type from permission_templates where user_type is not null`)) team[t.user_type] = t.id;
    sales = await newUser('ZZ Sales', 'sales_agent');
    uw1 = await newUser('ZZ Underwriter One', 'underwriter');
    uw2 = await newUser('ZZ Underwriter Two', 'underwriter');
    cs = await newUser('ZZ Service', 'customer_service');
    rec = await freshRecord('ZZ team probe');
  }, 120_000);

  afterAll(async () => {
    if (db) {
      await db.query('ROLLBACK');
      await db.end();
    }
  });

  it('the defaults are the spec’s table', async () => {
    const rows = await q<{ user_type: string; key: string; value: string }>(
      `select pt.user_type, ps.key, ps.value from permission_settings ps join permission_templates pt on pt.id = ps.owner_id
        where ps.owner_kind = 'template' and pt.user_type is not null and (ps.key like 'team.%' or ps.key like 'action.team_%')`,
    );
    const stored = new Map(rows.map((r) => [`${r.user_type}|${r.key}`, r.value]));
    const value = (type: string, key: string) => stored.get(`${type}|${key}`);
    const SALES: Record<string, string[]> = {
      assign: ['underwriter', 'customer_service', 'sales_agent'],
      assign_member: [],
      unassign: ['customer_service'],
      see_open: [],
      see_team: ['underwriter', 'customer_service', 'sales_agent'],
      see_users: ['customer_service', 'sales_agent'],
    };
    for (const [setting_, yes] of Object.entries(SALES)) {
      for (const t of Object.keys(team)) {
        expect(value('sales_agent', `team.${t}.${setting_}`), `${t} ${setting_}`).toBe(yes.includes(t) ? 'yes' : 'no');
        for (const other of ['super_admin', 'admin', 'underwriter', 'accounting', 'customer_service']) {
          expect(value(other, `team.${t}.${setting_}`)).toBe('yes');
        }
      }
    }
    expect(value('sales_agent', 'action.team_view_open')).toBe('no');
    expect(value('sales_agent', 'action.team_take')).toBe('yes');
    expect(value('underwriter', 'action.team_view_open')).toBe('yes');
  });

  it('rule 2: the picker holds only what the viewer can assign, and no people without the setting', async () => {
    const options = await as(sales, async () => (await one<{ o: { label: string; members: string[]; own: boolean }[] }>(`select team_assign_options() o`)).o);
    expect(options.map((o) => o.label)).toEqual(['Underwriting', 'Customer service', 'Sales agent']);
    expect(options.every((o) => o.members.length === 0)).toBe(true);
    expect(options.find((o) => o.own)?.label).toBe('Sales agent');
  });

  it('assigning a team leaves it Open, for any number of teams, and writes the Updates tab', async () => {
    await as(admin, () => q(`select assign_team($1, $2)`, [rec, team.underwriter]));
    await as(admin, () => q(`select assign_team($1, $2)`, [rec, team.customer_service]));
    expect((await view(admin))?.teams.map((t) => [t.label, t.open])).toEqual([['Underwriting', true], ['Customer service', true]]);
    expect((await updates()).map((u) => u.body)).toEqual(['Assigned the Customer service team.', 'Assigned the Underwriting team.']);
    await refused(admin, `select assign_team($1, $2)`, [rec, team.underwriter], '23505');
  });

  it('rule 1: a user can always assign their own team, whatever their settings say', async () => {
    const r = await freshRecord('ZZ own team');
    await q(`update records set values = jsonb_build_object('team_members_assigned', jsonb_build_array($2::text)) where id = $1`, [r, sales]);
    await q(`delete from record_team_assignments where record_id = $1`, [r]);
    await setting(sales, `team.sales_agent.assign`, 'no');
    await as(sales, () => q(`select assign_team($1, $2)`, [r, team.sales_agent]));
    await clearSetting(sales, `team.sales_agent.assign`);
    await refused(sales, `select assign_team($1, $2)`, [r, team.accounting], '42501');
  });

  it('assigning sends no notification', async () => {
    expect((await one<{ n: number }>(`select count(*)::int n from notifications where record_id = $1`, [rec])).n).toBe(0);
  });

  it('without See open records, an open record stays out of sight', async () => {
    expect(await view(sales)).toBeUndefined();
    expect(await as(sales, async () => (await one<{ v: boolean }>(`select record_visible($1) v`, [rec])).v)).toBe(false);
    expect(await as(sales, () => q(`select id from records where id = $1`, [rec]))).toHaveLength(0);
  });

  it('See open records without Can view open items: in the list, not openable, and nothing else readable', async () => {
    await setting(uw1, 'action.team_view_open', 'no');
    const v = await view(uw1);
    expect(v?.locked).toBe(true);
    expect(await as(uw1, () => q(`select id from records where id = $1`, [rec]))).toHaveLength(1);
    expect(await as(uw1, () => q(`select id from records_filterable where id = $1`, [rec]))).toHaveLength(1);
    expect(await as(uw1, () => q(`select module_id from record_modules where record_id = $1`, [rec]))).toHaveLength(1);
    expect(await as(uw1, async () => (await one<{ v: boolean }>(`select record_visible($1) v`, [rec])).v)).toBe(false);
    expect(await as(uw1, () => q(`select id from updates where record_id = $1`, [rec]))).toHaveLength(0);
    expect(await as(uw1, () => q(`select id from record_activity where record_id = $1`, [rec]))).toHaveLength(0);
    expect(v?.teams.find((t) => t.label === 'Underwriting')?.canTake).toBe(true);
  });

  it('Can view open items: opens it, read only until taken', async () => {
    await clearSetting(uw1, 'action.team_view_open');
    const v = await view(uw1);
    expect(v?.locked).toBe(false);
    expect(v?.writable).toBe(false);
    expect(v?.teams.find((t) => t.label === 'Underwriting')?.canUnassign).toBe(false);
    expect(await as(uw1, async () => (await one<{ ids: string[] }>(`select records_read_only($1) ids`, [[rec]])).ids)).toEqual([rec]);
    expect(await as(admin, async () => (await one<{ ids: string[] }>(`select records_read_only($1) ids`, [[rec]])).ids)).toEqual([]);
    await refused(uw1, `select * from set_record_value($1, 'mcc_code', '"5812"', now(), 's')`, [rec], 'P0001');
    await refused(uw1, `select add_update_with_mentions($1, 'hi', null, '{}')`, [rec], 'P0001');
  });

  it('every write function that skips the grants asks record_writable', async () => {
    const names = [
      'add_case_reply', 'add_case_reply_with_mentions', 'add_update_with_mentions', 'clear_pipeline', 'create_case', 'delete_file', 'delete_note',
      'delete_record', 'delete_statement_file', 'delete_update', 'edit_note', 'edit_update', 'edit_update_with_mentions', 'ensure_case_file_row',
      'grant_item_access', 'mention_field', 'record_file_upload', 'revoke_item_access', 'set_case_solution', 'set_pipeline_step',
      'set_record_memberships', 'set_record_value', 'set_record_values', 'statement_file_upload', 'store_login_password', 'toggle_case_state',
    ];
    const rows = await q<{ proname: string; ok: boolean }>(
      `select proname, prosrc ~ '\\mrecord_writable\\(' and prosrc !~ '\\mrecord_visible\\(' as ok from pg_proc where proname = any($1) and pronamespace = 'public'::regnamespace`,
      [names],
    );
    expect(rows.filter((r) => !r.ok).map((r) => r.proname)).toEqual([]);
    expect(new Set(rows.map((r) => r.proname)).size).toBe(names.length);
  });

  it('Assign to me: only a member of the team, with Can take open items', async () => {
    expect((await entry(uw1, 'Customer service'))?.canTake).toBe(false);
    await refused(uw1, `select take_team_assignment($1, $2)`, [rec, team.customer_service], '42501');
    await setting(uw1, 'action.team_take', 'no');
    expect((await entry(uw1, 'Underwriting'))?.canTake).toBe(false);
    await refused(uw1, `select take_team_assignment($1, $2)`, [rec, team.underwriter], '42501');
    await clearSetting(uw1, 'action.team_take');
  });

  it('taking it makes the taker a team member on the record, and it is no longer open', async () => {
    await as(uw1, () => q(`select take_team_assignment($1, $2)`, [rec, team.underwriter]));
    expect((await row())[0]?.taken_by).toBe(uw1);
    expect(await field()).toEqual([uw1]);
    expect(await q(`select 1 from record_team_members where record_id = $1 and user_id = $2`, [rec, uw1])).toHaveLength(1);
    const e = await entry(admin, 'Underwriting');
    expect(e?.open).toBe(false);
    expect(e?.people).toEqual([uw1]);
    expect((await updates()).map((u) => u.body)).toContain('ZZ Underwriter One took the Underwriting assignment.');
    expect((await view(uw1))?.writable).toBe(true);
    expect((await one<{ n: number }>(`select count(*)::int n from notifications where record_id = $1`, [rec])).n).toBe(0);
  });

  it('one person per team: nobody else can take it until it is unassigned', async () => {
    await refused(uw2, `select take_team_assignment($1, $2)`, [rec, team.underwriter], '23505');
  });

  it('after it is taken, the normal rules decide who opens it', async () => {
    expect(await view(uw2)).toBeDefined(); // Customer service is still open, and uw2 sees it…
    await as(admin, () => q(`select unassign_team($1, $2)`, [rec, team.customer_service]));
    expect(await view(uw2)).toBeUndefined(); // …and with nothing open, they are out.
    await as(admin, () => q(`select assign_team($1, $2)`, [rec, team.customer_service]));
  });

  it('hidden: a team the viewer cannot see leaves no trace', async () => {
    await q(`update records set values = values || jsonb_build_object('team_members_assigned', jsonb_build_array($2::text, $3::text)) where id = $1`, [rec, uw1, sales]);
    const v = await view(sales);
    expect(v?.teams.map((t) => t.label)).toEqual(['Underwriting', 'Customer service', 'Sales agent']);
    await setting(sales, 'team.customer_service.see_team', 'no');
    expect((await view(sales))?.teams.map((t) => t.label)).toEqual(['Underwriting', 'Sales agent']);
    await clearSetting(sales, 'team.customer_service.see_team');
  });

  it('hidden: the team without its users shows no person and no hint of whether it is taken', async () => {
    const e = await entry(sales, 'Underwriting');
    expect(e?.people).toEqual([]);
    expect(e?.open).toBeNull();
  });

  it('hidden: the person is not in the values either, by any read', async () => {
    const values = await as(sales, async () => (await one<{ values: Record<string, unknown> }>(`select "values" from record_values_for($1)`, [[rec]])).values);
    expect(values.team_members_assigned).toEqual([sales]);
    const row_ = await as(sales, () => one<{ values: Record<string, unknown>; search_text: string }>(`select "values", search_text from records_filterable where id = $1`, [rec]));
    expect(row_.values.team_members_assigned).toEqual([sales]);
    expect(row_.search_text).not.toContain(uw1);
    await setting(sales, 'team.underwriter.see_users', 'yes');
    const again = await as(sales, async () => (await one<{ values: Record<string, unknown> }>(`select "values" from record_values_for($1)`, [[rec]])).values);
    expect(again.team_members_assigned).toEqual([uw1, sales]);
    await clearSetting(sales, 'team.underwriter.see_users');
  });

  it('hidden: the history follows the same rules', async () => {
    await setting(sales, 'items.updates', 'all');
    const bodies = await as(sales, async () => (await q<{ body: string }>(`select body from updates where record_id = $1`, [rec])).map((u) => u.body));
    expect(bodies).toContain('Assigned the Underwriting team.');
    expect(bodies.some((b) => b.includes('ZZ Underwriter One'))).toBe(false);
    const activity = await as(sales, async () => (await q<{ summary: string }>(`select summary from record_activity where record_id = $1 and kind = 'assignment'`, [rec])).map((a) => a.summary));
    expect(activity.some((b) => b.includes('ZZ Underwriter One'))).toBe(false);
    await clearSetting(sales, 'items.updates');
  });

  it('rule 4: See users works only with See team', async () => {
    await setting(sales, 'team.underwriter.see_users', 'yes');
    await setting(sales, 'team.underwriter.see_team', 'no');
    expect(await entry(sales, 'Underwriting')).toBeUndefined();
    await clearSetting(sales, 'team.underwriter.see_users');
    await clearSetting(sales, 'team.underwriter.see_team');
  });

  it('someone who may see open records is told it is open, even without its users', async () => {
    const r = await freshRecord('ZZ open tag');
    await as(admin, () => q(`select assign_team($1, $2)`, [r, team.accounting]));
    await setting(sales, 'team.accounting.see_open', 'yes');
    await setting(sales, 'team.accounting.see_team', 'yes');
    const e = (await view(sales, r))?.teams[0];
    expect(e?.label).toBe('Accounting');
    expect(e?.open).toBe(true);
    expect(e?.people).toEqual([]);
    await clearSetting(sales, 'team.accounting.see_open');
    await clearSetting(sales, 'team.accounting.see_team');
  });

  it('See open records only adds: it never hides what the rules already show', async () => {
    const r = await freshRecord('ZZ all scope');
    await q(`update records set values = jsonb_build_object('team_members_assigned', jsonb_build_array($2::text)) where id = $1`, [r, sales]);
    await as(admin, () => q(`select assign_team($1, $2)`, [r, team.underwriter]));
    expect(await as(sales, async () => (await one<{ v: boolean }>(`select record_visible($1) v`, [r])).v)).toBe(true);
    expect((await view(sales, r))?.writable).toBe(true);
  });

  it('assigning a specific member needs the setting, an active member, and a team not yet taken', async () => {
    const r = await freshRecord('ZZ named');
    await q(`update records set values = jsonb_build_object('team_members_assigned', jsonb_build_array($2::text)) where id = $1`, [r, sales]);
    await refused(sales, `select assign_team_member($1, $2, $3)`, [r, team.underwriter, uw1], '42501');
    await refused(admin, `select assign_team_member($1, $2, $3)`, [r, team.underwriter, cs], '23503');
    await as(admin, () => q(`select assign_team_member($1, $2, $3)`, [r, team.underwriter, uw1]));
    expect((await row(r))[0]?.taken_by).toBe(uw1);
    expect(await field(r)).toEqual([sales, uw1]);
    expect((await updates(r)).map((u) => u.body)).toEqual(['Assigned ZZ Underwriter One from the Underwriting team.']);
    await refused(admin, `select assign_team_member($1, $2, $3)`, [r, team.underwriter, uw2], '23505');
  });

  it('rule 6: removing the person puts it back to Open, and needs Unassign this team', async () => {
    await refused(sales, `select unassign_team_member($1, $2, $3)`, [rec, team.underwriter, uw1], '42501');
    await as(admin, () => q(`select unassign_team_member($1, $2, $3)`, [rec, team.underwriter, uw1]));
    expect((await row())[0]?.taken_by).toBeNull();
    expect(await field()).not.toContain(uw1);
    expect((await entry(admin, 'Underwriting'))?.open).toBe(true);
    expect((await updates()).map((u) => u.body)).toContain('Unassigned ZZ Underwriter One from the Underwriting team.');
  });

  it('rule 6: removing the team takes it off the record entirely, open or taken', async () => {
    await as(uw2, () => q(`select take_team_assignment($1, $2)`, [rec, team.underwriter]));
    await as(admin, () => q(`select unassign_team($1, $2)`, [rec, team.underwriter]));
    expect(await row()).toHaveLength(0);
    expect(await field()).not.toContain(uw2);
    expect((await updates()).map((u) => u.body)).toContain('Unassigned the Underwriting team.');
  });

  it('rule 3: turning on Assign turns on See team, not See users', async () => {
    await setting(sales, 'team.accounting.see_team', 'no');
    await q(`select perm_set_setting($1, 'user', $2, 'team.accounting.assign', 'yes')`, [admin, sales]);
    const got = await q<{ key: string; value: string }>(`select key, value from permission_settings where owner_kind = 'user' and owner_id = $1 and key like 'team.accounting.%' order by key`, [sales]);
    expect(got).toEqual([{ key: 'team.accounting.assign', value: 'yes' }, { key: 'team.accounting.see_team', value: 'yes' }]);
    const audit = await q<{ what: string }>(`select what from permission_audit_log where target_id = $1 and what like 'team.accounting.%' order by what`, [sales]);
    expect(audit.map((a) => a.what)).toEqual(['team.accounting.assign', 'team.accounting.see_team']);
    await clearSetting(sales, 'team.accounting.assign');
    await clearSetting(sales, 'team.accounting.see_team');
  });

  it('a user’s override stays when the type’s default changes', async () => {
    await setting(sales, 'team.accounting.assign', 'yes');
    await q(`update permission_settings set value = 'no' where owner_kind = 'template' and owner_id = $1 and key = 'team.accounting.assign'`, [team.sales_agent]);
    expect((await one<{ v: string }>(`select user_perm($1, 'team.accounting.assign') v`, [sales])).v).toBe('yes');
    await clearSetting(sales, 'team.accounting.assign');
  });

  it('a direct write of the field is held to the same settings', async () => {
    const r = await freshRecord('ZZ direct');
    await q(`update records set values = jsonb_build_object('team_members_assigned', jsonb_build_array($2::text)) where id = $1`, [r, sales]);
    const at = (await one<{ updated_at: string }>(`select updated_at from records where id = $1`, [r])).updated_at;
    await refused(sales, `select * from set_record_value($1, 'team_members_assigned', $2, $3, 's')`, [r, JSON.stringify([sales, uw1]), at], '42501');
    await setting(uw1, 'team.underwriter.assign_member', 'yes');
    await q(`update records set values = jsonb_build_object('team_members_assigned', jsonb_build_array($2::text)) where id = $1`, [r, uw1]);
    await refused(uw1, `update records set values = jsonb_build_object('team_members_assigned', jsonb_build_array($2::text, $3::text)) where id = $1`, [r, uw1, uw2], '42501');
    await clearSetting(uw1, 'team.underwriter.assign_member');
  });

  it('two people from one team, from before this feature: both stay, and the second takes over', async () => {
    const r = await freshRecord('ZZ two');
    await q(`update records set values = jsonb_build_object('team_members_assigned', jsonb_build_array($2::text, $3::text)) where id = $1`, [r, uw1, uw2]);
    expect((await row(r))[0]?.taken_by).toBe(uw1);
    expect((await view(admin, r))?.teams[0]?.people).toEqual([uw1, uw2]);
    await as(admin, () => q(`select unassign_team_member($1, $2, $3)`, [r, team.underwriter, uw1]));
    expect((await row(r))[0]?.taken_by).toBe(uw2);
    await as(admin, () => q(`select unassign_team_member($1, $2, $3)`, [r, team.underwriter, uw2]));
    expect((await row(r))[0]?.taken_by).toBeNull();
  });

  it('a new record’s creator takes their own team', async () => {
    const r = (await one<{ id: string }>(`insert into records (deal_name, creator_user_id, values) values ('ZZ created', $1::uuid, jsonb_build_object('team_members_assigned', jsonb_build_array($1::text))) returning id`, [sales])).id;
    expect((await row(r, team.sales_agent))[0]?.taken_by).toBe(sales);
  });

  it('moving someone to another user type moves their assignment', async () => {
    const r = await freshRecord('ZZ moved');
    await q(`update records set values = jsonb_build_object('team_members_assigned', jsonb_build_array($2::text)) where id = $1`, [r, uw1]);
    await q(`update user_templates set template_id = $2 where user_id = $1`, [uw1, team.accounting]);
    expect((await row(r))[0]?.taken_by).toBeNull();
    expect((await row(r, team.accounting))[0]?.taken_by).toBe(uw1);
    await q(`update user_templates set template_id = $2 where user_id = $1`, [uw1, team.underwriter]);
  });
});
