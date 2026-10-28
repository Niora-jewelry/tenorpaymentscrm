/**
 * mail_purge_user_connections — what deleting a user does to their Outlook
 * connections (called by softDeleteUser / purgeUser). Live schema, always
 * rolled back, `.test` accounts only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { testAdmin, testMembers } from '@/test/testMembers';

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

async function people(): Promise<{ member: string; other: string; admin: string }> {
  // Standing test accounts first; throwaway ones inside this transaction when
  // there are too few (see src/test/testMembers.ts).
  const [member, other] = await testMembers(db, 2);
  return { member: member!, other: other!, admin: await testAdmin(db) };
}

async function connect(userId: string, oid: string, address: string, kind: 'personal' | 'shared', mailbox?: string) {
  const { rows: i } = await db.query(`insert into mail_identities (user_id, microsoft_user_id, primary_email, status) values ($1, $2, $3, 'ok') returning id`, [userId, oid, `${oid}@zz.test`]);
  await db.query(`insert into mail_identity_secrets (identity_id, refresh_token_enc, refresh_token_iv) values ($1, '\\x00', '\\x00')`, [i[0].id]);
  const id =
    mailbox ??
    ((await db.query(`insert into mail_mailboxes (kind, address, sync_identity_id, sync_status) values ($1, $2, $3, 'ok') returning id`, [kind, address, i[0].id])).rows[0].id as string);
  await db.query(`insert into mail_connections (user_id, mailbox_id, identity_id) values ($1, $2, $3)`, [userId, id, i[0].id]);
  return { identity: i[0].id as string, mailbox: id };
}

suite('mail_purge_user_connections (live schema, rolled back)', () => {
  it('destroys the sign-in, stops a personal mailbox and hides it from admins; a shared one passes to a co-connector', async () => {
    await inTransaction(async () => {
      const { member, other, admin } = await people();
      const personal = await connect(member, 'oid-off-1', 'off-personal@zz.test', 'personal');
      const shared = await connect(member, 'oid-off-2', 'off-shared@zz.test', 'shared');
      const co = await connect(other, 'oid-off-3', 'off-shared@zz.test', 'shared', shared.mailbox);

      await as(admin);
      const before = (await db.query(`select mail_visible_mailbox_ids() ids`)).rows[0].ids as string[];
      expect(before).toContain(personal.mailbox);

      await asSuper();
      const n = (await db.query(`select mail_purge_user_connections($1) n`, [member])).rows[0].n;
      expect(Number(n)).toBe(2);

      const live = await db.query(`select count(*)::int n from mail_connections where user_id = $1 and disconnected_at is null`, [member]);
      expect(live.rows[0].n).toBe(0);
      const secrets = await db.query(`select count(*)::int n from mail_identity_secrets where identity_id = any($1)`, [[personal.identity, shared.identity]]);
      expect(secrets.rows[0].n).toBe(0);

      const boxes = Object.fromEntries(
        (await db.query(`select id, sync_status, sync_identity_id from mail_mailboxes where id = any($1)`, [[personal.mailbox, shared.mailbox]])).rows.map((r) => [r.id, r]),
      );
      expect(boxes[personal.mailbox].sync_status).toBe('paused');
      expect(boxes[shared.mailbox].sync_identity_id).toBe(co.identity);
      expect(boxes[shared.mailbox].sync_status).not.toBe('paused');

      await as(admin);
      const after = (await db.query(`select mail_visible_mailbox_ids() ids`)).rows[0].ids as string[];
      expect(after).not.toContain(personal.mailbox);

      await as(other);
      const coSees = (await db.query(`select mail_visible_mailbox_ids() ids`)).rows[0].ids as string[];
      expect(coSees).toContain(shared.mailbox);
      await asSuper();
    });
  });

  it('cannot be called by a signed-in user', async () => {
    await inTransaction(async () => {
      const { member } = await people();
      await as(member);
      await db.query('savepoint p');
      const err = await db.query(`select mail_purge_user_connections($1)`, [member]).then(
        () => null,
        (e: { code?: string }) => e.code,
      );
      await db.query('rollback to savepoint p');
      expect(err).toBe('42501');
      await asSuper();
    });
  });
});
