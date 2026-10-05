/**
 * One-off verification for the Communication tab's read path — `messages`
 * is read-only from the app (writes only via a provider webhook under the
 * service role), so this checks: the real query works, RLS scopes it to
 * visible records, and the client (authenticated role) genuinely cannot
 * insert into it directly. Simulated as `authenticated` with RLS on,
 * wrapped in BEGIN/ROLLBACK so nothing persists.
 *
 * Usage:
 *   SUPABASE_DB_URL="postgresql://..." node scripts/verify-communication-flow.mjs
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

    // 1. Insert a message directly as postgres (bypassing RLS on purpose —
    //    this simulates what the provider webhook does under service role,
    //    which this test can't invoke through PostgREST, so it goes in via
    //    a superuser-privileged bootstrap step wrapped in its own savepoint).
    await client.query('reset role');
    const { rows: [msg] } = await client.query(
      `insert into messages (record_id, channel, direction, from_identity, to_identity, subject, body, sent_at)
       values ($1, 'email', 'in', 'merchant@example.com', 'sales@tapdash.com', 'Question about statement', 'Body text', now())
       returning id`,
      [recordId],
    );
    ok('bootstrap-inserted a message as postgres (simulates the webhook)', Boolean(msg));

    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ]);
    await client.query(`set local role authenticated`);

    // 2. The real read path (messagesFor) sees it.
    const { rows: readBack } = await client.query(
      `select id, channel, direction, from_identity, subject from messages where record_id = $1 order by sent_at desc`,
      [recordId],
    );
    /*
     * ── PRESENCE, NOT A ROW COUNT ─────────────────────────────────────────
     * This asserted `readBack.length === 1`, which tested the SEED as much as
     * the policy: the record it uses already carries demo messages, so the
     * read returns four and the check failed on correct behaviour.
     *
     * What it means to prove is that the row just inserted as `postgres` comes
     * back to an `authenticated` caller through `messages_select` — that the
     * policy admits it. A total is a fact about fixtures, and tying a security
     * check to one guarantees it breaks the next time anyone adds a demo row.
     */
    ok(
      'authenticated can read the message via messages_select RLS',
      readBack.some((r) => r.id === msg.id),
      JSON.stringify(readBack.map((r) => r.id)),
    );

    // 3. The client (authenticated) cannot write to messages directly — no
    //    insert/update/delete grant, per migration 9's design ("arrives via
    //    a provider webhook under the service role").
    let writeRejected = false;
    await client.query('savepoint before_write_probe');
    try {
      await client.query(
        `insert into messages (record_id, channel, direction, from_identity, to_identity, sent_at)
         values ($1, 'email', 'out', 'a@b.com', 'c@d.com', now())`,
        [recordId],
      );
    } catch (e) {
      writeRejected = /permission denied/i.test(e.message);
      await client.query('rollback to savepoint before_write_probe');
    }
    ok('authenticated cannot insert into messages directly (webhook-only write)', writeRejected);

    /*
     * 4. Which Communication subtabs are still "coming soon".
     *
     * ── THIS ASSERTION WAS WRONG FOR MONTHS ───────────────────────────────
     * It read ['phone', 'recordings', 'teams'], which was true when written
     * and stopped being true the moment migration
     * `20260819007000_phone_subtabs_are_live.sql` cleared the flag on `phone`
     * and `recordings` — the whole point of that migration. The script is not
     * part of `npm test`, so nothing caught it, and it has been reporting a
     * failure against correct data ever since.
     *
     * A check that cries wolf is worse than no check: it trains whoever runs
     * the suite to skim past a red line, which is exactly the line that will
     * matter one day.
     *
     * `teams` alone is correct today: there is no Teams provider and no
     * integration behind it, so the placeholder is honest. When that is built,
     * this expectation becomes `[]` — and it should be changed here rather
     * than widened to "some subset", because the value of this check is that
     * it names the exact set.
     */
    const { rows: comingSoonRows } = await client.query(
      `select s.key, s.coming_soon from subtabs s
       join tabs t on t.id = s.tab_id
       where t.kind = 'communication'
       order by s.position`,
    );
    const flagged = comingSoonRows.filter((r) => r.coming_soon).map((r) => r.key).sort();
    ok(
      'teams alone is coming_soon; phone and recordings went live in migration 70',
      JSON.stringify(flagged) === JSON.stringify(['teams']),
      JSON.stringify(comingSoonRows),
    );

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
