/**
 * The client's three Presets instructions, checked against the live database.
 *
 *   1. "a tab should not be able to be created with no module assigned"
 *   2. "Need ability to edit tab module assignments"
 *   3. "Tab order should be drag/drop"   <- a UI gesture; covered by the
 *      component, but the WRITE it performs is exercised here, because a
 *      perfect drag that saves nothing is still broken.
 *
 * Scratch rows only, prefixed ZZ_, removed at the end.
 *
 * Run: node --env-file=.env scripts/verify-preset-tabs.mjs
 */
import pg from 'pg';

const db = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});

const pass = [];
const fail = [];
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  (ok ? pass : fail).push(label);
  console.log(`  ${ok ? 'PASS' : '**FAIL**'}  ${label.padEnd(58)} ${actual}${ok ? '' : `   expected ${expected}`}`);
};

await db.connect();

const KEY = 'zz_preset_probe';
async function cleanup() {
  await db.query(`delete from module_tab_order where tab_id in (select id from tabs where key = $1)`, [KEY]);
  await db.query(`delete from tabs where key = $1`, [KEY]);
}
await cleanup();

const mods = (await db.query(`select id, slug, label from modules where slug <> 'records' order by position limit 3`)).rows;
if (mods.length < 2) throw new Error('need at least two modules to test with');
console.log(`\nusing modules: ${mods.map((m) => m.slug).join(', ')}\n`);

// ── 1. the rule lives in the schema, so prove it there ──────────────────────
console.log('a tab cannot be created with no module:');
const { createTabSchema } = await import('../src/lib/records/adminSchemas.ts').catch(() => ({}));
if (createTabSchema) {
  check('schema refuses an empty module list', createTabSchema.safeParse({ key: 'x', label: 'X', moduleIds: [] }).success, false);
  check('schema accepts one module', createTabSchema.safeParse({ key: 'x', label: 'X', moduleIds: [mods[0].id] }).success, true);
} else {
  console.log('  (schema not importable from node; covered by adminSchemas.test.ts)');
}

// ── 2. editing assignments: add AND remove ──────────────────────────────────
console.log('\nediting which modules show a tab:');
const maxPos = (await db.query(`select coalesce(max(position), -1) p from tabs`)).rows[0].p;
const tab = (
  await db.query(
    `insert into tabs (key, label, kind, is_system, accepts_fields, position)
     values ($1, 'ZZ Probe', 'custom', false, true, $2) returning id`,
    [KEY, maxPos + 1],
  )
).rows[0];

// start on two modules, exactly as appendToModuleOrder would leave it
for (const m of mods.slice(0, 2)) {
  const next = (
    await db.query(`select coalesce(max(position), -1) + 1 p from module_tab_order where module_id = $1`, [m.id])
  ).rows[0].p;
  await db.query(
    `insert into module_tab_order (module_id, tab_id, position) values ($1, $2, $3)`,
    [m.id, tab.id, next],
  );
}
const on = async () =>
  (await db.query(`select module_id from module_tab_order where tab_id = $1`, [tab.id])).rows.map((r) => r.module_id);

check('starts on two modules', (await on()).length, 2);

// remove the first — this is what the old UI could not do at all
await db.query(`delete from module_tab_order where tab_id = $1 and module_id = $2`, [tab.id, mods[0].id]);
const afterRemove = await on();
check('a module can be removed', afterRemove.length, 1);
check('  and it is the right one', afterRemove.includes(mods[1].id), true);

// the tab itself must survive being taken off a module
const stillThere = (await db.query(`select count(*)::int n from tabs where id = $1`, [tab.id])).rows[0].n;
check('removing from a module does not delete the tab', stillThere, 1);

// add a third
if (mods[2]) {
  const next = (
    await db.query(`select coalesce(max(position), -1) + 1 p from module_tab_order where module_id = $1`, [mods[2].id])
  ).rows[0].p;
  await db.query(`insert into module_tab_order (module_id, tab_id, position) values ($1, $2, $3)`, [
    mods[2].id, tab.id, next,
  ]);
  check('a module can be added back', (await on()).length, 2);
}

// ── 3. the write behind the drag ────────────────────────────────────────────
console.log('\nreordering (the write a drag performs):');
const order = async (moduleId) =>
  (
    await db.query(
      `select tab_id from module_tab_order where module_id = $1 order by position`,
      [moduleId],
    )
  ).rows.map((r) => r.tab_id);

const target = mods[1].id;
const before = await order(target);
check('the module has an ordered list', before.length > 1 ? 'yes' : `only ${before.length}`, 'yes');

if (before.length > 1) {
  // move the last to the front, which is what dragging it to the top does
  const moved = [before[before.length - 1], ...before.slice(0, -1)];
  await db.query('begin');
  /*
   * Rewritten as one transaction with a temporary offset. The unique index on
   * (module_id, position) means a straight renumber collides with itself
   * partway through — the classic reorder bug, and the reason this is not a
   * loop of naive updates.
   */
  await db.query(
    `update module_tab_order set position = position + 1000 where module_id = $1`,
    [target],
  );
  for (const [i, id] of moved.entries()) {
    await db.query(
      `update module_tab_order set position = $3 where module_id = $1 and tab_id = $2`,
      [target, id, i],
    );
  }
  await db.query('commit');

  const after = await order(target);
  check('the new order is stored', JSON.stringify(after), JSON.stringify(moved));
  check('  nothing was lost in the move', after.length, before.length);

  // put it back so the client's own configuration is untouched
  await db.query('begin');
  await db.query(`update module_tab_order set position = position + 1000 where module_id = $1`, [target]);
  for (const [i, id] of before.entries()) {
    await db.query(
      `update module_tab_order set position = $3 where module_id = $1 and tab_id = $2`,
      [target, id, i],
    );
  }
  await db.query('commit');
  check('the original order was restored', JSON.stringify(await order(target)), JSON.stringify(before));
}

await cleanup();
console.log(`\ncleaned up. ${pass.length} passed, ${fail.length} failed`);
await db.end();
process.exit(fail.length ? 1 : 0);
