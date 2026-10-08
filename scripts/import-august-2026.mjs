/**
 * Import the real August 2026 Maverick fee report.
 *
 * ── WHY A SCRIPT AND NOT THE SCREEN ──────────────────────────────────────
 * The screen is the real path and this uses the same contract: the same
 * fourteen target columns, the same decimal-text rule, the same refusal to
 * read `Buy Rate Per Item`. What it skips is the browser, because loading 397
 * rows once to find out whether the registry is complete is a thing to do from
 * a terminal, repeatably, with a `--remove` beside it.
 *
 * ── THE COLUMN THAT IS DELIBERATELY NOT MAPPED ───────────────────────────
 * `Buy Rate Per Item` is display-rounded to 2dp: it reads 0.03 where the cell
 * holds 0.025. The handoff records that reading it directly "has produced
 * three wrong conclusions", and the true rate is Agent Expense / Count. The
 * engine costs from the template schedule regardless, so the column is
 * attribution at best and a trap at worst. It is left out.
 *
 *   node --env-file=.env scripts/import-august-2026.mjs
 *   node --env-file=.env scripts/import-august-2026.mjs --remove
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import * as XLSX from 'xlsx';

const FILE =
  process.env.FEE_REPORT ??
  'C:/Users/brime/Downloads/Response_to_Residual_Request/Tapdash_LLC_Fee_Item_Report_August_2026.xlsx';
const MONTH = '2026-08-01';
const TAG = 'August 2026 Maverick fee report (real data)';

const db = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 180_000,
});

/** The file's own header spellings, mapped to residual_lines columns. */
const MAP = {
  MID: 'mid',
  'Merchant Name': 'merchant_name',
  'Fee Category': 'fee_category',
  'Fee Item Name': 'fee_item_name',
  Count: 'item_count',
  Amount: 'amount',
  'Agent Income': 'agent_income',
  'Agent Expense': 'agent_expense',
  'Net Revenue': 'net_revenue',
  'Root Agent': 'root_agent',
  'Agent Owner': 'agent_owner',
  Agent: 'agent',
  Branch: 'branch',
};

const NUMERIC = new Set([
  'item_count',
  'amount',
  'agent_income',
  'agent_expense',
  'net_revenue',
]);

/**
 * A numeric cell as DECIMAL TEXT, never a JavaScript number.
 *
 * `jsonb_to_recordset` casts text to numeric exactly; a JSON number has
 * already been through a float by the time PostgreSQL sees it.
 */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  const s = String(v).trim().replace(/[$,]/g, '');
  if (s === '' || s === '-') return null;
  return /^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s) ? s : null;
}

/** A MID Excel stored as a number must reach SQL as the digit string. */
function text(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isInteger(v) ? v.toFixed(0) : String(v);
  const t = String(v).trim();
  return t === '' ? null : t;
}

const CHILD_TABLES = [
  'residual_verdict_acknowledgments',
  'residual_calc_failures',
  'residual_calc_runs',
  'residual_line_groups',
  'residual_lines',
  'residual_merchant_volumes',
  'residual_plan_volumes',
  'residual_period_status_log',
  'residual_imports',
];

async function clearPeriods(ids) {
  /* Children first: they hold a foreign key to the period, and deleting the
     period first is refused — that refusal protects a calculation's
     provenance from being orphaned. */
  for (const t of CHILD_TABLES) {
    await db.query(`delete from ${t} where period_id = any($1)`, [ids]).catch(() => {});
  }
  await db.query(`delete from residual_periods where id = any($1)`, [ids]);
}

async function asAdmin(adminId, sql, params) {
  await db.query('BEGIN');
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: adminId, role: 'authenticated' }),
  ]);
  await db.query('set local role authenticated');
  const { rows } = await db.query(sql, params);
  await db.query('reset role');
  await db.query('COMMIT');
  return rows;
}

async function main() {
  await db.connect();

  if (process.argv.includes('--remove')) {
    const { rows } = await db.query(
      `select id from residual_periods where statement_month = $1 and notes = $2`,
      [MONTH, TAG],
    );
    if (!rows.length) {
      console.log('No August import found.');
      return;
    }
    await clearPeriods(rows.map((r) => r.id));
    console.log('Removed the August period and everything under it.');
    return;
  }

  if (!fs.existsSync(FILE)) throw new Error(`Fee report not found: ${FILE}`);

  const wb = XLSX.read(fs.readFileSync(FILE), { type: 'buffer', raw: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  });

  const headers = (grid[0] ?? []).map((h) => (h === null ? '' : String(h)));
  const byIndex = new Map();
  for (const [i, h] of headers.entries()) if (MAP[h]) byIndex.set(i, MAP[h]);

  const unmapped = headers.filter((h) => h && !MAP[h]);
  if (unmapped.length) console.log(`Not imported: ${unmapped.join(', ')}`);

  const rows = [];
  let skipped = 0;
  for (const cells of grid.slice(1)) {
    const row = {};
    for (const k of Object.values(MAP)) row[k] = null;
    for (const [i, key] of byIndex) {
      row[key] = NUMERIC.has(key) ? num(cells[i]) : text(cells[i]);
    }
    const mid = (row.mid ?? '').replace(/[^0-9]/g, '');
    if (!mid) {
      skipped += 1;
      continue;
    }
    row.mid = mid;
    rows.push(row);
  }
  console.log(`Parsed ${rows.length} rows (${skipped} without a MID).`);

  const { rows: admins } = await db.query(
    `select p.id from profiles p join roles r on r.id = p.role_id
      where r.is_admin and p.deleted_at is null and p.status = 'active' limit 1`,
  );
  if (!admins.length) throw new Error('No active admin profile to import as.');
  const adminId = admins[0].id;

  const prior = (
    await db.query(`select id from residual_periods where statement_month = $1`, [MONTH])
  ).rows.map((r) => r.id);
  if (prior.length) {
    await clearPeriods(prior);
    console.log('Cleared the previous August period.');
  }

  const [{ id: periodId }] = (
    await db.query(
      `insert into residual_periods (statement_month, status, notes)
       values ($1,'open',$2) returning id`,
      [MONTH, TAG],
    )
  ).rows;

  const [{ id: importId }] = (
    await db.query(
      `insert into residual_imports (period_id, processor, source_type, status, original_filename)
       values ($1,'MAVERICK','excel','processing',$2) returning id`,
      [periodId, path.basename(FILE)],
    )
  ).rows;

  const [{ r }] = await asAdmin(
    adminId,
    `select commit_residual_excel_import($1::uuid,$2::uuid,$3::jsonb) r`,
    [importId, periodId, JSON.stringify(rows)],
  );
  console.log(`Committed: ${r.inserted} inserted, ${r.swept} swept.`);

  const [{ s }] = await asAdmin(
    adminId,
    `select compute_residual_period($1::uuid,'MAVERICK') s`,
    [periodId],
  );

  console.log(
    `\nComputed: ${s.lines_computed} lines, ${s.merchants_computed} merchants, ` +
      `${s.merchants_failed} skipped, stamped=${s.stamped}`,
  );
  if (s.failures_by_reason && Object.keys(s.failures_by_reason).length) {
    console.log('failures by reason:', JSON.stringify(s.failures_by_reason));
  }
  console.log(`period_id = ${periodId}`);
}

try {
  await main();
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  console.error('\nFailed:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await db.end();
}
