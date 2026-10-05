/**
 * A fee report, from .xlsx bytes to a calculated residual — against the REAL
 * database. Skipped unless `SUPABASE_DB_URL` is set, matching the other
 * integration suites.
 *
 * ── WHAT THIS COVERS, AND WHAT IT CANNOT ─────────────────────────────────
 * Covered, with the real code: `parseWorkbook` on real .xlsx bytes,
 * `buildRows` on the result, `commit_residual_excel_import` on those rows, and
 * `compute_residual_period` on what it wrote. That is the whole arithmetic
 * path, and it is the part where a mistake produces a plausible number rather
 * than an error.
 *
 * NOT covered here: `commitImport()` and the server actions above it. Those go
 * through `createSupabaseServerClient()`, which reads cookies via
 * `next/headers` and has no meaning outside a Next.js request — the same
 * limitation `lib/records/flow.integration.test.ts` documents and handles the
 * same way. What those layers DECIDE is tested instead by asserting the
 * database constraint each decision exists to respect, which is why the
 * duplicate-import case below asserts a 23505 rather than asserting that some
 * TypeScript returned `needs_replace`.
 *
 * ── THE EXPECTED FIGURES ARE DANIEL'S, NOT MINE ──────────────────────────
 * The chain asserted at the end is lifted from `scripts/verify-residuals-engine.mjs`,
 * which took them from his `calc-engine.integration.test.ts` where they are
 * hand-computed. Inventing figures here would prove the pipeline agrees with
 * itself — which is exactly the test that passes when a port has gone subtly
 * wrong.
 *
 * ── ONE TRANSACTION, ROLLED BACK ─────────────────────────────────────────
 * `SET LOCAL ROLE` and `set_config(..., true)` are transaction-scoped, so the
 * role-switching the admin gate requires only works inside one. Everything
 * this suite writes is rolled back; nothing touches real data. The scratch
 * month and MIDs below could not collide with a real period in any case.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import * as XLSX from 'xlsx';
import { parseWorkbook } from './xlsxParser';
import { buildRows, suggestMapping, type Target } from './mapping';

const DB_URL = process.env.SUPABASE_DB_URL;
const suite = DB_URL ? describe : describe.skip;

/*
 * Twelve digits each, none a suffix of another — Daniel's invariant, and the
 * reason is his: two distinct strings of equal length cannot be suffixes of
 * one another, so an accidental suffix collision in the MID resolver is
 * arithmetically impossible rather than merely unlikely.
 */
const MID = {
  CLEAN: '550000000201',
  MIRROR_NEG: '550000000202',
  NO_RATES: '550000000209',
};
/** No real period uses it. */
const MONTH = '2031-04-01';

/**
 * A workbook in the shape of the Maverick Sample Fee Item Report.
 *
 * Deliberately awkward in the ways a real vendor file is awkward, because each
 * one is a thing the parser has to get right and would otherwise never meet:
 *
 *   · a title row above the headers
 *   · a header with surrounding whitespace (` Net Revenue `)
 *   · MIDs stored as numbers, not text
 *   · money in accounting format, including a parenthesised negative
 *   · a trailing total row with no MID
 */
function feeReportBytes(): Uint8Array {
  const rows: unknown[][] = [
    ['Maverick Fee Item Report'],
    [],
    [
      'Merchant Number',
      'DBA Name',
      'Fee Category',
      'Fee Item',
      'Item Count',
      ' Net Revenue ',
      'Root Agent',
      'Branch',
      'Statement Date',
    ],
    [550000000201, 'Clean Diner', 'Authorization Trxns', 'Authorization Fee IP/SSL', 100, '$8.00', 'TapDash', 'NJ', new Date(Date.UTC(2031, 3, 30))],
    [550000000201, 'Clean Diner', 'Data Capture Trxns', 'Merchant Deposit Transaction', 20, 0.8, 'TapDash', 'NJ', new Date(Date.UTC(2031, 3, 30))],
    [550000000201, 'Clean Diner', 'MISC Fixed Fees', 'Monthly Fee', 1, '(4.00)', 'TapDash', 'NJ', new Date(Date.UTC(2031, 3, 30))],
    [550000000201, 'Clean Diner', 'MISC Fixed Fees', 'PCI Program', 1, '($5.00)', 'TapDash', 'NJ', new Date(Date.UTC(2031, 3, 30))],
    [550000000202, 'Mirror Cafe', 'Interchange', 'Interchange', 0, '($375.32)', 'TapDash', 'NY', new Date(Date.UTC(2031, 3, 30))],
    [550000000209, 'Unrated Grocer', 'Authorization Trxns', 'Authorization Fee IP/SSL', 10, '$1.00', 'TapDash', 'NY', new Date(Date.UTC(2031, 3, 30))],
    [null, 'TOTAL', null, null, 131, '-375.52', null, null, null],
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Fee Items');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

let db: pg.Client;
let adminId: string;
let periodId: string;
let importId: string;
/** What `buildRows` produced, kept so later tests can assert on it. */
let built: ReturnType<typeof buildRows>;

/**
 * Runs a statement that is EXPECTED to fail, and returns its SQLSTATE.
 *
 * The savepoint is not optional. A failed statement aborts the surrounding
 * transaction, and every statement after it answers "current transaction is
 * aborted" — so a test that merely catches the error passes while poisoning
 * every test that follows. Rolling back to a savepoint is what contains it.
 *
 * Returns null when the statement unexpectedly SUCCEEDED, which is the
 * assertion failure worth seeing: it means the constraint being relied on is
 * not there.
 */
async function sqlstateOf(sql: string, params: unknown[] = []): Promise<string | null> {
  const name = `expect_fail_${Math.random().toString(36).slice(2, 10)}`;
  await db.query(`savepoint ${name}`);
  try {
    await db.query(sql, params);
    await db.query(`release savepoint ${name}`);
    return null;
  } catch (e) {
    await db.query(`rollback to savepoint ${name}`);
    return (e as { code?: string }).code ?? 'unknown';
  }
}

async function asAdmin<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: adminId, role: 'authenticated' }),
  ]);
  await db.query('set local role authenticated');
  const { rows } = await db.query(sql, params);
  await db.query('reset role');
  return rows as T[];
}

suite('a fee report, from .xlsx bytes to a calculated residual', () => {
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

    /* Rates for two of the three merchants. The third is left without any on
       purpose: the engine must skip it and record why, not cost it at zero. */
    const seedRates = (mid: string, r: Record<string, number | null>) =>
      db.query(
        `insert into residual_merchant_rates
           (mid, effective_from, risk_tier, vmd_auth_fee, batch_fee, avs_fee, monthly_fee_tapdash)
         values ($1,$2,'low',$3,$4,$5,$6)`,
        [mid, MONTH, r.vmd_auth_fee ?? null, r.batch_fee ?? null, r.avs_fee ?? null, r.monthly_fee_tapdash ?? null],
      );

    await seedRates(MID.CLEAN, { vmd_auth_fee: 0.1, batch_fee: 0.05, avs_fee: 0.02, monthly_fee_tapdash: 15 });
    await seedRates(MID.MIRROR_NEG, {});
  });

  afterAll(async () => {
    if (!db) return;
    await db.query('ROLLBACK');
    await db.end();
  });

  /* ── the file ──────────────────────────────────────────────────────── */

  it('reads the workbook past its title row, keeping the headers verbatim', () => {
    const wb = parseWorkbook(feeReportBytes());
    expect(wb.sheets).toHaveLength(1);
    const sheet = wb.sheets[0];

    expect(sheet.name).toBe('Fee Items');
    /* Worksheet row 3: row 1 is the banner, row 2 is blank. */
    expect(sheet.headerRow).toBe(3);
    /* And the data runs from row 4, which is what a cell error will cite. */
    expect(sheet.rowNumbers).toEqual([4, 5, 6, 7, 8, 9, 10]);
    /* The space-padded header survives intact — it is the join key against
       residual_column_mappings, and trimming it here is what makes a saved
       template stop matching its own file next month. */
    expect(sheet.headers).toContain(' Net Revenue ');
    expect(sheet.rows).toHaveLength(7);
  });

  it('suggests the right column for each header it recognises', () => {
    const sheet = parseWorkbook(feeReportBytes()).sheets[0];
    const s = suggestMapping(sheet, new Map());
    const chosen = Object.fromEntries(s.map((x) => [x.header, x.suggested]));

    expect(chosen['Merchant Number']).toBe('mid');
    expect(chosen['DBA Name']).toBe('merchant_name');
    expect(chosen['Fee Category']).toBe('fee_category');
    expect(chosen['Fee Item']).toBe('fee_item_name');
    expect(chosen['Item Count']).toBe('item_count');
    expect(chosen[' Net Revenue ']).toBe('net_revenue');
    expect(chosen['Root Agent']).toBe('root_agent');
    expect(chosen['Branch']).toBe('branch');
    /* Nothing claims the date column: `period_id` is not a mappable field, so
       the statement month is the operator's decision rather than a cell. */
    expect(chosen['Statement Date']).toBeNull();
  });

  it('builds rows with every value a string, and drops the total row', () => {
    const sheet = parseWorkbook(feeReportBytes()).sheets[0];
    const mapping = new Map<number, Target>();
    for (const s of suggestMapping(sheet, new Map())) {
      if (s.suggested) mapping.set(s.index, s.suggested);
    }

    built = buildRows(sheet, mapping);

    expect(built.errors).toEqual([]);
    /* Seven data rows, one of which is the file's own TOTAL with no MID. */
    expect(built.rows).toHaveLength(6);
    expect(built.skippedNoMid).toBe(1);

    /* The invariant the arithmetic rests on. */
    for (const row of built.rows) {
      for (const [k, v] of Object.entries(row)) {
        expect(v === null || typeof v === 'string', `${k} = ${String(v)}`).toBe(true);
      }
    }

    /* A MID Excel stored as a number reaches SQL as the digit string. */
    expect(built.rows[0].mid).toBe('550000000201');
    /*
     * Accounting format, read without guessing — and the decimals are kept as
     * the file wrote them rather than re-formatted. "8.00" and "8" are the
     * same `numeric`, and the one that is not re-formatted is the one that
     * cannot have been re-formatted wrongly.
     */
    expect(built.rows[0].net_revenue).toBe('8.00');
    expect(built.rows[2].net_revenue).toBe('-4.00');
    expect(built.rows[4].net_revenue).toBe('-375.32');
  });

  /* ── the commit ───────────────────────────────────────────────────── */

  it('commits those rows through the real RPC', async () => {
    const [{ id }] = await db
      .query(`insert into residual_periods (statement_month, status) values ($1,'open') returning id`, [MONTH])
      .then((r) => r.rows);
    periodId = id;

    const [{ id: iid }] = await db
      .query(
        `insert into residual_imports (period_id, processor, source_type, status, original_filename)
         values ($1,'MAVERICK','excel','processing','sample-fee-report.xlsx') returning id`,
        [periodId],
      )
      .then((r) => r.rows);
    importId = iid;

    const rows = await asAdmin<{ r: { inserted: number; swept: number } }>(
      `select commit_residual_excel_import($1::uuid, $2::uuid, $3::jsonb) r`,
      [importId, periodId, JSON.stringify(built.rows)],
    );

    expect(rows[0].r.inserted).toBe(6);
    expect(rows[0].r.swept).toBe(0);
  });

  it('and closes the import, with the row count it actually wrote', async () => {
    const { rows } = await db.query(
      `select status, row_count, processed_at from residual_imports where id = $1`,
      [importId],
    );
    expect(rows[0].status).toBe('completed');
    expect(rows[0].row_count).toBe(6);
    expect(rows[0].processed_at).not.toBeNull();
  });

  /*
   * The constraint the `needs_replace` branch exists to respect. If this ever
   * stops raising, that branch is guarding nothing and a month can be imported
   * twice with no sign of it.
   */
  it('refuses a second completed import of the same processor and month', async () => {
    const code = await sqlstateOf(
      `insert into residual_imports (period_id, processor, source_type, status)
       values ($1,'MAVERICK','excel','completed')`,
      [periodId],
    );
    expect(code).toBe('23505');
  });

  /* A failed or in-flight import must NOT block a retry of the same month. */
  it('but allows a retry while one is still processing', async () => {
    await db.query('savepoint retry');
    const { rows } = await db.query(
      `insert into residual_imports (period_id, processor, source_type, status)
       values ($1,'MAVERICK','excel','processing') returning id`,
      [periodId],
    );
    expect(rows[0].id).toBeTruthy();
    await db.query('rollback to savepoint retry');
  });

  /* ── the constraints the orchestration is written against ─────────── */

  /*
   * `commitImport()` and `replaceMappings()` cannot be called from here — they
   * go through `createSupabaseServerClient()`, which needs a real request, and
   * `AuthContext` is deliberately unconstructable outside the permission gate
   * (CLAUDE.md rule 2: forgetting to authorise must be a compile error). Adding
   * a test hatch for it would weaken the thing it exists to guarantee.
   *
   * So what is asserted here is the DATABASE PROPERTY each of those functions
   * relies on. That is not a mirror of the TypeScript — it is the premise the
   * TypeScript is built on, and the failure mode worth catching is the premise
   * turning out to be false.
   */

  it('allows only one live period per statement month', async () => {
    const code = await sqlstateOf(
      `insert into residual_periods (statement_month, status) values ($1,'open')`,
      [MONTH],
    );
    /*
     * This is why `ensurePeriod` is a find-then-insert with a re-read on
     * failure rather than an insert: a second import of the same month must
     * land in the period that already exists.
     */
    expect(code).toBe('23505');
  });

  /*
   * The case `replaceMappings` retires every live row for, instead of
   * upserting per row.
   *
   * Moving a target from one header to another needs the old row gone before
   * the new one lands, or the partial unique on (processor, target_column)
   * rejects it. A per-row upsert has no ordering that satisfies both indexes;
   * retire-all-then-insert does.
   */
  it('a column-mapping swap needs the old rows retired first', async () => {
    await db.query('savepoint swap');

    await db.query(
      `insert into residual_column_mappings (processor, source_column_header, target_column)
       values ('TEST_SWAP', 'Column A', 'net_revenue')`,
    );

    /* The naive move: insert the new one while the old one is still live. */
    const code = await sqlstateOf(
      `insert into residual_column_mappings (processor, source_column_header, target_column)
       values ('TEST_SWAP', 'Column B', 'net_revenue')`,
    );
    expect(code).toBe('23505');

    /* Retire, then insert — which is what `replaceMappings` does. */
    await db.query(
      `update residual_column_mappings set deleted_at = now()
        where processor = 'TEST_SWAP' and deleted_at is null`,
    );
    const { rows } = await db.query(
      `insert into residual_column_mappings (processor, source_column_header, target_column)
       values ('TEST_SWAP', 'Column B', 'net_revenue') returning id`,
    );
    expect(rows[0].id).toBeTruthy();

    /* And the retired row is still there — a bad edit is recoverable. */
    const { rows: all } = await db.query(
      `select count(*)::int n from residual_column_mappings where processor = 'TEST_SWAP'`,
    );
    expect(all[0].n).toBe(2);

    await db.query('rollback to savepoint swap');
  });

  it('refuses a target the fourteen-column vocabulary does not include', async () => {
    const code = await sqlstateOf(
      `insert into residual_column_mappings (processor, source_column_header, target_column)
       values ('TEST_SWAP', 'Column C', 'net_income')`,
    );
    /*
     * 23514, a CHECK violation. `net_income` is an ENGINE OUTPUT — letting a
     * spreadsheet column write it would put a vendor file in charge of our own
     * arithmetic, so the closed vocabulary is enforced in the database and not
     * only in `TARGETS`.
     */
    expect(code).toBe('23514');
  });

  /* ── the arithmetic ───────────────────────────────────────────────── */

  it('computes the period, and reports the merchant it would not guess at', async () => {
    const rows = await asAdmin<{ s: Record<string, unknown> }>(
      `select compute_residual_period($1::uuid, 'MAVERICK') s`,
      [periodId],
    );
    const s = rows[0].s;

    expect(Number(s.merchants_computed)).toBe(2);
    expect(Number(s.merchants_failed)).toBe(1);
    /*
     * NOT stamped, and that is correct. A run that skipped a merchant has not
     * earned the standing claim that the month's outputs are complete —
     * `residual_merchant_rate_is_locked` treats a stamped version as a
     * dependency, so stamping a gappy run would lock the very merchant whose
     * missing rates somebody has to go and enter.
     */
    expect(s.stamped).toBe(false);
    expect(s.failures_by_reason).toMatchObject({ no_merchant_rates: 1 });
  });

  /*
   * The chain, against hand-computed figures:
   *   1 Total Income   = merchant rate x count
   *   2 Total Buy Rate = the processor's template rate at the merchant's tier
   *   3 pre-split net  = 1 - 2
   *   4 after split    = 3 x share(tier)
   */
  it('gets the arithmetic right, line by line', async () => {
    const line = async (mid: string, item: string) => {
      const { rows } = await db.query(
        `select total_income::text ti, total_buy_rate::text tb,
                tapdash_net_before_split::text nb, tapdash_net_after_split::text na,
                additional_income_direct::text ad, net_income::text ni
           from residual_lines
          where period_id = $1 and mid = $2 and fee_item_name = $3 and deleted_at is null`,
        [periodId, mid, item],
      );
      return rows[0];
    };

    const auth = await line(MID.CLEAN, 'Authorization Fee IP/SSL');
    expect(auth.ti).toBe('10.00'); // 100 x 0.10
    expect(auth.tb).toBe('2.00'); //  100 x 0.02, the template rate at tier `low`
    expect(auth.nb).toBe('8.00'); //  10 - 2
    expect(auth.na).toBe('7.20'); //  8 x 0.90
    expect(auth.ad).toBe('0.00');
    expect(auth.ni).toBe('7.20');

    const dep = await line(MID.CLEAN, 'Merchant Deposit Transaction');
    expect(dep.ti).toBe('1.00'); // 20 x 0.05
    expect(dep.tb).toBe('0.20'); // 20 x 0.01
    expect(dep.na).toBe('0.72'); // 0.80 x 0.90

    /* Rule #6 has no terms on either side, and "a side with no terms is
       $0.00" — which is why the workbook's "Always $0" needs no opcode. */
    const pci = await line(MID.CLEAN, 'PCI Program');
    expect(pci.ti).toBe('0.00');
    expect(pci.tb).toBe('0.00');

    /* The mirror rule: a negative net revenue is stored as a positive cost. */
    const mirror = await line(MID.MIRROR_NEG, 'Interchange');
    expect(mirror.tb).toBe('375.32');
    expect(mirror.nb).toBe('-375.32');
    expect(mirror.na).toBe('-337.79');

    /* Skipped, not zeroed. A rate of zero and a rate nobody has entered are
       different claims, and only one of them is safe to book. */
    const unrated = await line(MID.NO_RATES, 'Authorization Fee IP/SSL');
    expect(unrated.ti).toBeNull();
  });

  it('holds the identity the whole module reconciles against', async () => {
    const { rows } = await db.query(
      `select count(*)::int bad from residual_lines
        where period_id = $1 and deleted_at is null and total_income is not null
          and round(total_income - total_buy_rate, 2) <> round(tapdash_net_before_split, 2)`,
      [periodId],
    );
    expect(rows[0].bad).toBe(0);
  });

  it('records the skipped merchant by name and reason, not just as a count', async () => {
    const { rows } = await db.query(
      `select mid, scope, reason_code from residual_calc_failures where period_id = $1`,
      [periodId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].mid).toBe(MID.NO_RATES);
    expect(rows[0].reason_code).toBe('no_merchant_rates');
  });

  it('records the run itself, so a gappy month is auditable afterwards', async () => {
    const { rows } = await db.query(
      `select stamped, merchants_computed, merchants_failed, summary
         from residual_calc_runs where period_id = $1`,
      [periodId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].stamped).toBe(false);
    expect(rows[0].merchants_failed).toBe(1);
    /* The run's stored summary is the same object the function returned —
       one account of one run, not two that can disagree. */
    expect(rows[0].summary.merchants_computed).toBe(2);
  });

  /* ── what the admin screen reads ──────────────────────────────────── */

  /*
   * These two exist because of a bug this work found. `adminResiduals.ts`
   * called `residual_link_worklist` through the SERVICE-ROLE client, and that
   * function is gated on `auth_is_admin()`, which resolves `auth.uid()` —
   * NULL for the service role. So it answered 42501 every time, the data
   * layer logged it and returned `[]`, and the Unmatched tab rendered that as
   * "Nothing unmatched". A permission error displayed as a clean bill of
   * health.
   *
   * The fix points both at the request-scoped client and makes the worklist
   * throw rather than return empty. That makes these the premise the admin
   * page now depends on: the SAME functions must SUCCEED for an authenticated
   * admin. Asserting only the service-role refusal would leave the page one
   * untested assumption away from a 500 on every load.
   */

  it('an authenticated admin CAN read the link worklist', async () => {
    const rows = await asAdmin<{ mid: string; match_kind: string }>(
      `select mid, match_kind from residual_link_worklist($1::uuid)`,
      [periodId],
    );
    /*
     * None of this fixture's MIDs is on a merchant record, so all three are
     * unmatched — which is the point: the call returns ROWS rather than
     * raising, and the rows are the real verdicts.
     */
    expect(rows.map((r) => r.mid).sort()).toEqual(
      [MID.CLEAN, MID.MIRROR_NEG, MID.NO_RATES].sort(),
    );
    for (const r of rows) expect(r.match_kind).toBe('unmatched');
  });

  it('and a caller with no identity cannot, which is why the service role is not used', async () => {
    /*
     * ── THE CLAIMS HAVE TO BE CLEARED FIRST ──────────────────────────────
     * `set_config('request.jwt.claims', ..., true)` is TRANSACTION-scoped, not
     * role-scoped, so `reset role` does not undo it. Without the line below
     * this test ran as `postgres` while `auth.uid()` still resolved to the
     * admin from the previous test — and the call SUCCEEDED, failing an
     * assertion that was in fact correct.
     *
     * Worth leaving written down: the first time this ran it reported a
     * passing production claim as a failure. The claim itself was verified
     * separately against the real service-role key, which answers:
     *
     *   residual_link_worklist -> ERROR 42501: Not authorized to read the
     *                             residual link worklist.
     */
    await db.query(`select set_config('request.jwt.claims', '', true)`);
    const code = await sqlstateOf(`select * from residual_link_worklist($1::uuid)`, [periodId]);
    expect(code).toBe('42501');
  });

  it('derives the period state at merchant grain, for the Periods tab', async () => {
    const rows = await asAdmin<{
      derived_status: string;
      stored_status: string;
      merchant_count: string;
      blocked: string;
      signable: boolean;
    }>(`select * from residual_period_state($1::uuid, 'MAVERICK')`, [periodId]);

    const st = rows[0];
    /*
     * The distinction the Periods tab exists to show. The STORED column says
     * 'open' — it can say nothing else, since the engine writes no status and
     * a CHECK allows only 'open' or 'reconciled'. The DERIVED value says
     * 'open' too here, but for a reason the stored one cannot express: a
     * merchant is blocked. Hence the blocked count beside the word.
     */
    expect(st.stored_status).toBe('open');
    expect(st.derived_status).toBe('open');
    expect(Number(st.blocked)).toBeGreaterThan(0);
    /* And a month with a blocked merchant is not signable. */
    expect(st.signable).toBe(false);
  });

  /* ── re-importing the month ───────────────────────────────────────── */

  /**
   * The supersede sweep, which is the behaviour that makes a correction safe.
   *
   * A second import of the same processor and month retires the first
   * import's lines in the SAME transaction that inserts the replacements, so
   * the month never holds two sets of figures — not even briefly, and not if
   * the insert fails.
   */
  it('a replacement import retires the previous lines in the same transaction', async () => {
    await db.query('savepoint reimport');

    /* What the app's `replaceExisting` branch does: retire the old import
       record, which is what frees the partial unique index. */
    await db.query(`update residual_imports set deleted_at = now() where id = $1`, [importId]);

    const { rows: created } = await db.query(
      `insert into residual_imports (period_id, processor, source_type, status)
       values ($1,'MAVERICK','excel','processing') returning id`,
      [periodId],
    );
    const secondId = created[0].id;

    const rows = await asAdmin<{ r: { inserted: number; swept: number } }>(
      `select commit_residual_excel_import($1::uuid, $2::uuid, $3::jsonb) r`,
      [secondId, periodId, JSON.stringify(built.rows)],
    );

    expect(rows[0].r.inserted).toBe(6);
    /* The six the first import wrote. */
    expect(rows[0].r.swept).toBe(6);

    const { rows: live } = await db.query(
      `select count(*)::int n from residual_lines where period_id = $1 and deleted_at is null`,
      [periodId],
    );
    expect(live[0].n).toBe(6);

    /* Retired, not destroyed — the history of what was loaded when survives. */
    const { rows: retired } = await db.query(
      `select count(*)::int n from residual_lines where period_id = $1 and deleted_at is not null`,
      [periodId],
    );
    expect(retired[0].n).toBe(6);

    await db.query('rollback to savepoint reimport');
  });
});
