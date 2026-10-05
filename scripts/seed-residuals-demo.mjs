/**
 * Demo residuals for four merchants that already exist in this CRM.
 *
 * ── WHAT IT IS FOR ───────────────────────────────────────────────────────
 * Until a real Maverick fee report arrives, every residuals screen is
 * correctly empty — which makes it impossible to tell a working module from a
 * broken one, or to show anyone what it does. This seeds one statement month
 * so the Periods tab, the reconciliation grid, the merchant states and the
 * per-record Residuals tab all have something true to render.
 *
 * ── IT WIRES TO REAL RECORDS, NOT TO INVENTED MIDS ───────────────────────
 * It picks live merchant records that already carry a MID and a risk level,
 * and keys everything on those MIDs. That is the point: the per-record
 * Residuals tab resolves by the record's own MID, so seeding against invented
 * numbers would produce a module full of figures that no record can reach —
 * which is exactly the failure that would look like the feature working.
 *
 * The rates come from each record's own Pricing tab where it has them, so the
 * computed figures are consistent with what the CRM already shows.
 *
 * ── EVERY ROW IS LABELLED AND REMOVABLE ──────────────────────────────────
 * The period is tagged in `notes` and the script is idempotent: run it twice
 * and it replaces its own month rather than doubling it. `--remove` deletes
 * exactly what it created and nothing else.
 *
 *   node --env-file=.env scripts/seed-residuals-demo.mjs
 *   node --env-file=.env scripts/seed-residuals-demo.mjs --remove
 */
import pg from 'pg';

const DB_URL = process.env.SUPABASE_DB_URL;
if (!DB_URL) {
  console.error('SUPABASE_DB_URL is not set.');
  process.exit(2);
}

/** The month this demo occupies. Recent, and not one a real statement uses. */
const MONTH = '2026-08-01';
/** Stamped on the period so the remover can find its own work. */
const TAG = 'DEMO DATA — seeded by scripts/seed-residuals-demo.mjs';

/**
 * The record ids whose Residuals membership this script created, encoded into
 * the period's `notes` after the tag.
 *
 * Kept with the period rather than in a side table because it is a fact about
 * this demo and must die with it — and because a `--remove` run has nothing
 * else to go on. A record already in the module before seeding is deliberately
 * NOT listed, so removal leaves it alone.
 */
function readAddedRecordIds(notes) {
  if (typeof notes !== 'string') return [];
  const nl = notes.indexOf(String.fromCharCode(10));
  if (nl === -1) return [];
  try {
    const parsed = JSON.parse(notes.slice(nl + 1));
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

const db = new pg.Client({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 120_000,
});

const remove = process.argv.includes('--remove');

/**
 * Fee items taken from the live registry, with a plausible shape per merchant.
 *
 * `fee_item_name` must match a rule EXACTLY — matching is on the exact name
 * and nothing else, and an unmatched name raises rather than guessing. So
 * these are read from `residual_formula_rules` at run time rather than typed
 * here, and the script fails loudly if the four it wants are not all present.
 */
const WANTED = [
  'Authorization Fee IP/SSL',
  'Merchant Deposit Transaction',
  'Monthly Fee',
  'PCI Program',
];

async function main() {
  await db.connect();

  /* ── removal ──────────────────────────────────────────────────────── */
  if (remove) {
    const { rows: periods } = await db.query(
      `select id, notes from residual_periods
        where statement_month = $1 and notes like $2 || '%'`,
      [MONTH, TAG],
    );
    if (periods.length === 0) {
      console.log('Nothing to remove — no demo period found.');
      return;
    }
    const ids = periods.map((p) => p.id);

    /* Order matters: the engine's own rows hold a foreign key to the period,
       and deleting the period first is refused. That refusal is the constraint
       protecting a calculation's provenance, not an inconvenience. */
    const { rows: mids } = await db.query(
      `select distinct mid from residual_lines where period_id = any($1)`,
      [ids],
    );
    for (const t of [
      'residual_verdict_acknowledgments',
      'residual_calc_failures',
      'residual_calc_runs',
      'residual_line_groups',
      'residual_lines',
      'residual_merchant_volumes',
      'residual_plan_volumes',
      'residual_period_status_log',
      'residual_imports',
    ]) {
      await db.query(`delete from ${t} where period_id = any($1)`, [ids]).catch(() => {});
    }
    await db.query(`delete from residual_periods where id = any($1)`, [ids]);

    /* The rates this script opened, identified by their own effective date and
       note — never a merchant's real rates. */
    const midList = mids.map((m) => m.mid);
    if (midList.length) {
      await db.query(
        `delete from residual_merchant_rates
          where mid = any($1) and effective_from = $2 and notes = $3`,
        [midList, MONTH, TAG],
      );
    }

    /*
     * Module memberships, but only the ones this script created.
     *
     * `added_by` is NOT a usable marker — four pre-existing rows already carry
     * NULL — so the ids are written into the period's notes at seed time and
     * read back here. Removing a membership a human added deliberately would
     * be the script quietly undoing someone's work.
     */
    const added = readAddedRecordIds(periods[0]?.notes);
    let removedMemberships = 0;
    if (added.length) {
      const { rowCount } = await db.query(
        `delete from record_modules
          where record_id = any($1)
            and module_id = (select id from modules where slug = 'residuals')`,
        [added],
      );
      removedMemberships = rowCount ?? 0;
    }

    console.log(
      `Removed the demo period, ${midList.length} demo rate rows and ` +
        `${removedMemberships} Residuals membership(s).`,
    );
    return;
  }

  /* ── the fee items this demo needs ────────────────────────────────── */
  const { rows: ruleRows } = await db.query(
    `select distinct fee_item_name from residual_formula_rules where deleted_at is null`,
  );
  const known = new Set(ruleRows.map((r) => r.fee_item_name));
  const missing = WANTED.filter((w) => !known.has(w));
  if (missing.length) {
    throw new Error(
      `The registry has no rule for: ${missing.join(', ')}. ` +
        'Fee items are matched on the exact name, so seeding one the engine cannot price would raise.',
    );
  }

  /* ── four real merchants ──────────────────────────────────────────── */
  const { rows: merchants } = await db.query(
    `select id,
            deal_name,
            regexp_replace(coalesce(values->>'mid',''),'[^0-9]','','g') as mid,
            values->>'pricing_risk_level'      as risk,
            nullif(btrim(values->>'td_monthly_fee_tapdash'), '') as monthly_fee_tapdash,
            nullif(btrim(values->>'td_vmd_auth_fee'), '')        as vmd_auth_fee,
            nullif(btrim(values->>'td_batch_fee'), '')           as batch_fee,
            nullif(btrim(values->>'td_avs_fee'), '')             as avs_fee
       from records
      where deleted_at is null
        and regexp_replace(coalesce(values->>'mid',''),'[^0-9]','','g') <> ''
        and coalesce(values->>'pricing_risk_level','') <> ''
      order by deal_name
      limit 4`,
  );

  if (merchants.length < 4) {
    throw new Error(`Only ${merchants.length} records carry both a MID and a risk level; this needs 4.`);
  }

  console.log('Seeding against real records:');
  for (const m of merchants) console.log(`  ${m.deal_name.padEnd(26)} MID ${m.mid}  (${m.risk})`);

  await db.query('BEGIN');

  /* Replace our own prior run rather than doubling it. */
  const { rows: existing } = await db.query(
    `select id from residual_periods where statement_month = $1`,
    [MONTH],
  );
  /* Memberships from a previous run of this script, so a re-run does not leave
     a growing set behind. Read before the period is deleted. */
  const priorAdded = (
    await db.query(
      `select notes from residual_periods
        where statement_month = $1 and notes like $2 || '%'`,
      [MONTH, TAG],
    )
  ).rows.flatMap((r) => readAddedRecordIds(r.notes));
  if (existing.length) {
    const ids = existing.map((p) => p.id);
    for (const t of [
      'residual_verdict_acknowledgments', 'residual_calc_failures', 'residual_calc_runs',
      'residual_line_groups', 'residual_lines', 'residual_merchant_volumes',
      'residual_plan_volumes', 'residual_period_status_log', 'residual_imports',
    ]) {
      await db.query(`delete from ${t} where period_id = any($1)`, [ids]).catch(() => {});
    }
    await db.query(`delete from residual_periods where id = any($1)`, [ids]);
  }

  const [{ id: periodId }] = (
    await db.query(
      `insert into residual_periods (statement_month, status, notes) values ($1,'open',$2) returning id`,
      [MONTH, TAG],
    )
  ).rows;

  /*
   * ── THE MODULE MEMBERSHIP, WHICH IS WHAT MAKES THEM VISIBLE ───────────
   * Seeding residual FIGURES for a merchant does not put that merchant in the
   * Residuals module. The module is a view over the one record store, and
   * which records it shows is `record_modules` — so without this the four
   * merchants have figures nobody can reach from the module, and the Residuals
   * list shows whatever was already in it.
   *
   * Only records not already members are added, and only those are recorded
   * for removal.
   */
  const residualsModuleId = (
    await db.query(`select id from modules where slug = 'residuals'`)
  ).rows[0]?.id;
  if (!residualsModuleId) throw new Error('No residuals module.');

  /* Anything a previous run added and this run will not re-add. */
  if (priorAdded.length) {
    await db.query(
      `delete from record_modules where record_id = any($1) and module_id = $2`,
      [priorAdded, residualsModuleId],
    );
  }

  const addedRecordIds = [];
  for (const m of merchants) {
    const { rowCount } = await db.query(
      `insert into record_modules (record_id, module_id)
       values ($1,$2)
       on conflict (record_id, module_id) do nothing`,
      [m.id, residualsModuleId],
    );
    if (rowCount) addedRecordIds.push(m.id);
  }

  /* Written now that the set is known. The remover reads it back. */
  await db.query(`update residual_periods set notes = $2 where id = $1`, [
    periodId,
    TAG + String.fromCharCode(10) + JSON.stringify(addedRecordIds),
  ]);

  const [{ id: importId }] = (
    await db.query(
      `insert into residual_imports
         (period_id, processor, source_type, status, original_filename, row_count, processed_at)
       values ($1,'MAVERICK','excel','completed','demo-fee-report.xlsx',0, now()) returning id`,
      [periodId],
    )
  ).rows;

  /* ── rates, from each merchant's own Pricing tab where present ─────── */
  for (const m of merchants) {
    const { rows: tierRows } = await db.query(
      `select residual_tier_from_pricing_choice($1) t`, [m.risk],
    );
    const tier = tierRows[0].t;
    if (!tier) {
      throw new Error(
        `"${m.risk}" resolves to no risk tier for ${m.deal_name}. ` +
          'Without a tier the split percentage is unknown and the merchant cannot be costed.',
      );
    }

    await db.query(
      `delete from residual_merchant_rates where mid = $1 and effective_from = $2`,
      [m.mid, MONTH],
    );
    await db.query(
      `insert into residual_merchant_rates
         (mid, effective_from, risk_tier, vmd_auth_fee, batch_fee, avs_fee,
          monthly_fee_tapdash, notes)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        m.mid,
        MONTH,
        tier,
        /* The record's own figures where it has them; otherwise a plain rate
           that keeps the arithmetic easy to follow on screen. */
        m.vmd_auth_fee ?? '0.10',
        m.batch_fee ?? '0.05',
        m.avs_fee ?? '0.02',
        m.monthly_fee_tapdash ?? '25.00',
        TAG,
      ],
    );
  }

  /* ── statement lines ──────────────────────────────────────────────── */
  const line = (mid, item, count, net, amount) =>
    db.query(
      `insert into residual_lines
         (period_id, import_id, mid, merchant_name, fee_item_name,
          item_count, net_revenue, amount, agent_expense, source)
       values ($1,$2,$3,$4,$5,$6,$7,$8,0,'excel')`,
      [periodId, importId, mid, null, item, count, net, amount],
    );

  let lineCount = 0;
  for (const [i, m] of merchants.entries()) {
    /* Varied so the grid is not four identical rows — a demo that shows one
       shape teaches nothing about the ones that matter. */
    const auths = 100 + i * 37;
    const deposits = 20 + i * 11;
    await line(m.mid, 'Authorization Fee IP/SSL', auths, (auths * 0.08).toFixed(2), (auths * 0.08).toFixed(2));
    await line(m.mid, 'Merchant Deposit Transaction', deposits, (deposits * 0.04).toFixed(2), (deposits * 0.04).toFixed(2));
    await line(m.mid, 'Monthly Fee', 1, '-4.00', '-4.00');
    /* PCI is the open question — the template says the merchant pays it and
       the processor's report charges TapDash. Included deliberately so the
       grid shows the mismatch it is supposed to show. */
    await line(m.mid, 'PCI Program', 1, '-5.00', '-5.00');
    lineCount += 4;
  }

  await db.query(`update residual_imports set row_count = $2 where id = $1`, [importId, lineCount]);
  await db.query('COMMIT');

  /* ── compute, as an admin ─────────────────────────────────────────── */
  const { rows: admins } = await db.query(
    `select p.id from profiles p join roles r on r.id = p.role_id
      where r.is_admin and p.deleted_at is null and p.status = 'active' limit 1`,
  );
  if (!admins.length) throw new Error('No active admin profile to compute as.');

  await db.query('BEGIN');
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: admins[0].id, role: 'authenticated' }),
  ]);
  await db.query('set local role authenticated');
  const { rows: summary } = await db.query(
    `select compute_residual_period($1::uuid,'MAVERICK') s`, [periodId],
  );
  await db.query('reset role');
  await db.query('COMMIT');

  const s = summary[0].s;
  console.log(`\nSeeded ${lineCount} lines across ${merchants.length} merchants for ${MONTH}.`);
  console.log(
    `Added ${addedRecordIds.length} of them to the Residuals module` +
      `${addedRecordIds.length === merchants.length ? '' : ' (the rest were already in it)'}.`,
  );
  console.log(`Computed: ${s.lines_computed} lines, ${s.merchants_computed} merchants, ` +
              `${s.merchants_failed} skipped, stamped=${s.stamped}`);
  if (!s.stamped) {
    console.log('Not stamped — see the reconciliation screen for which merchants are outstanding.');
  }
  console.log('\nRemove it again with:  node --env-file=.env scripts/seed-residuals-demo.mjs --remove');
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
