/**
 * Presets, modules and permissions — tested the way an attacker would.
 *
 * `verify-grant-matrix.mjs` already proves the RESOLUTION order: an override
 * beats a template, a template beats the default. This goes after the things
 * that script does not touch, and that the specification is most emphatic
 * about:
 *
 *   • a hidden field must be ABSENT from the query, never blanked afterwards
 *     ("UI-level hiding is never the security boundary")
 *   • an unset scope resolves to EDIT, which is the most misread fact in the
 *     whole model
 *   • a grant chain is capped WITHIN a module before the best is taken across
 *     modules — reversing those two grants access that holds in no single one
 *   • admin-only modules, paused accounts, and what a signed-out request sees
 *   • the presets tables are internally consistent, so nothing is configured
 *     into a state that is invisible rather than broken
 *
 * ── SAFETY ───────────────────────────────────────────────────────────────
 * Everything destructive happens to a scratch user and a scratch record,
 * both created here and both removed in the `finally`. No existing user's
 * grants are read-modified-written, and no client record is touched. That
 * rule exists because I have damaged client data in this database before by
 * probing against real rows.
 *
 * Run: node --env-file=.env scripts/verify-permissions-deep.mjs
 */
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const admin = createClient(SUPA, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const db = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});

const pass = [];
const fail = [];
const warn = [];
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  (ok ? pass : fail).push(label);
  console.log(`  ${ok ? 'PASS' : '**FAIL**'}  ${label.padEnd(60)} ${actual}${ok ? '' : `   expected ${expected}`}`);
};
const note = (label, detail) => {
  warn.push(`${label}: ${detail}`);
  console.log(`  NOTE  ${label.padEnd(60)} ${detail}`);
};
const section = (t) => console.log(`\n${t}`);

const EMAIL = 'zz-perm-tester@tapdash.test';
const PASSWORD = 'ZzPerm-2026!deep';
const RECORD_NAME = 'ZZ_PERM_PROBE';

let userId = null;
let recordId = null;

async function cleanup() {
  const { data } = await admin.auth.admin.listUsers();
  const existing = data?.users?.find((u) => u.email === EMAIL);
  if (existing) await admin.auth.admin.deleteUser(existing.id);
  await db.query(`delete from invites where email = $1`, [EMAIL]);
  await db.query(`delete from profiles where email in ($1, 'zz-no-invite@tapdash.test')`, [EMAIL]);
  await db.query(
    `delete from records where deal_name = $1 or coalesce(values->>'deal_name','') = $1`,
    [RECORD_NAME],
  );
}

await db.connect();

try {
  await cleanup();

  // ══════════════════════════════════════════════════════════════════════
  section('PRESETS — is the configuration internally consistent?');
  // ══════════════════════════════════════════════════════════════════════

  const orphanTabs = (
    await db.query(
      `select t.key from tabs t
        where not exists (select 1 from module_tab_order o where o.tab_id = t.id)
        order by t.position`,
    )
  ).rows.map((r) => r.key);
  /*
   * Not a hard failure: the new rule stops such a tab being CREATED, but
   * existing ones predate it and removing a tab from its last module is still
   * allowed on purpose. Reported because a tab on no module is invisible to
   * everyone, which looks like a bug long before anyone suspects configuration.
   */
  if (orphanTabs.length) note('tabs on no module (invisible to everyone)', orphanTabs.join(', '));
  else check('every tab is on at least one module', 'yes', 'yes');

  const dupAssign = (
    await db.query(
      `select count(*)::int n from (
         select module_id, tab_id from module_tab_order group by 1,2 having count(*) > 1
       ) d`,
    )
  ).rows[0].n;
  check('no tab is assigned to the same module twice', dupAssign, 0);

  const dupPos = (
    await db.query(
      `select count(*)::int n from (
         select module_id, position from module_tab_order group by 1,2 having count(*) > 1
       ) d`,
    )
  ).rows[0].n;
  check('no two tabs share a position in one module', dupPos, 0);

  const badFieldTab = (
    await db.query(
      `select count(*)::int n from fields f join tabs t on t.id = f.tab_id
        where t.accepts_fields = false`,
    )
  ).rows[0].n;
  check('no field sits on a tab that refuses fields', badFieldTab, 0);

  const orphanSubtabs = (
    await db.query(`select count(*)::int n from subtabs s left join tabs t on t.id = s.tab_id where t.id is null`)
  ).rows[0].n;
  check('every subtab has a parent tab', orphanSubtabs, 0);

  const unreachableFields = (
    await db.query(
      `select count(*)::int n from fields f join tabs t on t.id = f.tab_id
        where not exists (select 1 from module_tab_order o where o.tab_id = t.id)`,
    )
  ).rows[0].n;
  if (unreachableFields > 0) {
    note('fields on tabs that are on no module', `${unreachableFields} field(s) unreachable`);
  } else {
    check('every field is reachable through some module', 'yes', 'yes');
  }

  section('MODULES');
  const mods = (await db.query(`select id, slug, admin_only from modules order by position`)).rows;
  check('six modules exist', mods.length, 6);
  check('the Records List is admin-only', mods.find((m) => m.slug === 'records')?.admin_only, true);
  const noTabs = [];
  for (const m of mods) {
    const n = (
      await db.query(`select count(*)::int n from module_tab_order where module_id = $1`, [m.id])
    ).rows[0].n;
    if (n === 0) noTabs.push(m.slug);
  }
  check('every module has at least one tab', noTabs.length ? noTabs.join(',') : 'yes', 'yes');

  // ══════════════════════════════════════════════════════════════════════
  section('SETTING UP a scratch user and a scratch record');
  // ══════════════════════════════════════════════════════════════════════

  /*
   * A pending invite has to exist first. `complete_signup` raises
   * INVITE_NOT_VALID without one - the invite-only rule is enforced in the
   * DATABASE, not merely in the signup screen, which is worth stating as a
   * result rather than working around silently.
   */
  const inviter = (await db.query(`select id from profiles where deleted_at is null limit 1`)).rows[0];
  const memberRole = (await db.query(`select id from roles where is_admin = false limit 1`)).rows[0];
  await db.query(
    `insert into invites (email, invited_by, role_id, status, expires_at)
     values ($1, $2, $3, 'pending', now() + interval '1 day')`,
    [EMAIL, inviter.id, memberRole.id],
  );

  let signupRefusedWithoutInvite = 'not tested';
  try {
    await db.query(`select complete_signup($1::uuid, $2::citext, $3)`, [
      '00000000-0000-4000-8000-0000000000ff', 'zz-no-invite@tapdash.test', 'No Invite',
    ]);
    signupRefusedWithoutInvite = 'ALLOWED';
  } catch (e) {
    signupRefusedWithoutInvite = e.message === 'INVITE_NOT_VALID' ? 'refused' : `refused (${e.message})`;
  }
  check('signup is refused without a pending invite', signupRefusedWithoutInvite, 'refused');

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
  });
  if (createErr) throw new Error(`could not create the scratch user: ${createErr.message}`);
  userId = created.user.id;
  await db.query(`select complete_signup($1::uuid, $2::citext, $3)`, [userId, EMAIL, 'ZZ Perm Tester']);
  check('scratch user exists and is a member (not admin)',
    (await db.query(`select r.is_admin from profiles p join roles r on r.id = p.role_id where p.id = $1`, [userId])).rows[0].is_admin,
    false);

  const leads = mods.find((m) => m.slug === 'leads');
  const deals = mods.find((m) => m.slug === 'deals');

  // A record of our own, on two modules, with the scratch user on its team.
  const rec = (
    await db.query(
      /* `deal_name` exists BOTH as a column and inside `values`. The column is
         NOT NULL and the JSON is what the drawer reads, so a row needs both -
         writing only one is how a record ends up half-created. */
      /* `creator_matches_kind` requires creator_user_id when creator_kind is
         'user' (the default). A record with neither is rejected outright - the
         provenance of every record is a database-level guarantee, not a
         convention. */
      `insert into records (deal_name, values, creator_kind, creator_user_id)
       values ($1, jsonb_build_object('deal_name', $1::text, 'mid', 'ZZ-MID-123'), 'user', $2)
       returning id`,
      [RECORD_NAME, inviter.id],
    )
  ).rows[0];
  recordId = rec.id;
  for (const m of [leads, deals]) {
    await db.query(`insert into record_modules (record_id, module_id) values ($1, $2)`, [recordId, m.id]);
  }
  // Team membership is rebuilt from values.team_members_assigned by a trigger,
  // so writing record_team_members directly would be wiped on the next value
  // change. Learned the hard way.
  await db.query(
    `update records set values = jsonb_set(values, '{team_members_assigned}', to_jsonb(array[$2::text]), true)
      where id = $1`,
    [recordId, userId],
  );
  check('scratch user is on the record team',
    (await db.query(`select count(*)::int n from record_team_members where record_id=$1 and user_id=$2`, [recordId, userId])).rows[0].n,
    1);

  // A signed-in client for the scratch user.
  const session = await (
    await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: ANON, 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    })
  ).json();
  if (!session.access_token) throw new Error('the scratch user could not sign in');
  const asUser = createClient(SUPA, ANON, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { authorization: `Bearer ${session.access_token}` } },
  });
  const rpc = async (fn, args) => {
    const { data, error } = await asUser.rpc(fn, args);
    return error ? `ERROR ${error.message}` : data;
  };

  // ══════════════════════════════════════════════════════════════════════
  section('THE DEFAULT — an unset scope is EDIT, not hidden');
  // ══════════════════════════════════════════════════════════════════════
  /*
   * The single most misread fact in the model, and the reason the invite flow
   * had to apply permissions in the same transaction as the profile: a user
   * with nothing configured can edit everything, not nothing.
   */
  check('an unconfigured tab resolves to edit', await rpc('record_tab_grant', { rec: recordId, p_tab_key: 'overview' }), 'edit');
  check('an unconfigured field resolves to edit', await rpc('record_field_grant', { rec: recordId, p_field_key: 'mid' }), 'edit');

  // ══════════════════════════════════════════════════════════════════════
  section('HIDING — a hidden scope really is hidden');
  // ══════════════════════════════════════════════════════════════════════
  const tabRow = (await db.query(`select id from tabs where key = 'overview'`)).rows[0];
  const fieldRow = (await db.query(`select id from fields where key = 'mid'`)).rows[0];

  await db.query(
    `insert into user_grants (user_id, scope_kind, scope_id, grant_level, module_id)
     values ($1, 'field', $2, 'hidden', null)`,
    [userId, fieldRow.id],
  );
  check('a hidden field override is obeyed', await rpc('record_field_grant', { rec: recordId, p_field_key: 'mid' }), 'hidden');

  await db.query(
    `insert into user_grants (user_id, scope_kind, scope_id, grant_level, module_id)
     values ($1, 'tab', $2, 'hidden', null)`,
    [userId, tabRow.id],
  );
  check('a hidden tab override is obeyed', await rpc('record_tab_grant', { rec: recordId, p_tab_key: 'overview' }), 'hidden');

  // ══════════════════════════════════════════════════════════════════════
  section('CAP WITHIN A MODULE, THEN BEST ACROSS — the ordering that matters');
  // ══════════════════════════════════════════════════════════════════════
  /*
   * The record is on Leads AND Deals. Hide the tab in Leads only. The correct
   * answer is the BEST result across modules, where each module's answer was
   * first capped by that module's own chain — so Deals still allows it.
   *
   * Reversing those two steps (best tab grant across modules, then cap) can
   * produce access that holds in NO single module, which is the bug this
   * ordering exists to prevent.
   */
  await db.query(`delete from user_grants where user_id = $1 and scope_kind = 'tab'`, [userId]);
  await db.query(
    `insert into user_grants (user_id, scope_kind, scope_id, grant_level, module_id)
     values ($1, 'tab', $2, 'hidden', $3)`,
    [userId, tabRow.id, leads.id],
  );
  check('hidden in Leads only still allows it via Deals',
    await rpc('record_tab_grant', { rec: recordId, p_tab_key: 'overview' }), 'edit');

  await db.query(
    `insert into user_grants (user_id, scope_kind, scope_id, grant_level, module_id)
     values ($1, 'tab', $2, 'hidden', $3)`,
    [userId, tabRow.id, deals.id],
  );
  check('hidden in BOTH modules hides it outright',
    await rpc('record_tab_grant', { rec: recordId, p_tab_key: 'overview' }), 'hidden');

  /* A module set to view must cap an edit-level tab inside it. */
  await db.query(`delete from user_grants where user_id = $1 and scope_kind = 'tab'`, [userId]);
  await db.query(`delete from user_grants where user_id = $1 and scope_kind = 'module'`, [userId]);
  await db.query(
    `insert into user_grants (user_id, scope_kind, scope_id, grant_level, module_id)
     values ($1, 'module', $2, 'view', null), ($1, 'module', $3, 'view', null)`,
    [userId, leads.id, deals.id],
  );
  check('a view-only module caps its tabs to view',
    await rpc('record_tab_grant', { rec: recordId, p_tab_key: 'overview' }), 'view');

  // ══════════════════════════════════════════════════════════════════════
  section('THE SECURITY BOUNDARY — hidden data must be ABSENT, not blank');
  // ══════════════════════════════════════════════════════════════════════
  await db.query(`delete from user_grants where user_id = $1`, [userId]);
  await db.query(
    `insert into user_grants (user_id, scope_kind, scope_id, grant_level, module_id)
     values ($1, 'field', $2, 'hidden', null)`,
    [userId, fieldRow.id],
  );

  /*
   * ── A CORRECTION TO AN EARLIER VERSION OF THIS TEST ──────────────────
   * This first read the column directly - `.select('id, values')` - and
   * concluded the value was hidden because it did not come back. That was a
   * FALSE PASS. `values` is revoked from `authenticated` outright (migrations
   * 75 and 76), so the select is denied at the grant level and returns
   * nothing whatever the grants say. It would have reported success even if
   * field-level hiding did nothing at all.
   *
   * The app reads values through `record_values_for()`, a definer function
   * that strips them per the caller's grants, so that is what must be tested.
   */
  const rawSelect = await asUser.from('records').select('id, values').eq('id', recordId);
  check('the values column itself is not selectable by a member',
    rawSelect.error ? 'denied' : 'READABLE', 'denied');

  const visible = await rpc('record_values_for', { p_ids: [recordId] });
  const payload = JSON.stringify(visible ?? []);

  /*
   * The control matters as much as the assertion. An earlier end-to-end test
   * in this project "passed" because the user could see NOTHING at all, which
   * made "the hidden field is absent" trivially true. So a VISIBLE field must
   * be present in the same payload the hidden one is missing from.
   */
  check('the record is readable through the real path',
    payload.includes('ZZ_PERM_PROBE') ? 'yes' : 'NOT READABLE', 'yes');
  check("a hidden field's value does not reach the client",
    payload.includes('ZZ-MID-123') ? 'LEAKED' : 'absent', 'absent');
  check('  the key is absent, not blanked',
    /"mid"\s*:/.test(payload) ? 'KEY PRESENT' : 'absent', 'absent');

  /* Remove the override and the same field must come back - otherwise the
     absence above proves nothing about grants. */
  await db.query(`delete from user_grants where user_id = $1 and scope_kind = 'field'`, [userId]);
  const unhidden = JSON.stringify((await rpc('record_values_for', { p_ids: [recordId] })) ?? []);
  check('without the override the field returns',
    unhidden.includes('ZZ-MID-123') ? 'present' : 'STILL HIDDEN', 'present');

  // ══════════════════════════════════════════════════════════════════════
  section('ISOLATION — what this user must NOT reach');
  // ══════════════════════════════════════════════════════════════════════
  const otherRecords = await asUser.from('records').select('id').neq('id', recordId).limit(5);
  check('cannot read records they are not on',
    (otherRecords.data ?? []).length === 0 ? 'none' : `${otherRecords.data.length} VISIBLE`, 'none');

  /*
   * Reading the `modules` row is NOT the boundary, and asserting that it was
   * would have been testing the wrong thing. `modules_select` is `true` by
   * design: the table holds configuration metadata - a slug, a label, a
   * position - and the gate enforces access separately. `moduleGrant()`
   * returns hidden for a non-admin on an admin-only module "regardless of any
   * template or override", so knowing the row exists buys nothing.
   *
   * What WOULD matter is writing to it, and `authenticated` holds INSERT,
   * UPDATE and DELETE on these tables at the grant level - only RLS stops
   * them. So that is what gets tested.
   */
  const modulesRead = await asUser.from('modules').select('slug').eq('slug', 'records');
  note('modules metadata is readable by any signed-in user',
    `${(modulesRead.data ?? []).length} row(s) - by design; the gate enforces access, not the row`);

  const recordsModule = mods.find((m) => m.slug === 'records');
  const writeProbes = [
    ['modules', () => asUser.from('modules').update({ label: 'ZZ hijacked' }).eq('id', recordsModule.id).select('id')],
    ['modules (admin_only off)', () => asUser.from('modules').update({ admin_only: false }).eq('id', recordsModule.id).select('id')],
    ['tabs', () => asUser.from('tabs').update({ label: 'ZZ hijacked' }).eq('id', tabRow.id).select('id')],
    ['fields', () => asUser.from('fields').update({ label: 'ZZ hijacked' }).eq('id', fieldRow.id).select('id')],
    ['module_tab_order', () => asUser.from('module_tab_order').delete().eq('tab_id', tabRow.id).select('tab_id')],
    ['permission_templates', () => asUser.from('permission_templates').insert({ label: 'ZZ tpl' }).select('id')],
  ];
  for (const [name, run] of writeProbes) {
    const r = await run();
    const changed = !r.error && (r.data ?? []).length > 0;
    check(`a member cannot write to ${name}`, changed ? 'CHANGED' : 'refused', 'refused');
  }

  const grantsRead = await asUser.from('user_grants').select('user_id').neq('user_id', userId).limit(3);
  check("cannot read other users' grants",
    (grantsRead.data ?? []).length === 0 ? 'none' : `${grantsRead.data.length} VISIBLE`, 'none');

  const profilesRead = await asUser.from('profiles').select('id, email').limit(50);
  note('profiles visible to a member', `${(profilesRead.data ?? []).length} row(s)`);

  const escalate = await asUser
    .from('user_grants')
    .insert({ user_id: userId, scope_kind: 'module', scope_id: leads.id, grant_level: 'edit' });
  check('cannot grant themselves permissions', escalate.error ? 'refused' : 'ALLOWED', 'refused');

  const roleChange = await asUser
    .from('profiles')
    .update({ role_id: (await db.query(`select id from roles where is_admin limit 1`)).rows[0].id })
    .eq('id', userId)
    .select('id');
  check('cannot promote themselves to admin',
    roleChange.error || (roleChange.data ?? []).length === 0 ? 'refused' : 'PROMOTED', 'refused');

  // ══════════════════════════════════════════════════════════════════════
  section('SIGNED OUT');
  // ══════════════════════════════════════════════════════════════════════
  for (const t of ['records', 'fields', 'tabs', 'modules', 'user_grants', 'profiles']) {
    const res = await fetch(`${SUPA}/rest/v1/${t}?select=*&limit=1`, { headers: { apikey: ANON } });
    const body = res.ok ? await res.json() : null;
    check(`anon reads nothing from ${t}`, Array.isArray(body) && body.length ? 'ROWS' : 'nothing', 'nothing');
  }

  // ══════════════════════════════════════════════════════════════════════
  section('PAUSED ACCOUNT');
  // ══════════════════════════════════════════════════════════════════════
  await db.query(
    `update profiles set status = 'suspended', sessions_valid_from = now() where id = $1`,
    [userId],
  );
  const pausedLogin = await (
    await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: ANON, 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    })
  ).json();
  /*
   * Supabase still issues a token - pausing is OUR concept, not its. The gate
   * is `proxy.ts`, which rejects any token issued before sessions_valid_from
   * on every request. So the check is that the app refuses, not that the
   * token mint fails.
   */
  note('a paused user can still obtain a Supabase token', pausedLogin.access_token ? 'yes (expected)' : 'no');
  const appRes = await fetch('http://localhost:3210/dashboard', {
    headers: { cookie: authCookie(pausedLogin) },
    redirect: 'manual',
  }).catch(() => null);
  if (appRes) {
    check('the app refuses a paused user', appRes.status === 307 || appRes.status === 302 ? 'redirected' : `HTTP ${appRes.status}`, 'redirected');
  } else {
    note('app check skipped', 'the local server is not running on :3210');
  }
} finally {
  await cleanup();
  console.log(`\ncleaned up.`);
}

function authCookie(session) {
  const ref = new URL(SUPA).hostname.split('.')[0];
  const raw = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64');
  const N = `sb-${ref}-auth-token`;
  const C = 3180;
  return (raw.length <= C
    ? [[N, raw]]
    : Array.from({ length: Math.ceil(raw.length / C) }, (_, i) => [`${N}.${i}`, raw.slice(i * C, (i + 1) * C)])
  )
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

console.log(`\n${pass.length} passed, ${fail.length} failed, ${warn.length} note(s)`);
if (warn.length) {
  console.log('\nnotes:');
  for (const w of warn) console.log(`  - ${w}`);
}
await db.end();
process.exit(fail.length ? 1 : 0);
