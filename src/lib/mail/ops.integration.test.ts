/**
 * mail_op_submit (migration 9777) against the live schema, in transactions
 * that are always rolled back. Only `.test` accounts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const DB_URL = process.env.SUPABASE_DB_URL;
const suite = DB_URL ? describe : describe.skip;

let db: pg.Client;
beforeAll(async () => {
  if (!DB_URL) return;
  db = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
});
afterAll(async () => {
  if (db) await db.end();
});

async function inTransaction(fn: () => Promise<void>) {
  await db.query('BEGIN');
  try {
    await fn();
  } finally {
    await db.query('ROLLBACK');
  }
}
async function as(userId: string) {
  await db.query('reset role');
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })]);
  await db.query('set local role authenticated');
}
const asSuper = () => db.query('reset role');

async function members(): Promise<[string, string]> {
  const { rows } = await db.query(`
    select p.id from profiles p join roles r on r.id = p.role_id
     where p.deleted_at is null and p.status = 'active' and not r.is_admin
       and (p.email::text like '%@tapdash.test' or p.email::text like 'itest-%')
     order by p.email limit 2`);
  if (rows.length < 2) throw new Error('need two member test accounts');
  return [rows[0].id, rows[1].id];
}

async function fixture(owner: string) {
  const { rows: i } = await db.query(`insert into mail_identities (user_id, microsoft_user_id, primary_email) values ($1, 'oid-ops', 'o@zz.test') returning id`, [owner]);
  const { rows: m } = await db.query(`insert into mail_mailboxes (kind, address, sync_identity_id, sync_status) values ('personal', 'ops@zz.test', $1, 'ok') returning id`, [i[0].id]);
  const mailbox = m[0].id as string;
  await db.query(`insert into mail_connections (user_id, mailbox_id, identity_id) values ($1, $2, $3)`, [owner, mailbox, i[0].id]);
  const folder = async (g: string, wk: string | null) =>
    (await db.query(`insert into mail_folders (mailbox_id, graph_id, display_name, well_known, total_count, unread_count) values ($1, $2, $2, $3, 0, 0) returning id`, [mailbox, g, wk])).rows[0].id as string;
  const inbox = await folder('in', 'inbox');
  const archive = await folder('ar', 'archive');
  const bin = await folder('del', 'deleteditems');
  await db.query(
    `insert into mail_messages (mailbox_id, folder_id, graph_id, conversation_id, is_read) values
       ($1, $2, 'a', 'c1', false), ($1, $2, 'b', 'c1', false), ($1, $2, 'c', 'c2', true), ($1, $3, 'z', 'c9', false)`,
    [mailbox, inbox, bin],
  );
  await db.query(`update mail_folders set total_count = 3, unread_count = 2 where id = $1`, [inbox]);
  await db.query(`update mail_folders set total_count = 1, unread_count = 1 where id = $1`, [bin]);
  return { mailbox, inbox, archive, bin, identity: i[0].id as string };
}

const req = () => crypto.randomUUID();
const counts = async (ids: string[]) =>
  Object.fromEntries((await db.query(`select graph_id, total_count, unread_count from mail_folders where id = any($1)`, [ids])).rows.map((r) => [r.graph_id, [r.total_count, r.unread_count]]));

suite('mail_op_submit (live schema, rolled back)', () => {
  it('marks read locally, queues one op per message, keeps folder counts, bumps change_seq', async () => {
    await inTransaction(async () => {
      const [owner] = await members();
      const f = await fixture(owner);
      await as(owner);
      const seq = (await db.query(`select mail_op_submit($1, 'mark_read', array['a','b','c'], null, $2) s`, [f.mailbox, req()])).rows[0].s;
      await asSuper();
      expect(Number(seq)).toBe(1);
      const msgs = (await db.query(`select graph_id, is_read from mail_messages where mailbox_id = $1 and graph_id in ('a','b','c') order by 1`, [f.mailbox])).rows;
      expect(msgs.every((m) => m.is_read)).toBe(true);
      const ops = (await db.query(`select kind, target_graph_id, identity_id = $2 own from mail_ops where mailbox_id = $1 order by 2`, [f.mailbox, f.identity])).rows;
      expect(ops).toEqual([
        { kind: 'mark_read', target_graph_id: 'a', own: true },
        { kind: 'mark_read', target_graph_id: 'b', own: true },
        { kind: 'mark_read', target_graph_id: 'c', own: true },
      ]);
      expect((await counts([f.inbox])).in).toEqual([3, 0]);
    });
  });

  it('a retried request is harmless; a newer intent supersedes a queued older one', async () => {
    await inTransaction(async () => {
      const [owner] = await members();
      const f = await fixture(owner);
      await as(owner);
      const r = req();
      await db.query(`select mail_op_submit($1, 'mark_read', array['a'], null, $2)`, [f.mailbox, r]);
      await db.query(`select mail_op_submit($1, 'mark_unread', array['a'], null, $2)`, [f.mailbox, req()]);
      await db.query(`select mail_op_submit($1, 'mark_unread', array['a'], null, $2)`, [f.mailbox, r]); // replay of the FIRST request id
      await asSuper();
      const ops = (await db.query(`select kind, status, last_error_code from mail_ops where mailbox_id = $1 order by kind`, [f.mailbox])).rows;
      expect(ops).toEqual([
        { kind: 'mark_read', status: 'done', last_error_code: 'superseded' },
        { kind: 'mark_unread', status: 'queued', last_error_code: null },
      ]);
    });
  });

  it('moves with counts on both sides and records where to', async () => {
    await inTransaction(async () => {
      const [owner] = await members();
      const f = await fixture(owner);
      await as(owner);
      await db.query(`select mail_op_submit($1, 'move', array['a','b'], $2, $3)`, [f.mailbox, f.archive, req()]);
      await asSuper();
      const c = await counts([f.inbox, f.archive]);
      expect(c.in).toEqual([1, 0]);
      expect(c.ar).toEqual([2, 2]);
      const op = (await db.query(`select payload from mail_ops where mailbox_id = $1 limit 1`, [f.mailbox])).rows[0];
      expect(op.payload).toEqual({ dest_folder_id: f.archive, dest_graph_id: 'ar' });
    });
  });

  it('permanent delete only from Deleted Items or Junk', async () => {
    await inTransaction(async () => {
      const [owner] = await members();
      const f = await fixture(owner);
      await as(owner);
      await db.query(`select mail_op_submit($1, 'hard_delete', array['a','z'], null, $2)`, [f.mailbox, req()]);
      await asSuper();
      const live = (await db.query(`select graph_id from mail_messages where mailbox_id = $1 and deleted_at is null order by 1`, [f.mailbox])).rows.map((r) => r.graph_id);
      expect(live).toEqual(['a', 'b', 'c']); // 'z' (in Deleted Items) gone; 'a' (Inbox) untouched
      expect((await counts([f.bin])).del).toEqual([0, 0]);
      const ops = (await db.query(`select target_graph_id from mail_ops where mailbox_id = $1`, [f.mailbox])).rows;
      expect(ops).toEqual([{ target_graph_id: 'z' }]);
    });
  });

  it('refuses a mailbox the caller cannot see, bad kinds and foreign destinations', async () => {
    await inTransaction(async () => {
      const [owner, other] = await members();
      const f = await fixture(owner);
      const refused = async (sql: string, params: unknown[]) => {
        await db.query('savepoint s');
        const code = await db.query(sql, params).then(() => null, (e: { code?: string }) => e.code);
        await db.query('rollback to savepoint s');
        return code;
      };
      await as(other);
      expect(await refused(`select mail_op_submit($1, 'mark_read', array['a'], null, $2)`, [f.mailbox, req()])).toBe('42501');
      await as(owner);
      expect(await refused(`select mail_op_submit($1, 'drop_table', array['a'], null, $2)`, [f.mailbox, req()])).toBe('22023');
      expect(await refused(`select mail_op_submit($1, 'move', array['a'], gen_random_uuid(), $2)`, [f.mailbox, req()])).toBe('22023');
      expect(await refused(`select mail_op_submit($1, 'mark_read', '{}'::text[], null, $2)`, [f.mailbox, req()])).toBe('22023');
      // A graph id that is not in this mailbox is simply not acted on.
      await db.query(`select mail_op_submit($1, 'mark_read', array['not-here'], null, $2)`, [f.mailbox, req()]);
      await asSuper();
      expect((await db.query(`select count(*)::int n from mail_ops where mailbox_id = $1`, [f.mailbox])).rows[0].n).toBe(0);
    });
  });
});
