/**
 * Removes rows left behind by the integration test.
 *
 * The test cleans up after itself, but a run that fails partway can leave
 * fragments. Everything it creates uses an @tapdash.test address, so this is a
 * safe targeted sweep — it can never touch a real account.
 *
 * The audit log is deliberately NOT swept: it is append-only, and even the
 * service role cannot delete from it. That is the guarantee working.
 *
 * Usage:
 *   SUPABASE_DB_URL="postgresql://..." node scripts/cleanup-test-data.mjs
 */
import pg from 'pg';

const url = process.env.SUPABASE_DB_URL;
if (!url) {
  console.error('Set SUPABASE_DB_URL first.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

const TEST_PATTERN = '%@tapdash.test';

async function sweep(sql, label, param = TEST_PATTERN) {
  const result = await client.query(sql, [param]);
  console.log(`  ${label.padEnd(20)} ${result.rowCount}`);
}

console.log('\nRemoving integration-test rows (@tapdash.test only):');
await sweep(`delete from otp_challenges where email like $1`, 'otp_challenges');
await sweep(`delete from invites where email like $1`, 'invites');
await sweep(`delete from auth.users where email like $1`, 'auth.users');
await sweep(`delete from profiles where email like $1`, 'profiles');
await sweep(`delete from rate_limit_counters where key like $1`, 'rate_limits', '%@tapdash.test%');

console.log('\n  auth_audit_log        left intact — append-only by design');

const { rows: invites } = await client.query(
  `select i.email, r.slug, i.status
     from invites i join roles r on r.id = i.role_id
    order by i.created_at desc`,
);

console.log('\nRemaining invites:');
if (invites.length === 0) {
  console.log('  (none)');
} else {
  for (const row of invites) {
    console.log(`  ${row.email.padEnd(30)} ${row.slug.padEnd(13)} ${row.status}`);
  }
}

const { rows: profiles } = await client.query(`select count(*)::int as n from profiles`);
console.log(`\nAccounts: ${profiles[0].n}\n`);

await client.end();
