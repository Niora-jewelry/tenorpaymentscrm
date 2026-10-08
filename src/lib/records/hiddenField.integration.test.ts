/**
 * Does a Hidden grant actually stop anyone?
 *
 * `docs/PERMISSION-ENFORCEMENT-TEST.md` has sat at "⬜ not yet run" since
 * 2026-09-05, owned by "whoever has a browser and ten minutes", and it blocks
 * Phase 6d "and any claim that the permission model works end to end". Its
 * reasoning is worth keeping:
 *
 *   "What has never been checked is whether it STOPS anyone — because until
 *    2026-09-05 there was nobody it could stop. Every account in the live
 *    database was a super_admin, and admins are exempt by design. A lock only
 *    ever tested with the master key in hand tells you nothing."
 *
 * The promise under test is `CLAUDE.md` §3, and it is not a UI claim:
 *
 *   "A field the user may not see must be ABSENT FROM THE QUERY, not filtered
 *    out afterwards and not hidden with CSS. Absent columns, never blank
 *    cells. UI-level hiding is never the security boundary."
 *
 * That is a property of `record_values_for`, so it is testable here rather
 * than by looking at a screen — and better tested here, because this runs on
 * every `npm test` instead of once when somebody has ten minutes. A blank cell
 * and an absent key look identical in a browser; they do not look identical to
 * `?? in`.
 *
 * The manual document remains worth doing for what it alone covers: that the
 * admin UI writes the grant it appears to write. This covers the part that
 * matters if it is wrong.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const DB_URL = process.env.SUPABASE_DB_URL;
const suite = DB_URL ? describe : describe.skip;

/** Unique in the whole database, so a false match is impossible. */
const SECRET = `ZZTOPSECRET-${Date.now()}`;

let db: pg.Client;
let adminId: string;
let memberId: string;
let recordId: string;
let einFieldId: string;
let leadsModuleId: string;
/** Every non-admin-only module this record is displayed in. */
let recordModuleIds: string[] = [];
let savepoint = 0;

async function asUser<T = Record<string, unknown>>(
  userId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const sp = `sp${(savepoint += 1)}`;
  await db.query(`savepoint ${sp}`);
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: userId, role: 'authenticated' }),
  ]);
  await db.query('set local role authenticated');
  try {
    const { rows } = await db.query(sql, params);
    await db.query('reset role');
    await db.query(`release savepoint ${sp}`);
    return rows as T[];
  } catch (e) {
    await db.query(`rollback to savepoint ${sp}`);
    await db.query('reset role');
    throw e;
  }
}

async function asOwner<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  await db.query('reset role');
  const { rows } = await db.query(sql, params);
  return rows as T[];
}

/** The record's values as this user is allowed to receive them. */
async function valuesFor(userId: string): Promise<Record<string, unknown> | null> {
  const rows = await asUser<{ id: string; values: Record<string, unknown> }>(
    userId,
    `select id, "values" from record_values_for($1::uuid[])`,
    [[recordId]],
  );
  return rows[0]?.values ?? null;
}

suite('a Hidden field grant', () => {
  beforeAll(async () => {
    db = new pg.Client({
      connectionString: DB_URL,
      ssl: { rejectUnauthorized: false },
      statement_timeout: 120_000,
    });
    await db.connect();
    await db.query('BEGIN');

    const [admin] = await asOwner<{ id: string }>(
      `select p.id from profiles p join roles r on r.id = p.role_id
        where r.is_admin and p.deleted_at is null and p.status = 'active' limit 1`,
    );
    adminId = admin.id;

    /*
     * A NON-ADMIN actor is the whole point. Admins are exempt from the
     * permission rules by design, so running this as one would prove nothing —
     * which is exactly why the test could not exist before a non-admin account
     * did.
     */
    const [member] = await asOwner<{ id: string }>(
      `select p.id from profiles p join roles r on r.id = p.role_id
        where not r.is_admin and p.deleted_at is null and p.status = 'active'
        order by p.email limit 1`,
    );
    if (!member) throw new Error('No non-admin profile exists — this suite cannot prove anything without one.');
    memberId = member.id;

    const [ein] = await asOwner<{ id: string }>(`select id from fields where key = 'ein' limit 1`);
    einFieldId = ein.id;

    const [leads] = await asOwner<{ id: string }>(`select id from modules where slug = 'leads' limit 1`);
    leadsModuleId = leads.id;

    const [rec] = await asOwner<{ id: string }>(
      `select r.id from records r
        join record_modules rm on rm.record_id = r.id and rm.module_id = $1
       where r.deleted_at is null limit 1`,
      [leadsModuleId],
    );
    if (!rec) throw new Error('No record in Leads to test against.');
    recordId = rec.id;

    /*
     * `record_field_grant` resolves over every non-admin-only module the
     * record belongs to, and takes the MOST PERMISSIVE. Admin-only modules
     * (the Records List) are excluded by the resolver itself, so they are
     * excluded here too — granting against one would be a no-op that made a
     * failure look like a grant that did not work.
     */
    recordModuleIds = (
      await asOwner<{ id: string }>(
        `select m.id from record_modules rm
           join modules m on m.id = rm.module_id
          where rm.record_id = $1 and not m.admin_only`,
        [recordId],
      )
    ).map((r) => r.id);

    /*
     * Row visibility is driven entirely by Team member(s) assigned
     * (`can_see_record()`). Without it the member sees nothing at all and
     * every assertion below would pass for the wrong reason — the document
     * calls this step "Not optional" for exactly that reason.
     *
     * ── IT MUST GO IN THE FIELD, NOT THE JOIN TABLE ───────────────────────
     * `record_team_members` is DERIVED. `records_sync_team_members` fires
     * AFTER UPDATE OF "values" and deletes every row whose user is not listed
     * in `values -> 'team_members_assigned'`, then re-inserts from it.
     *
     * So inserting into the join table and then writing the EIN wiped the
     * membership a statement later, and the member was handed no row at all.
     * Measured: the insert alone works, and the same insert followed by any
     * `values` update leaves zero rows visible. The field is the authoritative
     * source and the trigger is right to enforce it; both go in one statement
     * here, which is also what the product does.
     */
    await asOwner(
      `update records
          set "values" = coalesce("values", '{}'::jsonb)
                       || jsonb_build_object('ein', $2::text)
                       || jsonb_build_object('team_members_assigned',
                            coalesce("values" -> 'team_members_assigned', '[]'::jsonb)
                            || to_jsonb($3::text))
        where id = $1`,
      [recordId, SECRET, memberId],
    );
  });

  afterAll(async () => {
    if (!db) return;
    await db.query('ROLLBACK');
    await db.end();
  });

  it('the control: with no grant recorded, the member can read the field', async () => {
    /*
     * Full access here is CORRECT, not a bug. An unmentioned scope resolves to
     * Edit, not Hidden — `effective_grant()` — and the document notes that
     * MODULE-2-PLAN.md's "default-deny" is wrong on this point. If this step
     * failed, every later assertion would pass vacuously.
     */
    const values = await valuesFor(memberId);
    expect(values).not.toBeNull();
    expect(values?.ein).toBe(SECRET);
  });

  it('hiding it in ONE of several modules hides nothing, by design', async () => {
    /*
     * `record_field_grant` is `max(least(module, tab, subtab, field))` over
     * every non-admin-only module the record belongs to: most restrictive
     * WITHIN a module, most permissive ACROSS them.
     *
     * That is deliberate and it is right. This record sits in Leads, Deals,
     * Contacts and Residuals, so a member who may read EIN through Deals can
     * simply open it there — hiding it in Leads alone would be a padlock on
     * one of four doors. Pinned because it is the thing most likely to be
     * mistaken for the bug this suite is looking for: the grant IS written and
     * the field IS still readable, and both are correct.
     */
    await asOwner(
      `insert into user_grants (user_id, scope_kind, scope_id, grant_level, module_id)
       values ($1, 'field', $2, 'hidden', $3)
       on conflict (user_id, scope_kind, scope_id, module_id)
       do update set grant_level = 'hidden'`,
      [memberId, einFieldId, leadsModuleId],
    );

    const [grant] = await asUser<{ v: string }>(
      memberId,
      `select record_field_grant($1, 'ein') as v`,
      [recordId],
    );
    expect(grant.v).not.toBe('hidden');

    const values = await valuesFor(memberId);
    expect(values?.ein).toBe(SECRET);
  });

  it('the field goes ABSENT from the payload, not blank', async () => {
    /*
     * THE ASSERTION THE WHOLE DOCUMENT EXISTS FOR, and the one a browser
     * cannot make: `'ein' in values` distinguishes an absent key from a key
     * holding null or ''. A blank cell and an absent column look identical on
     * screen and are not the same thing — one is readable with Inspect.
     *
     * Hidden in every module the record is displayed in, because of the `max`
     * above. That is what "this person may not see this field" actually means
     * for a record with several memberships.
     */
    for (const moduleId of recordModuleIds) {
      await asOwner(
        `insert into user_grants (user_id, scope_kind, scope_id, grant_level, module_id)
         values ($1, 'field', $2, 'hidden', $3)
         on conflict (user_id, scope_kind, scope_id, module_id)
         do update set grant_level = 'hidden'`,
        [memberId, einFieldId, moduleId],
      );
    }

    const values = await valuesFor(memberId);
    expect(values).not.toBeNull();
    expect('ein' in (values ?? {})).toBe(false);
    /* Belt and braces: the secret must not appear anywhere in the payload. */
    expect(JSON.stringify(values)).not.toContain(SECRET);
  });

  it('the resolver names it as hidden, so the UI and the query agree', async () => {
    const rows = await asUser<{ keys: string[] }>(
      memberId,
      `select hidden_field_keys_for_record($1::uuid) as keys`,
      [recordId],
    );
    expect(rows[0].keys).toContain('ein');
  });

  it('every other field on the record still comes through', async () => {
    /*
     * A Hidden grant that emptied the whole payload would pass the test above
     * and break the product. The member must lose one field and keep the rest.
     */
    const values = await valuesFor(memberId);
    expect(Object.keys(values ?? {}).length).toBeGreaterThan(0);
  });

  it('the admin is unaffected, which is why a non-admin was required', async () => {
    const values = await valuesFor(adminId);
    expect(values?.ein).toBe(SECRET);
  });

  it('View is enough to read it, so Hidden is doing the work and not the grant row', async () => {
    /*
     * Rules out the lazy explanation: that ANY grant row suppresses the field.
     * Flipping the same row to 'view' brings it back, so it is the LEVEL being
     * honoured.
     */
    await asOwner(
      `update user_grants set grant_level = 'view'
        where user_id = $1 and scope_kind = 'field' and scope_id = $2`,
      [memberId, einFieldId],
    );

    const values = await valuesFor(memberId);
    expect(values?.ein).toBe(SECRET);
  });
});
