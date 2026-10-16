/**
 * The add/remove-records permission (Addition 2, 16 Oct 2026), seen as a
 * MEMBER in a real browser — the one view every admin check misses, since an
 * admin may always move records.
 *
 *   1. Admin sets "Add / remove records = No" on one module for a test member.
 *   2. Signed in as that member: the chip for that module is locked with the
 *      reason; another module's chip still works both ways; the open-cases
 *      module's chip is an indicator; the bulk bar offers no Remove there.
 *   3. The server refuses the move the UI no longer offers.
 *   4. Admin clears the setting; the chip works again.
 *
 * ── WHAT IT TOUCHES, AND PUTS BACK ───────────────────────────────────────
 * The member is demo.rep@tapdash.test (never a real person). One probe record
 * is created for it and deleted afterwards, along with its activity rows; its
 * grants are snapshotted first and restored exactly. Nothing else is written.
 * Record, membership and grant counts are compared before and after.
 *
 *   npm run dev -- -p 3221
 *   npm run verify:member-permissions
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const BASE = process.argv[2] || 'http://localhost:3221';
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ADMIN = 'admin@tapdash.test';
const MEMBER = 'demo.rep@tapdash.test';
if (!/@([a-z0-9-]+\.)*test$/i.test(ADMIN) || !/@([a-z0-9-]+\.)*test$/i.test(MEMBER)) process.exit(1);

const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const q = (s, p = []) => db.query(s, p).then((r) => r.rows);

const [me] = await q(`select id from profiles where email=$1`, [ADMIN]);
const [member] = await q(`select p.id, r.is_admin from profiles p join roles r on r.id=p.role_id where p.email=$1`, [MEMBER]);
if (!member || member.is_admin) { console.log(`${MEMBER} must exist and not be an admin`); process.exit(1); }

const snapshot = async () => ({
  records: (await q(`select count(*)::int n from records where deleted_at is null`))[0].n,
  memberships: await q(`select m.slug, count(rm.record_id)::int n from modules m left join record_modules rm on rm.module_id=m.id group by m.slug order by m.slug`),
  grants: await q(`select scope_kind::text k, scope_id, grant_level::text l, module_id from user_grants where user_id=$1 order by 1,2,4`, [member.id]),
  allGrants: (await q(`select count(*)::int n from user_grants`))[0].n,
});
const before = await snapshot();

const mods = Object.fromEntries((await q(`select slug, id, label from modules`)).map((m) => [m.slug, m]));
const [lockMod, freeMod] = (await q(`select slug, id, label from modules where kind='display' and not admin_only and not shows_open_cases order by position limit 2`));
const autoMod = (await q(`select slug, id, label from modules where shows_open_cases limit 1`))[0];

/* ── sign in as admin ── */
const svc = createClient(SUPA, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const PW = 'ZzProbe-2026!page';
await svc.auth.admin.updateUserById(me.id, { password: PW });
const anon = createClient(SUPA, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const { data } = await anon.auth.signInWithPassword({ email: ADMIN, password: PW });
const ref = new URL(SUPA).hostname.split('.')[0];
const v = 'base64-' + Buffer.from(JSON.stringify(data.session)).toString('base64url');
const cookies = [];
if (v.length > 3180) for (let i = 0, n = 0; i < v.length; i += 3180, n++)
  cookies.push({ name: `sb-${ref}-auth-token.${n}`, value: v.slice(i, i + 3180), domain: 'localhost', path: '/' });
else cookies.push({ name: `sb-${ref}-auth-token`, value: v, domain: 'localhost', path: '/' });

const pass = [], fail = [];
const t = (n, ok, d = '') => (ok ? pass : fail).push(`${n}${d ? '  — ' + d : ''}`);

/*
 * The 24h idle rule in proxy.ts reads profiles.last_seen_at and signs the
 * borrowed session straight out for an account that has not been seen in a
 * day — which a test account never has. Set to now for the run, restored
 * after. Test account only.
 */
const [{ last_seen_at: seenBefore }] = await q(`select last_seen_at from profiles where id=$1`, [member.id]);
await db.query(`update profiles set last_seen_at = now() where id=$1`, [member.id]);

/* ── the probe record: made for the member, placed in the module to be locked ── */
const [probe] = await q(
  `insert into records (deal_name, creator_kind, creator_user_id, "values")
   values ('ZZ permission probe', 'user', $1, jsonb_build_object('team_members_assigned', jsonb_build_array($2::text)))
   returning id`, [member.id, member.id]);
await db.query(`insert into record_modules (record_id, module_id, added_by) values ($1, $2, $3)`, [probe.id, lockMod.id, me.id]);
// The test account's template hides every ordinary module, so for the run it
// gets Edit on the two modules under test. Its grants are snapshotted above
// and restored exactly at the end.
await db.query(
  `insert into user_grants (user_id, scope_kind, scope_id, grant_level) values ($1,'module',$2,'edit'), ($1,'module',$3,'edit') on conflict do nothing`,
  [member.id, lockMod.id, freeMod.id]);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
await ctx.addCookies(cookies);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });
await page.route('**://*.posthog.com/**', (r) => r.abort());

const inModule = async (modId) =>
  (await q(`select count(*)::int n from record_modules where record_id=$1 and module_id=$2`, [probe.id, modId]))[0].n === 1;

/** The yes/no control for one module on the member's permission screen. */
const ordinary = await q(`select label from modules where kind='display' and not admin_only and not shows_open_cases order by position`);
const yesNoFor = (label) =>
  // One yes/no row per ordinary module, drawn in module order — so the Nth
  // control belongs to the Nth ordinary module.
  page.getByRole('group', { name: 'Permission for Add / remove records' }).nth(ordinary.findIndex((m) => m.label === label));

let impersonating = false;
try {
  /* ── 1. admin sets No on the module the probe is in ─────────────────── */
  await page.goto(`${BASE}/admin/users/${member.id}/permissions`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.waitForTimeout(1500);
  await yesNoFor(lockMod.label).getByRole('button', { name: 'No', exact: true }).click();
  await page.waitForTimeout(3000);
  const [row] = await q(`select grant_level::text l from user_grants where user_id=$1 and scope_kind='membership' and scope_id=$2`, [member.id, lockMod.id]);
  t(`admin sets "Add / remove records = No" on ${lockMod.label}`, row?.l === 'view', row ? `stored as ${row.l}` : 'no row stored');

  /* ── 2. as the member ───────────────────────────────────────────────── */
  await page.goto(`${BASE}/admin/users`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.getByRole('button', { name: `Actions for ${MEMBER}` }).click();
  await page.getByRole('menuitem', { name: 'Sign in as this user' }).click();
  await page.getByText(/Signed in as/).first().waitFor({ timeout: 30000 }).catch(() => {});
  impersonating = /signed in as/i.test(await page.locator('body').innerText());
  t('signed in as the member through the app', impersonating);
  if (!impersonating) throw new Error('impersonation banner never appeared');

  await page.goto(`${BASE}/${lockMod.slug}?record=${probe.id}`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.waitForTimeout(1500);

  const locked = page.locator(`span[title*="permission to add records"]`).filter({ hasText: lockMod.label });
  t(`${lockMod.label} chip is locked for them, with the reason on hover`, (await locked.count()) === 1, (await locked.first().getAttribute('title')) ?? 'no locked chip');
  const freeChip = page.getByRole('button', { name: freeMod.label, exact: true });
  t(`${freeMod.label} chip is still a working button`, (await freeChip.count()) === 1);
  const autoChip = page.locator('span[title*="automatic"]').filter({ hasText: autoMod.label });
  t(`${autoMod.label} chip is an indicator, not a switch`, (await autoChip.count()) === 1);

  // The working chip works both ways. A chip click is a server action that
  // takes a few seconds here, so the database is polled rather than read once.
  const until = async (cond, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await page.waitForTimeout(500); } return cond(); };
  await freeChip.click();
  t(`clicking ${freeMod.label} adds the record there`, await until(() => inModule(freeMod.id)));
  const chipError = await page.getByText('Could not change that membership.').count();
  t('no error shown beside the chips', chipError === 0);
  await page.getByRole('button', { name: freeMod.label, exact: true }).click();
  t(`clicking it again removes it`, await until(async () => !(await inModule(freeMod.id))));
  t(`${lockMod.label} membership untouched throughout`, await inModule(lockMod.id));

  // The table's bulk bar offers no Remove in the locked module.
  await page.goto(`${BASE}/${lockMod.slug}`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.waitForTimeout(1500);
  await page.getByLabel('Select ZZ permission probe', { exact: true }).check();
  await page.waitForTimeout(600);
  const barText = (await page.locator('body').innerText()).replace(/\s+/g, ' ').match(/1 records? selected.{0,120}/)?.[0] ?? '';
  t('bulk bar shows Edit but not Remove', /Edit/.test(barText) && !/Remove|Archive/.test(barText), barText || 'no bar');

  /* ── 3. the server refuses what the UI no longer offers ─────────────── */
  await db.query('begin');
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: member.id, role: 'authenticated' })]);
  await db.query('set local role authenticated');
  let refusal = '';
  try { await db.query(`select set_record_memberships($1, '{}'::uuid[])`, [probe.id]); } catch (e) { refusal = e.message; }
  await db.query('rollback');
  t(`server refuses removing from ${lockMod.label} as the member`, /cannot add records to or remove them from/.test(refusal), refusal.slice(0, 90) || 'it was allowed');
  t(`record still in ${lockMod.label}`, await inModule(lockMod.id));

  /* ── 4. admin clears it; the chip works again ───────────────────────── */
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.getByRole('button', { name: 'Return to my account' }).click();
  await page.waitForTimeout(3000);
  impersonating = false;
  await page.goto(`${BASE}/admin/users/${member.id}/permissions`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.waitForTimeout(1500);
  await yesNoFor(lockMod.label).getByRole('button', { name: 'Not set' }).click();
  await page.waitForTimeout(3000);
  t('admin clears the setting', (await q(`select count(*)::int n from user_grants where user_id=$1 and scope_kind='membership'`, [member.id]))[0].n === 0);

  await page.goto(`${BASE}/admin/users`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.getByRole('button', { name: `Actions for ${MEMBER}` }).click();
  await page.getByRole('menuitem', { name: 'Sign in as this user' }).click();
  await page.getByText(/Signed in as/).first().waitFor({ timeout: 30000 }).catch(() => {});
  impersonating = true;
  await page.goto(`${BASE}/${lockMod.slug}?record=${probe.id}`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.waitForTimeout(1500);
  t(`${lockMod.label} chip is a working button again for the member`, (await page.getByRole('button', { name: lockMod.label, exact: true }).count()) === 1);

  t('no page errors or 500s', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) {
  fail.push(`script stopped: ${String(e).slice(0, 220)}`);
  await page.screenshot({ path: 'D:/tmp-claude/member-perm-fail.png', fullPage: true }).catch(() => {});
} finally {
  // Hand the session back whenever the banner is showing, whatever the flag says.
  if (/signed in as/i.test(await page.locator('body').innerText().catch(() => ''))) impersonating = true;
  if (impersonating) {
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle', timeout: 180000 }).catch(() => {});
    await page.getByRole('button', { name: 'Return to my account' }).click().catch(() => {});
    await page.waitForTimeout(2500);
  }
  const [last] = await q(`select event_type::text e from auth_audit_log where event_type::text like 'impersonation_%' and actor_id=$1 order by created_at desc limit 1`, [me.id]);
  console.log(last?.e === 'impersonation_ended' ? 'Session handed back (audit log).' : `⚠ last impersonation event: ${last?.e}`);

  /*
   * Put everything back — each step on its own, so one failure cannot stop
   * the rest. `record_activity` is append-only by design and is NOT touched:
   * the handful of rows the probe's chip clicks wrote stay, referencing a
   * record id that no longer exists, which no screen can reach.
   */
  const step = async (label, fn) => { try { await fn(); } catch (e) { fail.push(`restore step failed: ${label} — ${String(e.message).slice(0, 120)}`); } };
  await step('delete probe record', () => db.query(`delete from records where id=$1`, [probe.id]));
  await step('restore last_seen_at', () => db.query(`update profiles set last_seen_at = $2 where id=$1`, [member.id, seenBefore]));
  await step('clear run grants', () => db.query(`delete from user_grants where user_id=$1`, [member.id]));
  for (const g of before.grants) {
    await step('restore grant', () => db.query(`insert into user_grants (user_id, scope_kind, scope_id, grant_level, module_id) values ($1,$2::grant_scope,$3,$4::permission_level,$5) on conflict do nothing`, [member.id, g.k, g.scope_id, g.l, g.module_id]));
  }
  const after = await snapshot();
  const same = JSON.stringify(before) === JSON.stringify(after);
  console.log(same
    ? `restore: records ${after.records}, every module count, ${MEMBER}'s ${after.grants.length} grant(s) and ${after.allGrants} total grants — all exactly as before`
    : `⚠ RESTORE MISMATCH\nbefore ${JSON.stringify(before)}\nafter  ${JSON.stringify(after)}`);
  if (!same) fail.push('restore mismatch');
  await browser.close();
  await db.end();
}

for (const p of pass) console.log(' PASS  ' + p);
for (const f of fail) console.log('*FAIL  ' + f);
console.log(`\n=== ${pass.length}/${pass.length + fail.length} passed ===`);
process.exit(fail.length ? 1 : 0);
