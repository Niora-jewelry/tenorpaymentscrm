/**
 * One-off verification for the Files tab (application rows, other rows,
 * record_file_upload, delete_file) — simulated as the `authenticated` role
 * with RLS on, wrapped in BEGIN/ROLLBACK so nothing persists.
 *
 * Usage:
 *   SUPABASE_DB_URL="postgresql://..." node scripts/verify-files-flow.mjs
 */
import pg from 'pg';

const url = process.env.SUPABASE_DB_URL;
if (!url) {
  console.error('Set SUPABASE_DB_URL first.');
  process.exit(1);
}

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
    ok('found a super_admin profile to act as', Boolean(user), JSON.stringify(user));
    const userId = user.id;

    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ]);
    await client.query(`set local role authenticated`);

    const { rows: [rec] } = await client.query(
      `select id from records where deal_name = 'Joe''s Pizza' limit 1`,
    );
    ok('found seeded record Joe\'s Pizza', Boolean(rec), JSON.stringify(rec));
    const recordId = rec.id;

    // 1. ensureApplicationRows equivalent — insert the 5 locked rows if absent.
    const APPLICATION_ROWS = ['Owner ID', 'Bank statements', 'Processing statements', 'Corp docs', 'Voided check'];
    const { rows: existingRows } = await client.query(
      `select name from file_rows where record_id = $1 and kind = 'application' and deleted_at is null`,
      [recordId],
    );
    const have = new Set(existingRows.map((r) => r.name));
    const missing = APPLICATION_ROWS.filter((n) => !have.has(n));
    if (missing.length) {
      const values = missing.map((name, i) => `($1, 'application', $${i + 2}, true, ${APPLICATION_ROWS.indexOf(name) * 10 + i})`).join(',');
      await client.query(
        `insert into file_rows (record_id, kind, name, locked, position) values ${values}`,
        [recordId, ...missing],
      );
    }
    const { rows: appRows } = await client.query(
      `select id, name from file_rows where record_id = $1 and kind = 'application' and deleted_at is null order by position`,
      [recordId],
    );
    ok('5 application rows present after ensure', appRows.length === 5, `got ${appRows.length}`);

    // 2. Add an "other" row (as a real user would via addOtherFileRowAction).
    const { rows: [otherRow] } = await client.query(
      `insert into file_rows (record_id, kind, name, locked) values ($1, 'other', 'Test row', false) returning id, name`,
      [recordId],
    );
    ok('inserted an other-kind file row', Boolean(otherRow), JSON.stringify(otherRow));

    // 3. record_file_upload on the first application row.
    const targetRow = appRows[0];
    /*
     * The row's starting contents, because this script runs against a live
     * database and that row is not empty — Joe's Pizza already carries
     * Owner-ID.pdf. Asserting absolute counts made all three file assertions
     * fail on real data while the behaviour under test was perfectly correct.
     *
     * So every count below is a DELTA from this baseline. That is the property
     * worth having anyway: it holds whatever anyone has uploaded before.
     */
    const { rows: filesBefore } = await client.query(
      `select id from files where file_row_id = $1 and deleted_at is null`,
      [targetRow.id],
    );
    const baseline = filesBefore.length;

    const path = `${recordId}/application/${targetRow.id}/${Date.now()}-test.pdf`;
    const { rows: [uploadResult] } = await client.query(
      `select record_file_upload($1, $2, $3, $4) as file_id`,
      [targetRow.id, path, 'test.pdf', 12345],
    );
    ok('record_file_upload returned a file id', Boolean(uploadResult.file_id), JSON.stringify(uploadResult));
    const fileId = uploadResult.file_id;

    const { rows: filesAfterUpload } = await client.query(
      `select id, name, size_bytes, version from files where file_row_id = $1 and deleted_at is null`,
      [targetRow.id],
    );
    const uploaded = filesAfterUpload.find((f) => f.id === fileId);
    ok(
      'the upload added exactly one file, at version 1',
      filesAfterUpload.length === baseline + 1 && uploaded?.version === 1,
      JSON.stringify({ baseline, now: filesAfterUpload.length, uploaded }),
    );

    // 4. Upload a second file to the same row — version should bump if same
    //    name, or just be a second entry with version 1 if a different name
    //    (matches "replacement keeps the prior version" — different name is a
    //    distinct file, not a replacement).
    const path2 = `${recordId}/application/${targetRow.id}/${Date.now()}-test2.pdf`;
    await client.query(
      `select record_file_upload($1, $2, $3, $4) as file_id`,
      [targetRow.id, path2, 'test2.pdf', 999],
    );
    const { rows: filesAfterSecond } = await client.query(
      `select id, name from files where file_row_id = $1 and deleted_at is null`,
      [targetRow.id],
    );
    ok(
      'a second, differently-named upload is a distinct file rather than a replacement',
      filesAfterSecond.length === baseline + 2,
      JSON.stringify({ baseline, now: filesAfterSecond.length, files: filesAfterSecond }),
    );

    // 5. Activity log entry got written for the upload.
    const { rows: activity } = await client.query(
      `select kind, summary from record_activity where record_id = $1 and kind::text ilike '%file%' order by at desc limit 5`,
      [recordId],
    );
    ok('file upload wrote an activity entry', activity.length > 0, JSON.stringify(activity));

    // 6. delete_file soft-deletes.
    await client.query(`select delete_file($1)`, [fileId]);
    const { rows: filesAfterDelete } = await client.query(
      `select id from files where id = $1 and deleted_at is null`,
      [fileId],
    );
    ok('deleted file no longer shows in the live set', filesAfterDelete.length === 0, JSON.stringify(filesAfterDelete));
    const { rows: filesStillThere } = await client.query(
      `select id from files where file_row_id = $1 and deleted_at is null`,
      [targetRow.id],
    );
    ok(
      'deleting one file leaves every other file on the row alone',
      filesStillThere.length === baseline + 1 && !filesStillThere.some((f) => f.id === fileId),
      JSON.stringify({ baseline, now: filesStillThere.length, files: filesStillThere }),
    );

    // 7. A non-admin, non-team-member user should NOT be able to see this
    //    record's file rows at all (RLS check) — reuse a different profile if
    //    one exists with a plain role.
    const { rows: [otherUser] } = await client.query(
      `select p.id from profiles p join roles r on r.id = p.role_id where r.name <> 'Super Admin' limit 1`,
    );
    if (otherUser) {
      await client.query('savepoint before_other_user');
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: otherUser.id, role: 'authenticated' }),
      ]);
      const { rows: visibleToOther } = await client.query(
        `select id from file_rows where record_id = $1`,
        [recordId],
      );
      ok('non-privileged user without visibility sees 0 file rows (RLS)', visibleToOther.length === 0, `got ${visibleToOther.length}`);
      await client.query('rollback to savepoint before_other_user');
    } else {
      console.log('  (skipped RLS-negative check — no non-admin profile in DB)');
    }

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
