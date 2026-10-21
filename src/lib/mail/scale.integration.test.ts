/**
 * The read and write RPCs at the size the plan budgets for: one mailbox with
 * 500 folders and 10,000 messages (4,000 of them in the Inbox), in a
 * transaction that is always rolled back.
 *
 * Measured as the database's own execution time (EXPLAIN ANALYZE), not wall
 * clock: the test runs far from the database, and the round trip would
 * swamp what is being measured. Ceilings are generous for a shared instance;
 * the point is to catch a plan that degrades to a full scan.
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

async function as(userId: string) {
  await db.query('reset role');
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })]);
  await db.query('set local role authenticated');
}

/** Server-side execution time of one statement, in ms (second-worst of seven: plan-cache switches show). */
async function execMs(sql: string, params: unknown[]): Promise<number> {
  const runs: number[] = [];
  // Seven calls: past the point where a cached generic plan would take over.
  for (let i = 0; i < 7; i += 1) {
    const { rows } = await db.query(`explain (analyze, format json) ${sql}`, params);
    runs.push(Number(rows[0]['QUERY PLAN'][0]['Execution Time']));
  }
  return runs.sort((a, b) => a - b)[5];
}

suite('mail RPCs at scale: 500 folders, 10k messages (rolled back)', () => {
  it('lists, searches, opens and acts within budget', { timeout: 240_000 }, async () => {
    await db.query('BEGIN');
    try {
      const { rows: owners } = await db.query(`
        select p.id from profiles p join roles r on r.id = p.role_id
         where p.deleted_at is null and p.status = 'active' and not r.is_admin
           and (p.email::text like '%@tapdash.test' or p.email::text like 'itest-%')
         order by p.email limit 1`);
      const owner = owners[0].id as string;
      const { rows: i } = await db.query(`insert into mail_identities (user_id, microsoft_user_id, primary_email) values ($1, 'oid-scale', 's@zz.test') returning id`, [owner]);
      const { rows: m } = await db.query(`insert into mail_mailboxes (kind, address, sync_identity_id, sync_status) values ('personal', 'scale@zz.test', $1, 'ok') returning id`, [i[0].id]);
      const mailbox = m[0].id as string;
      await db.query(`insert into mail_connections (user_id, mailbox_id, identity_id) values ($1, $2, $3)`, [owner, mailbox, i[0].id]);
      const { rows: f } = await db.query(
        `insert into mail_folders (mailbox_id, graph_id, display_name, well_known, tier, seeded_at, delta_synced_at)
         select $1, 'f' || n, case when n = 1 then 'Inbox' else 'Folder ' || n end, case when n = 1 then 'inbox' end,
                case when n = 1 then 'hot' else 'cold' end, now(), now()
           from generate_series(1, 500) n
         returning id, graph_id`,
        [mailbox],
      );
      const inbox = f.find((r) => r.graph_id === 'f1')!.id as string;
      const others = f.filter((r) => r.graph_id !== 'f1').map((r) => r.id as string);
      // 4,000 in the Inbox (threads of up to 4), 6,000 spread over the other folders.
      await db.query(
        `insert into mail_messages (mailbox_id, folder_id, graph_id, conversation_id, subject, from_address, received_at, is_read, has_attachments, body_text, preview)
         select $1, $2, 'i' || n, 'conv' || (n / 4), 'Subject ' || (n / 4) || case when n % 97 = 0 then ' invoice' else '' end,
                'sender' || (n % 300) || '@zz.test', now() - (n || ' minutes')::interval, n % 3 <> 0, n % 11 = 0,
                'body text for message ' || n || case when n % 97 = 0 then ' quarterly invoice attached' else '' end, 'preview ' || n
           from generate_series(1, 4000) n`,
        [mailbox, inbox],
      );
      await db.query(
        `insert into mail_messages (mailbox_id, folder_id, graph_id, conversation_id, subject, from_address, received_at, is_read, body_text)
         select $1, ($2::uuid[])[1 + (n % array_length($2::uuid[], 1))], 'o' || n, 'oconv' || n, 'Filed ' || n, 'x' || (n % 50) || '@zz.test',
                now() - (n || ' hours')::interval, true, 'filed body ' || n
           from generate_series(1, 6000) n`,
        [mailbox, others],
      );
      await db.query(`update mail_folders set total_count = 4000, unread_count = 1334 where id = $1`, [inbox]);
      await db.query('analyze mail_messages');

      await as(owner);
      const list = await execMs(`select * from mail_list($1::uuid[], false, 50)`, [[inbox]]);
      const unread = await execMs(`select * from mail_list($1::uuid[], false, 50, null, null, true)`, [[inbox]]);
      const page5 = await execMs(`select * from mail_list($1::uuid[], false, 50, now() - interval '3 hours', 'conv40')`, [[inbox]]);
      const search = await execMs(`select * from mail_search($1, $2::uuid[])`, ['invoice:*', [mailbox]]);
      const thread = await execMs(`select * from mail_conversation($1, 'conv10')`, [mailbox]);
      const total = await execMs(`select mail_unread_total()`, []);
      const timings = { list, unread, page5, search, thread, total };

      // A bulk action on 500 messages: authorise, record, apply locally, in one call.
      const ids = Array.from({ length: 500 }, (_, k) => `i${k + 1}`);
      const t0 = Date.now();
      await db.query(`select mail_op_submit($1, 'mark_read', $2::text[], null, $3)`, [mailbox, ids, crypto.randomUUID()]);
      const bulkWall = Date.now() - t0;
      await db.query('reset role');
      const queued = (await db.query(`select count(*)::int n from mail_ops where mailbox_id = $1`, [mailbox])).rows[0].n;

      expect(list, JSON.stringify(timings)).toBeLessThan(150);
      expect(unread, JSON.stringify(timings)).toBeLessThan(150);
      expect(page5, JSON.stringify(timings)).toBeLessThan(150);
      expect(search, JSON.stringify(timings)).toBeLessThan(400);
      expect(thread, JSON.stringify(timings)).toBeLessThan(50);
      expect(total, JSON.stringify(timings)).toBeLessThan(50);
      expect(queued).toBeGreaterThan(0);
      expect(bulkWall).toBeLessThan(10_000);
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
