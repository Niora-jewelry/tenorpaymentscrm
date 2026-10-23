/**
 * @mentions and notifications, end to end in the database.
 *
 * The client's build plan (20 Oct 2026) is mostly rules about WHO may be
 * mentioned where, what a notification carries, and when it disappears. All
 * of that lives in SQL (`mention_candidates`, the `*_with_mentions` RPCs,
 * `notification_visible`), so this is where it is proved — against the real
 * database, inside one transaction that is rolled back at the end. Nothing
 * here is ever committed: the probe records, grants, mutes and notifications
 * all vanish with the ROLLBACK.
 *
 * Actors are borrowed, not made: `admin@tapdash.test`, a second active admin,
 * and `demo.rep@tapdash.test` (the non-admin, which is the whole point — an
 * admin passes every permission check by design).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const DB_URL = process.env.SUPABASE_DB_URL;
const suite = DB_URL ? describe : describe.skip;

let db: pg.Client;
let admin: string;
let admin2: string | null;
let member: string;
let memberName: string;
let leads: string;
let einField: string;
let einTab: string;
let einSubtab: string | null;
let updatesTab: string;
let rec: string;
let savepoint = 0;

type Row = Record<string, unknown>;

async function as<T = Row>(userId: string, sql: string, params: unknown[] = []): Promise<T[]> {
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

async function owner<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  await db.query('reset role');
  const { rows } = await db.query(sql, params);
  return rows as T[];
}

const candidates = async (who: string, scope: string) =>
  (await as<{ ids: string[] }>(who, `select mention_candidates($1, $2) as ids`, [rec, scope]))[0].ids;

const unread = async (who: string) => (await as<{ mentions: number; phone: number }>(who, `select * from my_unread_counts()`))[0];

const notifsFor = (recipient: string, where = 'true') =>
  owner<Row>(`select * from notifications where recipient_id = $1 and record_id = $2 and ${where} order by created_at`, [recipient, rec]);

async function makeRecord(name: string): Promise<string> {
  const [r] = await owner<{ id: string }>(
    `insert into records (deal_name, creator_kind, creator_user_id, "values")
     values ($1, 'user', $2, jsonb_build_object('team_members_assigned', jsonb_build_array($3::text), 'ein', '12-3456789'))
     returning id`,
    [name, admin, member],
  );
  await owner(`insert into record_modules (record_id, module_id, added_by) values ($1, $2, $3)`, [r.id, leads, admin]);
  return r.id;
}

suite('@mentions — who, what and when', () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false }, statement_timeout: 120_000 });
    await db.connect();
    await db.query('BEGIN');

    const people = await owner<{ id: string; email: string; is_admin: boolean; name: string }>(
      `select p.id, p.email::text, r.is_admin, coalesce(p.full_name, p.email::text) as name
         from profiles p join roles r on r.id = p.role_id
        where p.deleted_at is null and p.status = 'active'`,
    );
    const a = people.find((p) => p.email === 'admin@tapdash.test');
    const m = people.find((p) => p.email === 'demo.rep@tapdash.test');
    if (!a || !m || m.is_admin) throw new Error('needs admin@tapdash.test and a non-admin demo.rep@tapdash.test');
    admin = a.id;
    member = m.id;
    memberName = m.name;
    admin2 = people.find((p) => p.is_admin && p.id !== admin)?.id ?? null;

    leads = (await owner<{ id: string }>(`select id from modules where slug = 'leads'`))[0].id;
    const [ein] = await owner<{ id: string; tab_id: string; subtab_id: string | null }>(`select id, tab_id, subtab_id from fields where key = 'ein'`);
    einField = ein.id;
    einTab = ein.tab_id;
    einSubtab = ein.subtab_id;
    updatesTab = (await owner<{ id: string }>(`select id from tabs where key = 'updates'`))[0].id;

    // EIN is marked sensitive in the live configuration, which (correctly)
    // withholds its values from every mention. The value cases below need a
    // plain field, so it is plain for this transaction; one case flips it
    // back to prove the sensitive rule.
    await owner(`update fields set sensitive = false where id = $1`, [einField]);

    rec = await makeRecord('ZZ mention probe');
    // The test member's template hides every ordinary module (and the EIN's
    // sub-tab); open Leads and the whole chain down to this field for the
    // run. A field is visible only if its module, tab and sub-tab are — the
    // same resolver the product uses. All inside the transaction.
    await owner(
      `insert into user_grants (user_id, scope_kind, scope_id, grant_level) values ($1, 'module', $2, 'edit')
       on conflict (user_id, scope_kind, scope_id, module_id) do update set grant_level = 'edit'`,
      [member, leads],
    );
    await owner(
      `insert into user_grants (user_id, scope_kind, scope_id, grant_level, module_id) values ($1, 'tab', $2, 'edit', $3)
       on conflict (user_id, scope_kind, scope_id, module_id) do update set grant_level = 'edit'`,
      [member, einTab, leads],
    );
    if (einSubtab) {
      await owner(
        `insert into user_grants (user_id, scope_kind, scope_id, grant_level, module_id) values ($1, 'subtab', $2, 'edit', $3)
         on conflict (user_id, scope_kind, scope_id, module_id) do update set grant_level = 'edit'`,
        [member, einSubtab, leads],
      );
    }
    await owner(
      `insert into user_grants (user_id, scope_kind, scope_id, grant_level, module_id) values ($1, 'field', $2, 'edit', $3)
       on conflict (user_id, scope_kind, scope_id, module_id) do update set grant_level = 'edit'`,
      [member, einField, leads],
    );
  });

  afterAll(async () => {
    if (!db) return;
    await db.query('ROLLBACK');
    await db.end();
  });

  // ── Who may be mentioned ──────────────────────────────────────────────
  it('the pool is admins plus the team, never yourself', async () => {
    const asAdmin = await candidates(admin, 'updates');
    expect(asAdmin).toContain(member);
    expect(asAdmin).not.toContain(admin);
    if (admin2) expect(asAdmin).toContain(admin2);

    const asMember = await candidates(member, 'updates');
    expect(asMember).toContain(admin);
    expect(asMember).not.toContain(member);
  });

  it('a person who cannot see the field is not offered for it, but still for updates', async () => {
    expect(await candidates(admin, 'field:ein')).toContain(member);
    await owner(`update user_grants set grant_level = 'hidden' where user_id = $1 and scope_kind = 'field' and scope_id = $2`, [member, einField]);
    expect(await candidates(admin, 'field:ein')).not.toContain(member);
    expect(await candidates(admin, 'updates')).toContain(member);
    await owner(`update user_grants set grant_level = 'edit' where user_id = $1 and scope_kind = 'field' and scope_id = $2`, [member, einField]);
  });

  it('a hidden Updates tab removes a person from update mentions only', async () => {
    await owner(
      `insert into user_grants (user_id, scope_kind, scope_id, grant_level, module_id) values ($1, 'tab', $2, 'hidden', $3)`,
      [member, updatesTab, leads],
    );
    expect(await candidates(admin, 'updates')).not.toContain(member);
    expect(await candidates(admin, 'cases')).toContain(member);
    await owner(`delete from user_grants where user_id = $1 and scope_kind = 'tab' and scope_id = $2`, [member, updatesTab]);
  });

  it('a suspended person is never offered', async () => {
    await owner(`update profiles set status = 'suspended' where id = $1`, [member]);
    expect(await candidates(admin, 'updates')).not.toContain(member);
    await owner(`update profiles set status = 'active' where id = $1`, [member]);
  });

  it('an unknown scope and an invisible record are refused', async () => {
    await expect(candidates(admin, 'bogus')).rejects.toThrow(/Unknown mention scope/);
    const [stranger] = await owner<{ id: string }>(
      `select p.id from profiles p join roles r on r.id = p.role_id
        where not r.is_admin and p.status = 'active' and p.deleted_at is null and p.id <> $1 limit 1`,
      [member],
    );
    if (stranger) await expect(candidates(stranger.id, 'updates')).rejects.toThrow(/not found/);
  });

  // ── Update mentions ───────────────────────────────────────────────────
  let updateId: string;
  it('an update mention notifies the valid people once; self and strangers are dropped', async () => {
    const stray = '00000000-0000-4000-8000-000000000000';
    const [r] = await as<{ id: string }>(
      admin,
      `select add_update_with_mentions($1, $2, null, $3::uuid[]) as id`,
      [rec, `@${memberName} please look`, [member, member, admin, stray]],
    );
    updateId = r.id;
    const rows = await notifsFor(member, `update_id = '${updateId}'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].source_kind).toBe('mention_update');
    expect(rows[0].actor_id).toBe(admin);
    expect(rows[0].preview).toContain('please look');
    expect(await notifsFor(admin)).toHaveLength(0);
    const tagged = await owner(`select user_id from update_mentions where update_id = $1`, [updateId]);
    expect(tagged.map((t) => t.user_id)).toEqual([member]);
    expect((await unread(member)).mentions).toBe(1);
  });

  it('editing an update notifies only the people added, and revokes those removed', async () => {
    if (!admin2) return;
    await as(admin, `select edit_update_with_mentions($1, $2, $3::uuid[])`, [updateId, 'now for someone else', [admin2]]);
    const mine = await notifsFor(member, `update_id = '${updateId}'`);
    expect(mine).toHaveLength(1);
    expect(mine[0].revoked_at).not.toBeNull();
    const theirs = await notifsFor(admin2, `update_id = '${updateId}'`);
    expect(theirs).toHaveLength(1);
    expect(theirs[0].revoked_at).toBeNull();
    expect((await unread(member)).mentions).toBe(0);
    // Mentioning them again re-uses the row: no duplicate, and it is live again.
    await as(admin, `select edit_update_with_mentions($1, $2, $3::uuid[])`, [updateId, `back to @${memberName}`, [member]]);
    const again = await notifsFor(member, `update_id = '${updateId}'`);
    expect(again).toHaveLength(1);
    expect(again[0].revoked_at).toBeNull();
  });

  it('deleting the update removes its mentions', async () => {
    await as(admin, `select delete_update($1)`, [updateId]);
    const rows = await notifsFor(member, `update_id = '${updateId}'`);
    expect(rows.every((r) => r.revoked_at !== null)).toBe(true);
    expect((await unread(member)).mentions).toBe(0);
  });

  // ── Case replies ──────────────────────────────────────────────────────
  it('a case reply mention notifies, and deleting the case removes it', async () => {
    const [c] = await as<{ id: string }>(admin, `select create_case($1, 'Probe case', 'Something is off', '{}'::uuid[]) as id`, [rec]);
    const [reply] = await as<{ id: string }>(admin, `select add_case_reply_with_mentions($1, $2, $3::uuid[]) as id`, [
      c.id,
      `@${memberName} can you check`,
      [member, admin],
    ]);
    const rows = await notifsFor(member, `case_reply_id = '${reply.id}'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].source_kind).toBe('mention_case_reply');
    expect(rows[0].preview).toMatch(/^Case #\d+: /);
    expect((await unread(member)).mentions).toBe(1);
    const mine = await as<{ case_id: string; tab_key: string }>(member, `select case_id, tab_key from my_record_mentions($1)`, [rec]);
    expect(mine[0].case_id).toBe(c.id);
    expect(mine[0].tab_key).toBe('cases');

    await as(admin, `select delete_case($1)`, [c.id]);
    expect((await unread(member)).mentions).toBe(0);
  });

  // ── Field mentions ────────────────────────────────────────────────────
  let fieldNotif: string;
  it('a field mention carries the note, the value, and the sender’s own recent change', async () => {
    await owner(
      `insert into record_activity (record_id, actor_id, kind, field_key, summary, from_value, to_value)
       values ($1, $2, 'field', 'ein', 'EIN changed', '11-1111111', '12-3456789')`,
      [rec, admin],
    );
    const [{ n }] = await as<{ n: number }>(admin, `select mention_field($1, 'ein', $2::uuid[], '  Please verify  ', true) as n`, [rec, [member]]);
    expect(n).toBe(1);
    const [row] = await notifsFor(member, `field_key = 'ein'`);
    fieldNotif = row.id as string;
    expect(row.note).toBe('Please verify');
    expect(row.current_value).toBe('12-3456789');
    expect(row.previous_value).toBe('11-1111111');
    expect(row.preview).toBe('EIN — Please verify');
    const mine = await as<{ field_key: string; tab_key: string; subtab_key: string | null }>(member, `select field_key, tab_key, subtab_key from my_record_mentions($1)`, [rec]);
    expect(mine[0].field_key).toBe('ein');
    expect(mine[0].tab_key).toBeTruthy();
  });

  it('the previous value is withheld when unticked, when the change is someone else’s, or when the field is sensitive', async () => {
    await as(admin, `select mention_field($1, 'ein', $2::uuid[], 'unticked', false)`, [rec, [member]]);
    const [a] = await notifsFor(member, `note = 'unticked'`);
    expect(a.previous_value).toBeNull();
    expect(a.current_value).toBe('12-3456789');

    if (admin2) {
      await as(admin2, `select mention_field($1, 'ein', $2::uuid[], 'not my change', true)`, [rec, [member]]);
      const [b] = await notifsFor(member, `note = 'not my change'`);
      expect(b.previous_value).toBeNull();
    }

    await owner(`update fields set sensitive = true where id = $1`, [einField]);
    await as(admin, `select mention_field($1, 'ein', $2::uuid[], 'sensitive', true)`, [rec, [member]]);
    const [c] = await notifsFor(member, `note = 'sensitive'`);
    expect(c.current_value).toBeNull();
    expect(c.previous_value).toBeNull();
    await owner(`update fields set sensitive = false where id = $1`, [einField]);
  });

  it('a field mention is posted to Updates as a read-only entry by the sender, with the field on it', async () => {
    const rows = await owner(`select * from updates where record_id = $1 and deleted_at is null and field_key is not null order by created_at`, [rec]);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const first = rows[0];
    expect(first.body).toBe('Please verify');
    expect(first.author_id).toBe(admin);
    expect(String(first.field_key).toLowerCase()).toBe('ein');
    expect((await owner(`select user_id from update_mentions where update_id = $1`, [first.id])).map((r) => r.user_id)).toEqual([member]);
    const [n] = await owner(`select update_id from notifications where id = $1`, [fieldNotif]);
    expect(n.update_id).toBe(first.id);
    // The alert still lands on the FIELD, not on the Updates tab.
    const mine = await as<{ update_id: string; tab_key: string }>(member, `select update_id, tab_key from my_record_mentions($1) where id = $2`, [rec, fieldNotif]);
    expect(mine[0].update_id).toBe(first.id);
    expect(mine[0].tab_key).not.toBe('updates');
    // The member can read the entry (they may see the field)…
    expect(await as(member, `select 1 from updates where id = $1`, [first.id])).toHaveLength(1);
    // …and it cannot be edited, only removed.
    await expect(as(admin, `select edit_update_with_mentions($1, 'rewritten', '{}'::uuid[])`, [first.id])).rejects.toMatchObject({ code: '42501' });
    const [unticked] = await owner(`select n.id, n.update_id from notifications n where n.recipient_id = $1 and n.record_id = $2 and n.note = 'unticked'`, [member, rec]);
    await as(admin, `select delete_update($1)`, [unticked.update_id]);
    const [after] = await owner(`select revoked_at from notifications where id = $1`, [unticked.id]);
    expect(after.revoked_at).not.toBeNull();
    expect(await as(member, `select 1 from my_record_mentions($1) where id = $2`, [rec, unticked.id])).toHaveLength(0);
  });

  it('a field-mention entry is absent for a viewer whose grant hides the field', async () => {
    await owner(`update user_grants set grant_level = 'hidden' where user_id = $1 and scope_kind = 'field' and scope_id = $2`, [member, einField]);
    expect(await as(member, `select 1 from updates where record_id = $1 and field_key is not null`, [rec])).toHaveLength(0);
    await owner(`update user_grants set grant_level = 'edit' where user_id = $1 and scope_kind = 'field' and scope_id = $2`, [member, einField]);
    expect((await as(member, `select 1 from updates where record_id = $1 and field_key is not null`, [rec])).length).toBeGreaterThanOrEqual(1);
  });

  it('a note over 500 characters and a hidden field are refused', async () => {
    await expect(as(admin, `select mention_field($1, 'ein', $2::uuid[], repeat('x', 501), false)`, [rec, [member]])).rejects.toThrow(/500/);
    await owner(
      `insert into user_grants (user_id, scope_kind, scope_id, grant_level, module_id) values ($1, 'field', $2, 'hidden', $3)
       on conflict (user_id, scope_kind, scope_id, module_id) do update set grant_level = 'hidden'`,
      [member, einField, leads],
    );
    await expect(as(member, `select mention_field($1, 'ein', $2::uuid[], null, false)`, [rec, [admin]])).rejects.toThrow(/not found/);
    await owner(`update user_grants set grant_level = 'edit' where user_id = $1 and scope_kind = 'field' and scope_id = $2`, [member, einField]);
  });

  // ── Opening and marking ───────────────────────────────────────────────
  it('opening shows the previous value once, then it is gone; mark read/unread never touches it', async () => {
    const [opened] = await as<Row>(member, `select * from notification_open($1)`, [fieldNotif]);
    expect(opened.previous_value).toBe('11-1111111');
    expect(opened.read_at).not.toBeNull();
    const [after] = await owner(`select read_at, opened_at, previous_value from notifications where id = $1`, [fieldNotif]);
    expect(after.read_at).not.toBeNull();
    expect(after.opened_at).not.toBeNull();
    expect(after.previous_value).toBeNull();

    const [{ n }] = await as<{ n: number }>(member, `select notifications_mark($1::uuid[], false) as n`, [[fieldNotif]]);
    expect(n).toBe(1);
    const [back] = await owner(`select read_at, previous_value from notifications where id = $1`, [fieldNotif]);
    expect(back.read_at).toBeNull();
    expect(back.previous_value).toBeNull();
  });

  it('someone else cannot open or mark my notification', async () => {
    if (!admin2) return;
    const opened = await as<Row>(admin2, `select * from notification_open($1)`, [fieldNotif]);
    expect(opened).toHaveLength(0);
    const [{ n }] = await as<{ n: number }>(admin2, `select notifications_mark($1::uuid[], true) as n`, [[fieldNotif]]);
    expect(n).toBe(0);
    const [{ read_at }] = await owner(`select read_at from notifications where id = $1`, [fieldNotif]);
    expect(read_at).toBeNull();
  });

  it('the client has no direct update on notifications', async () => {
    await expect(as(member, `update notifications set read_at = now() where id = $1`, [fieldNotif])).rejects.toMatchObject({ code: '42501' });
  });

  it('mark all read clears only the given kinds', async () => {
    await owner(`select notify($1, 'missed call', $2, 'call')`, [member, rec]);
    const before = await unread(member);
    expect(before.phone).toBeGreaterThanOrEqual(1);
    expect(before.mentions).toBeGreaterThanOrEqual(1);
    await as(member, `select notifications_mark_all_read($1::text[])`, [['call', 'voicemail', 'recording', 'sms']]);
    const mid = await unread(member);
    expect(mid.phone).toBe(0);
    expect(mid.mentions).toBe(before.mentions);
    await as(member, `select notifications_mark_all_read(null)`);
    expect((await unread(member)).mentions).toBe(0);
    await as(member, `select notifications_mark($1::uuid[], false)`, [[fieldNotif]]);
  });

  it('the list filters by read state and pages by cursor', async () => {
    const all = await as<Row>(member, `select id, read_at, record_name from notifications_list('all', null, null, 30)`);
    const unreadRows = await as<Row>(member, `select id from notifications_list('unread', null, null, 30)`);
    const readRows = await as<Row>(member, `select id from notifications_list('read', null, null, 30)`);
    expect(unreadRows.length + readRows.length).toBe(all.length);
    expect(unreadRows.map((r) => r.id)).toContain(fieldNotif);
    expect(all[0].record_name).toBe('ZZ mention probe');
    const page1 = await as<Row>(member, `select id, created_at from notifications_list('all', null, null, 1)`);
    const page2 = await as<Row>(member, `select id from notifications_list('all', $1, $2, 1)`, [page1[0].created_at, page1[0].id]);
    expect(page2[0]?.id).not.toBe(page1[0].id);
  });

  // ── Mute ──────────────────────────────────────────────────────────────
  it('a muted record produces no notification for that person, and unmuting does not resurrect it', async () => {
    await as(member, `insert into notification_mutes (user_id, record_id) values (auth.uid(), $1)`, [rec]);
    const [{ n }] = await as<{ n: number }>(admin, `select mention_field($1, 'ein', $2::uuid[], 'while muted', false) as n`, [rec, [member]]);
    expect(n).toBe(0);
    expect(await notifsFor(member, `note = 'while muted'`)).toHaveLength(0);
    // …and no feed entry either: nobody was alerted, so there is nothing to record.
    expect(await owner(`select 1 from updates where record_id = $1 and body = 'while muted'`, [rec])).toHaveLength(0);
    await as(member, `delete from notification_mutes where user_id = auth.uid() and record_id = $1`, [rec]);
    expect(await notifsFor(member, `note = 'while muted'`)).toHaveLength(0);
  });

  // ── Disappearing and coming back ──────────────────────────────────────
  it('hidden while the record is in the Recycle Bin, back on restore', async () => {
    const before = (await unread(member)).mentions;
    expect(before).toBeGreaterThanOrEqual(1);
    await owner(`update records set deleted_at = now() where id = $1`, [rec]);
    expect((await unread(member)).mentions).toBe(0);
    await owner(`update records set deleted_at = null where id = $1`, [rec]);
    expect((await unread(member)).mentions).toBe(before);
  });

  it('hidden while archived (in no display module), back when it returns', async () => {
    const before = (await unread(member)).mentions;
    await owner(`delete from record_modules where record_id = $1`, [rec]);
    expect((await unread(member)).mentions).toBe(0);
    await owner(`insert into record_modules (record_id, module_id, added_by) values ($1, $2, $3)`, [rec, leads, admin]);
    expect((await unread(member)).mentions).toBe(before);
  });

  it('hidden once the person loses access to the record', async () => {
    const before = (await unread(member)).mentions;
    await owner(`update records set "values" = "values" || '{"team_members_assigned": []}'::jsonb where id = $1`, [rec]);
    expect((await unread(member)).mentions).toBe(0);
    expect(await as(member, `select * from notification_open($1)`, [fieldNotif])).toHaveLength(0);
    await owner(`update records set "values" = "values" || jsonb_build_object('team_members_assigned', jsonb_build_array($2::text)) where id = $1`, [rec, member]);
    expect((await unread(member)).mentions).toBe(before);
  });

  it('hidden once the field is hidden for the person', async () => {
    const before = (await unread(member)).mentions;
    await owner(`update user_grants set grant_level = 'hidden' where user_id = $1 and scope_kind = 'field' and scope_id = $2`, [member, einField]);
    expect((await unread(member)).mentions).toBeLessThan(before);
    await owner(`update user_grants set grant_level = 'edit' where user_id = $1 and scope_kind = 'field' and scope_id = $2`, [member, einField]);
    expect((await unread(member)).mentions).toBe(before);
  });

  // ── Housekeeping ──────────────────────────────────────────────────────
  it('prune drops rows older than 90 days and revoked rows after a day, nothing else', async () => {
    const [old] = await owner<{ id: string }>(
      `insert into notifications (recipient_id, actor_id, record_id, source_kind, field_key, body, preview, created_at)
       values ($1, $2, $3, 'mention_field', 'ein', 'old', 'old', now() - interval '91 days') returning id`,
      [member, admin, rec],
    );
    const [gone] = await owner<{ id: string }>(
      `insert into notifications (recipient_id, actor_id, record_id, source_kind, field_key, body, preview, revoked_at)
       values ($1, $2, $3, 'mention_field', 'ein', 'revoked', 'revoked', now() - interval '2 days') returning id`,
      [member, admin, rec],
    );
    const [{ n }] = await owner<{ n: number }>(`select notifications_prune() as n`);
    expect(n).toBeGreaterThanOrEqual(2);
    expect(await owner(`select 1 from notifications where id in ($1, $2)`, [old.id, gone.id])).toHaveLength(0);
    expect(await owner(`select 1 from notifications where id = $1`, [fieldNotif])).toHaveLength(1);
  });

  it('purge_record succeeds for a record that has notifications', async () => {
    const other = await makeRecord('ZZ purge probe');
    await as(admin, `select mention_field($1, 'ein', $2::uuid[], 'bye', false)`, [other, [member]]);
    expect(await owner(`select 1 from notifications where record_id = $1`, [other])).toHaveLength(1);
    await owner(`update records set deleted_at = now() where id = $1`, [other]);
    await owner(`select purge_record($1)`, [other]);
    expect(await owner(`select 1 from notifications where record_id = $1`, [other])).toHaveLength(0);
  });

  it('notifications are published for Realtime', async () => {
    const rows = await owner(`select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'notifications'`);
    expect(rows).toHaveLength(1);
  });
});
