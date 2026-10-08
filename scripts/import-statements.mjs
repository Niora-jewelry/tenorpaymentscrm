/**
 * Load the real merchant statements for a month.
 *
 * Volume comes from the processor's PDF statement and from nowhere else. Until
 * these are loaded, every fee item assessed on volume — BIN Sponsorship, Amex
 * OptBlue, the Cash Discount / Surcharge programme — is refused with
 * `no_volumes`, which is why a month with a complete fee report can still
 * leave a third of its lines uncomputed.
 *
 * ── THE PARSE IS PROVED, NOT TRUSTED ─────────────────────────────────────
 * Each statement prints its own `**` totals row. `verifyTotals` requires the
 * plan rows to sum to it exactly, on both the money and the transaction count,
 * and a statement that fails is SKIPPED rather than imported with a note.
 *
 * That is the whole safety argument of this script. The failure being guarded
 * against is not a crash — it is a row read off the wrong line, which yields a
 * volume that is wrong by a factor of four and looks entirely ordinary. The
 * reason `src/lib/residuals/statementParser.ts` reads coordinates rather than
 * laid-out text is that `pdftotext -layout` produces exactly that on this
 * statement format.
 *
 * ── ONE IMPORT ROW PER STATEMENT ─────────────────────────────────────────
 * A statement is one merchant's artifact, so each file gets its own
 * `residual_imports` row and `commit_residual_pdf_import` is called once per
 * file. Migration 20260819009746 is what makes that possible; before it the
 * second statement of any month raised 23505.
 *
 * Usage:
 *   node --import tsx --env-file=.env scripts/import-statements.mjs <dir>
 *   node --import tsx --env-file=.env scripts/import-statements.mjs <dir> --commit
 *
 * `--import tsx` because the parser is TypeScript and is shared with the app.
 * There is deliberately no JavaScript copy of it: a second implementation is a
 * second thing to be wrong.
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { parseStatement, verifyTotals } from '../src/lib/residuals/statementParser.ts';

const COMMIT = process.argv.includes('--commit');
const DIR = process.argv.find((a, i) => i >= 2 && !a.startsWith('--'))
  ?? 'C:/Users/brime/Downloads/Response_to_Residual_Request';

const PROCESSOR = 'MAVERICK';
const STATEMENT_MONTH = '2026-08-01';

/**
 * The month each statement must say it is for, as the document prints it.
 *
 * Checked per file rather than assumed from the folder. A September statement
 * dropped into the August batch would otherwise load its volumes against
 * August's lines, and the arithmetic would all succeed.
 */
const EXPECTED_MONTH = '08-26';

const db = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 180_000,
});

/** Opens a PDF and returns its text runs with positions, page by page. */
async function loadPdf(bytes) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({
    data: bytes,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
  try {
    const pages = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      try {
        const content = await page.getTextContent();
        pages.push(
          content.items
            .filter((i) => 'str' in i && i.str.trim() !== '')
            .map((i) => ({ text: i.str.trim(), x: i.transform[4], y: i.transform[5] })),
        );
      } finally {
        page.cleanup();
      }
    }
    return { pages };
  } finally {
    await doc.destroy();
  }
}

async function main() {
  const files = fs
    .readdirSync(DIR)
    .filter((f) => f.toLowerCase().endsWith('.pdf'))
    .sort();

  if (files.length === 0) throw new Error(`No PDF in ${DIR}`);
  console.log(`${files.length} PDF(s) in ${DIR}\n`);

  /* ── read and prove every file BEFORE touching the database ─────────── */
  const ready = [];
  const refused = [];

  for (const file of files) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(DIR, file)));
    let parsed;
    try {
      parsed = await parseStatement(bytes, loadPdf);
    } catch (e) {
      refused.push({ file, why: `could not be opened: ${e.message}` });
      continue;
    }

    const verdict = verifyTotals(parsed);
    if (!verdict.ok) {
      refused.push({ file, why: verdict.problems.join(' ') });
      continue;
    }
    if (!parsed.mid) {
      refused.push({ file, why: 'no merchant number is printed in the document.' });
      continue;
    }
    if (parsed.processingMonth !== EXPECTED_MONTH) {
      refused.push({
        file,
        why: `is for processing month ${parsed.processingMonth ?? 'unknown'}, not ${EXPECTED_MONTH}.`,
      });
      continue;
    }

    ready.push({ file, parsed, verdict });
  }

  for (const { file, parsed, verdict } of ready) {
    console.log(
      `  ${parsed.mid.padEnd(14)} ${(verdict.amountCents / 100).toFixed(2).padStart(12)} ` +
        `${String(verdict.itemCount).padStart(6)} sales  ${parsed.planRows.length} plan rows  ${file}`,
    );
  }
  if (refused.length) {
    console.log(`\n  REFUSED (${refused.length}) — nothing will be written for these:`);
    for (const r of refused) console.log(`    ${r.file}\n      ${r.why}`);
  }

  if (ready.length === 0) {
    console.log('\nNothing provable to import.');
    return;
  }

  /* ── the database ───────────────────────────────────────────────────── */
  await db.connect();

  const { rows: periods } = await db.query(
    `select id from residual_periods where statement_month = $1 and deleted_at is null`,
    [STATEMENT_MONTH],
  );
  if (!periods.length) throw new Error(`No live period for ${STATEMENT_MONTH}.`);
  const periodId = periods[0].id;

  const { rows: admins } = await db.query(
    `select p.id from profiles p join roles r on r.id = p.role_id
      where r.is_admin and p.deleted_at is null and p.status = 'active' limit 1`,
  );
  if (!admins.length) throw new Error('No active admin profile.');
  const adminId = admins[0].id;

  /*
   * `commit_residual_pdf_import` raises if `auth.uid()` is null — a volume
   * figure with no author is refused by design, and the service role has no
   * author. So every call runs as the admin, exactly as the app would.
   */
  const asAdmin = async (fn) => {
    await db.query('BEGIN');
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: adminId, role: 'authenticated' }),
    ]);
    await db.query('set local role authenticated');
    try {
      const out = await fn();
      await db.query('reset role');
      if (COMMIT) await db.query('COMMIT');
      else await db.query('ROLLBACK');
      return out;
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    }
  };

  console.log(COMMIT ? '\nCommitting…' : '\nDry run — every statement is loaded and then rolled back.');

  let loaded = 0;
  const failures = [];

  for (const { file, parsed } of ready) {
    try {
      const out = await asAdmin(async () => {
        const { rows: imp } = await db.query(
          `insert into residual_imports
             (period_id, processor, source_type, status, original_filename, size_bytes, created_by_id)
           values ($1, $2, 'pdf', 'processing', $3, $4, $5)
           returning id`,
          [periodId, PROCESSOR, file, fs.statSync(path.join(DIR, file)).size, adminId],
        );
        const { rows } = await db.query(
          `select commit_residual_pdf_import($1::uuid, $2::uuid, $3::jsonb, $4::jsonb) r`,
          [
            imp[0].id,
            periodId,
            JSON.stringify({
              mid: parsed.mid,
              merchant_name: null,
              stated_total: parsed.printedTotals.amount,
              stated_item_count: parsed.printedTotals.itemCount,
            }),
            /* Money as text the whole way; PostgreSQL does the cast. */
            JSON.stringify(
              parsed.planRows.map((r) => ({
                plan_code: r.planCode,
                amount: r.amount,
                item_count: r.itemCount,
              })),
            ),
          ],
        );
        return rows[0].r;
      });

      loaded += 1;
      const codes = out.unmapped_codes ?? [];
      console.log(
        `  ${parsed.mid.padEnd(14)} reconciled=${out.reconciled} ` +
          `plan rows=${out.plan_rows_inserted} swept=${out.swept}` +
          (Number(out.unmapped_volume) !== 0
            ? `  ⚠ ${out.unmapped_volume} in unmapped codes: ${codes.join(', ')}`
            : ''),
      );
    } catch (e) {
      failures.push({ mid: parsed.mid, file, code: e.code, message: e.message });
      console.log(`  ${String(parsed.mid).padEnd(14)} FAILED ${e.code ?? ''} ${e.message}`);
    }
  }

  console.log(`\n${loaded} statement(s) ${COMMIT ? 'imported' : 'would import'}, ${failures.length} failed.`);

  if (!COMMIT) {
    console.log('Nothing written. Re-run with --commit to apply.');
    return;
  }

  /* ── recompute, so the effect is visible and not merely claimed ─────── */
  const recompute = async () => {
    await db.query('BEGIN');
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: adminId, role: 'authenticated' }),
    ]);
    await db.query('set local role authenticated');
    const { rows } = await db.query(`select compute_residual_period($1::uuid, $2) s`, [
      periodId,
      PROCESSOR,
    ]);
    await db.query('reset role');
    await db.query('COMMIT');
    return rows[0].s;
  };

  const s = await recompute();
  console.log(
    `\nRecomputed: ${s.lines_computed} lines, ${s.merchants_computed} merchants, ` +
      `${s.merchants_failed} skipped, stamped=${s.stamped}`,
  );
  if (s.failures_by_reason && Object.keys(s.failures_by_reason).length) {
    console.log('remaining failures by reason:', JSON.stringify(s.failures_by_reason));
  }
}

try {
  await main();
} finally {
  await db.end().catch(() => {});
}
