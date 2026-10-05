/**
 * The merchant-rates bulk import, against the real database.
 *
 * ── WHY THIS IS STEP 3's PRIMARY PATH ────────────────────────────────────
 * `monthly_fee_tapdash` is empty for every merchant and rule #2 raises without
 * it, so a first real month needs 34 merchants priced before it can compute
 * once. The per-merchant editor is the right tool for one rate and the wrong
 * one for that.
 *
 * ── THE PREVIEW IS NOT A SECOND IMPLEMENTATION ───────────────────────────
 * `residual_preview_merchant_rates_import` calls the real commit inside a
 * subtransaction and raises `ZZ001` to discard the writes, keeping the result
 * because plpgsql variables survive a subtransaction rollback. So the preview
 * cannot disagree with the commit — it IS the commit. The assertions below
 * check that: same inputs, same numbers, and nothing on disk afterwards.
 *
 * Rolled back. Scratch MIDs, a month no real period uses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as XLSX from 'xlsx';
import pg from 'pg';
import { parseWorkbook } from './xlsxParser';
import { buildRateRows, splitRejection, suggestRateMapping } from './rateImport';

const DB_URL = process.env.SUPABASE_DB_URL;
const suite = DB_URL ? describe : describe.skip;

const MID = { A: '550000001001', B: '550000001002' };
const FROM = '2019-08-01';

let db: pg.Client;
let adminId: string;

async function asAdmin<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: adminId, role: 'authenticated' }),
  ]);
  await db.query('set local role authenticated');
  const { rows } = await db.query(sql, params);
  return rows as T[];
}

async function asOwner<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  await db.query('reset role');
  const { rows } = await db.query(sql, params);
  return rows as T[];
}

/** A rates workbook, in the shape of the real sheet. */
function ratesBook(rows: unknown[][]): Uint8Array {
  const header = [
    'Merchant Number',
    'DBA Name',
    'Risk Code',
    'VMD Auth Fee',
    'Batch Fee',
    'VMD Volume',
    'Monthly Fee TapDash',
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([['TapDash rates'], [], header, ...rows]),
    /* Excel truncates a sheet name at 31 characters, which is why the real tab
       reads "Drawer tab Processor-TD Merchan" — cut mid-word. */
    'Drawer tab Processor-TD Merchan',
  );
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

/** Parse + map, the way the action does, so the test exercises the real path. */
function rowsFrom(bytes: Uint8Array) {
  const sheet = parseWorkbook(bytes).sheets[0];
  const mapping = new Map<number, string>();
  for (const s of suggestRateMapping(sheet)) if (s.suggested) mapping.set(s.index, s.suggested);
  return { sheet, mapping, built: buildRateRows(sheet, mapping) };
}

const liveVersions = (mid: string) =>
  asOwner<{ ef: string; et: string | null; risk_tier: string; mft: string | null }>(
    `select effective_from::text ef, effective_to::text et, risk_tier,
            monthly_fee_tapdash::text mft
       from residual_merchant_rates
      where mid = $1 and deleted_at is null order by effective_from`,
    [mid],
  );

suite('the merchant-rates bulk import', () => {
  beforeAll(async () => {
    db = new pg.Client({
      connectionString: DB_URL,
      ssl: { rejectUnauthorized: false },
      statement_timeout: 120_000,
    });
    await db.connect();
    await db.query('BEGIN');
    const { rows } = await db.query(
      `select p.id from profiles p join roles r on r.id = p.role_id
        where r.is_admin and p.deleted_at is null and p.status = 'active' limit 1`,
    );
    if (!rows.length) throw new Error('No active admin profile — cannot run this suite.');
    adminId = rows[0].id;
  });

  afterAll(async () => {
    if (!db) return;
    await db.query('ROLLBACK');
    await db.end();
  });

  /* ── the sheet ─────────────────────────────────────────────────────── */

  it('finds the rates tab by its truncated name and suggests every column', () => {
    const { sheet, built } = rowsFrom(
      ratesBook([[550000001001, 'Alpha Diner', 1, 0.1, 0.05, 0.001, 15]]),
    );
    expect(sheet.name).toBe('Drawer tab Processor-TD Merchan');
    expect(built.errors).toEqual([]);
    expect(built.rows).toHaveLength(1);

    const r = built.rows[0];
    /* Digits only, and every value a string — the RPC casts. */
    expect(r.mid).toBe('550000001001');
    expect(r.risk_code).toBe('1');
    expect(r.vmd_auth_fee).toBe('0.1');
    expect(r.monthly_fee_tapdash).toBe('15');
    for (const [k, v] of Object.entries(r)) {
      expect(v === null || typeof v === 'string', `${k} = ${String(v)}`).toBe(true);
    }
  });

  it('drops the sheet’s own footer rather than failing on it', () => {
    const { built } = rowsFrom(
      ratesBook([
        [550000001001, 'Alpha Diner', 1, 0.1, 0.05, 0.001, 15],
        [null, 'TOTAL', null, null, null, null, null],
      ]),
    );
    /*
     * The RPC treats a blank MID as an error rather than skipping it, so a
     * perfectly good file would be refused for carrying a footer.
     */
    expect(built.rows).toHaveLength(1);
    expect(built.skippedNoMid).toBe(1);
  });

  it('refuses a decimal risk code, which means the wrong column is mapped', () => {
    const { built } = rowsFrom(
      ratesBook([[550000001001, 'Alpha Diner', 1.5, 0.1, 0.05, 0.001, 15]]),
    );
    expect(built.errors).toHaveLength(1);
    expect(built.errors[0].key).toBe('risk_code');
  });

  /* ── the dry run IS the commit ─────────────────────────────────────── */

  it('the preview reports what the commit will do, and writes nothing', async () => {
    const { built } = rowsFrom(
      ratesBook([
        [550000001001, 'Alpha Diner', 1, 0.1, 0.05, 0.001, 15],
        [550000001002, 'Beta Cafe', 2, 0.12, 0.06, 0.002, 20],
      ]),
    );

    const [{ r: preview }] = await asAdmin<{ r: Record<string, unknown> }>(
      `select residual_preview_merchant_rates_import($1::date, $2::jsonb) r`,
      [FROM, JSON.stringify(built.rows)],
    );

    expect(Number(preview.rows_read)).toBe(2);
    expect(Number(preview.inserted)).toBe(2);
    expect(preview.dry_run).toBe(true);

    /* And nothing landed. */
    expect(await liveVersions(MID.A)).toHaveLength(0);
    expect(await liveVersions(MID.B)).toHaveLength(0);

    /* Now the real thing, same rows, same numbers. */
    const [{ r: commit }] = await asAdmin<{ r: Record<string, unknown> }>(
      `select commit_residual_merchant_rates_import(null::uuid, $1::date, $2::jsonb) r`,
      [FROM, JSON.stringify(built.rows)],
    );
    expect(Number(commit.inserted)).toBe(Number(preview.inserted));
    expect(Number(commit.rows_read)).toBe(Number(preview.rows_read));

    const a = await liveVersions(MID.A);
    expect(a).toHaveLength(1);
    expect(a[0].ef).toBe(FROM);
    /* Risk code 1 resolves through residual_risk_tiers.statement_code, not a
       map in the code. */
    expect(a[0].risk_tier).toBe('low');
    expect(Number(a[0].mft)).toBeCloseTo(15, 2);

    const b = await liveVersions(MID.B);
    expect(b[0].risk_tier).toBe('medium');
  });

  /*
   * The property that makes re-importing the same sheet safe, and the reason
   * the screen reports three outcomes rather than one count.
   */
  it('re-importing the identical sheet opens no successor', async () => {
    const { built } = rowsFrom(
      ratesBook([
        [550000001001, 'Alpha Diner', 1, 0.1, 0.05, 0.001, 15],
        [550000001002, 'Beta Cafe', 2, 0.12, 0.06, 0.002, 20],
      ]),
    );

    const [{ r }] = await asAdmin<{ r: Record<string, unknown> }>(
      `select commit_residual_merchant_rates_import(null::uuid, $1::date, $2::jsonb) r`,
      [FROM, JSON.stringify(built.rows)],
    );

    expect(Number(r.unchanged)).toBe(2);
    expect(Number(r.inserted)).toBe(0);
    expect(await liveVersions(MID.A)).toHaveLength(1);
  });

  /* ── the guards ────────────────────────────────────────────────────── */

  /**
   * The percent-scale guard, which is what a CSV round trip triggers.
   *
   * Threshold 0.10, derived from the data rather than chosen: "real volume
   * rates span [0.001, 0.047619] and the same values percent-scaled span
   * [0.1, 4.7619], two disjoint populations with a 2.10x gap."
   */
  it('refuses a percent-scaled rate, and says so in a splittable message', async () => {
    const { built } = rowsFrom(
      /* 0.001 written as a percentage: 0.1. */
      ratesBook([[550000001001, 'Alpha Diner', 1, 0.1, 0.05, 0.1, 15]]),
    );

    const name = `pct_${Math.random().toString(36).slice(2, 10)}`;
    await db.query(`savepoint ${name}`);
    let message = '';
    let code = '';
    try {
      await asAdmin(`select commit_residual_merchant_rates_import(null::uuid, $1::date, $2::jsonb)`, [
        FROM,
        JSON.stringify(built.rows),
      ]);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      code = err.code ?? '';
      message = err.message ?? '';
    }
    await db.query(`rollback to savepoint ${name}`);

    expect(code).toBe('23514');

    /*
     * The separator is part of the contract: "at most c_max_shown problems
     * joined with ' | '. The client splits on that separator to render them in
     * a scrollable list, so the shape is part of the contract, not incidental
     * formatting." This asserts the client's splitter against the real message.
     */
    const { summary, problems } = splitRejection(message);
    expect(summary).toMatch(/rejected/i);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toContain(MID.A);
  });

  it('refuses a MID that appears twice in one file', async () => {
    const { built } = rowsFrom(
      ratesBook([
        [550000001001, 'Alpha Diner', 1, 0.1, 0.05, 0.001, 15],
        [550000001001, 'Alpha Diner again', 1, 0.11, 0.05, 0.001, 15],
      ]),
    );

    const name = `dup_${Math.random().toString(36).slice(2, 10)}`;
    await db.query(`savepoint ${name}`);
    let message = '';
    try {
      await asAdmin(`select commit_residual_merchant_rates_import(null::uuid, $1::date, $2::jsonb)`, [
        FROM,
        JSON.stringify(built.rows),
      ]);
    } catch (e) {
      message = (e as { message?: string }).message ?? '';
    }
    await db.query(`rollback to savepoint ${name}`);
    expect(message).toMatch(/more than once/i);
  });

  it('refuses a risk code matching no live tier', async () => {
    const { built } = rowsFrom(
      ratesBook([[550000001001, 'Alpha Diner', 9, 0.1, 0.05, 0.001, 15]]),
    );
    const name = `tier_${Math.random().toString(36).slice(2, 10)}`;
    await db.query(`savepoint ${name}`);
    let message = '';
    try {
      await asAdmin(`select commit_residual_merchant_rates_import(null::uuid, $1::date, $2::jsonb)`, [
        FROM,
        JSON.stringify(built.rows),
      ]);
    } catch (e) {
      message = (e as { message?: string }).message ?? '';
    }
    await db.query(`rollback to savepoint ${name}`);
    expect(message).toMatch(/risk code/i);
  });

  it('refuses both RPCs to a caller with no identity', async () => {
    await db.query(`select set_config('request.jwt.claims', '', true)`);
    for (const sql of [
      `select residual_preview_merchant_rates_import($1::date, '[]'::jsonb)`,
      `select commit_residual_merchant_rates_import(null::uuid, $1::date, '[]'::jsonb)`,
    ]) {
      const name = `anon_${Math.random().toString(36).slice(2, 10)}`;
      await db.query(`savepoint ${name}`);
      let code: string | null = null;
      try {
        await db.query(sql, [FROM]);
      } catch (e) {
        code = (e as { code?: string }).code ?? null;
      }
      await db.query(`rollback to savepoint ${name}`);
      expect(code, sql).toBe('42501');
    }
  });
});
