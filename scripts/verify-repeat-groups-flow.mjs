/**
 * One-off verification for repeat-group editing (Owners/Contacts/
 * Affiliates) — the real DB stores each as a JSONB array per `fields` row,
 * and 'owner' specifically spans two locations (`owner_private` holds SSN,
 * `owner_ownership` holds the rest, migration 27's `repeat_group_key`)
 * that must grow/shrink together. Exercises set_record_value directly
 * (what setValueAction/addRepeatInstanceAction ultimately call), simulated
 * as `authenticated` with RLS on, wrapped in BEGIN/ROLLBACK.
 *
 * Usage:
 *   SUPABASE_DB_URL="postgresql://..." node scripts/verify-repeat-groups-flow.mjs
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

// timestamptz columns come back through `pg` as JS Date objects, truncated to
// millisecond precision — round-tripping via toISOString() for the next
// call's CAS comparison would then mismatch Postgres's stored microsecond
// value. Casting to text in SQL keeps the exact string, same as the real app
// gets from PostgREST/supabase-js (never a JS Date in the loop).
async function setValue(client, recordId, fieldKey, value, expectedUpdatedAt) {
  const { rows: [r] } = await client.query(
    `select ok, updated_at::text as updated_at, current_value, changed_by, changed_at::text as changed_at
       from set_record_value($1, $2, $3, $4, $5)`,
    [recordId, fieldKey, JSON.stringify(value), expectedUpdatedAt, `${fieldKey} changed`],
  );
  return r;
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
      `select id, updated_at::text as updated_at from records where deal_name = 'Joe''s Pizza' limit 1`,
    );
    ok('found seeded record Joe\'s Pizza', Boolean(rec));
    const recordId = rec.id;
    let at = rec.updated_at;

    // Sanity: the two owner rows share repeat_group_key = 'owner'.
    const { rows: ownerFields } = await client.query(
      `select key, repeat_group_key, repeat_max, repeat_schema from fields where repeat_group_key = 'owner' order by key`,
    );
    ok('owner_ownership + owner_private both carry repeat_group_key = owner', ownerFields.length === 2, JSON.stringify(ownerFields.map((f) => f.key)));

    // 1. Set owner_ownership to 2 instances (mirrors "Add owner" clicked twice from Ownership).
    let r = await setValue(client, recordId, 'owner_ownership', [
      { first: 'Alice', last: 'Smith', percentage: 60 },
      { first: 'Bob', last: 'Jones', percentage: 40 },
    ], at);
    ok('set owner_ownership to 2 instances', r.ok === true, JSON.stringify(r));
    at = r.updated_at;

    // 2. Pad owner_private (currently 0 or 1 entries) to the SAME length,
    //    with the SSN member only — mirrors addRepeatInstance()'s padding
    //    logic when the sibling arrays start out different lengths.
    const { rows: [row1] } = await client.query(`select values -> 'owner_private' as v from records where id = $1`, [recordId]);
    const privateBefore = row1.v ?? [];
    ok('owner_private starts shorter than owner_ownership (the desync case this exists to fix)', privateBefore.length < 2, JSON.stringify(privateBefore));

    const padded = [...privateBefore, ...Array.from({ length: 2 - privateBefore.length }, () => ({}))];
    r = await setValue(client, recordId, 'owner_private', padded, at);
    ok('padded owner_private to match owner_ownership length', r.ok === true, JSON.stringify(r));
    at = r.updated_at;

    // 3. Set the SSN member on instance 2 of owner_private.
    const { rows: [row2] } = await client.query(`select values -> 'owner_private' as v from records where id = $1`, [recordId]);
    const withSsn = row2.v.map((inst, i) => (i === 1 ? { ...inst, ssn: '123456789' } : inst));
    r = await setValue(client, recordId, 'owner_private', withSsn, at);
    ok('set SSN member on owner_private instance 2', r.ok === true, JSON.stringify(r));
    at = r.updated_at;

    // 4. Both arrays are now length 2 — the sync invariant migration 27 exists for.
    const { rows: [final] } = await client.query(
      `select jsonb_array_length(values -> 'owner_ownership') as ownership_len, jsonb_array_length(values -> 'owner_private') as private_len, values -> 'owner_private' -> 1 -> 'ssn' as ssn2
       from records where id = $1`,
      [recordId],
    );
    ok('owner_ownership and owner_private are the same length after sync', final.ownership_len === final.private_len && final.ownership_len === 2, JSON.stringify(final));
    ok('instance 2 SSN landed only on owner_private, not overwriting ownership data', final.ssn2 === '123456789', JSON.stringify(final));

    // 5. Removing instance 2 from both (mirrors removeRepeatInstance()).
    const { rows: [row3] } = await client.query(`select values -> 'owner_ownership' as v from records where id = $1`, [recordId]);
    r = await setValue(client, recordId, 'owner_ownership', row3.v.slice(0, 1), at);
    ok('removed instance 2 from owner_ownership', r.ok === true, JSON.stringify(r));
    at = r.updated_at;

    r = await setValue(client, recordId, 'owner_private', withSsn.slice(0, 1), at);
    ok('removed instance 2 from owner_private', r.ok === true, JSON.stringify(r));
    at = r.updated_at;

    const { rows: [afterRemove] } = await client.query(
      `select jsonb_array_length(values -> 'owner_ownership') as ownership_len, jsonb_array_length(values -> 'owner_private') as private_len
       from records where id = $1`,
      [recordId],
    );
    ok('both back to length 1 after removal', afterRemove.ownership_len === 1 && afterRemove.private_len === 1, JSON.stringify(afterRemove));

    // 6. A CAS conflict is still correctly rejected on a repeat-group write
    //    (stale expected_updated_at), same guarantee as an ordinary field.
    const stale = new Date(Date.now() - 999_999).toISOString();
    r = await setValue(client, recordId, 'owner_ownership', [{ first: 'X' }], stale);
    ok('stale CAS on a repeat-group write is rejected, not silently applied', r.ok === false, JSON.stringify(r));

    // 7. Activity log recorded the repeat-group writes like any other field.
    const { rows: activity } = await client.query(
      `select field_key from record_activity where record_id = $1 and field_key in ('owner_ownership','owner_private') order by at desc limit 6`,
      [recordId],
    );
    ok('repeat-group writes show up in record_activity', activity.length > 0, JSON.stringify(activity));

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
