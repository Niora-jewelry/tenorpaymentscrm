/**
 * One-off verification for the Statements tab — statement_file_upload/
 * delete_statement_file, simulated as `authenticated` with RLS on, wrapped
 * in BEGIN/ROLLBACK so nothing persists.
 *
 * Usage:
 *   SUPABASE_DB_URL="postgresql://..." node scripts/verify-statements-flow.mjs
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
      `select p.id from profiles p
        join roles r on r.id = p.role_id
       where r.is_admin and p.deleted_at is null and p.status = 'active'
       order by p.email
       limit 1`,
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
    ok('found seeded record Joe\'s Pizza', Boolean(rec));
    const recordId = rec.id;

    const { rows: periodRows } = await client.query(
      `select count(*)::int as n, min(year) as min_year, max(year) as max_year from statement_periods`,
    );
    ok('statement_periods is the global seeded lookup', periodRows[0].n > 0 && periodRows[0].min_year === 2024 && periodRows[0].max_year === 2032, JSON.stringify(periodRows[0]));

    const { rows: [period] } = await client.query(
      `select id, year, month from statement_periods where year = 2026 and month = 6`,
    );
    ok('found the 2026-06 period row', Boolean(period));

    // 1. statement_file_upload — the atomic RPC path.
    const path = `${recordId}/statements/2026-06/${Date.now()}-june-statement.pdf`;
    const { rows: [uploadResult] } = await client.query(
      `select statement_file_upload($1, $2, $3, $4, $5) as file_id`,
      [recordId, period.id, path, 'june-statement.pdf', 54321],
    );
    ok('statement_file_upload returned a file id', Boolean(uploadResult.file_id));
    const fileId = uploadResult.file_id;

    const { rows: filesAfter } = await client.query(
      `select id, name, size_bytes from statement_files where record_id = $1 and period_id = $2 and deleted_at is null`,
      [recordId, period.id],
    );
    ok('file now attached to the 2026-06 period', filesAfter.length === 1 && filesAfter[0].name === 'june-statement.pdf', JSON.stringify(filesAfter));

    // 2. Activity log entry got written atomically with the upload.
    const { rows: activity } = await client.query(
      `select summary from record_activity where record_id = $1 and summary ilike '%statement%' order by at desc limit 3`,
      [recordId],
    );
    ok('upload wrote a record_activity entry mentioning statements', activity.length > 0, JSON.stringify(activity));

    // 3. Uploading against a nonexistent period should fail loudly.
    let badPeriodRejected = false;
    await client.query('savepoint before_bad_period');
    try {
      await client.query(
        `select statement_file_upload($1, $2, $3, $4, $5)`,
        [recordId, '00000000-0000-0000-0000-000000000000', path, 'x.pdf', 100],
      );
    } catch (e) {
      badPeriodRejected = /unknown period/i.test(e.message);
      await client.query('rollback to savepoint before_bad_period');
    }
    ok('upload against an unknown period is rejected', badPeriodRejected);

    // 4. delete_statement_file soft-deletes.
    await client.query(`select delete_statement_file($1)`, [fileId]);
    const { rows: afterDelete } = await client.query(
      `select id from statement_files where id = $1 and deleted_at is null`,
      [fileId],
    );
    ok('deleted statement file no longer shows in the live set', afterDelete.length === 0);

    // 5. statement_periods is admin-writable (this seeded profile is admin) —
    //    the negative (non-admin rejected) case needs a second, non-admin
    //    profile to simulate, which this database doesn't have; skipped, not
    //    faked.
    await client.query('savepoint before_period_write');
    const { rows: [inserted] } = await client.query(
      `insert into statement_periods (year, month) values (2033, 1) returning id`,
    );
    ok('admin can extend statement_periods with a new year', Boolean(inserted));
    await client.query('rollback to savepoint before_period_write');

    console.log(`\n${pass} passed, ${fail} failed.`);
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
