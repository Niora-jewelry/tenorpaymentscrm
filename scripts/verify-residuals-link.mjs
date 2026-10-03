/**
 * The residuals link layer: the kernel, the six operator entry points, and
 * the gate between them.
 *
 * The design being tested is specific. `residual_resolve_mid` and
 * `residual_reconcile_mid_links` are UNGATED and reachable by no client role,
 * because they must run from the relink trigger under a service-role
 * connection where auth.uid() is NULL. The six entry points carry the admin
 * check instead. If the kernels were reachable, the whole arrangement would be
 * an unauthenticated write endpoint — which is precisely what Daniel measured
 * happening on his side behind a revoke-from-PUBLIC alone.
 *
 * Scratch period, lines and records only; all removed in the `finally`.
 *
 * Run: node --env-file=.env scripts/verify-residuals-link.mjs
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
  console.log(`  ${ok ? 'PASS' : '**FAIL**'}  ${label.padEnd(56)} ${actual}${ok ? '' : `   expected ${expected}`}`);
};

const TAG = 'ZZ_LINK';
const MID_MATCH = '660000000111';   // will exist on a record
const MID_ORPHAN = '660000000222';  // will match nothing

await db.connect();
const q = async (s, p) => (await db.query(s, p)).rows;

async function cleanup() {
  await db.query(`delete from residual_lines where mid = any($1)`, [[MID_MATCH, MID_ORPHAN]]);
  await db.query(`delete from residual_periods where statement_month = date '2031-01-01'`);
  await db.query(`delete from records where deal_name like $1`, [`${TAG}%`]);
}

/**
 * Run as a real signed-in user, so the gates are exercised rather than
 * bypassed.
 *
 * ROLLS BACK. That is right for reads and for checking that a call is refused,
 * and WRONG for anything whose effect is then asserted — an earlier version of
 * this file linked three rows, rolled the link back, and reported a bug in the
 * function that had worked perfectly. `asUserCommitting` is for writes.
 */
async function asUser(userId, sql, params) {
  await db.query('begin');
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: userId, role: 'authenticated' }),
  ]);
  await db.query(`set local role authenticated`);
  try {
    const rows = (await db.query(sql, params)).rows;
    await db.query('rollback');
    return { ok: true, rows };
  } catch (e) {
    await db.query('rollback');
    return { ok: false, message: e.message };
  }
}

/** The same, but the work survives. For calls whose effect is asserted after. */
async function asUserCommitting(userId, sql, params) {
  await db.query('begin');
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: userId, role: 'authenticated' }),
  ]);
  await db.query(`set local role authenticated`);
  try {
    const rows = (await db.query(sql, params)).rows;
    await db.query('commit');
    return { ok: true, rows };
  } catch (e) {
    await db.query('rollback');
    return { ok: false, message: e.message };
  }
}

try {
  await cleanup();

  const [{ id: admin }] = await q(
    `select p.id from profiles p join roles r on r.id = p.role_id
      where r.is_admin and p.deleted_at is null and p.status = 'active' limit 1`,
  );
  const member = (
    await q(`select p.id from profiles p join roles r on r.id = p.role_id
              where not r.is_admin and p.deleted_at is null limit 1`)
  )[0]?.id;

  // ── fixtures ────────────────────────────────────────────────────────────
  const [{ id: merchantId }] = await q(
    `insert into records (deal_name, values, creator_kind, creator_user_id)
     values ($1, jsonb_build_object('deal_name',$1::text,'mid',$2::text), 'user', $3)
     returning id`,
    [`${TAG}_Merchant`, MID_MATCH, admin],
  );
  /* A month far enough out that it cannot collide with a real period. The
     table is keyed by statement_month and has no label column. */
  const [{ id: periodId }] = await q(
    `insert into residual_periods (statement_month, status)
     values (date '2031-01-01', 'open') returning id`,
  );
  for (const [mid, n] of [[MID_MATCH, 2], [MID_ORPHAN, 3]]) {
    for (let i = 0; i < n; i += 1) {
      /* `source` defaults to 'excel', and residual_lines_provenance_consistent
         requires an import_id whenever it is not 'manual'. A fixture line has
         no import, so it is manual — which is what a hand-entered line is. */
      await db.query(
        `insert into residual_lines (period_id, mid, fee_item_name, source) values ($1, $2, $3, 'manual')`,
        [periodId, mid, `${TAG} item ${i}`],
      );
    }
  }

  // ── the kernel ──────────────────────────────────────────────────────────
  console.log('\nthe resolver:');
  check('a MID on a record resolves exact',
    (await q(`select match_kind from residual_resolve_mid($1)`, [MID_MATCH]))[0].match_kind, 'exact');
  check('a MID on no record is unmatched',
    (await q(`select match_kind from residual_resolve_mid($1)`, [MID_ORPHAN]))[0].match_kind, 'unmatched');

  console.log('\nre-adjudication writes the verdict onto the rows:');
  await q(`select residual_reconcile_mid_links($1)`, [MID_MATCH]);
  const linked = await q(
    `select record_id, thread_match from residual_lines where mid = $1 and deleted_at is null`, [MID_MATCH]);
  check('both lines got the link', linked.filter((r) => r.record_id).length, 2);
  check('  with the right verdict', linked[0].thread_match, 'exact');

  // ── the gate ────────────────────────────────────────────────────────────
  console.log('\nthe gate — a non-admin must be TOLD no, not shown nothing:');
  if (member) {
    const r = await asUser(member, `select * from residual_link_worklist(null)`);
    check('worklist refuses a member', r.ok ? 'ALLOWED' : 'refused', 'refused');
    check('  and says why', /not authorized/i.test(r.message ?? '') ? 'explains' : 'silent', 'explains');
    const l = await asUser(member, `select residual_link_mid_to_record($1,$2,null)`, [MID_ORPHAN, merchantId]);
    check('linking refuses a member', l.ok ? 'ALLOWED' : 'refused', 'refused');
  } else {
    console.log('  (no non-admin profile to test with — skipped)');
  }

  console.log('\nthe kernels are unreachable from a client:');
  for (const [label, sql] of [
    ['residual_resolve_mid', `select * from residual_resolve_mid('1')`],
    ['residual_reconcile_mid_links', `select residual_reconcile_mid_links(null)`],
  ]) {
    const r = await asUser(admin, sql);
    check(`  ${label} denied even to an admin`, r.ok ? 'REACHABLE' : 'denied', 'denied');
  }

  // ── the six, as an admin ────────────────────────────────────────────────
  console.log('\nthe operator surface:');
  const w = await asUser(admin, `select * from residual_link_worklist($1)`, [periodId]);
  check('worklist runs for an admin', w.ok ? 'ok' : w.message, 'ok');
  const orphan = (w.rows ?? []).find((r) => r.mid === MID_ORPHAN);
  check('  the unlinked MID is listed', orphan ? 'listed' : 'MISSING', 'listed');
  check('  with its row count', orphan?.line_rows, 3);
  check('  and its verdict', orphan?.match_kind, 'unmatched');
  check('  the linked MID is NOT in the worklist',
    (w.rows ?? []).some((r) => r.mid === MID_MATCH) ? 'listed' : 'absent', 'absent');

  const p = await asUser(admin, `select residual_preview_mid_link($1,$2) j`, [MID_ORPHAN, periodId]);
  check('preview counts what it would touch', p.rows?.[0]?.j?.lines, 3);
  check('  and changes nothing',
    (await q(`select count(*)::int n from residual_lines where mid=$1 and record_id is not null`, [MID_ORPHAN]))[0].n, 0);

  const lk = await asUserCommitting(admin, `select residual_link_mid_to_record($1,$2,$3) j`, [MID_ORPHAN, merchantId, periodId]);
  check('a manual link writes all three tables', lk.rows?.[0]?.j?.lines_linked, 3);
  const man = await q(`select thread_match, thread_confirmed_by_id from residual_lines where mid=$1 limit 1`, [MID_ORPHAN]);
  check("  it is marked 'manual'", man[0].thread_match, 'manual');
  check('  and names who did it', man[0].thread_confirmed_by_id === admin ? 'actor recorded' : 'MISSING', 'actor recorded');

  console.log('\na sweep must not overturn a human:');
  await asUserCommitting(admin, `select residual_sweep_mid_links()`);
  const after = await q(`select thread_match, record_id from residual_lines where mid=$1 limit 1`, [MID_ORPHAN]);
  check("the manual link survived the sweep", after[0].thread_match, 'manual');
  check('  and still points at the record', after[0].record_id === merchantId ? 'intact' : 'LOST', 'intact');

  console.log('\nconfirm and unlink:');
  const c = await asUserCommitting(admin, `select residual_confirm_mid_link($1,$2) j`, [MID_MATCH, periodId]);
  check('confirming stamps the rows', c.rows?.[0]?.j?.rows_confirmed, 2);
  check("  without changing how it was found",
    (await q(`select thread_match from residual_lines where mid=$1 limit 1`, [MID_MATCH]))[0].thread_match, 'exact');

  const u = await asUserCommitting(admin, `select residual_unlink_mid($1,$2) j`, [MID_ORPHAN, periodId]);
  check('unlinking clears the rows', u.rows?.[0]?.j?.rows_unlinked, 3);
  const cleared = await q(
    `select record_id, thread_match, thread_matched_at, thread_confirmed_by_id
       from residual_lines where mid=$1 limit 1`, [MID_ORPHAN]);
  check('  all four columns cleared together',
    [cleared[0].record_id, cleared[0].thread_match, cleared[0].thread_matched_at, cleared[0].thread_confirmed_by_id]
      .every((v) => v === null) ? 'consistent' : 'PARTIAL', 'consistent');
} finally {
  await cleanup();
  console.log(`\ncleaned up. ${pass.length} passed, ${fail.length} failed`);
  await db.end();
}

process.exit(fail.length ? 1 : 0);
