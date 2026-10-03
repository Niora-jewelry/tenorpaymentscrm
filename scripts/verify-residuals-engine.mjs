/**
 * The calculation engine, against Daniel's own hand-computed figures.
 *
 * ── WHY THESE NUMBERS AND NOT NUMBERS OF MY OWN ──────────────────────────
 * The expected values below are lifted from his `calc-engine.integration.test.ts`,
 * where they are hand-computed and commented. Inventing my own would prove the
 * engine is self-consistent — that it agrees with whatever it does — which is
 * exactly the test that passes when a port has gone subtly wrong.
 *
 * It runs against the REAL MAVERICK registry and buy rates, not a scratch
 * copy, because the point is to prove the ported reference data is right as
 * well as the arithmetic. His vmd_auth_fee at tier `low` is 0.020000 here,
 * which is what makes 100 items cost 2.00; if the port had dropped a digit
 * these assertions would fail rather than quietly agreeing with themselves.
 *
 * ── THE CHAIN BEING TESTED ───────────────────────────────────────────────
 *   1 Total Income            merchant rate x count
 *   2 Total Buy Rate          processor's template rate at the merchant's tier
 *   3 pre-split net           = 1 - 2      <- reconciles against net_revenue
 *   4 TapDash net after split = 3 x share(tier)
 *   5 Additional Income       billed by TapDash directly, OUTSIDE the split
 *   6 Net Income              = 4 + 5
 *
 * Scratch period and MIDs only, removed in the `finally`.
 *
 * Run: node --env-file=.env scripts/verify-residuals-engine.mjs
 */
import pg from 'pg';

const db = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 120_000,
});

const pass = [];
const fail = [];
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  (ok ? pass : fail).push(label);
  console.log(`  ${ok ? 'PASS' : '**FAIL**'}  ${label.padEnd(52)} ${actual}${ok ? '' : `   expected ${expected}`}`);
};

/* Twelve digits each, none a suffix of another — his invariant, and the reason
   is his too: two distinct strings of equal length cannot be suffixes of one
   another, so an accidental suffix collision in the resolver is arithmetically
   impossible. */
const MID = {
  CLEAN: '550000000101',
  MIRROR_NEG: '550000000102',
  MIRROR_POS: '550000000103',
  NO_RATES: '550000000109',
};
const MONTH = '2031-03-01'; // no real period uses it

await db.connect();
const q = async (s, p) => (await db.query(s, p)).rows;

async function cleanup() {
  const ids = Object.values(MID);
  await db.query(`delete from residual_lines where mid = any($1)`, [ids]);
  await db.query(`delete from residual_merchant_rates where mid = any($1)`, [ids]);
  /* The engine writes its own rows - failures and run records - and both hold
     a foreign key to the period. Deleting the period first is refused, which
     is the constraint protecting a calculation's provenance from being
     orphaned rather than an inconvenience. */
  const periods = (await db.query(
    `select id from residual_periods where statement_month = $1`, [MONTH])).rows.map((r) => r.id);
  if (periods.length) {
    await db.query(`delete from residual_calc_failures where period_id = any($1)`, [periods]);
    await db.query(`delete from residual_calc_runs where period_id = any($1)`, [periods]);
    await db.query(`delete from residual_imports where period_id = any($1)`, [periods]);
    await db.query(`delete from residual_periods where id = any($1)`, [periods]);
  }
}

try {
  await cleanup();

  // ── fixtures ────────────────────────────────────────────────────────────
  const [{ id: periodId }] = await q(
    `insert into residual_periods (statement_month, status) values ($1,'open') returning id`, [MONTH]);
  const [{ id: importId }] = await q(
    `insert into residual_imports (period_id, processor, source_type, status)
     values ($1,'MAVERICK','excel','completed') returning id`, [periodId]);

  const seedRates = (mid, r) => db.query(
    `insert into residual_merchant_rates
       (mid, effective_from, risk_tier, vmd_auth_fee, batch_fee, avs_fee, monthly_fee_tapdash)
     values ($1,$2,'low',$3,$4,$5,$6)`,
    [mid, MONTH, r.vmd_auth_fee ?? null, r.batch_fee ?? null, r.avs_fee ?? null, r.monthly_fee_tapdash ?? null]);

  const seedLine = (mid, item, count, net) => db.query(
    `insert into residual_lines (period_id, mid, fee_item_name, item_count, net_revenue, source, import_id)
     values ($1,$2,$3,$4,$5,'excel',$6)`,
    [periodId, mid, item, count, net, importId]);

  // His CLEAN merchant, rates and all.
  await seedRates(MID.CLEAN, { vmd_auth_fee: 0.1, batch_fee: 0.05, avs_fee: 0.02, monthly_fee_tapdash: 15 });
  await seedRates(MID.MIRROR_NEG, {});
  await seedRates(MID.MIRROR_POS, {});

  await seedLine(MID.CLEAN, 'Authorization Fee IP/SSL', 100, 8);
  await seedLine(MID.CLEAN, 'Merchant Deposit Transaction', 20, 0.8);
  await seedLine(MID.CLEAN, 'Monthly Fee', 1, -4);
  await seedLine(MID.CLEAN, 'PCI Program', 1, -5);
  await seedLine(MID.MIRROR_NEG, 'Interchange', 0, -375.32);
  await seedLine(MID.MIRROR_POS, 'Interchange', 0, 23);
  // Deliberately NO rate row — the engine must skip, not assume zero.
  await seedLine(MID.NO_RATES, 'Authorization Fee IP/SSL', 10, 1);

  // ── compute ─────────────────────────────────────────────────────────────
  console.log('\nrunning the engine:');
  /*
   * `compute_residual_period` is admin-gated and raises for a caller with no
   * role, which a plain `postgres` connection is. Running it inside an admin
   * JWT context exercises the real path an operator takes, rather than
   * exempting the test from the gate it is meant to prove.
   */
  const [{ id: adminId }] = await q(
    `select p.id from profiles p join roles r on r.id = p.role_id
      where r.is_admin and p.deleted_at is null and p.status = 'active' limit 1`,
  );
  const t0 = Date.now();
  await db.query('begin');
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: adminId, role: 'authenticated' }),
  ]);
  await db.query(`set local role authenticated`);
  try {
    await db.query(`select compute_residual_period($1::uuid, 'MAVERICK')`, [periodId]);
    await db.query(`reset role`);
    await db.query('commit');
  } catch (e) {
    /* Surface the real reason. A failure inside the transaction aborts it, and
       every later statement then reports "current transaction is aborted",
       which hides what actually went wrong. */
    await db.query('rollback').catch(() => {});
    console.log(`  engine raised: ${e.message}`);
    throw e;
  }
  console.log(`  computed in ${Date.now() - t0}ms`);

  const line = async (mid, item) =>
    (await q(
      `select total_income::text ti, total_buy_rate::text tb, tapdash_net_before_split::text nb,
              tapdash_net_after_split::text na, additional_income_direct::text ad, net_income::text ni
         from residual_lines where mid=$1 and fee_item_name=$2 and deleted_at is null`,
      [mid, item],
    ))[0];

  // ── 1. the whole chain, hand-computed ───────────────────────────────────
  console.log('\n1 — a clean merchant, against hand-computed values:');
  const auth = await line(MID.CLEAN, 'Authorization Fee IP/SSL');
  check('Authorization Fee: total income  (100 x 0.10)', auth?.ti, '10.00');
  check('                   total buy     (100 x 0.02)', auth?.tb, '2.00');
  check('                   pre-split net (10 - 2)', auth?.nb, '8.00');
  check('                   after split   (8 x 0.90)', auth?.na, '7.20');
  check('                   additional income', auth?.ad, '0.00');
  check('                   net income', auth?.ni, '7.20');

  const dep = await line(MID.CLEAN, 'Merchant Deposit Transaction');
  check('Merchant Deposit:  total income  (20 x 0.05)', dep?.ti, '1.00');
  check('                   total buy     (20 x 0.01)', dep?.tb, '0.20');
  check('                   after split   (0.80 x 0.90)', dep?.na, '0.72');

  /* Rule #6 has no terms on either side. "A side with no terms is $0.00" -
     that one rule removes an entire opcode, because the workbook's "Always $0"
     needs no representation when absence already means it. */
  const pci = await line(MID.CLEAN, 'PCI Program');
  check('PCI Program: a rule with no terms is 0.00', pci?.ti, '0.00');
  check('             and stays 0.00 on the buy side', pci?.tb, '0.00');

  // ── 2. the mirror sign ──────────────────────────────────────────────────
  console.log('\n2 — the mirror rules, stored as -net_revenue:');
  const mNeg = await line(MID.MIRROR_NEG, 'Interchange');
  check('negative net revenue becomes a positive cost', mNeg?.tb, '375.32');
  check('  pre-split net is the negative', mNeg?.nb, '-375.32');
  check('  and the split applies to it too', mNeg?.na, '-337.79');

  /* Two Interchange rows in the real May sample have POSITIVE net revenue,
     which under the mirror rule is a legitimately negative buy rate - a
     rebate. There is deliberately no CHECK forbidding it. */
  const mPos = await line(MID.MIRROR_POS, 'Interchange');
  check('positive net revenue is a NEGATIVE buy rate', mPos?.tb, '-23.00');
  check('  which is a rebate, not an error', mPos?.nb, '23.00');
  check('  split applied', mPos?.na, '20.70');

  // ── 3. a missing rate must not read as zero ─────────────────────────────
  console.log('\n3 — a merchant with no rates is skipped, not zeroed:');
  const none = await line(MID.NO_RATES, 'Authorization Fee IP/SSL');
  check('nothing was computed for it', none?.ti === null ? 'NULL' : String(none?.ti), 'NULL');
  const failures = await q(
    `select scope, reason_code from residual_calc_failures
      where period_id=$1 and mid=$2`, [periodId, MID.NO_RATES]);
  check('  and it was RECORDED as a failure', failures.length > 0 ? 'recorded' : 'SILENT', 'recorded');
  check('  naming the reason', failures[0]?.reason_code ?? '-', 'no_merchant_rates');

  // ── 4. the identity the whole module reconciles against ─────────────────
  console.log('\n4 — Total Income - Total Buy Rate = pre-split net, on every line:');
  const [{ bad }] = await q(
    `select count(*)::int bad from residual_lines
      where period_id=$1 and deleted_at is null and total_income is not null
        and round(total_income - total_buy_rate, 2) <> round(tapdash_net_before_split, 2)`,
    [periodId]);
  check('no line breaks the identity', bad, 0);

  console.log('\n5 - a period with failures is NOT stamped as complete:');
  /*
   * This fixture deliberately contains a merchant with no rates, so the run
   * HAS a failure - and calculation_version must stay NULL.
   *
   * An earlier version of this test asserted the opposite and failed, which
   * was the test being wrong rather than the engine. The column means "there
   * is a standing assertion that this period's stored outputs are current and
   * complete", and a run that skipped a merchant has not earned it. Daniel
   * fixed the same mistake one column over in R6a: a period with zero
   * merchants used to derive 'ready' because it asked "were there failures?",
   * and min() over an empty set is not 'ready', it is nothing.
   */
  const [{ calculation_version: ver }] = await q(
    `select calculation_version from residual_periods where id=$1`, [periodId]);
  check('version stays NULL while a merchant was skipped', ver === null ? 'NULL' : String(ver), 'NULL');

  const [{ n: runs }] = await q(
    `select count(*)::int n from residual_calc_runs where period_id=$1`, [periodId]);
  check('  but the run itself was recorded', runs > 0 ? 'recorded' : 'MISSING', 'recorded');
} finally {
  await cleanup();
  console.log(`\ncleaned up. ${pass.length} passed, ${fail.length} failed`);
  await db.end();
}

process.exit(fail.length ? 1 : 0);
