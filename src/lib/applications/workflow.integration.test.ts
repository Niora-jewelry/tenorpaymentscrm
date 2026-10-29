/**
 * Prepopulated Application — the database half, against the live functions,
 * inside one transaction that is always rolled back.
 *
 *   application_record_return   empty fields fill (with history + source),
 *                               differences wait, notes are written, status moves
 *   application_write_values    accept / keep settle rows; nothing left → Reviewed
 *   RLS                         a person without the Applications tab sees no
 *                               application; a hidden field's review row is absent
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

const DB_URL = process.env.SUPABASE_DB_URL;
const suite = DB_URL ? describe : describe.skip;
let db: pg.Client;

const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows as T[];
const one = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await q<T>(sql, p))[0]!;

suite('Prepopulated Application — workflow', () => {
  let admin: string;
  let member: string;
  let rec: string;
  let app: string;
  let label: string;

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
         values ('ZZ application probe', $1, jsonb_build_object('dba', 'Old DBA', 'team_members_assigned', jsonb_build_array($2::text),
                 'owner_ownership', jsonb_build_array(jsonb_build_object('first','Joe','last','B')), 'owner_private', jsonb_build_array(jsonb_build_object('ssn','111223333'))))
         returning id`,
        [admin, member],
      )
    ).id;
    await q(`insert into record_modules (record_id, module_id) select $1, id from modules where slug = 'leads'`, [rec]);
    const a = await one<{ id: string; number: number }>(
      `insert into applications (record_id, token_hash, token_sealed, token_iv, recipient, subject, sent_by, expires_at)
       values ($1, gen_random_bytes(32), '\\x00', '\\x00', 'm@zz.test', 's', $2, now() + interval '30 days') returning id, number`,
      [rec, admin],
    );
    app = a.id;
    label = (await one<{ l: string }>(`select application_label($1) l`, [a.number])).l;
  });

  afterAll(async () => {
    if (db) {
      await db.query('ROLLBACK');
      await db.end();
    }
  });

  it('a return fills empty fields with history and source, holds differences, writes notes', async () => {
    const before = await one<{ updated_at: string }>(`select updated_at::text as updated_at from records where id = $1`, [rec]);
    const res = await one<{ applied: number; pending: number }>(
      `select * from application_record_return($1, $2, $3, $4, 'online', null, $5)`,
      [
        app,
        JSON.stringify([
          { target: 'field:legal_business_name', field_key: 'legal_business_name', question: 'Legal business name', crm_value: null, answer_value: { v: 'Acme LLC' }, answer_display: 'Acme LLC', crm_display: null, status: 'applied' },
          { target: 'field:dba', field_key: 'dba', question: 'DBA', crm_value: 'Old DBA', answer_value: { v: 'New DBA' }, answer_display: 'New DBA', crm_display: 'Old DBA', status: 'pending' },
          { target: 'member:owner_private.0.ssn', field_key: 'owner_private', question: 'Owner 1 — SSN', crm_value: null, answer_value: { v: '999887777' }, answer_display: '•••-••-7777', crm_display: '•••-••-3333', status: 'pending' },
          { target: 'field:square_footage', field_key: 'square_footage', question: 'Square footage', crm_value: null, answer_value: { v: null, c: [{ value: '0_500', display: '0-500' }, { value: '501_2500', display: '501-2500' }] }, answer_display: '1–1000 sq ft', crm_display: null, status: 'pending' },
          { target: 'note:bankruptcy', field_key: 'bankruptcy', question: 'Bankruptcy details', crm_value: null, answer_value: { v: 'Ch. 7' }, answer_display: 'Ch. 7', crm_display: null, status: 'applied' },
        ]),
        JSON.stringify({ legal_business_name: 'Acme LLC' }),
        JSON.stringify([{ field_key: 'bankruptcy', body: 'Bankruptcy details: Ch. 7' }]),
        before.updated_at,
      ],
    );
    expect(res).toEqual({ applied: 2, pending: 3 });

    const r = await one<{ v: Record<string, unknown> }>(`select values v from records where id = $1`, [rec]);
    expect(r.v.legal_business_name).toBe('Acme LLC');
    expect(r.v.dba).toBe('Old DBA'); // held, not overwritten

    const h = await one<{ source: string; actor_id: string | null; summary: string }>(
      `select source, actor_id, summary from record_activity where record_id = $1 and field_key = 'legal_business_name'`,
      [rec],
    );
    expect(h.source).toBe(`Application ${label}, online`);
    expect(h.summary).toContain(label);

    const note = await one<{ body: string; scope_id: string }>(`select body, scope_id from notes where record_id = $1 and scope_kind = 'field'`, [rec]);
    expect(note.scope_id).toBe('bankruptcy');
    expect(note.body).toContain('Ch. 7');

    const a = await one<{ status: string; returned_via: string }>(`select status, returned_via from applications where id = $1`, [app]);
    expect(a).toEqual({ status: 'submitted', returned_via: 'online' });
    // A CRM SSN is never copied into the review table.
    const ssnRow = await one<{ crm_value: unknown }>(`select crm_value from application_changes where application_id = $1 and target like 'member:owner_private%'`, [app]);
    expect(ssnRow.crm_value).toBeNull();
  });

  it('a person who cannot see a field does not see its review row; a person without the tab sees nothing', async () => {
    const asMember = async () =>
      q(`select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`, [JSON.stringify({ sub: member, role: 'authenticated' })]);
    await q('savepoint s');
    await asMember();
    const seenBefore = await q<{ target: string }>(`select target from application_changes where application_id = $1`, [app]);
    await q('rollback to savepoint s');
    expect(seenBefore.some((s) => s.target === 'field:dba')).toBe(true);

    // The SSN field hidden for this person: its review row goes with it.
    await q('savepoint s1');
    await q(`insert into user_grants (user_id, scope_kind, scope_id, grant_level) select $1, 'field', id, 'hidden' from fields where key = 'owner_private'`, [member]);
    await asMember();
    const seen = await q<{ target: string }>(`select target from application_changes where application_id = $1`, [app]);
    await q('rollback to savepoint s1');
    expect(seen.some((s) => s.target.startsWith('member:owner_private'))).toBe(false);
    expect(seen.some((s) => s.target === 'field:dba')).toBe(true);

    await q('savepoint s2');
    await q(
      `insert into permission_settings (owner_kind, owner_id, key, value)
       select 'user', $1, 'module:' || id, 'hidden' from modules where slug = 'leads'
       on conflict (owner_kind, owner_id, key) do update set value = excluded.value`,
      [member],
    );
    await q(`select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`, [JSON.stringify({ sub: member, role: 'authenticated' })]);
    const none = await q(`select id from applications where id = $1`, [app]);
    await q('rollback to savepoint s2');
    expect(none).toHaveLength(0);
  });

  it('accept writes with the reviewer and source; keep leaves the CRM; nothing left → Reviewed', async () => {
    const rows = await q<{ id: string; target: string }>(`select id, target from application_changes where application_id = $1 and status = 'pending'`, [app]);
    const id = (t: string) => rows.find((r) => r.target === t)!.id;
    const before = await one<{ updated_at: string }>(`select updated_at::text as updated_at from records where id = $1`, [rec]);
    await q(`select application_write_values($1, $2, '[]', $3, 'accepted', $4, $5, 'online', $6)`, [
      app,
      JSON.stringify({ dba: 'New DBA', square_footage: '501_2500' }),
      [id('field:dba'), id('field:square_footage')],
      [id('member:owner_private.0.ssn')],
      admin,
      before.updated_at,
    ]);
    const r = await one<{ v: Record<string, unknown> }>(`select values v from records where id = $1`, [rec]);
    expect(r.v.dba).toBe('New DBA');
    expect(r.v.square_footage).toBe('501_2500');
    expect((r.v.owner_private as { ssn: string }[])[0]!.ssn).toBe('111223333'); // kept

    const h = await one<{ actor_id: string; source: string }>(
      `select actor_id, source from record_activity where record_id = $1 and field_key = 'dba' order by at desc limit 1`,
      [rec],
    );
    expect(h).toEqual({ actor_id: admin, source: `Application ${label}, online` });

    const a = await one<{ status: string; reviewed_at: string | null }>(`select status, reviewed_at from applications where id = $1`, [app]);
    expect(a.status).toBe('reviewed');
    expect(a.reviewed_at).not.toBeNull();
    const statuses = await q<{ status: string }>(`select status from application_changes where application_id = $1 order by status`, [app]);
    expect(statuses.map((s) => s.status).sort()).toEqual(['accepted', 'accepted', 'applied', 'applied', 'kept']);
  });

  it('refuses a stale write, a system field, and anything on a voided application', async () => {
    await q('savepoint w');
    await expect(
      q(`select application_write_values($1, '{"dba":"X"}', '[]', '{}', 'applied', '{}', null, 'online', '2000-01-01')`, [app]),
    ).rejects.toThrow(/changed while this was being applied/);
    await q('rollback to savepoint w');
    await q('savepoint w2');
    await expect(q(`select application_write_values($1, '{"deal_name":"X"}', '[]', '{}', 'applied', '{}', null, 'online', null)`, [app])).rejects.toThrow(/cannot write deal_name/);
    await q('rollback to savepoint w2');
    await q('savepoint w3');
    await q(`update applications set status = 'voided' where id = $1`, [app]);
    await expect(q(`select application_write_values($1, '{}', '[]', '{}', 'applied', '{}', null, 'online', null)`, [app])).rejects.toThrow(/voided/);
    await q('rollback to savepoint w3');
  });

  it('the browser can never read the token, its sealed copy or the draft', async () => {
    const cols = await q<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
        where table_name = 'applications' and grantee = 'authenticated' and privilege_type = 'SELECT'`,
    );
    const names = cols.map((c) => c.column_name);
    for (const secret of ['token_hash', 'token_sealed', 'token_iv', 'draft', 'draft_sealed', 'draft_iv']) expect(names).not.toContain(secret);
    const fileCols = (
      await q<{ column_name: string }>(
        `select column_name from information_schema.column_privileges where table_name = 'application_files' and grantee = 'authenticated' and privilege_type = 'SELECT'`,
      )
    ).map((c) => c.column_name);
    expect(fileCols).not.toContain('storage_path');
    expect(fileCols).not.toContain('iv');
  });
});
