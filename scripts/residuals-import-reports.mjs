/**
 * Loads one month of the Maverick ACH fee item report and the Accept.blue residual report
 * into residual_ach_lines / residual_acceptblue_lines, and auto-matches ACH merchant names
 * to MIDs where exactly one CRM record has that name (residual_ach_name_matches).
 *
 * Re-running for the same month replaces that month's rows (soft delete + insert).
 * Existing name matches are never overwritten.
 *
 * Usage:
 *   node --env-file=.env scripts/residuals-import-reports.mjs 2026-08 --ach <ach.xlsx> --ab <ab.xlsx>
 */
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import XLSX from 'xlsx';

const [month, ...rest] = process.argv.slice(2);
const arg = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : null; };
const achFile = arg('--ach');
const abFile = arg('--ab');
if (!/^\d{4}-\d{2}$/.test(month ?? '') || (!achFile && !abFile)) {
  console.error('Usage: node --env-file=.env scripts/residuals-import-reports.mjs YYYY-MM --ach <file> --ab <file>');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production') { console.error('Refusing to run with NODE_ENV=production.'); process.exit(1); }

const sheet = (f) => {
  const wb = XLSX.read(fs.readFileSync(f));
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: true });
};
const n = (v) => (v == null || v === '' ? 0 : Number(v));
const digits = (v) => String(v ?? '').replace(/[^0-9]/g, '');
const normName = (s) => String(s ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ')
  .replace(/\b(llc|inc|corp|corporation|co|ltd|the)\b/g, ' ').replace(/\s+/g, ' ').trim();

const url = process.env.SUPABASE_DB_URL;
const db = new pg.Client({ connectionString: url, ssl: /@(127\.0\.0\.1|localhost)[:/]/.test(url) ? false : { rejectUnauthorized: false } });
await db.connect();
await db.query('begin');

const period = (await db.query(`select id from residual_periods where statement_month = $1::date and deleted_at is null`, [`${month}-01`])).rows[0];
if (!period) throw new Error(`No residual period for ${month}. Create it on the Residuals admin page first.`);

if (achFile) {
  const rows = sheet(achFile).filter((r) => r.Date === month);
  await db.query(`update residual_ach_lines set deleted_at = now() where period_id = $1 and deleted_at is null`, [period.id]);
  for (const r of rows) {
    await db.query(
      `insert into residual_ach_lines (period_id, merchant_name, dba_id, ach_id, fee_category, item_count, buyrate, income, expense, net, source_file)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [period.id, String(r['Merchant Name']).trim(), r['DBA ID'] == null ? null : String(r['DBA ID']), r['ACH ID'] == null ? null : String(r['ACH ID']),
        String(r['Fee Category']).trim(), n(r.Count), r.Buyrate == null ? null : n(r.Buyrate), n(r.Income), n(r.Expense), n(r.Net), path.basename(achFile)],
    );
  }
  // Auto-match names to MIDs where exactly one CRM record carries that name.
  const recs = (await db.query(`select deal_name, regexp_replace(values->>'mid','[^0-9]','','g') mid from records
                                 where deleted_at is null and coalesce(values->>'mid','') ~ '[0-9]'`)).rows;
  const byName = new Map();
  for (const r of recs) { const k = normName(r.deal_name); (byName.get(k) ?? byName.set(k, new Set()).get(k)).add(r.mid); }
  const names = [...new Set(rows.map((r) => String(r['Merchant Name']).trim()))];
  let matched = 0;
  for (const name of names) {
    const mids = [...(byName.get(normName(name)) ?? [])];
    if (mids.length !== 1) continue;
    const res = await db.query(`insert into residual_ach_name_matches (merchant_name, mid, matched_by) values ($1,$2,'auto_name') on conflict do nothing`, [name, mids[0]]);
    matched += res.rowCount;
  }
  console.log(`ACH: ${rows.length} rows, ${names.length} merchants, ${matched} new name matches`);
}

if (abFile) {
  const rows = sheet(abFile);
  const KNOWN = new Set(['Month', 'Name', 'MID', 'Agent Id', 'Setup Fee ISO', 'Monthly Gateway Fee ISO', 'Transaction Fee ISO', 'Transaction Count',
    'Payment Pages ISO', 'Card Updater Monthly ISO', 'Card Updater Per Update ISO', 'DAF Transaction Fee ISO', 'ISO Total']);
  await db.query(`update residual_acceptblue_lines set deleted_at = now() where period_id = $1 and deleted_at is null`, [period.id]);
  for (const r of rows) {
    const other = Object.fromEntries(Object.entries(r).filter(([k]) => !KNOWN.has(k)).map(([k, v]) => [k, String(v)]));
    await db.query(
      `insert into residual_acceptblue_lines (period_id, name, mid, report_month, setup_fee_iso, monthly_gateway_fee_iso, transaction_fee_iso,
         transaction_count, payment_pages_iso, card_updater_monthly_iso, card_updater_per_update_iso, daf_transaction_fee_iso, iso_total, other_columns, source_file)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [period.id, String(r.Name).trim(), digits(r.MID) || null, r.Month == null ? null : String(r.Month), 'Setup Fee ISO' in r ? n(r['Setup Fee ISO']) : null,
        n(r['Monthly Gateway Fee ISO']), n(r['Transaction Fee ISO']), n(r['Transaction Count']), n(r['Payment Pages ISO']), n(r['Card Updater Monthly ISO']),
        n(r['Card Updater Per Update ISO']), n(r['DAF Transaction Fee ISO']), n(r['ISO Total']), other, path.basename(abFile)],
    );
  }
  console.log(`Accept.blue: ${rows.length} rows`);
}

await db.query('commit');
await db.end();
