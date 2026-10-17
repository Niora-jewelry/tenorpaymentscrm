/**
 * The sync engine's RPCs (migration 9774) against the live schema, inside
 * transactions that are always rolled back. Only `.test` accounts.
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

async function driver(): Promise<string> {
  const { rows: u } = await db.query(
    `select id from profiles where deleted_at is null and status='active' and email::text like '%@tapdash.test' order by email limit 1`,
  );
  const { rows } = await db.query(
    `insert into mail_identities (user_id, microsoft_user_id, primary_email) values ($1, gen_random_uuid()::text, 'x@zz.test') returning id`,
    [u[0].id],
  );
  return rows[0].id;
}

async function mailbox(address: string, ident: string, extra = ''): Promise<string> {
  const { rows } = await db.query(
    `insert into mail_mailboxes (kind, address, sync_identity_id, sync_status) values ('personal', $1, $2, 'ok') returning id`,
    [address, ident],
  );
  if (extra) await db.query(`update mail_mailboxes set ${extra} where id = $1`, [rows[0].id]);
  return rows[0].id;
}

const enqueue = (mb: string, priority = 5) => db.query(`select mail_enqueue($1, 'folders_refresh', '', $2::smallint)`, [mb, priority]);

suite('mail engine RPCs (live schema, rolled back)', () => {
  it('two claimers never hold the same mailbox; throttled and leased ones wait', async () => {
    await inTransaction(async () => {
      const ident = await driver();
      const a = await mailbox('claim-a@zz.test', ident);
      const b = await mailbox('claim-b@zz.test', ident);
      const throttled = await mailbox('claim-t@zz.test', ident, `throttled_until = now() + interval '1 minute'`);
      const idle = await mailbox('claim-i@zz.test', ident);
      await enqueue(a, 1);
      await enqueue(b, 5);
      await enqueue(throttled, 1);
      void idle; // no queued work → never claimed

      const mine = (owner: string) => db.query(`select id from mail_claim_mailboxes($1, 10, 60) where address::text like 'claim-%'`, [owner]);
      const first = (await mine('one')).rows.map((r) => r.id);
      const second = (await mine('two')).rows.map((r) => r.id);
      expect(first).toEqual([a, b]); // most urgent first
      expect(second).toEqual([]); // leased by "one"
      const { rows } = await db.query(`select lease_owner from mail_mailboxes where id = any($1)`, [[a, b]]);
      expect(rows.every((r) => r.lease_owner === 'one')).toBe(true);

      await db.query(`update mail_mailboxes set lease_until = now() - interval '1 second' where id = $1`, [a]);
      expect((await mine('two')).rows.map((r) => r.id)).toEqual([a]); // an expired lease is fair game
    });
  });

  it('schedules hot folders every tick without webhooks, every 5 minutes with them, cold hourly', async () => {
    await inTransaction(async () => {
      const ident = await driver();
      const mb = await mailbox('sched@zz.test', ident);
      const folder = async (graph: string, tier: string, ago: string) =>
        (
          await db.query(
            `insert into mail_folders (mailbox_id, graph_id, display_name, tier, seeded_at, delta_link, delta_synced_at)
             values ($1, $2, $2, $3, now(), 'https://graph.microsoft.com/v1.0/x?$deltatoken=1', now() - $4::interval) returning id`,
            [mb, graph, tier, ago],
          )
        ).rows[0].id as string;
      const hot = await folder('hot', 'hot', '2 minutes');
      const cold = await folder('cold', 'cold', '2 minutes');
      const coldStale = await folder('cold-stale', 'cold', '2 hours');

      await db.query(`select mail_schedule_due()`);
      const due = async () =>
        (await db.query(`select target from mail_sync_queue where mailbox_id=$1 and kind='folder_delta' and processed_at is null`, [mb])).rows
          .map((r) => r.target)
          .sort();
      expect(await due()).toEqual([coldStale, hot].sort());

      await db.query(`delete from mail_sync_queue where mailbox_id=$1`, [mb]);
      await db.query(`update mail_mailboxes set subscription_healthy = true where id=$1`, [mb]);
      await db.query(`select mail_schedule_due()`);
      expect(await due()).toEqual([coldStale]); // webhooks healthy: hot waits 5 minutes
      void cold;

      await db.query(`select mail_schedule_due()`);
      const { rows } = await db.query(`select count(*)::int n from mail_sync_queue where mailbox_id=$1 and processed_at is null`, [mb]);
      const again = rows[0].n;
      await db.query(`select mail_schedule_due()`);
      const { rows: rows2 } = await db.query(`select count(*)::int n from mail_sync_queue where mailbox_id=$1 and processed_at is null`, [mb]);
      expect(rows2[0].n).toBe(again); // idempotent
    });
  });

  it('tombstones only while the message is still in the folder that reported it gone', async () => {
    await inTransaction(async () => {
      const ident = await driver();
      const mb = await mailbox('tomb@zz.test', ident);
      const f = async (g: string) =>
        (await db.query(`insert into mail_folders (mailbox_id, graph_id, display_name) values ($1, $2, $2) returning id`, [mb, g])).rows[0].id;
      const inbox = await f('in');
      const other = await f('other');
      await db.query(`insert into mail_messages (mailbox_id, folder_id, graph_id) values ($1, $2, 'stays'), ($1, $3, 'moved')`, [mb, inbox, other]);

      const { rows } = await db.query(`select mail_soft_delete_messages($1, array['stays','moved'], $2) n`, [mb, inbox]);
      expect(rows[0].n).toBe(1);
      const { rows: left } = await db.query(`select graph_id from mail_messages where mailbox_id=$1 and deleted_at is null`, [mb]);
      expect(left.map((r) => r.graph_id)).toEqual(['moved']);
      const { rows: seq } = await db.query(`select mail_bump_seq($1) s`, [mb]);
      expect(Number(seq[0].s)).toBe(1);
    });
  });

  it('none of the engine RPCs is callable by a signed-in session', async () => {
    await inTransaction(async () => {
      const { rows: u } = await db.query(`select id from profiles where email::text like '%@tapdash.test' limit 1`);
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: u[0].id, role: 'authenticated' })]);
      await db.query('set local role authenticated');
      const id = '00000000-0000-0000-0000-000000000000';
      for (const sql of [
        `select mail_schedule_due()`,
        `select * from mail_claim_mailboxes('x', 1, 60)`,
        `select mail_bump_seq('${id}')`,
        `select mail_soft_delete_messages('${id}', array['a'], null)`,
        `select mail_prune()`,
      ]) {
        await db.query('savepoint s');
        const code = await db.query(sql).then(
          () => null,
          (e: { code?: string }) => e.code,
        );
        await db.query('rollback to savepoint s');
        expect(code, sql).toBe('42501');
      }
      await db.query('reset role');
    });
  });
});
