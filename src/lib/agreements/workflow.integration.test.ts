/**
 * Agreements — the database half, against the live functions, inside one
 * transaction that is always rolled back.
 *
 *   agreement_apply_event   forward-only statuses, per-signer statuses,
 *                           one notification per signer event, a replay is
 *                           a no-op, a terminal status absorbs what follows
 *   agreement_log           activity row + Updates post, authored by the sender
 *   RLS                     a member sees the row, never the sealed snapshot
 *   agreements_one_open     a second open agreement on a record is refused
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

const DB_URL = process.env.SUPABASE_DB_URL;
const suite = DB_URL ? describe : describe.skip;
let db: pg.Client;

const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows as T[];
const one = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await q<T>(sql, p))[0]!;

suite('Agreements — workflow', () => {
  let admin: string;
  let member: string;
  let rec: string;
  let agr: string;
  let label: string;
  const DOC = 'doc-zz-probe-1';

  const apply = (type: string, signer: string | null, dedupe: string, reason: string | null = null, source = 'webhook') =>
    one<{ applied: boolean; status_after: string; completed_now: boolean }>(
      `select * from agreement_apply_event('signwell', $1, null, $2, $3, now(), null, $4, $5, $6)`,
      [DOC, dedupe, type, signer, reason, source],
    );
  const status = async () => (await one<{ status: string }>(`select status::text from agreements where id = $1`, [agr])).status;
  const signerStatus = async (email: string) => (await one<{ status: string }>(`select status::text from agreement_signers where agreement_id = $1 and email = $2`, [agr, email])).status;
  const notes = async () => q<{ body: string }>(`select body from notifications where agreement_id = $1 and recipient_id = $2 order by created_at`, [agr, admin]);

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
         values ('ZZ agreement probe', $1, jsonb_build_object('team_members_assigned', jsonb_build_array($2::text))) returning id`,
        [admin, member],
      )
    ).id;
    await q(`insert into record_modules (record_id, module_id) select $1, id from modules where slug = 'leads'`, [rec]);
    const a = await one<{ id: string; number: number }>(
      `insert into agreements (record_id, kind, status, vendor, vendor_document_id, sent_by, expires_at, subject, message, requester_name,
                               snapshot_sealed, snapshot_iv, used_field_keys, signer_count)
       values ($1, 'maverick_merchant', 'sent', 'signwell', $2, $3, now() + interval '30 days', 's', 'm', 'TapDash', '\\x00', '\\x00', '{legal_business_name,ein}', 2)
       returning id, number`,
      [rec, DOC, admin],
    );
    agr = a.id;
    label = (await one<{ l: string }>(`select agreement_label($1) l`, [a.number])).l;
    await q(
      `insert into agreement_signers (agreement_id, record_id, slot, owner_index, name, email, ownership_pct, vendor_recipient_id)
       values ($1, $2, 1, 0, 'Jane Doe', 'jane@zz.test', 60, 'r1'), ($1, $2, 2, 1, 'John Roe', 'john@zz.test', 40, 'r2')`,
      [agr, rec],
    );
  });

  afterAll(async () => {
    if (db) {
      await db.query('ROLLBACK');
      await db.end();
    }
  });

  it('viewed → the document and the signer move, the sender is told once', async () => {
    const r = await apply('document_viewed', 'jane@zz.test', 'v1');
    expect(r.applied).toBe(true);
    expect(await status()).toBe('viewed');
    expect(await signerStatus('jane@zz.test')).toBe('viewed');
    expect(await signerStatus('john@zz.test')).toBe('sent');
    expect((await notes()).map((n) => n.body)).toEqual([`Jane Doe viewed agreement ${label}.`]);
  });

  it('a replay of the same event changes nothing', async () => {
    const r = await apply('document_viewed', 'jane@zz.test', 'v1');
    expect(r.applied).toBe(false);
    expect((await notes()).length).toBe(1);
  });

  it('signed → partially signed; the activity and Updates carry it', async () => {
    const r = await apply('document_signed', 'jane@zz.test', 's1');
    expect(r.applied).toBe(true);
    expect(await status()).toBe('partially_signed');
    expect(await signerStatus('jane@zz.test')).toBe('signed');
    const act = await q<{ summary: string; source: string }>(`select summary, source from record_activity where record_id = $1 and kind = 'agreement' order by at`, [rec]);
    expect(act.some((a) => a.summary === `Jane Doe signed ${label}` && a.source === `Agreement ${label}`)).toBe(true);
    const upd = await q<{ body: string; author_id: string }>(`select body, author_id from updates where record_id = $1 order by created_at`, [rec]);
    expect(upd.some((u) => u.body === `Jane Doe signed agreement ${label}.` && u.author_id === admin)).toBe(true);
  });

  it('a late "viewed" for the second signer still lands on the signer', async () => {
    await apply('document_viewed', 'john@zz.test', 'v2');
    expect(await status()).toBe('partially_signed');
    expect(await signerStatus('john@zz.test')).toBe('viewed');
  });

  it('a bounce marks the signer only; the agreement stays open', async () => {
    await apply('document_bounced', 'john@zz.test', 'b1');
    expect(await status()).toBe('partially_signed');
    expect(await signerStatus('john@zz.test')).toBe('bounced');
    expect((await notes()).at(-1)?.body).toContain('bounced');
  });

  it('completed → every signer signed, the download is pending, the sender is told', async () => {
    const r = await apply('document_completed', null, 'c1');
    expect(r.applied).toBe(true);
    expect(r.completed_now).toBe(true);
    expect(await status()).toBe('completed');
    expect(await signerStatus('john@zz.test')).toBe('signed');
    const row = await one<{ download_status: string; completed_at: string | null }>(`select download_status, completed_at from agreements where id = $1`, [agr]);
    expect(row.download_status).toBe('pending');
    expect(row.completed_at).not.toBeNull();
    expect((await notes()).at(-1)?.body).toBe(`All principals signed agreement ${label}. The signed PDF is saved on the record.`);
  });

  it('a terminal status absorbs what follows: declined, viewed, canceled', async () => {
    const before = (await notes()).length;
    for (const [t, k] of [['document_declined', 'd1'], ['document_viewed', 'v3'], ['document_canceled', 'x1']] as const) {
      const r = await apply(t, 'jane@zz.test', k);
      expect(r.applied, t).toBe(false);
    }
    expect(await status()).toBe('completed');
    expect((await notes()).length).toBe(before);
  });

  // An expected error aborts the transaction, so each one runs inside a
  // savepoint and is rolled back to it.
  const expectError = async (sql: string, p: unknown[], code: string) => {
    await q('savepoint expected');
    try {
      await expect(q(sql, p)).rejects.toMatchObject({ code });
    } finally {
      await q('rollback to savepoint expected');
    }
  };

  it('an unknown document is refused as P0002', async () => {
    await expectError(`select * from agreement_apply_event('signwell', 'doc-nobody-knows', null, 'u1', 'document_viewed', now(), null, null, null, 'webhook')`, [], 'P0002');
  });

  it('a second open agreement on the record is refused', async () => {
    await q(`update agreements set status = 'sent' where id = $1`, [agr]);
    await expectError(
      `insert into agreements (record_id, kind, status, vendor, sent_by, expires_at, subject, message, requester_name, snapshot_sealed, snapshot_iv, signer_count)
       values ($1, 'maverick_merchant', 'sending', 'signwell', $2, now() + interval '30 days', 's', 'm', 'TapDash', decode('00', 'hex'), decode('00', 'hex'), 1)`,
      [rec, admin],
      '23505',
    );
    await q(`update agreements set status = 'completed' where id = $1`, [agr]);
  });

  it('RLS: a member on the record sees the agreement but never the sealed snapshot', async () => {
    await q(`select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`, [JSON.stringify({ sub: member, role: 'authenticated' })]);
    const rows = await q<{ id: string }>(`select id from agreements where id = $1`, [agr]);
    expect(rows.length).toBe(1);
    await expectError(`select snapshot_sealed from agreements where id = $1`, [agr], '42501');
    await expectError(`select id from agreement_events where agreement_id = $1`, [agr], '42501');
  });
});
