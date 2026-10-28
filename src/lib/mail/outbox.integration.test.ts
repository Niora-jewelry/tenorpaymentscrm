/**
 * mail_outbox_submit / mail_outbox_cancel / mail_claim_outbox (migrations
 * 9771, 9778) against the live schema, in transactions that are always rolled
 * back. Only `.test` accounts.
 *
 * Inside one transaction now() is fixed, so "due" is arranged by moving
 * release_at / lease_until into the past rather than by waiting.
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

/** Runs `sql` inside a savepoint so an expected error doesn't abort the transaction; returns the SQLSTATE. */
async function failsWith(sql: string, params: unknown[]): Promise<string | null> {
  await db.query('savepoint probe');
  try {
    await db.query(sql, params);
    await db.query('release savepoint probe');
    return null;
  } catch (e) {
    await db.query('rollback to savepoint probe');
    return (e as { code?: string }).code ?? 'unknown';
  }
}

async function members(): Promise<[string, string]> {
  // Standing test accounts first; throwaway ones inside this transaction when
  // there are too few (see src/test/testMembers.ts).
  const [a, b] = await testMembers(db, 2);
  return [a!, b!];
}

async function fixture(owner: string) {
  const { rows: i } = await db.query(`insert into mail_identities (user_id, microsoft_user_id, primary_email) values ($1, 'oid-outbox', 'o@zz.test') returning id`, [owner]);
  const { rows: m } = await db.query(`insert into mail_mailboxes (kind, address, sync_identity_id, sync_status) values ('personal', 'outbox@zz.test', $1, 'ok') returning id`, [i[0].id]);
  await db.query(`insert into mail_connections (user_id, mailbox_id, identity_id) values ($1, $2, $3)`, [owner, m[0].id, i[0].id]);
  return { mailbox: m[0].id as string, identity: i[0].id as string };
}

const TO = JSON.stringify([{ name: 'Dave', address: 'dave@client.example' }]);
const SUBMIT = `select * from mail_outbox_submit($1, $2, $3, $4, $5, 'Subject', '<p>Hi</p>', $6::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, $7)`;
const submit = (o: { req?: string; mailbox: string; draft?: string | null; kind?: string; source?: string | null; to?: string; at?: string | null }) =>
  db.query(SUBMIT, [o.req ?? crypto.randomUUID(), o.mailbox, o.draft ?? null, o.kind ?? 'new', o.source ?? null, o.to ?? TO, o.at ?? null]);
const claim = (only: string | null = null) => db.query(`select id, status, attempts, lease_until > now() leased from mail_claim_outbox('itest', 10, 60, $1)`, [only]);

suite('mail_outbox_submit (live schema, rolled back)', () => {
  it('holds a send for the default 5-second undo window, under the sender’s own sign-in', async () => {
    await inTransaction(async () => {
      const [owner] = await members();
      const f = await fixture(owner);
      await as(owner);
      const r = (await submit({ mailbox: f.mailbox })).rows[0];
      await asSuper();
      expect(r.status).toBe('held');
      const row = (await db.query(`select identity_id, user_id, extract(epoch from release_at - now())::int secs from mail_outbox where id = $1`, [r.id])).rows[0];
      expect(row).toEqual({ identity_id: f.identity, user_id: owner, secs: 5 });
    });
  });

  it('uses the person’s own undo window', async () => {
    await inTransaction(async () => {
      const [owner] = await members();
      const f = await fixture(owner);
      await db.query(
        `insert into mail_user_settings (user_id, undo_send_seconds) values ($1, 9) on conflict (user_id) do update set undo_send_seconds = 9`,
        [owner],
      );
      await as(owner);
      const r = (await submit({ mailbox: f.mailbox })).rows[0];
      await asSuper();
      expect((await db.query(`select extract(epoch from release_at - now())::int s from mail_outbox where id = $1`, [r.id])).rows[0].s).toBe(9);
    });
  });

  it('a replayed click returns the first answer and records nothing new', async () => {
    await inTransaction(async () => {
      const [owner] = await members();
      const f = await fixture(owner);
      const req = crypto.randomUUID();
      await as(owner);
      const a = (await submit({ req, mailbox: f.mailbox })).rows[0];
      const b = (await submit({ req, mailbox: f.mailbox })).rows[0];
      await asSuper();
      expect(b.id).toBe(a.id);
      expect((await db.query(`select count(*)::int n from mail_outbox where mailbox_id = $1`, [f.mailbox])).rows[0].n).toBe(1);
    });
  });

  it('schedules between one minute and one year ahead, and refuses outside that', async () => {
    await inTransaction(async () => {
      const [owner] = await members();
      const f = await fixture(owner);
      await as(owner);
      const at = (await db.query(`select (now() + interval '2 hours')::text t`)).rows[0].t;
      const r = (await submit({ mailbox: f.mailbox, at })).rows[0];
      expect(r.status).toBe('scheduled');
      const soon = (await db.query(`select (now() + interval '10 seconds')::text t`)).rows[0].t;
      const far = (await db.query(`select (now() + interval '13 months')::text t`)).rows[0].t;
      expect(await failsWith(SUBMIT, [crypto.randomUUID(), f.mailbox, null, 'new', null, TO, soon])).toBe('22023');
      expect(await failsWith(SUBMIT, [crypto.randomUUID(), f.mailbox, null, 'new', null, TO, far])).toBe('22023');
      await asSuper();
    });
  });

  it('refuses: someone else’s mailbox, no recipients, a reply without its source, someone else’s draft, no session', async () => {
    await inTransaction(async () => {
      const [owner, other] = await members();
      const f = await fixture(owner);
      const { rows: d } = await db.query(`insert into mail_drafts (mailbox_id, user_id, kind) values ($1, $2, 'new') returning id`, [f.mailbox, owner]);
      await as(other);
      expect(await failsWith(SUBMIT, [crypto.randomUUID(), f.mailbox, null, 'new', null, TO, null])).toBe('42501');
      await as(owner);
      expect(await failsWith(SUBMIT, [crypto.randomUUID(), f.mailbox, null, 'new', null, '[]', null])).toBe('22023');
      expect(await failsWith(SUBMIT, [crypto.randomUUID(), f.mailbox, null, 'reply', null, TO, null])).toBe('22023');
      expect(await failsWith(SUBMIT, [crypto.randomUUID(), f.mailbox, null, 'bogus', null, TO, null])).toBe('22023');
      await asSuper();
      await db.query(`update mail_drafts set user_id = $2 where id = $1`, [d[0].id, other]);
      await as(owner);
      expect(await failsWith(SUBMIT, [crypto.randomUUID(), f.mailbox, d[0].id, 'new', null, TO, null])).toBe('22023');
      await db.query('reset role');
      await db.query(`select set_config('request.jwt.claims', '{"role":"anon"}', true)`);
      await db.query('set local role anon');
      expect(await failsWith(SUBMIT, [crypto.randomUUID(), f.mailbox, null, 'new', null, TO, null])).toBe('42501');
      await asSuper();
      expect((await db.query(`select count(*)::int n from mail_outbox where mailbox_id = $1`, [f.mailbox])).rows[0].n).toBe(0);
    });
  });

  it('attachments: only the caller’s own uploads that exist; the stored size wins; 35 MB in all', async () => {
    await inTransaction(async () => {
      const [owner, other] = await members();
      const f = await fixture(owner);
      const mine = `${owner}/u1/brief.pdf`;
      const theirs = `${other}/u2/secret.pdf`;
      await db.query(
        `insert into storage.objects (bucket_id, name, metadata) values ('mail-outbox', $1, '{"size": 2048}'), ('mail-outbox', $2, '{"size": 10}'),
                ('mail-outbox', $3, '{"size": 30000000}'), ('mail-outbox', $4, '{"size": 9000000}')`,
        [mine, theirs, `${owner}/u3/big1.bin`, `${owner}/u4/big2.bin`],
      );
      const att = (paths: string[]) => JSON.stringify(paths.map((p) => ({ path: p, name: p.split('/').pop(), size: 1, contentType: 'application/pdf' })));
      const SQL = `select * from mail_outbox_submit($1, $2, null, 'new', null, 'S', '<p>x</p>', $3::jsonb, '[]'::jsonb, '[]'::jsonb, $4::jsonb, null)`;
      await as(owner);
      const ok = (await db.query(SQL, [crypto.randomUUID(), f.mailbox, TO, att([mine])])).rows[0];
      expect(await failsWith(SQL, [crypto.randomUUID(), f.mailbox, TO, att([theirs])])).toBe('22023');
      expect(await failsWith(SQL, [crypto.randomUUID(), f.mailbox, TO, att([`${owner}/u9/missing.pdf`])])).toBe('22023');
      expect(await failsWith(SQL, [crypto.randomUUID(), f.mailbox, TO, att([`${owner}/../${other}/u2/secret.pdf`])])).toBe('22023');
      expect(await failsWith(SQL, [crypto.randomUUID(), f.mailbox, TO, att([`${owner}/u3/big1.bin`, `${owner}/u4/big2.bin`])])).toBe('22023');
      await asSuper();
      const stored = (await db.query(`select attachments from mail_outbox where id = $1`, [ok.id])).rows[0].attachments;
      expect(stored).toEqual([{ path: mine, name: 'brief.pdf', size: 2048, contentType: 'application/pdf' }]);
    });
  });

  it('carries an autosaved draft’s Outlook id onto the send', async () => {
    await inTransaction(async () => {
      const [owner] = await members();
      const f = await fixture(owner);
      const { rows: d } = await db.query(`insert into mail_drafts (mailbox_id, user_id, kind, draft_graph_id) values ($1, $2, 'new', 'AAMk-draft') returning id`, [f.mailbox, owner]);
      await as(owner);
      const r = (await submit({ mailbox: f.mailbox, draft: d[0].id })).rows[0];
      await asSuper();
      expect((await db.query(`select existing_draft_graph_id g, draft_id from mail_outbox where id = $1`, [r.id])).rows[0]).toEqual({ g: 'AAMk-draft', draft_id: d[0].id });
    });
  });
});

suite('mail_claim_outbox / mail_outbox_cancel (live schema, rolled back)', () => {
  it('is for the engine only: a signed-in person cannot claim', async () => {
    await inTransaction(async () => {
      const [owner] = await members();
      await as(owner);
      expect(await failsWith(`select * from mail_claim_outbox('x', 1, 60, null)`, [])).toBe('42501');
      await asSuper();
    });
  });

  it('claims only what is due, once; a lapsed lease is reclaimed with the attempt counted', async () => {
    await inTransaction(async () => {
      const [owner] = await members();
      const f = await fixture(owner);
      await as(owner);
      const due = (await submit({ mailbox: f.mailbox })).rows[0].id as string;
      const later = (await submit({ mailbox: f.mailbox })).rows[0].id as string;
      await asSuper();
      expect((await claim()).rows).toEqual([]); // nothing due yet: the undo window is still open
      await db.query(`update mail_outbox set release_at = now() - interval '1 second' where id = $1`, [due]);
      const first = (await claim()).rows;
      expect(first).toEqual([{ id: due, status: 'sending', attempts: 1, leased: true }]);
      expect((await claim()).rows).toEqual([]); // leased: not handed out twice
      await db.query(`update mail_outbox set lease_until = now() - interval '1 second' where id = $1`, [due]);
      expect((await claim()).rows).toEqual([{ id: due, status: 'sending', attempts: 2, leased: true }]);
      await db.query(`update mail_outbox set release_at = now() - interval '1 second' where id = $1`, [later]);
      expect((await claim(due)).rows).toEqual([]); // p_only: just that one (still leased)
      expect((await claim(later)).rows.map((r) => r.id)).toEqual([later]);
    });
  });

  it('undo wins before the claim, and is refused after it', async () => {
    await inTransaction(async () => {
      const [owner, other] = await members();
      const f = await fixture(owner);
      await as(owner);
      const a = (await submit({ mailbox: f.mailbox })).rows[0].id as string;
      const b = (await submit({ mailbox: f.mailbox })).rows[0].id as string;
      await as(other);
      expect((await db.query(`select mail_outbox_cancel($1) ok`, [a])).rows[0].ok).toBe(false); // not theirs
      await as(owner);
      expect((await db.query(`select mail_outbox_cancel($1) ok`, [a])).rows[0].ok).toBe(true);
      await asSuper();
      await db.query(`update mail_outbox set release_at = now() - interval '1 second' where id = any($1)`, [[a, b]]);
      expect((await claim()).rows.map((r) => r.id)).toEqual([b]); // the cancelled one never goes
      await as(owner);
      expect((await db.query(`select mail_outbox_cancel($1) ok`, [b])).rows[0].ok).toBe(false); // already sending
      await asSuper();
    });
  });
});
