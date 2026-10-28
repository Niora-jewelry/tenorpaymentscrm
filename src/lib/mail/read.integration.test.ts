/**
 * The reading RPCs (migration 9776) against the live schema, in transactions
 * that are always rolled back. Only `.test` accounts.
 *
 * They are SECURITY INVOKER, so the important property is negative: asked
 * by someone who cannot see a mailbox, they return nothing — not an error,
 * not a count, nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { testMembers } from '@/test/testMembers';

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

/** Two members (no admins involved): one owns the mailbox, the other must see nothing. */
async function members(): Promise<[string, string]> {
  // Standing test accounts first; throwaway ones inside this transaction when
  // there are too few (see src/test/testMembers.ts).
  const [a, b] = await testMembers(db, 2);
  return [a!, b!];
}

async function fixture(owner: string) {
  const { rows: i } = await db.query(
    `insert into mail_identities (user_id, microsoft_user_id, primary_email) values ($1, 'oid-read', 'r@zz.test') returning id`, [owner]);
  const { rows: m } = await db.query(`insert into mail_mailboxes (kind, address, sync_identity_id, sync_status) values ('personal', 'read@zz.test', $1, 'ok') returning id`, [i[0].id]);
  const mailbox = m[0].id as string;
  await db.query(`insert into mail_connections (user_id, mailbox_id, identity_id) values ($1, $2, $3)`, [owner, mailbox, i[0].id]);
  const { rows: f } = await db.query(
    `insert into mail_folders (mailbox_id, graph_id, display_name, well_known, tier, seeded_at, delta_synced_at)
     values ($1, 'in', 'Inbox', 'inbox', 'hot', now(), now()) returning id`, [mailbox]);
  const inbox = f[0].id as string;
  // 60 single-message conversations (one an hour), plus a 3-message thread, one pinned, one with a file.
  await db.query(
    `insert into mail_messages (mailbox_id, folder_id, graph_id, conversation_id, subject, from_address, received_at, is_read, has_attachments, body_text)
     select $1, $2, 'g' || n, 'c' || n, 'Bulk ' || n, 'sender' || n || '@zz.test', now() - (n || ' hours')::interval, n % 2 = 0, n = 7, 'body ' || n
       from generate_series(1, 60) n`, [mailbox, inbox]);
  await db.query(
    `insert into mail_messages (mailbox_id, folder_id, graph_id, conversation_id, subject, from_address, received_at, is_read, body_text)
     values ($1, $2, 't1', 'thread', 'Invoice for Acme', 'ann@client.zz', now() - interval '3 days', true, 'quarterly invoice attached'),
            ($1, $2, 't2', 'thread', 'RE: Invoice for Acme', 'ann@client.zz', now() - interval '10 minutes', false, 'looks good')`, [mailbox, inbox]);
  await db.query(`insert into mail_pins (mailbox_id, folder_id, conversation_id) values ($1, $2, 'c30')`, [mailbox, inbox]);
  return { mailbox, inbox };
}

suite('mail read RPCs (live schema, rolled back)', () => {
  it('lists conversations newest-first, pages by keyset without gaps or repeats, pins apart', async () => {
    await inTransaction(async () => {
      const [owner] = await members();
      const { inbox } = await fixture(owner);
      await as(owner);

      const pinned = (await db.query(`select conversation_key from mail_list($1, true, 50)`, [[inbox]])).rows;
      expect(pinned.map((r) => r.conversation_key)).toEqual(['c30']);

      const seen: string[] = [];
      let cursor: { at: string; key: string } | null = null;
      for (let page = 0; page < 5; page += 1) {
        type Page = { conversation_key: string; last_at: string; message_count: number; unread_count: number };
        const res: pg.QueryResult<Page> = await db.query<Page>(
          `select conversation_key, last_at, message_count, unread_count from mail_list($1, false, 25, $2, $3)`,
          [[inbox], cursor?.at ?? null, cursor?.key ?? null],
        );
        const rows: Page[] = res.rows;
        if (rows.length === 0) break;
        seen.push(...rows.map((r: Page) => r.conversation_key));
        const last: Page = rows[rows.length - 1];
        cursor = { at: last.last_at, key: last.conversation_key };
      }
      expect(seen).toHaveLength(60); // 59 unpinned singles + the thread
      expect(new Set(seen).size).toBe(60);
      expect(seen[0]).toBe('thread'); // newest activity first, though it began three days ago
      expect(seen).not.toContain('c30');

      const thread = (await db.query(`select message_count, unread_count, subject from mail_list($1, false, 5) where conversation_key = 'thread'`, [[inbox]])).rows[0];
      expect(thread).toEqual({ message_count: 2, unread_count: 1, subject: 'RE: Invoice for Acme' });

      const unread = (await db.query(`select count(*)::int n from mail_list($1, false, 200, null, null, true, false)`, [[inbox]])).rows[0].n;
      expect(unread).toBe(31); // the 30 odd-numbered singles (pinned c30 is even and read anyway) + the thread
      const files = (await db.query(`select conversation_key from mail_list($1, false, 200, null, null, false, true)`, [[inbox]])).rows;
      expect(files.map((r) => r.conversation_key)).toEqual(['c7']);
    });
  });

  it('searches by word prefix and opens a conversation across its messages', async () => {
    await inTransaction(async () => {
      const [owner] = await members();
      const { mailbox } = await fixture(owner);
      await as(owner);
      const hits = (await db.query(`select conversation_key, message_count from mail_search('invoi:* & acm:*', $1)`, [[mailbox]])).rows;
      expect(hits).toEqual([{ conversation_key: 'thread', message_count: 2 }]);
      expect((await db.query(`select count(*)::int n from mail_search('quarter:*', $1)`, [[mailbox]])).rows[0].n).toBe(1);
      // Malformed tsquery text degrades to plain matching instead of erroring.
      expect((await db.query(`select count(*)::int n from mail_search('invoice & & (', $1)`, [[mailbox]])).rows[0].n).toBe(1);
      const msgs = (await db.query(`select subject from mail_conversation($1, 'thread')`, [mailbox])).rows;
      expect(msgs.map((r) => r.subject)).toEqual(['RE: Invoice for Acme', 'Invoice for Acme']);
    });
  });

  it('gives someone who cannot see the mailbox nothing at all', async () => {
    await inTransaction(async () => {
      const [owner, other] = await members();
      const { mailbox, inbox } = await fixture(owner);
      await as(other);
      expect((await db.query(`select count(*)::int n from mail_list($1, false, 50)`, [[inbox]])).rows[0].n).toBe(0);
      expect((await db.query(`select count(*)::int n from mail_list($1, true, 50)`, [[inbox]])).rows[0].n).toBe(0);
      expect((await db.query(`select count(*)::int n from mail_search('invoi:*', $1)`, [[mailbox]])).rows[0].n).toBe(0);
      expect((await db.query(`select count(*)::int n from mail_conversation($1, 'thread')`, [mailbox])).rows[0].n).toBe(0);
      await db.query('savepoint s');
      const code = await db.query(`select mail_touch_folder($1)`, [inbox]).then(() => null, (e: { code?: string }) => e.code);
      await db.query('rollback to savepoint s');
      expect(code).toBe('42501');
      await asSuper();
    });
  });

  it('an admin can read who connected a mailbox; a member cannot; a hidden mailbox hides its owner too', async () => {
    await inTransaction(async () => {
      const [owner, other] = await members();
      const { rows: admins } = await db.query(
        `select p.id from profiles p join roles r on r.id = p.role_id
          where r.is_admin and p.deleted_at is null and p.status = 'active' and p.email::text like '%@tapdash.test' limit 1`);
      const admin = admins[0]?.id as string | undefined;
      if (!admin) throw new Error('needs an active admin test account');
      const { mailbox } = await fixture(owner);
      const who = async () => (await db.query(`select user_id from mail_connections where mailbox_id = $1 and disconnected_at is null`, [mailbox])).rows.map((r) => r.user_id);
      await as(admin);
      expect(await who()).toEqual([owner]);
      await as(other);
      expect(await who()).toEqual([]);
      await asSuper();
      await db.query(`insert into mail_user_settings (user_id, hide_my_mailboxes_from_admins) values ($1, true)`, [owner]);
      await as(admin);
      // A standard user's hide flag does nothing (spec): the owner stays readable.
      expect(await who()).toEqual([owner]);
      await asSuper();
    });
  });

  it('opening a stale folder queues it at top priority; a fresh one does not', async () => {
    await inTransaction(async () => {
      const [owner] = await members();
      const { mailbox, inbox } = await fixture(owner);
      await as(owner);
      expect((await db.query(`select mail_touch_folder($1) r`, [inbox])).rows[0].r).toBeNull(); // synced just now
      await asSuper();
      await db.query(`update mail_folders set delta_synced_at = now() - interval '5 minutes', delta_link = 'x' where id = $1`, [inbox]);
      await as(owner);
      expect((await db.query(`select mail_touch_folder($1) r`, [inbox])).rows[0].r).toBe(mailbox);
      await asSuper();
      const q = (await db.query(`select kind, priority from mail_sync_queue where mailbox_id = $1 and target = $2`, [mailbox, inbox])).rows;
      expect(q).toEqual([{ kind: 'folder_delta', priority: 1 }]);
      const opened = (await db.query(`select last_opened_at > now() - interval '1 minute' recent from mail_folders where id = $1`, [inbox])).rows[0];
      expect(opened.recent).toBe(true);
    });
  });
});
