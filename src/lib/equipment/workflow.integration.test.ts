/**
 * Merchant Equipment Setup: the database half, against the live functions, inside one
 * transaction that is always rolled back. 9911 is applied inside it too, so this runs
 * the same whether or not 9911 has gone live yet.
 *
 *   equipment_row_*       the value and its log together, provider clears Billed by
 *   equipment_providers   ten presets, duplicates refused in any case
 *   RLS                   default-deny: no signed-in user reads or calls anything
 *   the log               says which column to who can see it, never the value
 *   9911                  columns and grants copied from Merchant Equipment List
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

const DB_URL = process.env.SUPABASE_DB_URL;
const suite = DB_URL ? describe : describe.skip;
let db: pg.Client;

const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows as T[];
const one = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await q<T>(sql, p))[0]!;

suite('Merchant Equipment Setup: workflow', () => {
  let admin: string;
  let member: string;
  let rec: string;
  let contacts: string;

  const as = async <T>(user: string, fn: () => Promise<T>): Promise<T> => {
    await q(`select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`, [JSON.stringify({ sub: user, role: 'authenticated' })]);
    const out = await fn();
    await q(`select set_config('request.jwt.claims', '', true), set_config('role', 'none', true)`);
    return out;
  };
  const refused = async (fn: () => Promise<unknown>, pattern: RegExp) => {
    await q('savepoint s');
    await expect(fn()).rejects.toThrow(pattern);
    await q('rollback to savepoint s');
    await q(`select set_config('request.jwt.claims', '', true), set_config('role', 'none', true)`);
  };

  const addRow = (record = rec) => one<{ id: string }>(`select equipment_row_add($1, $2) id`, [record, admin]).then((r) => r.id);
  const change = (row: string, changes: Record<string, unknown>, actor = admin) => q(`select equipment_row_update($1, $2, $3::jsonb)`, [row, actor, JSON.stringify(changes)]);
  const read = (row: string) => one<Record<string, unknown>>(`select * from equipment_rows where id = $1`, [row]);
  const providerId = (name: string) => one<{ id: string }>(`select id from equipment_providers where name = $1`, [name]).then((r) => r.id);
  const logCount = (record = rec) => one<{ n: number }>(`select count(*)::int n from updates where record_id = $1 and is_log`, [record]).then((r) => r.n);
  const newRecord = async () => {
    const { id } = await one<{ id: string }>(`insert into records (deal_name, creator_user_id, values) values ($1, $2, '{}') returning id`, [`ZZ equipment ${randomUUID().slice(0, 8)}`, admin]);
    await q(`insert into record_modules (record_id, module_id) values ($1, $2)`, [id, contacts]);
    return id;
  };

  beforeAll(async () => {
    db = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false }, statement_timeout: 120_000 });
    await db.connect();
    await q('begin');
    await db.query(readFileSync(join(process.cwd(), 'supabase/migrations/20260819009911_equipment_setup_tab.sql'), 'utf8'));

    admin = (await one<{ id: string }>(`select id from profiles where email = 'admin@tapdash.test'`)).id;
    contacts = (await one<{ id: string }>(`select id from modules where slug = 'contacts'`)).id;

    // Full access underneath, so every difference below is the column's.
    member = randomUUID();
    const email = `zz-${member.slice(0, 8)}@tapdash.test`;
    const { id: roleId } = await one<{ id: string }>(`select id from roles where not is_admin order by name limit 1`);
    const { id: template } = await one<{ id: string }>(`select id from permission_templates where user_type = 'sales_agent'`);
    await q(`insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')`, [member, email]);
    await q(`insert into profiles (id, email, full_name, role_id, status) values ($1, $2, 'Zz Member', $3, 'active') on conflict (id) do update set role_id = excluded.role_id, status = 'active'`, [member, email, roleId]);
    await q(`insert into user_templates (user_id, template_id) values ($1, $2) on conflict (user_id) do update set template_id = excluded.template_id`, [member, template]);
    await q(`insert into permission_settings (owner_kind, owner_id, key, value) values ('user', $1, $2, 'all') on conflict (owner_kind, owner_id, key) do update set value = 'all'`, [member, `module:${contacts}`]);
    await q(`insert into user_grants (user_id, scope_kind, scope_id, grant_level) select $1, 'tab', id, 'edit' from tabs where key = 'pricing'`, [member]);

    rec = await newRecord();
  }, 120_000);

  afterAll(async () => {
    await q('rollback');
    await db.end();
  });

  describe('9911 (inside this transaction)', () => {
    it('the eleven columns, in order, kept out of the ordinary fields', async () => {
      const rows = await q<{ key: string; label: string; type: string; row_column: boolean }>(
        `select f.key::text, f.label, f.type::text, f.row_column from fields f join subtabs s on s.id = f.subtab_id where s.shows_equipment_setup and f.row_column order by f.position`,
      );
      expect(rows.map((r) => r.label)).toEqual(['Provider name', 'Billed by', 'Billed to', 'Item', 'Item amount', 'Monthly fee', 'Per item fee', 'One-time fee', 'Volume fee', 'Notes', 'Proposal']);
      expect(rows.every((r) => r.row_column)).toBe(true);
    });

    it('takes over the old sub-tab\'s grants and modules', async () => {
      const grants = (key: string) => q<{ template_id: string; grant_level: string }>(
        `select g.template_id, g.grant_level::text from template_grants g join subtabs s on s.id = g.scope_id where g.scope_kind = 'subtab' and s.key = $1 order by 1`,
        [key],
      );
      const modules = (key: string) => q<{ module_id: string }>(`select o.module_id from module_subtab_order o join subtabs s on s.id = o.subtab_id where s.key = $1 order by 1`, [key]);
      expect((await grants('equipment_setup')).length).toBeGreaterThan(0);
      expect((await modules('equipment_setup')).length).toBeGreaterThan(0);
      // Migration 9916 removes the old sub-tab. Until then the two must agree.
      const old = await grants('equipment');
      if (old.length) {
        expect(await grants('equipment_setup')).toEqual(old);
        expect(await modules('equipment_setup')).toEqual(await modules('equipment'));
      }
    });
  });

  describe('a row', () => {
    it('starts empty: every fee NULL, the checkbox off', async () => {
      const row = await read(await addRow());
      for (const c of ['provider_id', 'billed_by', 'billed_to', 'item', 'item_amount', 'monthly_fee', 'per_item_fee', 'one_time_fee', 'volume_fee', 'notes']) expect(row[c]).toBeNull();
      expect(row.proposal).toBe(false);
    });

    it('nothing is preset on a new record', async () => {
      const fresh = await newRecord();
      expect((await one<{ n: number }>(`select count(*)::int n from equipment_rows where record_id = $1`, [fresh])).n).toBe(0);
    });

    it('a blank stays NULL, and a typed 0 stays 0', async () => {
      const id = await addRow();
      await change(id, { monthly_fee: '0.00', one_time_fee: null });
      const row = await read(id);
      expect(Number(row.monthly_fee)).toBe(0);
      expect(row.one_time_fee).toBeNull();
    });

    it('numbers its rows, and never reuses a number', async () => {
      const fresh = await newRecord();
      const first = await addRow(fresh);
      await addRow(fresh);
      await q(`select equipment_row_delete($1, $2)`, [first, admin]);
      const third = await read(await addRow(fresh));
      expect(third.row_no).toBe(3);
    });
  });

  describe('Billed by follows the provider', () => {
    it('changing the provider clears it', async () => {
      const id = await addRow();
      await change(id, { provider_id: await providerId('NMI') });
      await change(id, { billed_by: 'provider' });
      expect((await read(id)).billed_by).toBe('provider');
      await change(id, { provider_id: await providerId('Valor') });
      expect((await read(id)).billed_by).toBeNull();
    });

    it('clears a Tenor choice too: the rule has no exceptions', async () => {
      const id = await addRow();
      await change(id, { provider_id: await providerId('NMI') });
      await change(id, { billed_by: 'tenor' });
      await change(id, { provider_id: await providerId('Valor') });
      expect((await read(id)).billed_by).toBeNull();
    });

    it('sending the same provider again is no change', async () => {
      const id = await addRow();
      const nmi = await providerId('NMI');
      await change(id, { provider_id: nmi });
      await change(id, { billed_by: 'tenor' });
      await change(id, { provider_id: nmi });
      expect((await read(id)).billed_by).toBe('tenor');
    });

    it('cannot be the provider with no provider', async () => {
      const id = await addRow();
      await refused(() => change(id, { billed_by: 'provider' }), /equipment_rows_billed_by_needs_provider/);
    });

    it('stores a choice, never a name', async () => {
      const id = await addRow();
      await refused(() => change(id, { billed_by: 'NMI' }), /check/);
    });

    it('many rows can share a provider', async () => {
      const nmi = await providerId('NMI');
      const a = await addRow();
      const b = await addRow();
      await change(a, { provider_id: nmi });
      await change(b, { provider_id: nmi });
      expect((await read(a)).provider_id).toBe((await read(b)).provider_id);
    });
  });

  describe('the log', () => {
    it('adding is in Updates and in history, with who', async () => {
      const fresh = await newRecord();
      await addRow(fresh);
      const u = await one<{ body: string; author_id: string; is_log: boolean }>(`select body, author_id, is_log from updates where record_id = $1`, [fresh]);
      expect(u).toEqual({ body: 'Added equipment row 1.', author_id: admin, is_log: true });
      const a = await one<{ kind: string; actor_id: string; summary: string }>(`select kind::text, actor_id, summary from record_activity where record_id = $1`, [fresh]);
      expect(a).toEqual({ kind: 'equipment', actor_id: admin, summary: 'Added equipment row 1.' });
    });

    it('a change names the column, never the value', async () => {
      const fresh = await newRecord();
      const id = await addRow(fresh);
      await change(id, { monthly_fee: '1234.56', notes: 'SECRET WORDS' });
      const all = JSON.stringify([
        await q(`select body from updates where record_id = $1`, [fresh]),
        await q(`select body from update_details where record_id = $1`, [fresh]),
        await q(`select summary, from_value, to_value from record_activity where record_id = $1`, [fresh]),
      ]);
      expect(all).toContain('Changed Monthly fee on equipment row 1.');
      expect(all).toContain('Changed equipment row 1.');
      expect(all).not.toContain('1234');
      expect(all).not.toContain('SECRET');
    });

    it('nothing changed, nothing logged, even written differently', async () => {
      const id = await addRow();
      await change(id, { monthly_fee: '12.50' });
      const before = await logCount();
      await change(id, { monthly_fee: '12.5' });
      await change(id, { item: null });
      expect(await logCount()).toBe(before);
    });

    it('a change and its log succeed or fail together', async () => {
      const id = await addRow();
      await change(id, { item: 'kept' });
      const before = await logCount();
      await refused(() => change(id, { item: 'lost', billed_to: 'nobody' }), /check/);
      expect((await read(id)).item).toBe('kept');
      expect(await logCount()).toBe(before);
    });

    it('removing and restoring are both logged', async () => {
      const fresh = await newRecord();
      const id = await addRow(fresh);
      await q(`select equipment_row_delete($1, $2)`, [id, admin]);
      await as(admin, () => q(`select restore_equipment_row($1)`, [id]));
      const bodies = (await q<{ body: string }>(`select body from updates where record_id = $1 order by created_at`, [fresh])).map((r) => r.body);
      expect(bodies).toEqual(['Added equipment row 1.', 'Removed equipment row 1.', 'Restored equipment row 1.']);
      expect((await read(id)).deleted_at).toBeNull();
    });
  });

  describe('a hidden column in the log', () => {
    it('the reader sees the entry without the column\'s name', async () => {
      const fresh = await newRecord();
      const id = await addRow(fresh);
      await change(id, { monthly_fee: '5.00' });
      await change(id, { item: 'Terminal' });

      const details = () => as(member, () => q<{ body: string }>(`select body from update_details where record_id = $1`, [fresh])).then((r) => r.map((d) => d.body));
      expect(await details()).toEqual(expect.arrayContaining(['Changed Monthly fee on equipment row 1.', 'Changed Item on equipment row 1.']));

      await q(`insert into user_grants (user_id, scope_kind, scope_id, grant_level) select $1, 'field', id, 'hidden' from fields where key = 'eq_monthly_fee'`, [member]);
      const shown = await details();
      expect(shown).toContain('Changed Item on equipment row 1.');
      expect(shown).not.toContain('Changed Monthly fee on equipment row 1.');
      const generic = await as(member, () => q<{ body: string }>(`select body from updates where record_id = $1`, [fresh]));
      expect(generic.map((g) => g.body)).toContain('Changed equipment row 1.');
    });
  });

  describe('removed rows', () => {
    it('go soft, and cannot be changed or removed again', async () => {
      const id = await addRow();
      await q(`select equipment_row_delete($1, $2)`, [id, admin]);
      expect((await read(id)).deleted_at).not.toBeNull();
      await refused(() => change(id, { item: 'x' }), /no longer exists/);
      await refused(() => q(`select equipment_row_delete($1, $2)`, [id, admin]), /no longer exists/);
    });
    it('a member cannot restore one', async () => {
      const id = await addRow();
      await q(`select equipment_row_delete($1, $2)`, [id, admin]);
      await refused(() => as(member, () => q(`select restore_equipment_row($1)`, [id])), /Only an admin/);
    });
    it('follow the record when it is purged', async () => {
      const fresh = await newRecord();
      const id = await addRow(fresh);
      await q(`delete from records where id = $1`, [fresh]);
      expect((await q(`select 1 from equipment_rows where id = $1`, [id])).length).toBe(0);
    });
  });

  describe('providers', () => {
    it('the ten presets, in the spec\'s order', async () => {
      const names = (await q<{ name: string }>(`select name from equipment_providers where is_preset order by position`)).map((r) => r.name);
      expect(names).toEqual(['Accept.blue', 'Authorize.net', 'NMI', 'Maverick', 'Tenor', 'Deja Voo', 'IPOS', 'Deja Pro', 'Valor', 'UsaEpay']);
    });
    it('a duplicate is refused in any case, by the database', async () => {
      await refused(() => q(`select equipment_provider_add('nmi', $1, $2)`, [rec, admin]), /equipment_providers_name_unique/);
      await refused(() => q(`select equipment_provider_add('ACCEPT.BLUE', $1, $2)`, [rec, admin]), /equipment_providers_name_unique/);
    });
    it('a custom one is logged on the record, with who', async () => {
      const fresh = await newRecord();
      const { id } = await one<{ id: string }>(`select equipment_provider_add('ZZ Custom Provider', $1, $2) id`, [fresh, admin]);
      expect((await one<{ created_by: string; is_preset: boolean }>(`select created_by, is_preset from equipment_providers where id = $1`, [id]))).toEqual({ created_by: admin, is_preset: false });
      const a = await one<{ actor_id: string; summary: string }>(`select actor_id, summary from record_activity where record_id = $1`, [fresh]);
      expect(a).toEqual({ actor_id: admin, summary: 'Added custom provider ZZ Custom Provider.' });
    });
  });

  describe('the permission', () => {
    const setting = (user: string) => one<{ v: string }>(`select user_permissions($1) -> 'settings' ->> 'equipment.add_providers' v`, [user]).then((r) => r.v);
    it('Yes for an admin, No for the rest, and overridable per user', async () => {
      expect(await setting(admin)).toBe('yes');
      expect(await setting(member)).toBe('no');
      await q(`insert into permission_settings (owner_kind, owner_id, key, value) values ('user', $1, 'equipment.add_providers', 'yes')`, [member]);
      expect(await setting(member)).toBe('yes');
      await q(`delete from permission_settings where owner_kind = 'user' and owner_id = $1 and key = 'equipment.add_providers'`, [member]);
    });
    it('the defaults by user type', async () => {
      const rows = await q<{ user_type: string; value: string }>(
        `select pt.user_type::text, ps.value from permission_settings ps join permission_templates pt on pt.id = ps.owner_id where ps.owner_kind = 'template' and ps.key = 'equipment.add_providers' order by 1`,
      );
      expect(Object.fromEntries(rows.map((r) => [r.user_type, r.value]))).toEqual({
        accounting: 'no', admin: 'yes', customer_service: 'no', sales_agent: 'no', super_admin: 'yes', underwriter: 'no',
      });
    });
    it('only yes or no', async () => {
      expect((await one<{ ok: boolean }>(`select permission_setting_valid('equipment.add_providers', 'yes') ok`)).ok).toBe(true);
      expect((await one<{ ok: boolean }>(`select permission_setting_valid('equipment.add_providers', 'all') ok`)).ok).toBe(false);
    });
  });

  describe('default-deny', () => {
    it.each(['equipment_rows', 'equipment_providers'])('a signed-in user cannot read %s', async (table) => {
      await refused(() => as(member, () => q(`select * from ${table}`)), /permission denied/);
    });
    it('a signed-in user cannot call the writers', async () => {
      const id = await addRow();
      await refused(() => as(member, () => q(`select equipment_row_add($1, $2)`, [rec, member])), /permission denied/);
      await refused(() => as(member, () => q(`select equipment_row_update($1, $2, '{}'::jsonb)`, [id, member])), /permission denied/);
      await refused(() => as(member, () => q(`select equipment_row_delete($1, $2)`, [id, member])), /permission denied/);
      await refused(() => as(member, () => q(`select equipment_provider_add('x', $1, $2)`, [rec, member])), /permission denied/);
    });
    it('every function pins search_path', async () => {
      const rows = await q<{ proname: string; config: string[] }>(
        `select p.proname, p.proconfig config from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname in ('equipment_row_add', 'equipment_row_update', 'equipment_row_delete', 'equipment_provider_add', 'restore_equipment_row')`,
      );
      expect(rows).toHaveLength(5);
      for (const r of rows) expect(r.config.join()).toContain('search_path=public, pg_temp');
    });
  });
});
