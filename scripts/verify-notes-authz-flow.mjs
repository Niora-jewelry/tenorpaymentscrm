/**
 * One-off verification for the notes authorization fix (migration 29) —
 * edit/delete used to be a raw `.update()` against `notes`, with nothing
 * stopping any teammate who could see the record from editing or deleting
 * someone else's note. Simulated as `authenticated` with RLS on, wrapped in
 * BEGIN/ROLLBACK.
 *
 * The true negative case ("a DIFFERENT non-admin user is rejected") needs a
 * second real, non-admin profile, which this database doesn't have (single
 * seeded Super Admin) — noted, not faked. What IS verified directly: the
 * underlying vulnerability class (an arbitrary raw UPDATE/DELETE against the
 * table, bypassing any author check entirely) is now categorically
 * impossible regardless of the function's own logic, because the table
 * grant itself is gone.
 *
 * Usage:
 *   SUPABASE_DB_URL="postgresql://..." node scripts/verify-notes-authz-flow.mjs
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
    const recordId = rec.id;

    /*
     * `notes.scope_id` holds the tab's UUID, not its key.
     *
     * This script passed the literal string 'updates' and had been failing on
     * it: note_scope_tab_key('tab', 'updates') resolves no tab, so
     * record_tab_grant() is asked about a tab that does not exist, does not
     * come back 'edit', and notes_insert refuses the row with 42501 — which is
     * the policy working. The row really is malformed.
     *
     * Measured both ways against Joe's Pizza as a super_admin: the literal
     * 'updates' is refused and the tab's UUID inserts. So the lookup is the
     * fix, not a change to the policy.
     */
    const { rows: [updatesTab] } = await client.query(
      `select id from tabs where key = 'updates' limit 1`,
    );
    ok('found the Updates tab to scope the note to', Boolean(updatesTab));
    const updatesTabId = updatesTab.id;

    // 1. A raw UPDATE against notes is now flatly impossible (the actual
    //    vulnerability: this used to succeed for ANY teammate).
    const { rows: [note] } = await client.query(
      `insert into notes (record_id, scope_kind, scope_id, author_id, body)
       values ($1, 'tab', $3, $2, 'original') returning id`,
      [recordId, userId, updatesTabId],
    );
    let rawUpdateBlocked = false;
    await client.query('savepoint before_raw_update');
    try {
      await client.query(`update notes set body = 'hacked' where id = $1`, [note.id]);
    } catch (e) {
      rawUpdateBlocked = /permission denied/i.test(e.message);
      await client.query('rollback to savepoint before_raw_update');
    }
    ok('a raw UPDATE against notes is rejected at the grant level (the actual bug this closes)', rawUpdateBlocked);

    let rawDeleteBlocked = false;
    await client.query('savepoint before_raw_delete');
    try {
      await client.query(`delete from notes where id = $1`, [note.id]);
    } catch (e) {
      rawDeleteBlocked = /permission denied/i.test(e.message);
      await client.query('rollback to savepoint before_raw_delete');
    }
    ok('a raw DELETE against notes is rejected at the grant level', rawDeleteBlocked);

    // 2. edit_note/delete_note happy path — author editing their own note.
    await client.query(`select edit_note($1, 'edited by author')`, [note.id]);
    const { rows: [afterEdit] } = await client.query(`select body, edited_at from notes where id = $1`, [note.id]);
    ok('edit_note updated the body and stamped edited_at (author == self)', afterEdit.body === 'edited by author' && afterEdit.edited_at !== null, JSON.stringify(afterEdit));

    await client.query(`select delete_note($1)`, [note.id]);
    const { rows: liveAfterDelete } = await client.query(`select id from notes where id = $1 and deleted_at is null`, [note.id]);
    ok('delete_note soft-deleted it (author == self)', liveAfterDelete.length === 0);

    // 3. edit_note/delete_note reject an unknown note id (not found, not a
    //    silent no-op).
    let notFoundRejected = false;
    await client.query('savepoint before_missing');
    try {
      await client.query(`select edit_note('00000000-0000-0000-0000-000000000000', 'x')`);
    } catch (e) {
      notFoundRejected = /not found/i.test(e.message);
      await client.query('rollback to savepoint before_missing');
    }
    ok('edit_note on a nonexistent note raises "not found"', notFoundRejected);

    console.log(`\n${pass} passed, ${fail} failed.`);
    console.log('(skipped: a different non-admin author being rejected — no second non-admin profile in this DB)');
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
