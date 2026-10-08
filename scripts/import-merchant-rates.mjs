/**
 * Load the real merchant rates from the Merchant Mastersheet.
 *
 * ── .xlsx, AND THE REASON IS MEASURED ────────────────────────────────────
 * The same sheet exported as CSV gives `3.38%` where the cell holds
 * `0.033816`. Checked on this very file:
 *
 *   CSV   201100208546 ... VMD Volume = 3.38%     -> 0.0338
 *   xlsx  201100208546 ... VMD Volume = 0.033816
 *
 * That is a real loss of digits on a rate multiplied by hundreds of thousands
 * of dollars of volume, so the workbook is read directly and the CSV is never
 * used.
 *
 * ── THE SHEET HAS A TWO-ROW HEADER ───────────────────────────────────────
 * Row 1 names MID, Merchant Name and Processor beside merged group labels
 * ("Authorization Fees", "Volume Fees"); row 2 names the rate columns and
 * opens with a sentence of prose. Neither row is the header on its own, so
 * the columns are addressed BY INDEX from row 2 — the same answer the UI
 * reaches by letting the operator pick the header row.
 *
 * ── WHERE THE RISK TIER COMES FROM, AND WHY IT IS NOT A GUESS ────────────
 * The RPC requires a `risk_code` and neither file has a risk column. The
 * handoff says the tier comes from the merchant's Pricing tab — but none of
 * these 52 real MIDs exists as a CRM record, because the CRM holds invented
 * data.
 *
 * The fee report settles it. Its `Agent %` column is the share the processor
 * ACTUALLY applied, and the share is the only thing a tier changes in the
 * money. Measured across all 47 August merchants:
 *
 *   90%  30 merchants      80%  9 merchants      70%  8 merchants
 *   and not one MID carries more than a single percentage
 *
 * against the seeded tiers: no_program 0.90, low 0.90, medium 0.80, high 0.70.
 *
 * So the tier is derived from the share rather than assumed, which makes the
 * computed money right by construction instead of right by luck. 90% is
 * recorded as `low`: it is indistinguishable from `no_program` on the only
 * axis that matters, and inventing a distinction the data does not carry would
 * be worse than picking the commoner one.
 *
 *   node --env-file=.env scripts/import-merchant-rates.mjs          (dry run)
 *   node --env-file=.env scripts/import-merchant-rates.mjs --commit
 */
import fs from 'node:fs';
import pg from 'pg';
import * as XLSX from 'xlsx';

const DIR = process.env.RESIDUAL_DIR ?? 'C:/Users/brime/Downloads/Response_to_Residual_Request';
const RATES_FILE = `${DIR}/Merchant Mastersheet.xlsx`;
const REPORT_FILE = `${DIR}/Tapdash_LLC_Fee_Item_Report_August_2026.xlsx`;
const SHEET = 'Processor -TD Merchant Pricing';
const EFFECTIVE_FROM = '2026-08-01';

const COMMIT = process.argv.includes('--commit');

/**
 * Re-state an existing version at this effective date, in place.
 *
 * The import RPC refuses to write over a standing version that starts on the
 * same date with DIFFERENT values, and it is right to: migration
 * ...idempotency_r5d1c spells out that "backdating onto a DIFFERENT value at
 * an existing effective_from remains 23514. That must never become a silent
 * overwrite."
 *
 * The word doing the work there is *silent*. This flag is the loud version,
 * for the one case the guard cannot distinguish: a month whose rates were
 * imported from a MISREADING of the sheet, where there is no history worth
 * keeping because the version being replaced is hours old and was never
 * right. It happened here — `num` collapsed `"$ -"` into blank, against
 * §6.6, and 38 of August's line failures were the result.
 *
 * It goes through `residual_update_merchant_rate_row`, the same RPC the rate
 * editor screen uses, so every change lands in `residual_audit_log` with an
 * actor against it. It does NOT touch effective dating, and the locked-month
 * trigger still refuses a version a computed period depends on.
 *
 * For a genuine rate CHANGE, this is the wrong tool: that is a new version at
 * a new effective date, which the normal path already does.
 */
const FIX_IN_PLACE = process.argv.includes('--fix-in-place');

/**
 * Column index on the rates sheet -> the RPC's key.
 *
 * By index, because the header spans two rows. Deliberately omitted:
 *   3  Amex Auth Fee          no column on residual_merchant_rates
 *  14  EBT (Volume)           likewise
 *  18  Gateway Auth Fee       likewise
 *  21  Terminal Auth Fee      likewise
 *  22  Notes / 23 Notes       free text, two columns, neither authoritative
 *  26  Lease Payments         the sheet itself says "not income"
 */
const COLUMNS = {
  0: 'mid',
  1: 'merchant_name',
  4: 'vmd_auth_fee',
  5: 'pin_debit_auth_fee',
  6: 'amex_volume',
  7: 'vmd_volume',
  8: 'pin_debit_volume',
  9: 'chargeback_fee',
  10: 'vmd_transaction_fee',
  11: 'avs_fee',
  12: 'batch_fee',
  /* "Monthly Fee" under Other Fees is what the merchant pays the PROCESSOR. */
  13: 'monthly_fee_maverick',
  15: 'amex_template_volume_fee',
  16: 'gateway_provider_mav',
  17: 'gateway_monthly_mav',
  19: 'terminal_provider_mav',
  20: 'terminal_monthly_mav',
  /* "Monthly Fee" under "Fees Charged Directly by TapDash to Merchant" — the
     column rule #2 raises without, and the one the first real month waited on. */
  25: 'monthly_fee_tapdash',
};

const TEXT_KEYS = new Set([
  'mid',
  'merchant_name',
  'gateway_provider_mav',
  'terminal_provider_mav',
]);

/** Agent % -> statement_code on residual_risk_tiers. */
const SHARE_TO_CODE = { 90: 1, 80: 2, 70: 3 };

/**
 * MIDs held back, with the reason, because the sheet does not settle them.
 *
 * ── 30119900929 — TWO SITES, ONE MID, TWO RATES ───────────────────────
 * The Mastersheet carries it twice:
 *
 *   row 17  "House Of Tacos Llc"  volume 0.047619
 *   row 18  "House Of Tacos II"   volume 0.038462
 *           noted: "We need to change to 4.76%, Mav was making issues"
 *
 * The note says the intent is 4.76%, which matches row 17 — but a note is not
 * an instruction, and the difference is 0.9157% on every dollar of that
 * merchant's volume. Picking one would be choosing a price on the client's
 * behalf.
 *
 * So it is excluded and SAID, rather than deduplicated quietly. The merchant
 * will show as blocked on the reconciliation screen for want of rates, which
 * is what that state is for and is the honest outcome until somebody decides.
 *
 * Removing the entry here is all it takes once they have.
 */
const HELD_BACK = {
  '30119900929':
    'Listed twice with different volume rates (0.047619 vs 0.038462) under two ' +
    'site names. A note says it should become 4.76%; that needs confirming.',
};

/**
 * A cell as decimal TEXT, or null — under the THREE-state rule.
 *
 * `residuals.md` §6.6 is explicit that the sheet distinguishes three things,
 * and that two of them look alike and mean opposite things:
 *
 *   a number   the rate
 *   "$ -"      a RECORDED DECISION — we do not charge this. Stored 0.000000.
 *   blank      an ABSENCE — no arrangement recorded. Stored NULL, fails loud.
 *
 * This function read `"$ -"` as NULL at first, collapsing the first two. The
 * cost was measurable: 38 of August's line failures were fees the sheet had
 * explicitly declined, which the engine then refused for want of a rate that
 * had in fact been decided.
 *
 * The opposite shortcut is worse and is not taken — a blank stays NULL. §6.7
 * is explicit that `monthly_fee_tapdash` is never auto-zeroed, and 18 of
 * August's remaining failures are exactly that, correctly refused.
 */
function num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;

  const trimmed = String(v).trim();
  if (trimmed === '') return null;
  /* Tested before the symbols are stripped, so "$ -" is caught as written. */
  if (/^\$?\s*[-—]\s*\$?$/.test(trimmed)) return '0';

  const s = trimmed.replace(/[$,\s]/g, '');
  if (s === '') return null;
  return /^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s) ? s : null;
}

function text(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isInteger(v) ? v.toFixed(0) : String(v);
  const t = String(v).trim();
  return t === '' || t === '$ -' ? null : t;
}

const db = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 180_000,
});

function sheetRows(file, name) {
  const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer', raw: true });
  return XLSX.utils.sheet_to_json(wb.Sheets[name], {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  });
}

async function main() {
  for (const f of [RATES_FILE, REPORT_FILE]) {
    if (!fs.existsSync(f)) throw new Error(`Not found: ${f}`);
  }

  /* ── the share each merchant was actually paid at ──────────────────── */
  const report = sheetRows(REPORT_FILE, 'Agent fee item report');
  const head = report[0];
  const midCol = head.indexOf('MID');
  const pctCol = head.indexOf('Agent %');
  if (midCol < 0 || pctCol < 0) throw new Error('The fee report has no MID / Agent % column.');

  const shareByMid = new Map();
  const conflicting = new Set();
  for (const r of report.slice(1)) {
    const mid = String(r?.[midCol] ?? '').replace(/[^0-9]/g, '');
    if (!mid) continue;
    const pct = Number(r[pctCol]);
    if (!Number.isFinite(pct)) continue;
    if (shareByMid.has(mid) && shareByMid.get(mid) !== pct) conflicting.add(mid);
    shareByMid.set(mid, pct);
  }
  if (conflicting.size) {
    /* One merchant, one share. Two would mean the tier is not a property of
       the merchant and the whole derivation is unsound. */
    throw new Error(`These MIDs carry more than one Agent %: ${[...conflicting].join(', ')}`);
  }
  console.log(`Agent % read for ${shareByMid.size} merchants.`);

  /* ── the rates ─────────────────────────────────────────────────────── */
  const grid = sheetRows(RATES_FILE, SHEET);
  const rows = [];
  const noShare = [];
  const unknownShare = [];
  const held = new Map();
  /** Per-column counts of number / "$ -" / blank. See §6.6 and `num`. */
  const cellStates = {};

  for (const cells of grid.slice(2)) {
    const mid = String(cells?.[0] ?? '').replace(/[^0-9]/g, '');
    if (!mid) continue;

    if (HELD_BACK[mid]) {
      if (!held.has(mid)) held.set(mid, HELD_BACK[mid]);
      continue;
    }

    const share = shareByMid.get(mid);
    if (share === undefined) {
      /* In the Mastersheet but not in August's report — nothing to price. */
      noShare.push(mid);
      continue;
    }
    const code = SHARE_TO_CODE[share];
    if (!code) {
      unknownShare.push(`${mid} (${share}%)`);
      continue;
    }

    const row = { mid, risk_code: String(code) };
    for (const [idx, key] of Object.entries(COLUMNS)) {
      if (key === 'mid') continue;
      const v = cells[Number(idx)];
      row[key] = TEXT_KEYS.has(key) ? text(v) : num(v);

      /* The §6.6 tally, for the panel below. */
      if (!TEXT_KEYS.has(key)) {
        const t = (cellStates[key] ??= { numbers: 0, declined: 0, absent: 0 });
        const trimmed = v === null || v === undefined ? '' : String(v).trim();
        if (trimmed === '') t.absent += 1;
        else if (/^\$?\s*[-—]\s*\$?$/.test(trimmed)) t.declined += 1;
        else t.numbers += 1;
      }
    }
    rows.push(row);
  }

  console.log(`Rates built for ${rows.length} merchants.`);
  if (noShare.length) {
    console.log(`  skipped, not in the August report: ${noShare.length} (${noShare.slice(0, 5).join(', ')}${noShare.length > 5 ? ', …' : ''})`);
  }
  if (unknownShare.length) {
    /* A share that maps to no tier must stop the run: picking a tier would be
       picking a split percentage. */
    throw new Error(`Agent % values with no matching tier: ${unknownShare.join(', ')}`);
  }

  if (held.size) {
    console.log(`  held back, needing a decision: ${held.size}`);
    for (const [mid, why] of held) console.log(`      ${mid} — ${why}`);
  }

  /*
   * §6.6 requires these three counts to be shown before a commit, "not a
   * footnote", because reading "$ -" as zero is an inference. The spec records
   * the trap too: a column counted as "populated" when a cell is a number OR
   * "$ -" overstates real coverage badly.
   */
  console.log('');
  console.log('  column                   numbers   "$ -"   blank');
  for (const [key, t] of Object.entries(cellStates)) {
    if (t.numbers === 0 && t.declined === 0) continue;
    console.log(
      `  ${key.padEnd(24)} ${String(t.numbers).padStart(7)} ${String(t.declined).padStart(7)} ${String(t.absent).padStart(7)}`,
    );
  }

  const withTdFee = rows.filter((r) => r.monthly_fee_tapdash !== null).length;
  console.log(`  carrying a TapDash monthly fee: ${withTdFee}`);

  await db.connect();
  const { rows: admins } = await db.query(
    `select p.id from profiles p join roles r on r.id = p.role_id
      where r.is_admin and p.deleted_at is null and p.status = 'active' limit 1`,
  );
  if (!admins.length) throw new Error('No active admin profile.');
  const adminId = admins[0].id;

  const asAdmin = async (sql, params) => {
    await db.query('BEGIN');
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: adminId, role: 'authenticated' }),
    ]);
    await db.query('set local role authenticated');
    const r = await db.query(sql, params);
    await db.query('reset role');
    await db.query('COMMIT');
    return r.rows;
  };

  if (FIX_IN_PLACE) {
    /*
     * There is no dry run for this one — the editor RPC writes per merchant
     * and has no preview twin — so the second flag is the confirmation step
     * that `--commit` provides everywhere else. Overwriting a standing rate
     * version should take two deliberate words, not one.
     */
    if (!COMMIT) {
      console.log(
        '\n--fix-in-place re-states existing rate versions through the audited rate\n' +
          'editor. It overwrites values a previous import wrote at the same effective\n' +
          'date, so it needs --commit as well. Nothing was done.',
      );
      return;
    }
    await fixInPlace(rows, asAdmin);
    return;
  }

  /*
   * The dry run is the REAL commit inside a discarded subtransaction, so what
   * it reports is what the commit will do — including every refusal.
   */
  const [{ p }] = await asAdmin(
    `select residual_preview_merchant_rates_import($1::date, $2::jsonb) p`,
    [EFFECTIVE_FROM, JSON.stringify(rows)],
  );
  console.log(
    `\nDry run: ${p.rows_read} read, ${p.inserted} new versions, ` +
      `${p.unchanged} unchanged, ${p.closed} predecessors closed.`,
  );
  if (p.locked_versions?.length) {
    console.log(`  ${p.locked_versions.length} locked version(s) would be closed.`);
  }

  if (!COMMIT) {
    console.log('\nNothing written. Re-run with --commit to apply.');
    return;
  }

  const [{ c }] = await asAdmin(
    `select commit_residual_merchant_rates_import(null::uuid, $1::date, $2::jsonb) c`,
    [EFFECTIVE_FROM, JSON.stringify(rows)],
  );
  console.log(`\nCommitted: ${c.inserted} new versions, ${c.unchanged} unchanged, ${c.closed} closed.`);

  const { rows: periods } = await db.query(
    `select id from residual_periods where statement_month = '2026-08-01' and deleted_at is null`,
  );
  if (!periods.length) {
    console.log('No August period to recompute.');
    return;
  }

  const [{ s }] = await asAdmin(`select compute_residual_period($1::uuid,'MAVERICK') s`, [
    periods[0].id,
  ]);
  console.log(
    `\nRecomputed August: ${s.lines_computed} lines, ${s.merchants_computed} merchants, ` +
      `${s.merchants_failed} skipped, stamped=${s.stamped}`,
  );
  if (s.failures_by_reason && Object.keys(s.failures_by_reason).length) {
    console.log('failures by reason:', JSON.stringify(s.failures_by_reason));
  }
}

/** Rate columns the editor RPC accepts. Anything else it raises on. */
const EDITABLE = [
  'vmd_auth_fee', 'pin_debit_auth_fee', 'avs_fee', 'batch_fee',
  'vmd_transaction_fee', 'amex_volume', 'vmd_volume', 'pin_debit_volume',
  'amex_template_volume_fee', 'gateway_provider_mav', 'gateway_monthly_mav',
  'terminal_provider_mav', 'terminal_monthly_mav', 'monthly_fee_tapdash',
  'monthly_fee_maverick', 'chargeback_fee',
];

/**
 * Re-states each merchant's standing version through the rate editor.
 *
 * A WHOLE row every time, because the RPC documents that "absent key and JSON
 * null both mean SQL NULL" — so a partial payload would quietly blank every
 * column it omitted. Every editable column is sent, including the ones that
 * are not changing.
 */
async function fixInPlace(rows, asAdmin) {
  const tierByCode = new Map(
    (await asAdmin(`select tier_key, statement_code from residual_risk_tiers
                     where deleted_at is null and statement_code is not null`))
      .map((t) => [String(t.statement_code), t.tier_key]),
  );

  let changed = 0;
  let same = 0;
  const failed = [];

  for (const row of rows) {
    const tier = tierByCode.get(String(row.risk_code));
    if (!tier) {
      failed.push(`${row.mid}: no tier for statement_code ${row.risk_code}`);
      continue;
    }

    /*
     * The row BEFORE, so the diff is observed rather than claimed.
     *
     * `residual_update_merchant_rate_row` returns `{mid, rate_id}` and nothing
     * else — it has no `changed_fields`. Reading one off it reported "44
     * already correct" on the very run that corrected forty of them, which is
     * the kind of confident-and-wrong summary this script exists to avoid. So
     * the comparison is made here, against the stored row.
     */
    const [before] = await asAdmin(
      `select * from residual_merchant_rates
        where mid = $1 and effective_from = $2::date and deleted_at is null`,
      [row.mid, EFFECTIVE_FROM],
    );
    if (!before) {
      failed.push(`${row.mid}: no version starting ${EFFECTIVE_FROM} to re-state`);
      continue;
    }

    const values = {};
    for (const k of EDITABLE) values[k] = row[k] ?? null;

    /* Compared as numbers where both sides are numbers, so '0' and '0.000000'
       are one value and not a spurious change. */
    const differs = EDITABLE.filter((k) => {
      const now = before[k];
      const next = values[k];
      if (now === null || now === undefined) return next !== null;
      if (next === null) return true;
      const a = Number(now);
      const b = Number(next);
      return Number.isFinite(a) && Number.isFinite(b) ? a !== b : String(now) !== String(next);
    });

    if (differs.length === 0) {
      same += 1;
      continue;
    }

    try {
      await asAdmin(`select residual_update_merchant_rate_row($1::uuid, $2, $3::jsonb) r`, [
        before.id,
        tier,
        JSON.stringify(values),
      ]);
      changed += 1;
      console.log(`  ${row.mid.padEnd(14)} ${differs.length} field(s): ${differs.join(', ')}`);
    } catch (e) {
      failed.push(`${row.mid}: ${e.code ?? ''} ${e.message}`);
    }
  }

  console.log(`
Re-stated ${changed} version(s), ${same} already correct, ${failed.length} failed.`);
  for (const f of failed) console.log(`  ${f}`);
  if (failed.length) return;

  const periods = await asAdmin(
    `select id from residual_periods where statement_month = '2026-08-01' and deleted_at is null`,
  );
  if (!periods.length) return;
  const [{ s }] = await asAdmin(`select compute_residual_period($1::uuid,'MAVERICK') s`, [periods[0].id]);
  console.log(
    `
Recomputed August: ${s.lines_computed} lines, ${s.merchants_computed} merchants, ` +
      `${s.merchants_failed} skipped, stamped=${s.stamped}`,
  );
  if (s.failures_by_reason && Object.keys(s.failures_by_reason).length) {
    console.log('failures by reason:', JSON.stringify(s.failures_by_reason));
  }
}

try {
  await main();
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  console.error('\nFailed:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await db.end().catch(() => {});
}
