/**
 * One-off verification for the drawer's field drag-to-reorder — the DB
 * table (user_field_order) and its RLS/CRUD were already built, but
 * page.tsx never actually called fieldOrderFor()/resolveOrder() to APPLY a
 * saved order before this pass — the whole read path was silently unwired.
 * This checks the underlying table read/write directly (the resolution
 * function itself, resolveOrder, is pure and exercised by its own unit test
 * once Stage 5 lands). Simulated as `authenticated` with RLS on, wrapped in
 * BEGIN/ROLLBACK.
 *
 * Usage:
 *   SUPABASE_DB_URL="postgresql://..." node scripts/verify-field-order-flow.mjs
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
    const userId = user.id;
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ]);
    await client.query(`set local role authenticated`);

    // Overview tab (no subtab) has several plain fields — a real placement.
    const { rows: [tab] } = await client.query(`select id from tabs where key = 'overview'`);
    ok('found the overview tab', Boolean(tab));

    const { rows: adminFields } = await client.query(
      `select id, key from fields where tab_id = $1 and subtab_id is null and archived_at is null order by position`,
      [tab.id],
    );
    ok('overview tab has at least 3 admin-ordered fields to reorder', adminFields.length >= 3, `got ${adminFields.length}`);
    const adminIds = adminFields.map((f) => f.id);

    // 1. No saved order yet — should read back nothing.
    const { rows: before } = await client.query(
      `select field_id from user_field_order where user_id = $1 and tab_id = $2 and subtab_id is null`,
      [userId, tab.id],
    );
    ok('starts with no saved field order', before.length === 0);

    // 2. Save a reversed order (mirrors reorderFieldsAction → setFieldOrder).
    const reversed = [...adminIds].reverse();
    await client.query(`delete from user_field_order where user_id = $1 and tab_id = $2 and subtab_id is null`, [userId, tab.id]);
    await client.query(
      `insert into user_field_order (user_id, tab_id, subtab_id, field_id, position)
       select $1, $2, null, v.field_id, v.position
       from unnest($3::uuid[]) with ordinality as v(field_id, position)`,
      [userId, tab.id, reversed],
    );

    const { rows: saved } = await client.query(
      `select field_id from user_field_order where user_id = $1 and tab_id = $2 and subtab_id is null order by position`,
      [userId, tab.id],
    );
    ok('saved order reads back exactly as reversed', JSON.stringify(saved.map((r) => r.field_id)) === JSON.stringify(reversed));

    // 3. Global to every module — no module_id column on user_field_order.
    const { rows: cols } = await client.query(
      `select column_name from information_schema.columns where table_name = 'user_field_order'`,
    );
    ok('user_field_order has no module_id column (one order covers every module)', !cols.some((c) => c.column_name === 'module_id'), JSON.stringify(cols.map((c) => c.column_name)));

    // 4. Reset (mirrors resetFieldOrderAction) removes the shadow.
    await client.query(`delete from user_field_order where user_id = $1 and tab_id = $2 and subtab_id is null`, [userId, tab.id]);
    const { rows: afterReset } = await client.query(
      `select field_id from user_field_order where user_id = $1 and tab_id = $2 and subtab_id is null`,
      [userId, tab.id],
    );
    ok('reset removes the saved order entirely', afterReset.length === 0);

    // 5. RLS: a row cannot be inserted for a DIFFERENT user_id (own-rows-only).
    let crossUserBlocked = false;
    await client.query('savepoint before_cross_user');
    try {
      await client.query(
        `insert into user_field_order (user_id, tab_id, subtab_id, field_id, position) values ($1, $2, null, $3, 0)`,
        ['00000000-0000-0000-0000-000000000001', tab.id, adminIds[0]],
      );
    } catch (e) {
      crossUserBlocked = /permission denied|policy|row-level security/i.test(e.message);
      await client.query('rollback to savepoint before_cross_user');
    }
    ok('cannot insert a field-order row for a different user_id (RLS)', crossUserBlocked);

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
