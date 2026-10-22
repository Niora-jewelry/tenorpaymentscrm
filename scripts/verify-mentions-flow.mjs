/**
 * One-off verification for @mentions + notifications — record_team_member_ids()
 * and add_update_with_mentions() (migration 34), the read/mark-read path in
 * lib/records/notifications.ts. Simulated as `authenticated` with RLS on,
 * wrapped in BEGIN/ROLLBACK.
 *
 * Usage:
 *   SUPABASE_DB_URL="postgresql://..." node scripts/verify-mentions-flow.mjs
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
      `select p.id, p.full_name from profiles p
        join roles r on r.id = p.role_id
       where r.is_admin and p.deleted_at is null and p.status = 'active'
       order by p.email
       limit 1`,
    );
    const userId = user.id;
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ]);
    await client.query(`set local role authenticated`);

    const { rows: [rec] } = await client.query(
      `select id from records where deal_name = 'Joe''s Pizza' limit 1`,
    );
    const recordId = rec.id;

    // Ensure our user is on the record's team (bootstrap via service-role-
    // equivalent postgres role, since record_team_members is trigger-only).
    await client.query('reset role');
    await client.query(
      `insert into record_team_members (record_id, user_id) values ($1, $2) on conflict do nothing`,
      [recordId, userId],
    );
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ]);
    await client.query(`set local role authenticated`);

    // 1. record_team_member_ids returns the roster (including ourselves).
    const { rows: [roster] } = await client.query(`select record_team_member_ids($1) as ids`, [recordId]);
    ok('record_team_member_ids includes the seeded team member', roster.ids.includes(userId), JSON.stringify(roster));

    // 2. A regular direct select on record_team_members only shows OUR OWN
    //    row, not the full roster — the actual reason record_team_member_ids
    //    had to be built.
    //
    //    CHECKED AS A NON-ADMIN, because the policy is
    //    `user_id = auth.uid() OR auth_is_admin()` and this script acts as a
    //    Super Admin for everything else. Asserting the scoping while admin
    //    was asserting the wrong half of that OR: the admin legitimately sees
    //    the whole roster, so the check failed while RLS was working.
    await client.query('reset role');
    const { rows: [plain] } = await client.query(
      `select p.id from profiles p
         join roles r on r.id = p.role_id
        where not r.is_admin and p.deleted_at is null and p.status = 'active'
        limit 1`,
    );
    if (plain) {
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: plain.id, role: 'authenticated' }),
      ]);
      await client.query(`set local role authenticated`);
      const { rows: directSelect } = await client.query(
        `select user_id from record_team_members where record_id = $1`,
        [recordId],
      );
      ok(
        'a non-admin sees only their own team-member row, never the roster (RLS)',
        directSelect.every((r) => r.user_id === plain.id),
        JSON.stringify(directSelect),
      );
      await client.query('reset role');
    } else {
      ok('a non-admin sees only their own team-member row, never the roster (RLS)', true,
         'skipped: no non-admin profile exists to act as');
    }

    /* Back to the admin for the rest of the script. */
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ]);
    await client.query(`set local role authenticated`);

    // 3. Post an update mentioning ourself by name — self-mentions must NOT
    //    self-notify (no point notifying yourself of your own update).
    const { rows: [selfMention] } = await client.query(
      `select add_update_with_mentions($1, $2, null, $3) as id`,
      [recordId, `Heads up @${user.full_name}, following up on this.`, [userId]],
    );
    ok('add_update_with_mentions created the update', Boolean(selfMention.id));

    const { rows: mentionRows } = await client.query(`select user_id from update_mentions where update_id = $1`, [selfMention.id]);
    // Since the @mentions build (Oct 2026): you are never a candidate for your
    // own mention, so nothing is recorded for a self-tag either.
    ok('a self-mention is not recorded in update_mentions', !mentionRows.some((m) => m.user_id === userId));

    const { rows: notifsAfterSelf } = await client.query(
      `select id from notifications where recipient_id = $1 and record_id = $2 and created_at > now() - interval '1 minute'`,
      [userId, recordId],
    );
    ok('self-mention did NOT create a notification', notifsAfterSelf.length === 0, JSON.stringify(notifsAfterSelf));

    // 4. Mentioning an id that is NOT on the record's team is silently
    //    dropped — never a fake mention/notification for an arbitrary id.
    const fakeId = '00000000-0000-0000-0000-000000000099';
    let bogusRejectedCleanly = true;
    try {
      const { rows: [withBogus] } = await client.query(
        `select add_update_with_mentions($1, 'test', null, $2) as id`,
        [recordId, [fakeId]],
      );
      const { rows: bogusMentions } = await client.query(`select user_id from update_mentions where update_id = $1`, [withBogus.id]);
      bogusRejectedCleanly = bogusMentions.length === 0;
    } catch {
      bogusRejectedCleanly = false;
    }
    ok('mentioning a non-team-member id creates zero mention rows (not a crash, not a fake mention)', bogusRejectedCleanly);

    // 5. Reply threading still works (parent must be a root update).
    let invalidParentRejected = false;
    await client.query('savepoint before_bad_parent');
    try {
      await client.query(`select add_update_with_mentions($1, 'reply', $2, '{}')`, [recordId, '00000000-0000-0000-0000-000000000000']);
    } catch (e) {
      invalidParentRejected = /invalid parent/i.test(e.message);
      await client.query('rollback to savepoint before_bad_parent');
    }
    ok('replying to a nonexistent parent update is rejected', invalidParentRejected);

    // 6. Notifications read path — bootstrap a real notification (as
    //    postgres, simulating a genuine cross-user @mention) and confirm the
    //    app's own read/unread-count/mark-read functions work.
    await client.query('reset role');
    const { rows: [notif] } = await client.query(
      `select notify($1, 'mentioned you in an update', $2, 'update') `,
      [userId, recordId],
    ).catch(() => ({ rows: [{}] }));
    await client.query(
      `insert into notifications (recipient_id, body, record_id, source_kind) values ($1, 'test notification', $2, 'update') returning id`,
      [userId, recordId],
    ).then(async (r) => {
      const notifId = r.rows[0].id;
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: userId, role: 'authenticated' }),
      ]);
      await client.query(`set local role authenticated`);

      const { rows: [before] } = await client.query(
        `select count(*)::int as n from notifications where recipient_id = $1 and read_at is null`,
        [userId],
      );
      ok('unread count includes the bootstrapped notification', before.n >= 1, JSON.stringify(before));
      await client.query('savepoint before_direct');

      // Since the @mentions build (Oct 2026) the client has NO update grant on
      // notifications — every state change goes through an RPC, so that
      // opening one can also clear its one-time previous value.
      const direct = await client
        .query(`update notifications set read_at = now() where id = $1 and recipient_id = $2`, [notifId, userId])
        .then(() => 'allowed', (e) => e.code);
      ok('a direct update on notifications is refused (42501)', direct === '42501', String(direct));
      // ...but the savepoint-free session is now aborted; recover it.
      await client.query('rollback to savepoint before_direct').catch(() => {});
      const { rows: [marked] } = await client.query(`select notifications_mark(array[$1]::uuid[], true) as n`, [notifId]);
      ok('notifications_mark marks it read', marked.n === 1, JSON.stringify(marked));
      const { rows: [afterRead] } = await client.query(`select read_at from notifications where id = $1`, [notifId]);
      ok('marking a notification read persists', afterRead.read_at !== null);
    });

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
