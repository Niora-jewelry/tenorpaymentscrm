/**
 * Sending inbox — the database half, against the live functions, inside one
 * transaction that is always rolled back.
 *
 *   mail_send_purposes      RLS: nothing from the browser; rules enforced
 *   set_mail_send_purpose   admins only; an inbox with no connection is refused
 *   crm_mail_enqueue        server only; the inbox's connection, the asker kept
 *   crm_mail_failed         a refused signer email is that signer's bounce; an
 *                           application or proposal is noted on its record
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const DB_URL = process.env.SUPABASE_DB_URL;
const suite = DB_URL ? describe : describe.skip;
let db: pg.Client;

const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows as T[];
const one = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await q<T>(sql, p))[0]!;

/** Runs as a signed-in person, and rolls that part back. */
async function as<T>(user: string | null, fn: () => Promise<T>): Promise<T | Error> {
  await q('savepoint who');
  try {
    await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user, role: 'authenticated' })]);
    await q(`set local role authenticated`);
    const out = await fn();
    await q('rollback to savepoint who');
    return out;
  } catch (e) {
    await q('rollback to savepoint who');
    return e as Error;
  }
}

suite('Sending inbox', () => {
  let admin: string;
  let member: string;
  let rec: string;
  let mailbox: string;
  let identity: string;

  const enqueue = (ref: string, opts: { user?: string | null; asker?: string | null; to?: unknown[] } = {}) =>
    one<{ id: string; sender_user: string }>(
      `select * from crm_mail_enqueue($1, $2, $3, $4, $5, $6, 'Subject', '<p>Body</p>', $7::jsonb, '[]'::jsonb, '[]'::jsonb)`,
      [randomUUID(), mailbox, opts.user ?? member, opts.asker ?? member, ref, rec, JSON.stringify(opts.to ?? [{ name: '', address: 'merchant@zz.test' }])],
    );

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
    rec = (await one<{ id: string }>(`insert into records (deal_name, creator_user_id, values) values ('ZZ inbox probe', $1, '{}') returning id`, [admin])).id;
    identity = (
      await one<{ id: string }>(
        `insert into mail_identities (user_id, microsoft_user_id, tenant_id, primary_email, display_name) values ($1, 'zz-probe', 'zz', 'office@zz.test', 'Office') returning id`,
        [admin],
      )
    ).id;
    mailbox = (
      await one<{ id: string }>(`insert into mail_mailboxes (kind, address, display_name, sync_identity_id, sync_status) values ('personal', 'office@zz.test', 'Office', $1, 'paused') returning id`, [identity])
    ).id;
    await q(`insert into mail_connections (user_id, mailbox_id, identity_id) values ($1, $2, $3)`, [admin, mailbox, identity]);
  });

  afterAll(async () => {
    await db.query('ROLLBACK').catch(() => undefined);
    await db.end().catch(() => undefined);
  });

  it('the setting is invisible from the browser', async () => {
    const r = await as(member, () => q(`select * from mail_send_purposes`));
    expect(r).toBeInstanceOf(Error);
    expect((r as Error).message).toMatch(/permission denied/);
  });

  it('the rules hold in the table itself', async () => {
    for (const bad of [`('applications', 'signwell', null)`, `('applications', 'mailbox', null)`, `('proposals', 'own', '${mailbox}'::uuid)`]) {
      await q('savepoint s');
      await expect(q(`insert into mail_send_purposes (purpose, mode, mailbox_id) values ${bad}`)).rejects.toThrow(/check constraint/);
      await q('rollback to savepoint s');
    }
  });

  it('a member cannot change the setting; an admin can, and only to a working inbox', async () => {
    const denied = await as(member, () => q(`select set_mail_send_purpose('agreements', 'mailbox', $1)`, [mailbox]));
    expect((denied as Error).message).toMatch(/no access to presets/);

    const saved = await as(admin, async () => {
      await q(`select set_mail_send_purpose('agreements', 'mailbox', $1)`, [mailbox]);
      await q(`select set_mail_send_purpose('agreements', 'signwell', null)`);
      return 'ok';
    });
    expect(saved).toBe('ok');

    const none = await as(admin, () => q(`select set_mail_send_purpose('applications', 'mailbox', $1)`, [randomUUID()]));
    expect((none as Error).message).toMatch(/no working connection/);
    const wrong = await as(admin, () => q(`select set_mail_send_purpose('proposals', 'signwell', null)`));
    expect((wrong as Error).message).toMatch(/only agreements/);
  });

  it('nobody signed in can queue a CRM email or report one failed', async () => {
    for (const sql of [
      `select crm_mail_enqueue(gen_random_uuid(), gen_random_uuid(), null, null, null, null, 's', 'b', '[]', '[]', '[]')`,
      `select crm_mail_failed(gen_random_uuid(), 'x')`,
    ]) {
      const r = await as(admin, () => q(sql));
      expect((r as Error).message).toMatch(/permission denied/);
    }
  });

  it('a queued email goes through the inbox’s connection and remembers who asked', async () => {
    const row = await enqueue(`application:${randomUUID()}`);
    expect(row.sender_user).toBe(admin); // the member has no connection: the connector's is used
    const o = await one<Record<string, unknown>>(`select * from mail_outbox where id = $1`, [row.id]);
    expect(o).toMatchObject({ user_id: admin, identity_id: identity, requested_by: member, record_id: rec, status: 'held', kind: 'new' });
  });

  it('an inbox with no working connection is refused, and so is no recipient', async () => {
    await q('savepoint s');
    await expect(enqueue('application:x', { to: [] })).rejects.toThrow(/Between 1 and 50/);
    await q('rollback to savepoint s');
    await q('savepoint s');
    await q(`update mail_connections set status = 'broken' where mailbox_id = $1`, [mailbox]);
    await expect(enqueue('application:x')).rejects.toThrow(/no working connection/);
    await q('rollback to savepoint s');
  });

  it('a signer’s refused email is that signer’s bounce: told once, and the agreement knows', async () => {
    const a = await one<{ id: string }>(
      `insert into agreements (record_id, kind, status, vendor, vendor_document_id, sent_by, expires_at, subject, message, requester_name, snapshot_sealed, snapshot_iv, used_field_keys, signer_count, delivery, delivery_mailbox_id, delivery_address)
       values ($1, 'maverick_merchant', 'sent', 'signwell', 'doc-zz-inbox', $2, now() + interval '30 days', 's', 'm', 'r', '\\x00', '\\x00', '{}', 1, 'outlook', $3, 'office@zz.test') returning id`,
      [rec, admin, mailbox],
    );
    const s = await one<{ id: string }>(
      `insert into agreement_signers (agreement_id, record_id, slot, owner_index, name, email, status) values ($1, $2, 1, 0, 'Jane Doe', 'jane@zz.test', 'sent') returning id`,
      [a.id, rec],
    );
    const row = await enqueue(`agreement_link:${s.id}`, { asker: admin });
    await q(`select crm_mail_failed($1, 'The address does not exist.')`, [row.id]);
    expect((await one<{ status: string }>(`select status::text from agreement_signers where id = $1`, [s.id])).status).toBe('bounced');
    const notes = () => q(`select body from notifications where agreement_id = $1`, [a.id]);
    const first = (await notes()).length;
    expect(first).toBe(1);
    // A second report of the same outbox row changes nothing.
    await q(`select crm_mail_failed($1, 'The address does not exist.')`, [row.id]);
    expect((await notes()).length).toBe(first);
  });

  it('a notice that fails is not a bounce, and an unreadable reference is ignored', async () => {
    const a = await one<{ id: string }>(`select id from agreements where vendor_document_id = 'doc-zz-inbox'`);
    const s2 = await one<{ id: string }>(
      `insert into agreement_signers (agreement_id, record_id, slot, owner_index, name, email, status) values ($1, $2, 2, 1, 'John Roe', 'john@zz.test', 'sent') returning id`,
      [a.id, rec],
    );
    const n = await enqueue(`agreement_notice:${s2.id}`, { asker: admin });
    await q(`select crm_mail_failed($1, 'x')`, [n.id]);
    expect((await one<{ status: string }>(`select status::text from agreement_signers where id = $1`, [s2.id])).status).toBe('sent');
    const junk = await enqueue('application:not-a-uuid', { asker: admin });
    await expect(q(`select crm_mail_failed($1, 'x')`, [junk.id])).resolves.toBeTruthy();
  });

  it('an application that did not send is noted on its record', async () => {
    const app = await one<{ id: string; number: number }>(
      `insert into applications (record_id, token_hash, token_sealed, token_iv, recipient, cc, subject, sent_by, expires_at)
       values ($1, '\\x01', '\\x00', '\\x00', 'merchant@zz.test', '{}', 's', $2, now() + interval '7 days') returning id, number`,
      [rec, admin],
    );
    const row = await enqueue(`application:${app.id}`, { asker: admin });
    await q(`select crm_mail_failed($1, 'Outlook refused it.')`, [row.id]);
    const log = await q<{ summary: string }>(`select summary from record_activity where record_id = $1 and summary like 'Application email%'`, [rec]);
    expect(log.length).toBe(1);
    expect(log[0]!.summary).toContain('merchant@zz.test');
    expect(log[0]!.summary).toContain('Outlook refused it.');
  });
});
