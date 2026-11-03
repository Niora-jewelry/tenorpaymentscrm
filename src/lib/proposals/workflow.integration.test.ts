/**
 * Proposals — the database half, against the live functions, inside one
 * transaction that is always rolled back.
 *
 *   proposal_viewed    first open only: status, and one line in the history
 *   proposal_approve   "the CRM registers an approval": status, history, a
 *                      notification to the sender and the relationship
 *                      manager (once each, muted ones skipped); once only;
 *                      never on a voided or expired proposal
 *   notifications      a proposal notification opens on the proposals tab and
 *                      counts in the sidebar badge
 *   RLS                no browser role reads the table at all
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

const DB_URL = process.env.SUPABASE_DB_URL;
const suite = DB_URL ? describe : describe.skip;
let db: pg.Client;

const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows as T[];
const one = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await q<T>(sql, p))[0]!;

suite('Proposals — workflow', () => {
  let admin: string;
  let member: string;
  let rec: string;
  let n = 0;

  const proposal = async (status = 'sent', expires = "now() + interval '30 days'") => {
    n += 1;
    return (
      await one<{ id: string; number: number }>(
        `insert into proposals (record_id, token_hash, status, content, recipient, sent_by, expires_at)
         values ($1, decode(md5($2), 'hex'), $3, '{"version":1}'::jsonb, 'owner@zz.test', $4, ${expires}) returning id, number`,
        [rec, `zz-proposal-probe-${n}-${Date.now()}`, status, admin],
      )
    );
  };
  const label = async (num: number) => (await one<{ l: string }>(`select proposal_label($1) l`, [num])).l;
  const notesFor = (id: string, who: string) =>
    q<{ body: string; source_kind: string }>(`select body, source_kind from notifications where record_id = $1 and recipient_id = $2 and source_kind = 'proposal' and body like $3`, [
      rec,
      who,
      `%${id}%`,
    ]);

  beforeAll(async () => {
    db = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false }, statement_timeout: 120_000 });
    await db.connect();
    await db.query('BEGIN');
    admin = (await one<{ id: string }>(`select id from profiles where email = 'admin@tapdash.test'`)).id;
    member = (
      await one<{ id: string }>(
        `select p.id from profiles p join roles r on r.id = p.role_id
          where not r.is_admin and p.deleted_at is null and p.status = 'active' and p.email like '%@tapdash.test' order by p.email limit 1`,
      )
    ).id;
    rec = (
      await one<{ id: string }>(
        `insert into records (deal_name, creator_user_id, values)
         values ('ZZ proposal probe', $1, jsonb_build_object('team_members_assigned', jsonb_build_array($2::text), 'relationship_manager', jsonb_build_array($2::text)))
         returning id`,
        [admin, member],
      )
    ).id;
    await q(`insert into record_modules (record_id, module_id) select $1, id from modules where slug = 'leads'`, [rec]);
  });

  afterAll(async () => {
    if (db) {
      await db.query('ROLLBACK');
      await db.end();
    }
  });

  it('the panel lives on the tab flagged shows_proposals', async () => {
    const t = await one<{ k: string | null }>(`select proposals_tab_key() k`);
    expect(t.k).toBe((await one<{ key: string }>(`select key from tabs where shows_proposals order by position limit 1`)).key);
  });

  it('viewed: first open only, one history line', async () => {
    const p = await proposal();
    await q(`select proposal_viewed($1)`, [p.id]);
    await q(`select proposal_viewed($1)`, [p.id]);
    const row = await one<{ status: string; viewed_at: string | null }>(`select status, viewed_at from proposals where id = $1`, [p.id]);
    expect(row.status).toBe('viewed');
    expect(row.viewed_at).not.toBeNull();
    const lines = await q<{ summary: string }>(`select summary from record_activity where record_id = $1 and kind = 'proposal' and summary like $2`, [
      rec,
      `%${await label(p.number)} opened%`,
    ]);
    expect(lines).toHaveLength(1);
  });

  it('approve: status, history, the sender and the relationship manager told — once', async () => {
    const p = await proposal('viewed');
    const l = await label(p.number);
    expect((await one<{ ok: boolean }>(`select proposal_approve($1, '203.0.113.9', 'zz-agent') ok`, [p.id])).ok).toBe(true);
    const row = await one<{ status: string; approved_at: string | null; approved_ip: string }>(`select status, approved_at, approved_ip from proposals where id = $1`, [p.id]);
    expect(row).toMatchObject({ status: 'approved', approved_ip: '203.0.113.9' });
    expect(row.approved_at).not.toBeNull();

    const history = await q<{ summary: string }>(`select summary from record_activity where record_id = $1 and kind = 'proposal' and summary like $2`, [rec, `%${l} approved%`]);
    expect(history).toHaveLength(1);
    const post = await q<{ actor_label: string | null }>(`select actor_label from updates where record_id = $1 and body like $2`, [rec, `%${l} approved%`]);
    expect(post.map((u) => u.actor_label)).toEqual(['Merchant']);

    expect(await notesFor(l, admin)).toHaveLength(1);
    expect(await notesFor(l, member)).toHaveLength(1);

    // A second click changes nothing.
    expect((await one<{ ok: boolean }>(`select proposal_approve($1, 'x', 'y') ok`, [p.id])).ok).toBe(false);
    expect(await notesFor(l, admin)).toHaveLength(1);
  });

  it('a muted record is not notified', async () => {
    await q(`insert into notification_mutes (user_id, record_id) values ($1, $2) on conflict do nothing`, [member, rec]);
    const p = await proposal();
    const l = await label(p.number);
    await q(`select proposal_approve($1, 'x', 'y')`, [p.id]);
    expect(await notesFor(l, admin)).toHaveLength(1);
    expect(await notesFor(l, member)).toHaveLength(0);
    await q(`delete from notification_mutes where user_id = $1 and record_id = $2`, [member, rec]);
  });

  it('never approves a voided or expired proposal', async () => {
    const voided = await proposal('voided');
    expect((await one<{ ok: boolean }>(`select proposal_approve($1, 'x', 'y') ok`, [voided.id])).ok).toBe(false);
    const expired = await proposal('sent', "now() - interval '1 day'");
    expect((await one<{ ok: boolean }>(`select proposal_approve($1, 'x', 'y') ok`, [expired.id])).ok).toBe(false);
    expect((await one<{ status: string }>(`select status from proposals where id = $1`, [expired.id])).status).toBe('sent');
  });

  it('the notification opens on the proposals tab and counts in the badge', async () => {
    const p = await proposal();
    const l = await label(p.number);
    await q(`select proposal_approve($1, 'x', 'y')`, [p.id]);
    const id = (await one<{ id: string }>(`select id from notifications where recipient_id = $1 and source_kind = 'proposal' and body like $2`, [member, `%${l}%`])).id;
    await q(`select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`, [JSON.stringify({ sub: member, role: 'authenticated' })]);
    try {
      const rows = await q<Record<string, unknown>>(`select * from notification_rows(array[$1]::uuid[])`, [id]);
      expect(rows).toHaveLength(1);
      expect(Object.values(rows[0]!)).toContain(await one<{ k: string }>(`select proposals_tab_key() k`).then((r) => r.k));
      expect((await one<{ mentions: number }>(`select mentions from my_unread_counts()`)).mentions).toBeGreaterThan(0);
      // No browser role reads proposals directly.
      await q('savepoint rls');
      await expect(q(`select id from proposals where id = $1`, [p.id])).rejects.toMatchObject({ code: '42501' });
      await q('rollback to savepoint rls');
    } finally {
      await q(`select set_config('role', 'postgres', true)`).catch(() => undefined);
      await q(`reset role`);
    }
  });
});
