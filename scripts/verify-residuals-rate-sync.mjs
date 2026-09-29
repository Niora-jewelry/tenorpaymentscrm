/**
 * The Pricing tab feeding the residuals calculator, end to end.
 *
 * The thing worth testing is not that a value copies across — it is Izzy's
 * Option A: that changing a rate TODAY does not change what a month already
 * calculated says. A mirror would pass a naive "did it sync" test and fail
 * this one silently, which is exactly the failure being guarded against.
 *
 * Scratch record only, removed in the `finally`. Never a client record.
 *
 * Run: node --env-file=.env scripts/verify-residuals-rate-sync.mjs
 */
import pg from 'pg';

const db = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});

const pass = [];
const fail = [];
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  (ok ? pass : fail).push(label);
  console.log(`  ${ok ? 'PASS' : '**FAIL**'}  ${label.padEnd(58)} ${actual}${ok ? '' : `   expected ${expected}`}`);
};

const NAME = 'ZZ_RATE_SYNC';
const MID = '778899001';

await db.connect();
const q = async (s, p) => (await db.query(s, p)).rows;

async function cleanup() {
  await db.query(`delete from residual_merchant_rates where mid = $1`, [MID]);
  await db.query(`delete from records where deal_name like $1`, [`${NAME}%`]);
}

try {
  await cleanup();
  const [{ id: actor }] = await q(`select id from profiles where deleted_at is null limit 1`);

  // ── a merchant record with Pricing-tab rates ─────────────────────────────
  const [{ id: recordId }] = await q(
    `insert into records (deal_name, values, creator_kind, creator_user_id)
     values ($1, jsonb_build_object(
        'deal_name', $1::text, 'mid', $2::text,
        'pricing_risk_level', 'Moderate risk',
        'td_avs_fee', '0.05',
        'td_batch_fee', '0.25',
        'td_chargeback_fee', '25.00'
     ), 'user', $3) returning id`,
    [NAME, MID, actor],
  );

  console.log('\nthe trigger fires on an edit, not on creation:');
  let rates = await q(`select * from residual_merchant_rates where mid = $1`, [MID]);
  check('creating the record alone writes no rate row', rates.length, 0);

  /*
   * The drawer save path is an UPDATE of `values`, which is what the trigger
   * watches — creation is deliberately not a rate event.
   *
   * Note the record was seeded WITHOUT this rate. An earlier version of this
   * test set it to the value it already held, the trigger correctly saw no
   * change, and the test reported a bug that did not exist. Writing the same
   * value is not an edit.
   */
  await db.query(
    `update records set values = jsonb_set(values, '{td_vmd_auth_fee}', '"0.15"') where id = $1`,
    [recordId],
  );
  rates = await q(`select * from residual_merchant_rates where mid = $1 order by effective_from`, [MID]);
  check('editing a rate opens a rate row', rates.length, 1);
  check('  the risk tier resolved from the choice', rates[0]?.risk_tier, 'medium');
  check('  the rate came across', Number(rates[0]?.vmd_auth_fee), 0.15);
  check('  and so did the others', Number(rates[0]?.chargeback_fee), 25);
  check('  it is open-ended', rates[0]?.effective_to, 'null');

  console.log('\nOPTION A — a later change must not rewrite history:');
  // Backdate the row so the next edit lands in a different month, which is
  // what an edit "months later" really is.
  await db.query(
    `update residual_merchant_rates set effective_from = (date_trunc('month', now()) - interval '3 months')::date
      where mid = $1`,
    [MID],
  );
  await db.query(
    `update records set values = jsonb_set(values, '{td_vmd_auth_fee}', '"0.18"') where id = $1`,
    [recordId],
  );

  rates = await q(
    `select effective_from, effective_to, vmd_auth_fee from residual_merchant_rates
      where mid = $1 and deleted_at is null order by effective_from`,
    [MID],
  );
  check('a second dated row was opened, not an overwrite', rates.length, 2);
  check('  the OLD month keeps its original rate', Number(rates[0]?.vmd_auth_fee), 0.15);
  check('  the old row was closed', rates[0]?.effective_to ? 'closed' : 'STILL OPEN', 'closed');
  check('  the new row carries the new rate', Number(rates[1]?.vmd_auth_fee), 0.18);
  check('  and is open-ended', rates[1]?.effective_to, 'null');
  check('  the two do not overlap',
    new Date(rates[0].effective_to).getTime() === new Date(rates[1].effective_from).getTime() ? 'contiguous' : 'OVERLAP',
    'contiguous');

  console.log('\nthe dated lookup reproduces each month:');
  /*
   * `residual_merchant_rates_for_month` is admin-gated and raises for a caller
   * with no role - which a plain `postgres` connection is, since auth.uid() is
   * NULL there. That gate firing is correct behaviour, so these lookups run
   * inside an admin JWT context rather than being exempted from it.
   */
  const [{ id: adminId }] = await q(
    `select p.id from profiles p join roles r on r.id = p.role_id
      where r.is_admin and p.deleted_at is null and p.status = 'active' limit 1`,
  );
  const asAdmin = async (sql, params) => {
    await db.query('begin');
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: adminId, role: 'authenticated' }),
    ]);
    await db.query(`set local role authenticated`);
    const rows = (await db.query(sql, params)).rows;
    await db.query('rollback');
    return rows;
  };

  const old = await asAdmin(
    `select vmd_auth_fee from residual_merchant_rates_for_month($1, (date_trunc('month', now()) - interval '2 months')::date)`,
    [MID],
  );
  const now = await asAdmin(
    `select vmd_auth_fee from residual_merchant_rates_for_month($1, date_trunc('month', now())::date)`,
    [MID],
  );
  check('a past month still resolves to 0.15', Number(old[0]?.vmd_auth_fee), 0.15);
  check('this month resolves to 0.18', Number(now[0]?.vmd_auth_fee), 0.18);

  console.log('\nediting the same month edits in place:');
  const before = (await q(`select count(*)::int n from residual_merchant_rates where mid = $1`, [MID]))[0].n;
  await db.query(
    `update records set values = jsonb_set(values, '{td_vmd_auth_fee}', '"0.19"') where id = $1`,
    [recordId],
  );
  const after = (await q(`select count(*)::int n from residual_merchant_rates where mid = $1`, [MID]))[0].n;
  check('no third row for the same month', after, before);
  check('  the current row took the new value',
    Number((await q(`select vmd_auth_fee from residual_merchant_rates where mid=$1 and effective_to is null`, [MID]))[0].vmd_auth_fee),
    0.19);

  console.log('\nabsence is not zero:');
  await db.query(
    `update records set values = jsonb_set(values, '{td_avs_fee}', '""') where id = $1`,
    [recordId],
  );
  const avs = (await q(`select avs_fee from residual_merchant_rates where mid=$1 and effective_to is null`, [MID]))[0];
  check('a cleared rate becomes NULL, not 0.00', avs.avs_fee === null ? 'NULL' : String(avs.avs_fee), 'NULL');

  console.log('\nedits that are not rates do nothing:');
  const n1 = (await q(`select count(*)::int n from residual_merchant_rates where mid=$1`, [MID]))[0].n;
  await db.query(
    `update records set values = jsonb_set(values, '{deal_name}', '"ZZ_RATE_SYNC_renamed"') where id = $1`,
    [recordId],
  );
  const n2 = (await q(`select count(*)::int n from residual_merchant_rates where mid=$1`, [MID]))[0].n;
  check('renaming the record opens no rate row', n2, n1);

  console.log('\nthe risk-tier mapping:');
  for (const [choice, tier] of [['No risk','no_program'],['Low risk','low'],['Moderate risk','medium'],['High risk','high']]) {
    const [{ residual_tier_from_pricing_choice: got }] =
      await q(`select residual_tier_from_pricing_choice($1)`, [choice]);
    check(`  "${choice}"`, got, tier);
  }
  const [{ residual_tier_from_pricing_choice: junk }] =
    await q(`select residual_tier_from_pricing_choice('something else')`);
  check('  an unknown choice returns NULL, never a guessed tier', junk === null ? 'NULL' : junk, 'NULL');
} finally {
  await cleanup();
  console.log(`\ncleaned up. ${pass.length} passed, ${fail.length} failed`);
  await db.end();
}

process.exit(fail.length ? 1 : 0);
