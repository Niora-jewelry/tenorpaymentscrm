/**
 * One-off verification for this pass's collaboration-surface work: real
 * author names (profile_names, migration 28), the notes authorization fix
 * (migration 29, verified separately in verify-notes-authz-flow.mjs), and
 * the new case-solution/manager-gated-state-change path (migration 30).
 * Simulated as `authenticated` with RLS on, wrapped in BEGIN/ROLLBACK.
 *
 * Usage:
 *   SUPABASE_DB_URL="postgresql://..." node scripts/verify-collab-flow.mjs
 */
import pg from 'pg';

const url = process.env.SUPABASE_DB_URL;
if (!url) { console.error('Set SUPABASE_DB_URL first.'); process.exit(1); }

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
let pass = 0, fail = 0;

function ok(label, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok  - ${label}`); }
  else { fail++; console.log(`  FAIL - ${label} ${extra}`); }
}

async function main() {
  await client.connect();
  await client.query('BEGIN');
  try {
    const { rows: [user] } = await client.query(
      `select id, full_name from profiles where role_id in (select id from roles where name = 'Super Admin') limit 1`,
    );
    ok('found a super_admin profile to act as', Boolean(user));
    const userId = user.id;

    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ]);
    await client.query(`set local role authenticated`);

    const { rows: [rec] } = await client.query(
      `select id from records where deal_name = 'Joe''s Pizza' limit 1`,
    );
    const recordId = rec.id;

    // 1. profile_names — returns exactly {id, full_name}, nothing else, for
    //    a real id. The actual bug this closes (a non-admin unable to read a
    //    DIFFERENT teammate's name via plain `profiles` RLS) needs a second
    //    non-admin profile to demonstrate, which this database doesn't have;
    //    what's checked here is that the function itself works and returns
    //    only the narrow shape it promises.
    const { rows: viaFunction } = await client.query(`select * from profile_names($1)`, [[userId]]);
    ok('profile_names returns {id, full_name} for a real id', viaFunction.length === 1 && viaFunction[0].full_name === user.full_name, JSON.stringify(viaFunction));
    ok('profile_names returns exactly two columns (id, full_name) — no email/role/status', Object.keys(viaFunction[0]).sort().join(',') === 'full_name,id');

    // 2. Case lifecycle: create → non-manager blocked from state change and
    //    solution → manager (creator is auto-assigned) succeeds.
    const { rows: [kase] } = await client.query(`select create_case($1, 'Test case', 'Something is wrong', '{}') as id`, [recordId]);
    const caseId = kase.id;
    ok('created a case (creator auto-assigned as manager)', Boolean(caseId));

    const { rows: managers } = await client.query(`select user_id from case_managers where case_id = $1`, [caseId]);
    ok('creator was auto-assigned as a case manager', managers.some((m) => m.user_id === userId), JSON.stringify(managers));

    // 3. set_case_solution — the RPC that didn't exist before this pass.
    await client.query(`select set_case_solution($1, 'Refunded the merchant')`, [caseId]);
    const { rows: [afterSolution] } = await client.query(`select solution, solution_author from cases where id = $1`, [caseId]);
    ok('set_case_solution wrote the solution and stamped the author', afterSolution.solution === 'Refunded the merchant' && afterSolution.solution_author === userId, JSON.stringify(afterSolution));

    // 4. toggle_case_state now requires manager status — our user IS a
    //    manager, so close should succeed (solution is written).
    await client.query(`select toggle_case_state($1, true)`, [caseId]);
    const { rows: [afterClose] } = await client.query(`select state from cases where id = $1`, [caseId]);
    ok('toggle_case_state closed the case (manager + solution present)', afterClose.state === 'closed');

    // 5. toggle_case_state still refuses to close without a solution, on a
    //    fresh case (regression check on the pre-existing constraint).
    const { rows: [kase2] } = await client.query(`select create_case($1, 'No solution yet', 'Still broken', '{}') as id`, [recordId]);
    let closeWithoutSolutionRejected = false;
    await client.query('savepoint before_close_without_solution');
    try {
      await client.query(`select toggle_case_state($1, true)`, [kase2.id]);
    } catch (e) {
      closeWithoutSolutionRejected = /solution/i.test(e.message);
      await client.query('rollback to savepoint before_close_without_solution');
    }
    ok('closing without a solution is still rejected', closeWithoutSolutionRejected);

    console.log(`\n${pass} passed, ${fail} failed.`);
    console.log('(skipped: a non-manager, non-admin being rejected by set_case_solution/toggle_case_state — the only seeded profile is Super Admin, which bypasses the manager check by design)');
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
