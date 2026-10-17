/**
 * The Email module's database boundary, proven against the live schema.
 *
 * Everything runs inside ONE transaction per test that is always rolled
 * back: fixture mailboxes, connections and messages are created, the role
 * of two test accounts is raised to admin, identities are borrowed with
 * `set local role authenticated` + `request.jwt.claims` — and none of it is
 * ever committed. Only `.test` / test accounts are used.
 *
 * ── THE VISIBILITY MATRIX (spec, 16 Oct 2026) ────────────────────────────
 *   A1, A2 = admins (A2 hides her mailboxes from other admins)
 *   M1, M2 = standard users
 *
 *   P1 personal  connected by M1
 *   P2 personal  connected by A2 only            → hidden from A1
 *   P3 personal  connected by A2 and M2          → A1 sees it, through M2
 *   S1 shared    connected by M1 and M2          → admins do NOT see it
 *   S2 shared    connected by A1
 *
 *   M1 → P1, S1        M2 → P3, S1
 *   A1 → P1, P3, S2    A2 → P1, P2, P3
 *
 * Every read is also made as someone who SHOULD see rows, so an empty table
 * cannot make "sees nothing" pass by accident.
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

type People = { A1: string; A2: string; M1: string; M2: string };

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

async function asSuper() {
  await db.query('reset role');
}

/** Runs a statement expected to fail; returns the SQLSTATE and keeps the transaction usable. */
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

async function pickPeople(): Promise<People> {
  const { rows } = await db.query(`
    select p.id from profiles p
     where p.deleted_at is null and p.status = 'active'
       and (p.email::text like '%@tapdash.test' or p.email::text like 'itest-%' or p.email::text like 'test-member@%')
     order by p.email limit 4`);
  if (rows.length < 4) throw new Error('need four active test accounts');
  const [A1, A2, M1, M2] = rows.map((r) => r.id as string);
  // Inside the rolled-back transaction: A1/A2 admins, M1/M2 members.
  const { rows: roles } = await db.query(`select id, is_admin from roles order by is_admin desc, name`);
  const admin = roles.find((r) => r.is_admin).id;
  const member = roles.find((r) => !r.is_admin).id;
  await db.query(`update profiles set role_id = $1 where id = any($2)`, [admin, [A1, A2]]);
  await db.query(`update profiles set role_id = $1 where id = any($2)`, [member, [M1, M2]]);
  return { A1, A2, M1, M2 };
}

async function identity(userId: string): Promise<string> {
  const { rows } = await db.query(
    `insert into mail_identities (user_id, microsoft_user_id, primary_email) values ($1, gen_random_uuid()::text, 'x@zz.test') returning id`,
    [userId]);
  return rows[0].id;
}

async function mailbox(kind: 'personal' | 'shared', address: string): Promise<string> {
  const { rows } = await db.query(`insert into mail_mailboxes (kind, address) values ($1, $2) returning id`, [kind, address]);
  const id = rows[0].id as string;
  await db.query(`insert into mail_messages (mailbox_id, graph_id, subject) values ($1, gen_random_uuid()::text, 'probe')`, [id]);
  return id;
}

async function connect(userId: string, identityId: string, mailboxId: string) {
  await db.query(`insert into mail_connections (user_id, mailbox_id, identity_id) values ($1, $2, $3)`, [userId, mailboxId, identityId]);
}

async function visible(userId: string): Promise<string[]> {
  await as(userId);
  const { rows } = await db.query(`select m.address::text a from mail_mailboxes m order by 1`);
  const { rows: msgs } = await db.query(`select count(*)::int n from mail_messages`);
  await asSuper();
  // Messages must follow mailboxes exactly — one probe message each.
  expect(msgs[0].n, `${userId}: message visibility disagrees with mailbox visibility`).toBe(rows.length);
  return rows.map((r) => r.a);
}

suite('Email module — RLS shape', () => {
  it('every mail_* table has RLS enabled AND forced, and signed-in users cannot write any of them', async () => {
    const { rows } = await db.query(`
      select c.relname, c.relrowsecurity rls, c.relforcerowsecurity forced,
             has_table_privilege('authenticated', c.oid, 'INSERT') ins,
             has_table_privilege('authenticated', c.oid, 'UPDATE') upd,
             has_table_privilege('authenticated', c.oid, 'DELETE') del,
             has_table_privilege('anon', c.oid, 'SELECT') anon_sel
        from pg_class c
       where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname like 'mail\\_%'`);
    expect(rows.length, 'mail tables missing').toBeGreaterThanOrEqual(20);
    const bad = rows.filter((r) => !r.rls || !r.forced || r.ins || r.upd || r.del || r.anon_sel).map((r) => r.relname);
    expect(bad, `unprotected: ${bad.join(', ')}`).toEqual([]);
  });

  it('the token table is unreadable by any signed-in session', async () => {
    const { rows } = await db.query(`select has_table_privilege('authenticated', 'public.mail_identity_secrets', 'SELECT') s`);
    expect(rows[0].s).toBe(false);
  });

  it('every SECURITY DEFINER mail_ function pins its search_path', async () => {
    const { rows } = await db.query(`
      select p.proname, p.proconfig from pg_proc p
       where p.pronamespace = 'public'::regnamespace and p.prosecdef
         and (p.proname like 'mail\\_%' or p.proname like 'tg\\_mail\\_%')`);
    expect(rows.length).toBeGreaterThan(10);
    const unpinned = rows.filter((r) => !(r.proconfig ?? []).some((c: string) => c.startsWith('search_path=public'))).map((r) => r.proname);
    expect(unpinned).toEqual([]);
  });

  it('the connect function is not callable by a signed-in session', async () => {
    const { rows } = await db.query(`
      select has_function_privilege('authenticated', p.oid, 'EXECUTE') x from pg_proc p where p.proname = 'mail_connect_mailbox'`);
    expect(rows[0].x).toBe(false);
  });
});

suite('Email module — who sees which mailbox', () => {
  it('matches the spec matrix exactly, for messages as well as mailboxes', async () => {
    await inTransaction(async () => {
      const P = await pickPeople();
      const id = { A1: await identity(P.A1), A2: await identity(P.A2), M1: await identity(P.M1), M2: await identity(P.M2) };
      const P1 = await mailbox('personal', 'p1@zz.test');
      const P2 = await mailbox('personal', 'p2@zz.test');
      const P3 = await mailbox('personal', 'p3@zz.test');
      const S1 = await mailbox('shared', 's1@zz.test');
      const S2 = await mailbox('shared', 's2@zz.test');
      await connect(P.M1, id.M1, P1);
      await connect(P.A2, id.A2, P2);
      await connect(P.A2, id.A2, P3);
      await connect(P.M2, id.M2, P3);
      await connect(P.M1, id.M1, S1);
      await connect(P.M2, id.M2, S1);
      await connect(P.A1, id.A1, S2);
      await db.query(`insert into mail_user_settings (user_id, hide_my_mailboxes_from_admins) values ($1, true)`, [P.A2]);

      expect(await visible(P.M1)).toEqual(['p1@zz.test', 's1@zz.test']);
      expect(await visible(P.M2)).toEqual(['p3@zz.test', 's1@zz.test']);
      expect(await visible(P.A1)).toEqual(['p1@zz.test', 'p3@zz.test', 's2@zz.test']);
      expect(await visible(P.A2)).toEqual(['p1@zz.test', 'p2@zz.test', 'p3@zz.test']);

      // A standard user's hide flag does nothing.
      await db.query(`insert into mail_user_settings (user_id, hide_my_mailboxes_from_admins) values ($1, true)`, [P.M1]);
      expect(await visible(P.A1)).toContain('p1@zz.test');

      // Disconnecting removes the mailbox from that person's view only.
      await as(P.M1);
      const { rows: c } = await db.query(`select id from mail_connections where mailbox_id = $1 and user_id = $2`, [S1, P.M1]);
      await db.query(`select mail_disconnect_mailbox($1)`, [c[0].id]);
      await asSuper();
      expect(await visible(P.M1)).toEqual(['p1@zz.test']);
      expect(await visible(P.M2)).toEqual(['p3@zz.test', 's1@zz.test']);
    });
  });
});

suite('Email module — limits and dedupe', () => {
  it('the 31st connection is refused with mail_limit_reached', async () => {
    await inTransaction(async () => {
      const P = await pickPeople();
      const ident = await identity(P.M1);
      for (let i = 0; i < 30; i++) await connect(P.M1, ident, await mailbox('personal', `cap${i}@zz.test`));
      const extra = await mailbox('personal', 'cap30@zz.test');
      expect(await refused(`insert into mail_connections (user_id, mailbox_id, identity_id) values ($1, $2, $3)`, [P.M1, extra, ident])).toBe('P0001');
    });
  });

  it('two people connecting the same address share ONE mailbox row', async () => {
    await inTransaction(async () => {
      const P = await pickPeople();
      const call = (user: string, oid: string) => db.query(
        `select mail_connect_mailbox($1, $2, 't', 'shared@zz.test', 'X', '{Mail.ReadWrite}', '{}', '\\x00'::bytea, '\\x00'::bytea, 'shared', 'Shared@ZZ.test', 'Shared', null) r`,
        [user, oid]);
      const a = (await call(P.M1, 'oid-1')).rows[0].r;
      const b = (await call(P.M2, 'oid-2')).rows[0].r;
      expect(a.mailbox_id).toBe(b.mailbox_id);
      expect(a.mailbox_created).toBe(true);
      expect(b.mailbox_created).toBe(false);
      const again = (await call(P.M1, 'oid-1')).rows[0].r;
      expect(again.reconnected).toBe(true);
      expect(again.connection_id).toBe(a.connection_id);
      const { rows } = await db.query(`select count(*)::int n from mail_mailboxes where address = 'shared@zz.test'`);
      expect(rows[0].n).toBe(1);
    });
  });
});

suite('Email module — RPCs refuse what is not yours', () => {
  it('cannot disconnect, pin, or edit what belongs to someone else; cannot write tables directly', async () => {
    await inTransaction(async () => {
      const P = await pickPeople();
      const idM1 = await identity(P.M1);
      const P1 = await mailbox('personal', 'own@zz.test');
      await connect(P.M1, idM1, P1);
      const { rows: f } = await db.query(`insert into mail_folders (mailbox_id, graph_id, display_name, well_known) values ($1, 'g', 'Inbox', 'inbox') returning id`, [P1]);
      const { rows: c } = await db.query(`select id from mail_connections where mailbox_id = $1`, [P1]);

      await as(P.M2);
      expect(await refused(`select mail_disconnect_mailbox($1)`, [c[0].id])).toBe('42501');
      expect(await refused(`select mail_set_pin($1, $2, 'conv', true)`, [P1, f[0].id])).toBe('42501');
      expect(await refused(`select mail_template_upsert(null, 'T', null, '<p>x</p>', true)`)).toBe('42501');
      expect(await refused(`select mail_set_user_settings(11::smallint, false, null)`)).toBe('22023');
      expect(await refused(`insert into mail_messages (mailbox_id, graph_id) values ($1, 'x')`, [P1])).toBe('42501');
      expect(await refused(`update mail_mailboxes set display_name = 'x'`)).toBe('42501');

      // …and the owner can.
      await as(P.M1);
      expect(await refused(`select mail_set_pin($1, $2, 'conv', true)`, [P1, f[0].id])).toBeNull();
      expect(await refused(`select mail_set_user_settings(7::smallint, false, null)`)).toBeNull();
      const { rows: t } = await db.query(`select mail_template_upsert(null, 'Mine', null, '<p>x</p>', false) id`);
      expect(t[0].id).toBeTruthy();

      // An admin may manage shared templates.
      await as(P.A1);
      expect(await refused(`select mail_template_upsert(null, 'Shared', null, '<p>x</p>', true)`)).toBeNull();
    });
  });

  it('undo send stops a held message once, and reports when it was too late', async () => {
    await inTransaction(async () => {
      const P = await pickPeople();
      const mb = await mailbox('personal', 'send@zz.test');
      const { rows } = await db.query(
        `insert into mail_outbox (idempotency_key, mailbox_id, user_id, kind, body_html, status, release_at)
         values (gen_random_uuid(), $1, $2, 'new', '<p>x</p>', 'held', now() + interval '5 seconds') returning id`, [mb, P.M1]);
      await as(P.M2);
      expect((await db.query(`select mail_outbox_cancel($1) ok`, [rows[0].id])).rows[0].ok).toBe(false);
      await as(P.M1);
      expect((await db.query(`select mail_outbox_cancel($1) ok`, [rows[0].id])).rows[0].ok).toBe(true);
      expect((await db.query(`select mail_outbox_cancel($1) ok`, [rows[0].id])).rows[0].ok).toBe(false);
    });
  });
});
