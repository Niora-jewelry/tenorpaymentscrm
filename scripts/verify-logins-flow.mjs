/**
 * One-off verification for the Logins tab — add a login, encrypt/store the
 * password server-side, reveal it back, confirm the audit trail. Simulated
 * as the `authenticated` role with RLS on, wrapped in BEGIN/ROLLBACK so
 * nothing persists. Requires LOGIN_ENC_KEY (same key the app uses).
 *
 * Usage:
 *   SUPABASE_DB_URL="postgresql://..." LOGIN_ENC_KEY="..." node scripts/verify-logins-flow.mjs
 */
import pg from 'pg';

const url = process.env.SUPABASE_DB_URL;
const key = process.env.LOGIN_ENC_KEY;
if (!url) { console.error('Set SUPABASE_DB_URL first.'); process.exit(1); }
if (!key) { console.error('Set LOGIN_ENC_KEY first.'); process.exit(1); }

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
      `select id from profiles where role_id in (select id from roles where name = 'Super Admin') limit 1`,
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

    // 1. Insert a login row (metadata only — mirrors addLogin()).
    const { rows: [login] } = await client.query(
      `insert into logins (record_id, login_type, link, username, note)
       values ($1, 'Gateway', 'https://gateway.example.com', 'merchant_admin', 'Test note')
       returning id`,
      [recordId],
    );
    ok('inserted a login row', Boolean(login));
    const loginId = login.id;

    // 2. Metadata select excludes password_enc/password_key (column revoke).
    let columnRevokeHolds = false;
    await client.query('savepoint before_column_probe');
    try {
      await client.query(`select password_enc from logins where id = $1`, [loginId]);
    } catch (e) {
      columnRevokeHolds = /permission denied/i.test(e.message);
      await client.query('rollback to savepoint before_column_probe');
    }
    ok('authenticated cannot select password_enc directly (column revoke)', columnRevokeHolds);

    // 3. store_login_password (as the real app calls it).
    await client.query(`select store_login_password($1, $2, $3, 'v1')`, [loginId, 'S3cret!Pass', key]);

    let passwordKeyRevoked = false;
    await client.query('savepoint before_key_probe');
    try {
      await client.query(`select password_key from logins where id = $1`, [loginId]);
    } catch (e) {
      passwordKeyRevoked = /permission denied/i.test(e.message);
      await client.query('rollback to savepoint before_key_probe');
    }
    ok('password_key is likewise not selectable by authenticated', passwordKeyRevoked);

    // 4. reveal_password — should decrypt back to the original plaintext.
    const { rows: [revealed] } = await client.query(
      `select reveal_password($1, $2) as pw`,
      [loginId, key],
    );
    ok('reveal_password returns the original plaintext', revealed.pw === 'S3cret!Pass', JSON.stringify(revealed));

    // 5. Wrong key should NOT decrypt to the right value (sanity on the crypto itself).
    let wrongKeyFailed = false;
    await client.query('savepoint before_wrong_key');
    try {
      await client.query(`select reveal_password($1, $2) as pw`, [loginId, 'not-the-real-key']);
    } catch {
      wrongKeyFailed = true;
      await client.query('rollback to savepoint before_wrong_key');
    }
    ok('reveal_password with the wrong key fails (not silently wrong)', wrongKeyFailed);

    // 6. credential_reveals audit row got written for the successful reveal.
    const { rows: revealsLog } = await client.query(
      `select user_id from credential_reveals where login_id = $1 order by at desc limit 1`,
      [loginId],
    );
    ok('reveal wrote a credential_reveals row for this user', revealsLog.length === 1 && revealsLog[0].user_id === userId, JSON.stringify(revealsLog));

    // 7. record_activity also got an entry (migration 13's "now also logged").
    const { rows: activity } = await client.query(
      `select kind, summary from record_activity where record_id = $1 and summary ilike '%password%' order by at desc limit 3`,
      [recordId],
    );
    ok('reveal wrote a record_activity entry', activity.length > 0, JSON.stringify(activity));

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
