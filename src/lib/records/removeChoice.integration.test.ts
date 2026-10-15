/**
 * `remove_field_choice` — the database half of "remove an option nobody holds".
 *
 * Every case runs inside a transaction that is rolled back, so the options and
 * record values it creates never exist outside it.
 *
 * ── WHY EACH RULE GETS ITS OWN CASE ──────────────────────────────────────
 * The function returns a number, and a number is easy to get right for the
 * wrong reason. "Refused because in use" and "refused because it was the last
 * option" both leave the row in place; only asserting on WHICH happened tells
 * them apart. And the module-precision case is the one most likely to be
 * "simplified" later into "any record anywhere", which would block Izzy from
 * removing an option from Leads because a Deals record happens to share a key.
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

/** Run `fn` in a transaction that is always rolled back. */
async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  await db.query('BEGIN');
  try {
    return await fn();
  } finally {
    await db.query('ROLLBACK');
  }
}

const one = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) =>
  (await db.query(sql, p)).rows[0] as T;

suite('remove_field_choice', () => {
  let fieldId: string;
  let leadsId: string;
  let dealsId: string;
  /** Two records, placed in exactly one module each INSIDE each transaction —
   *  the live data has no record in Leads-but-not-Deals to borrow, and a test
   *  that depends on what happens to be in the database is a test that starts
   *  failing the day someone tidies it. */
  let leadsRecord: string;
  let dealsRecord: string;

  beforeAll(async () => {
    fieldId = (await one<{ id: string }>(`select id from fields where key = 'current_status'`)).id;
    leadsId = (await one<{ id: string }>(`select id from modules where slug = 'leads'`)).id;
    dealsId = (await one<{ id: string }>(`select id from modules where slug = 'deals'`)).id;

    const two = (await db.query(`select id from records order by created_at limit 2`)).rows;
    expect(two.length, 'need two records to place in separate modules').toBe(2);
    leadsRecord = two[0].id;
    dealsRecord = two[1].id;
  });

  /** Inside the open transaction: each probe record in exactly one module. */
  const placeRecords = async () => {
    await db.query(`delete from record_modules where record_id = any($1)`, [[leadsRecord, dealsRecord]]);
    await db.query(`insert into record_modules (record_id, module_id) values ($1, $2), ($3, $4)`, [
      leadsRecord,
      leadsId,
      dealsRecord,
      dealsId,
    ]);
  };

  /** Add a throwaway option to a scope, inside the open transaction. */
  const addOption = (moduleId: string | null, key: string) =>
    db.query(
      `insert into field_choices (field_id, module_id, key, value, position) values ($1, $2, $3, $4, 9990)`,
      [fieldId, moduleId, key, `Probe ${key}`],
    );

  const exists = async (moduleId: string | null, key: string) =>
    Boolean(
      (
        await db.query(
          `select 1 from field_choices where field_id = $1 and module_id is not distinct from $2 and key = $3`,
          [fieldId, moduleId, key],
        )
      ).rowCount,
    );

  const holds = (recordId: string, key: string) =>
    db.query(`update records set values = jsonb_set(values, '{current_status}', to_jsonb($2::text)) where id = $1`, [
      recordId,
      key,
    ]);

  const remove = async (moduleId: string | null, key: string) =>
    (await one<{ n: number }>(`select remove_field_choice($1, $2, $3) as n`, [fieldId, moduleId, key])).n;

  it('removes an option nobody holds', async () => {
    await inTx(async () => {
      await placeRecords();
      await addOption(leadsId, 'zz_unused');
      expect(await remove(leadsId, 'zz_unused')).toBe(0);
      expect(await exists(leadsId, 'zz_unused')).toBe(false);
    });
  });

  it('refuses an option a record in that module holds, and says how many', async () => {
    await inTx(async () => {
      await placeRecords();
      await addOption(leadsId, 'zz_held');
      await holds(leadsRecord, 'zz_held');
      expect(await remove(leadsId, 'zz_held')).toBe(1);
      expect(await exists(leadsId, 'zz_held'), 'the option was removed while a record held it').toBe(true);
    });
  });

  it('is not blocked by a record in a DIFFERENT module holding the same key', async () => {
    /*
     * Leads and Deals each have their own Current Status list. A Deals record
     * holding `zz_shared` reads it from Deals' list; removing the option from
     * Leads' list changes nothing it can see.
     */
    await inTx(async () => {
      await placeRecords();
      await addOption(leadsId, 'zz_shared');
      await addOption(dealsId, 'zz_shared');
      await holds(dealsRecord, 'zz_shared');
      expect(await remove(leadsId, 'zz_shared')).toBe(0);
      expect(await exists(leadsId, 'zz_shared')).toBe(false);
      expect(await exists(dealsId, 'zz_shared'), "Deals' own option must be untouched").toBe(true);
    });
  });

  it('refuses a GLOBAL option held by a record in any module', async () => {
    // The Records List resolves every record against the global list.
    await inTx(async () => {
      await placeRecords();
      await addOption(null, 'zz_global');
      await holds(dealsRecord, 'zz_global');
      expect(await remove(null, 'zz_global')).toBe(1);
      expect(await exists(null, 'zz_global')).toBe(true);
    });
  });

  it('counts a record in the Recycle Bin as holding it', async () => {
    await inTx(async () => {
      await placeRecords();
      await addOption(leadsId, 'zz_binned');
      await holds(leadsRecord, 'zz_binned');
      await db.query(`update records set deleted_at = now() where id = $1`, [leadsRecord]);
      expect(await remove(leadsId, 'zz_binned'), 'a restored record would come back orphaned').toBe(1);
    });
  });

  it('matches the exact key, never a prefix', async () => {
    await inTx(async () => {
      await placeRecords();
      await addOption(leadsId, 'zz_work');
      await holds(leadsRecord, 'zz_working');
      expect(await remove(leadsId, 'zz_work')).toBe(0);
    });
  });

  it('refuses to empty a list — the module would silently switch to the shared options', async () => {
    await inTx(async () => {
      await placeRecords();
      const { n } = await one<{ n: number }>(
        `select count(*)::int n from field_choices where field_id = $1 and module_id = $2`,
        [fieldId, leadsId],
      );
      // Remove all but one through the function, then try the last.
      const keys = (
        await db.query(
          `select key::text k from field_choices where field_id = $1 and module_id = $2 order by position`,
          [fieldId, leadsId],
        )
      ).rows.map((r) => r.k as string);
      expect(keys.length).toBe(n);
      // Clear values so none of them is "in use" for this test.
      await db.query(`update records set values = values - 'current_status'`);
      for (const k of keys.slice(0, -1)) expect(await remove(leadsId, k)).toBe(0);

      // A raised exception aborts the transaction, so the refusal is fenced
      // in a savepoint — otherwise the check after it could not run at all,
      // and "the row is still there" would go unverified.
      await db.query('savepoint before_last');
      await expect(remove(leadsId, keys.at(-1)!)).rejects.toThrow(/last option/i);
      await db.query('rollback to savepoint before_last');
      expect(await exists(leadsId, keys.at(-1)!)).toBe(true);
    });
  });

  it("refuses a pipeline's status options — those are the pipeline's steps", async () => {
    await inTx(async () => {
      await placeRecords();
      const p = await one<{ field: string; module: string; key: string }>(
        `select p.status_field_id field, p.module_id module, c.key::text key
           from pipelines p join field_choices c on c.field_id = p.status_field_id and c.module_id = p.module_id
          limit 1`,
      );
      await expect(
        db.query(`select remove_field_choice($1, $2, $3)`, [p.field, p.module, p.key]),
      ).rejects.toThrow(/Change them in Pipelines/);
    });
  });

  it('cannot be called by a signed-in user directly', async () => {
    await inTx(async () => {
      await placeRecords();
      await db.query('set local role authenticated');
      await expect(
        db.query(`select remove_field_choice($1, $2, 'anything')`, [fieldId, leadsId]),
      ).rejects.toThrow(/permission denied/i);
    });
  });
});
