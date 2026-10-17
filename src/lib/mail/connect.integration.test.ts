/**
 * The connect-time RPCs (migration 9773) against the live schema.
 *
 * Every test runs inside one transaction that is always rolled back; only
 * `.test` / test accounts are used, and nothing is ever committed.
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

async function refused(sql: string, params: unknown[] = []): Promise<string | null> {
  await db.query('savepoint s');
  try {
    await db.query(sql, params);
    await db.query('release savepoint s');
    return null;
  } catch (e) {
    await db.query('rollback to savepoint s');
    return (e as { code?: string }).code ?? 'error';
  }
}

async function testUsers(): Promise<[string, string]> {
  const { rows } = await db.query(`
    select p.id from profiles p
     where p.deleted_at is null and p.status = 'active'
       and (p.email::text like '%@tapdash.test' or p.email::text like 'itest-%' or p.email::text like 'test-member@%')
     order by p.email limit 2`);
  if (rows.length < 2) throw new Error('need two active test accounts');
  return [rows[0].id, rows[1].id];
}

async function identity(userId: string, withSecret = true): Promise<string> {
  const { rows } = await db.query(
    `insert into mail_identities (user_id, microsoft_user_id, primary_email) values ($1, gen_random_uuid()::text, 'x@zz.test') returning id`,
    [userId],
  );
  if (withSecret) {
    await db.query(`insert into mail_identity_secrets (identity_id, refresh_token_enc, refresh_token_iv) values ($1, '\\x01', '\\x02')`, [rows[0].id]);
  }
  return rows[0].id;
}

async function mailbox(address: string, driver: string | null = null, kind = 'shared'): Promise<string> {
  const { rows } = await db.query(`insert into mail_mailboxes (kind, address, sync_identity_id) values ($1, $2, $3) returning id`, [kind, address, driver]);
  return rows[0].id;
}

const tree = (folders: object[]) => JSON.stringify(folders);

suite('mail connect RPCs (live schema, rolled back)', () => {
  it('applies a folder tree: parents, well-known, removals, and refuses an empty complete tree', async () => {
    await inTransaction(async () => {
      const mb = await mailbox('tree@zz.test');
      const first = [
        { graph_id: 'in', parent_graph_id: null, display_name: 'Inbox', well_known: 'inbox', depth: 0, total_count: 5, unread_count: 1, child_count: 1, tier: 'hot' },
        { graph_id: 'c1', parent_graph_id: 'in', display_name: 'Clients', well_known: null, depth: 1, total_count: 2, unread_count: 0, child_count: 0, tier: 'cold' },
        { graph_id: 'ar', parent_graph_id: null, display_name: 'Archive', well_known: 'archive', depth: 0, total_count: 0, unread_count: 0, child_count: 0, tier: 'warm' },
      ];
      await db.query(`select mail_apply_folder_tree($1, $2::jsonb, true)`, [mb, tree(first)]);
      const { rows } = await db.query(
        `select f.graph_id, f.well_known, p.graph_id parent from mail_folders f left join mail_folders p on p.id = f.parent_folder_id
          where f.mailbox_id = $1 and f.deleted_at is null order by f.graph_id`,
        [mb],
      );
      expect(rows).toEqual([
        { graph_id: 'ar', well_known: 'archive', parent: null },
        { graph_id: 'c1', well_known: null, parent: 'in' },
        { graph_id: 'in', well_known: 'inbox', parent: null },
      ]);

      // Archive recreated under a new id; Clients deleted in Outlook.
      const second = [first[0], { ...first[2], graph_id: 'ar2' }];
      await db.query(`select mail_apply_folder_tree($1, $2::jsonb, true)`, [mb, tree(second)]);
      const { rows: after } = await db.query(
        `select graph_id, well_known, deleted_at is not null gone from mail_folders where mailbox_id = $1 order by graph_id`,
        [mb],
      );
      expect(after).toEqual([
        { graph_id: 'ar', well_known: null, gone: true },
        { graph_id: 'ar2', well_known: 'archive', gone: false },
        { graph_id: 'c1', well_known: null, gone: true },
        { graph_id: 'in', well_known: 'inbox', gone: false },
      ]);

      // A failed well-known lookup (null) keeps what we knew.
      await db.query(`select mail_apply_folder_tree($1, $2::jsonb, false)`, [mb, tree([{ ...first[0], well_known: null, tier: 'cold' }])]);
      const { rows: inbox } = await db.query(`select well_known, tier from mail_folders where mailbox_id = $1 and graph_id = 'in'`, [mb]);
      expect(inbox[0]).toEqual({ well_known: 'inbox', tier: 'hot' });

      expect(await refused(`select mail_apply_folder_tree($1, '[]'::jsonb, true)`, [mb])).toBe('22023');
      const { rows: live } = await db.query(`select count(*)::int n from mail_folders where mailbox_id = $1 and deleted_at is null`, [mb]);
      expect(live[0].n).toBe(2);
    });
  });

  it('coalesces queue work and bootstraps only what needs seeding', async () => {
    await inTransaction(async () => {
      const mb = await mailbox('queue@zz.test');
      await db.query(`select mail_enqueue($1, 'folders_refresh', '', 5::smallint)`, [mb]);
      await db.query(`select mail_enqueue($1, 'folders_refresh', '', 1::smallint)`, [mb]);
      const { rows: q } = await db.query(`select priority from mail_sync_queue where mailbox_id = $1 and kind = 'folders_refresh'`, [mb]);
      expect(q).toEqual([{ priority: 1 }]);

      await db.query(`select mail_apply_folder_tree($1, $2::jsonb, true)`, [
        mb,
        tree([
          { graph_id: 'in', display_name: 'Inbox', well_known: 'inbox', tier: 'hot', total_count: 0 },
          { graph_id: 'full', display_name: 'Projects', tier: 'cold', total_count: 9 },
          { graph_id: 'empty', display_name: 'Empty', tier: 'cold', total_count: 0 },
          { graph_id: 'out', display_name: 'Outbox', well_known: 'outbox', tier: 'cold', total_count: 3 },
        ]),
      ]);
      await db.query(`select mail_enqueue_bootstrap($1)`, [mb]);
      await db.query(`select mail_enqueue_bootstrap($1)`, [mb]); // idempotent
      const { rows } = await db.query(
        `select q.kind, f.graph_id, q.priority from mail_sync_queue q left join mail_folders f on f.id::text = q.target
          where q.mailbox_id = $1 and q.processed_at is null order by q.kind, f.graph_id`,
        [mb],
      );
      expect(rows).toEqual([
        { kind: 'contacts_delta', graph_id: null, priority: 6 },
        { kind: 'folders_refresh', graph_id: null, priority: 1 },
        { kind: 'rules_refresh', graph_id: null, priority: 6 },
        { kind: 'seed_folder', graph_id: 'full', priority: 5 },
        { kind: 'seed_folder', graph_id: 'in', priority: 2 },
        { kind: 'subscription_ensure', graph_id: null, priority: 3 },
      ]);
    });
  });

  it('a dead sign-in breaks its connections and hands each mailbox to a working connector', async () => {
    await inTransaction(async () => {
      const [u1, u2] = await testUsers();
      const dead = await identity(u1);
      const alive = await identity(u2);
      const shared = await mailbox('team@zz.test', dead);
      const solo = await mailbox('solo@zz.test', dead, 'personal');
      for (const [u, i, m] of [[u1, dead, shared], [u2, alive, shared], [u1, dead, solo]]) {
        await db.query(`insert into mail_connections (user_id, mailbox_id, identity_id) values ($1, $2, $3)`, [u, m, i]);
      }

      await db.query(`select mail_mark_identity_broken($1, 'reconnect_required', 'invalid_grant')`, [dead]);

      const { rows: mbs } = await db.query(`select address::text, sync_identity_id, sync_status from mail_mailboxes where id = any($1) order by 1`, [[shared, solo]]);
      expect(mbs).toEqual([
        { address: 'solo@zz.test', sync_identity_id: dead, sync_status: 'broken' },
        { address: 'team@zz.test', sync_identity_id: alive, sync_status: 'pending' },
      ]);
      const { rows: conns } = await db.query(`select identity_id, status from mail_connections where mailbox_id = any($1) order by identity_id = $2 desc`, [[shared, solo], dead]);
      expect(conns.filter((c) => c.identity_id === dead).every((c) => c.status === 'broken')).toBe(true);
      expect(conns.find((c) => c.identity_id === alive)?.status).toBe('ok');
      const { rows: sec } = await db.query(`select count(*)::int n from mail_identity_secrets where identity_id = $1`, [dead]);
      expect(sec[0].n).toBe(0);
      const { rows: q } = await db.query(`select kind, priority from mail_sync_queue where mailbox_id = $1`, [shared]);
      expect(q).toEqual([{ kind: 'subscription_ensure', priority: 1 }]);
    });
  });

  it('reconnecting heals the same sign-in’s other auth-broken connections', async () => {
    await inTransaction(async () => {
      const [u1] = await testUsers();
      const { rows: idr } = await db.query(
        `select (mail_connect_mailbox($1, 'oid-heal', 'tid', 'me@zz.test', 'Me', '{}', '{}', '\\x01', '\\x02', 'personal', 'me@zz.test', 'Me', 'oid-heal'))->>'identity_id' id`,
        [u1],
      );
      const ident = idr[0].id as string;
      const { rows: shr } = await db.query(
        `select (mail_connect_mailbox($1, 'oid-heal', 'tid', 'me@zz.test', 'Me', '{}', '{}', '\\x01', '\\x02', 'shared', 'heal-team@zz.test', '', null))->>'mailbox_id' id`,
        [u1],
      );
      const sharedMb = shr[0].id as string;

      await db.query(`select mail_mark_identity_broken($1, 'reconnect_required', 'invalid_grant')`, [ident]);
      const { rows: broken } = await db.query(`select status from mail_connections where identity_id = $1 and disconnected_at is null`, [ident]);
      expect(broken.map((r) => r.status)).toEqual(['broken', 'broken']);

      // The person reconnects their OWN mailbox only.
      const { rows: again } = await db.query(
        `select mail_connect_mailbox($1, 'oid-heal', 'tid', 'me@zz.test', 'Me', '{}', '{}', '\\x03', '\\x04', 'personal', 'me@zz.test', 'Me', 'oid-heal') r`,
        [u1],
      );
      expect(again[0].r.reconnected).toBe(true);
      const { rows: healed } = await db.query(
        `select c.status, m.sync_status, m.sync_identity_id = $2 driven from mail_connections c join mail_mailboxes m on m.id = c.mailbox_id
          where c.user_id = $1 and c.disconnected_at is null and m.id = $3`,
        [u1, ident, sharedMb],
      );
      expect(healed).toEqual([{ status: 'ok', sync_status: 'pending', driven: true }]);
    });
  });

  it('none of the connect RPCs is callable by a signed-in session', async () => {
    await inTransaction(async () => {
      const [u1] = await testUsers();
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: u1, role: 'authenticated' })]);
      await db.query('set local role authenticated');
      const id = '00000000-0000-0000-0000-000000000000';
      expect(await refused(`select mail_apply_folder_tree($1, '[]'::jsonb, false)`, [id])).toBe('42501');
      expect(await refused(`select mail_enqueue($1, 'folders_refresh')`, [id])).toBe('42501');
      expect(await refused(`select mail_enqueue_bootstrap($1)`, [id])).toBe('42501');
      expect(await refused(`select mail_mark_identity_broken($1, 'x', 'y')`, [id])).toBe('42501');
      await db.query('reset role');
    });
  });
});
