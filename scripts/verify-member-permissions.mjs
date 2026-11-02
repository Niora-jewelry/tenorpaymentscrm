/**
 * Adding records to and removing them from modules, seen as a MEMBER in a real
 * browser — the one view every admin check misses, since an admin may always
 * move records.
 *
 * The rule today (Permissions spec): a person may add a record to a module, or
 * take it out, when "Display / remove from modules" is Yes for them AND that
 * module isn't Hidden in their Module access.
 *
 *   1. Admin sets "Display / remove from modules = No" on the member's own
 *      permissions screen.
 *   2. Signed in as the member: every module chip is locked with the reason, the
 *      open-cases module's chip is an indicator, the bulk bar offers no Remove,
 *      and the server refuses the move the screen no longer offers.
 *   3. Admin sets Yes: the chips work both ways.
 *   4. Module access Hidden on one module: that chip alone is locked again.
 *
 * ── WHAT IT TOUCHES, AND PUTS BACK ─────────────────────────────────────────
 * A throwaway `zz-…@tapdash.test` member made for the run and removed after, and
 * one probe record, deleted after. `record_activity` is append-only and is not
 * touched. Record and module counts are compared before and after.
 *
 *   npm run build && npx next start -p 3221
 *   node --env-file=.env scripts/verify-member-permissions.mjs [base url]
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const BASE = process.argv[2] || 'http://localhost:3221';
const HOST = new URL(BASE).hostname;
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ADMIN = 'admin@tapdash.test';
const PW = 'ZzProbe-2026!page';

const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const q = (s, p = []) => db.query(s, p).then((r) => r.rows);
const svc = createClient(SUPA, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = createClient(SUPA, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });

const snapshot = async () => ({
  records: (await q(`select count(*)::int n from records where deleted_at is null`))[0].n,
  memberships: await q(`select m.slug, count(rm.record_id)::int n from modules m left join record_modules rm on rm.module_id=m.id group by m.slug order by m.slug`),
});
const before = await snapshot();

const [me] = await q(`select id from profiles where email=$1`, [ADMIN]);
const [lockMod, freeMod] = await q(`select slug, id, label from modules where kind='display' and not admin_only and not shows_open_cases order by position limit 2`);
const autoMod = (await q(`select slug, id, label from modules where shows_open_cases limit 1`))[0];

/* ── a throwaway member, on the Sales agent type ── */
const MEMBER = `zz-member-perm-${randomUUID().slice(0, 8)}@tapdash.test`;
const { data: made, error: makeError } = await svc.auth.admin.createUser({ email: MEMBER, password: PW, email_confirm: true });
if (makeError) throw makeError;
const member = { id: made.user.id };
const [role] = await q(`select id from roles where not is_admin order by name limit 1`);
await db.query(`insert into profiles (id, email, full_name, role_id, status, last_seen_at) values ($1, $2, 'Zz Member Perm', $3, 'active', now())
  on conflict (id) do update set role_id = excluded.role_id, status = 'active', last_seen_at = now()`, [member.id, MEMBER, role.id]);
const [tpl] = await q(`select id from permission_templates where user_type = 'sales_agent'`);
await db.query(`insert into user_templates (user_id, template_id) values ($1, $2) on conflict (user_id) do update set template_id = excluded.template_id`, [member.id, tpl.id]);
const setting = (key, value) => db.query(
  `insert into permission_settings (owner_kind, owner_id, key, value) values ('user', $1, $2, $3)
   on conflict (owner_kind, owner_id, key) do update set value = excluded.value`, [member.id, key, value]);
for (const m of [lockMod, freeMod]) await setting(`module:${m.id}`, 'mine');

/* ── sign in as admin ── */
await svc.auth.admin.updateUserById(me.id, { password: PW });
await db.query(`update profiles set last_seen_at = now() where id=$1`, [me.id]);
const { data } = await anon.auth.signInWithPassword({ email: ADMIN, password: PW });
const ref = new URL(SUPA).hostname.split('.')[0];
const v = 'base64-' + Buffer.from(JSON.stringify(data.session)).toString('base64url');
const cookies = [];
if (v.length > 3180) for (let i = 0, n = 0; i < v.length; i += 3180, n++)
  cookies.push({ name: `sb-${ref}-auth-token.${n}`, value: v.slice(i, i + 3180), domain: HOST, path: '/' });
else cookies.push({ name: `sb-${ref}-auth-token`, value: v, domain: HOST, path: '/' });

const pass = [], fail = [];
const t = (n, ok, d = '') => (ok ? pass : fail).push(`${n}${d ? '  — ' + d : ''}`);

/* ── the probe record, the member on its team, in the module to be tested ── */
const [probe] = await q(
  `insert into records (deal_name, creator_kind, creator_user_id, "values")
   values ('ZZ permission probe', 'user', $1, jsonb_build_object('team_members_assigned', jsonb_build_array($2::text)))
   returning id`, [me.id, member.id]);
await db.query(`insert into record_modules (record_id, module_id, added_by) values ($1, $2, $3)`, [probe.id, lockMod.id, me.id]);

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
const until = async (cond, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await page.waitForTimeout(500); } return cond(); };
/** What the member actually has: their own setting, else their type's. */
const effective = async (key) => (await q(`select user_perm($1, $2) v`, [member.id, key]))[0]?.v ?? null;

/** The Yes/No pair for "Display / remove from modules" on the member's screen. */
const displayRow = () => page.getByRole('radiogroup', { name: 'Display / remove from modules', exact: true });

let impersonating = false;
const signInAsMember = async () => {
  await page.goto(`${BASE}/admin/users`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.getByRole('button', { name: `Actions for ${MEMBER}` }).click();
  await page.getByRole('menuitem', { name: 'Sign in as this user' }).click();
  await page.getByText(/Signed in as/).first().waitFor({ timeout: 30000 }).catch(() => {});
  impersonating = /signed in as/i.test(await page.locator('body').innerText());
  if (!impersonating) throw new Error('impersonation banner never appeared');
};
const backToAdmin = async () => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.getByRole('button', { name: 'Return to my account' }).click();
  await page.waitForTimeout(3000);
  impersonating = false;
};
const openProbe = async () => {
  await page.goto(`${BASE}/${lockMod.slug}?record=${probe.id}`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.getByText('ZZ permission probe').first().waitFor({ timeout: 60000 });
  await page.waitForTimeout(1000);
};
const lockedChip = (label) => page.locator('span[title*="permission to add records"]').filter({ hasText: label });

try {
  /* ── 1. admin sets No ─────────────────────────────────────────────────── */
  await page.goto(`${BASE}/admin/users/${member.id}/permissions`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.getByText('Display / remove from modules', { exact: true }).waitFor({ timeout: 60000 });
  await displayRow().getByRole('radio', { name: 'No', exact: true }).click();
  t('admin sets "Display / remove from modules = No"', await until(async () => (await effective('action.modules')) === 'no'), `has ${await effective('action.modules')}`);

  /* ── 2. as the member ─────────────────────────────────────────────────── */
  await signInAsMember();
  t('signed in as the member through the app', impersonating);
  await openProbe();
  t(`${lockMod.label} chip is locked for them, with the reason on hover`, (await lockedChip(lockMod.label).count()) === 1, (await lockedChip(lockMod.label).first().getAttribute('title').catch(() => null)) ?? 'no locked chip');
  t(`${freeMod.label} chip is locked too: the setting is company-wide`, (await lockedChip(freeMod.label).count()) === 1);
  if (autoMod) t(`${autoMod.label} chip is an indicator, not a switch`, (await page.locator('span[title*="automatic"]').filter({ hasText: autoMod.label }).count()) === 1);

  await page.goto(`${BASE}/${lockMod.slug}`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.getByLabel('Select ZZ permission probe', { exact: true }).check();
  await page.waitForTimeout(600);
  const barText = (await page.locator('body').innerText()).replace(/\s+/g, ' ').match(/1 records? selected.{0,160}/)?.[0] ?? '';
  t('bulk bar offers no Remove', !/Remove|Archive/.test(barText), barText || 'no bar');

  /* ── the server refuses what the screen no longer offers ─────────────── */
  await db.query('begin');
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: member.id, role: 'authenticated' })]);
  await db.query('set local role authenticated');
  let refusal = '';
  try { await db.query(`select set_record_memberships($1, '{}'::uuid[])`, [probe.id]); } catch (e) { refusal = e.message; }
  await db.query('rollback');
  t('the server refuses removing it as the member', refusal.length > 0, refusal.slice(0, 90) || 'it was allowed');
  t(`record still in ${lockMod.label}`, await inModule(lockMod.id));

  /* ── 3. admin sets Yes; the chips work both ways ─────────────────────── */
  await backToAdmin();
  await page.goto(`${BASE}/admin/users/${member.id}/permissions`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.getByText('Display / remove from modules', { exact: true }).waitFor({ timeout: 60000 });
  await displayRow().getByRole('radio', { name: 'Yes', exact: true }).click();
  t('admin sets Yes', await until(async () => (await effective('action.modules')) === 'yes'));
  await signInAsMember();
  await openProbe();
  const freeChip = page.getByRole('button', { name: freeMod.label, exact: true });
  t(`${freeMod.label} chip is a working button`, (await freeChip.count()) === 1);
  await freeChip.click();
  t(`clicking ${freeMod.label} adds the record there`, await until(() => inModule(freeMod.id)));
  await page.getByRole('button', { name: freeMod.label, exact: true }).click();
  t('clicking it again takes it out', await until(async () => !(await inModule(freeMod.id))));

  /* ── 4. Hidden in Module access: that module alone is out of reach ───── */
  await backToAdmin();
  await setting(`module:${freeMod.id}`, 'hidden');
  await signInAsMember();
  await openProbe();
  t(`${lockMod.label} still a working button`, (await page.getByRole('button', { name: lockMod.label, exact: true }).count()) === 1);
  t(`${freeMod.label}, Hidden for them, can't be added to`, (await page.getByRole('button', { name: freeMod.label, exact: true }).count()) === 0);

  t('no page errors or 500s', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) {
  fail.push(`script stopped: ${String(e).slice(0, 220)}`);
} finally {
  if (/signed in as/i.test(await page.locator('body').innerText().catch(() => ''))) impersonating = true;
  if (impersonating) {
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle', timeout: 180000 }).catch(() => {});
    await page.getByRole('button', { name: 'Return to my account' }).click().catch(() => {});
    await page.waitForTimeout(2500);
  }
  const [last] = await q(`select event_type::text e from auth_audit_log where event_type::text like 'impersonation_%' and actor_id=$1 order by created_at desc limit 1`, [me.id]);
  console.log(last?.e === 'impersonation_ended' ? 'Session handed back (audit log).' : `⚠ last impersonation event: ${last?.e}`);

  const step = async (label, fn) => { try { await fn(); } catch (e) { fail.push(`restore step failed: ${label} — ${String(e.message).slice(0, 120)}`); } };
  await step('delete probe record', () => db.query(`delete from records where id=$1`, [probe.id]));
  await step('remove the member', async () => {
    await db.query(`delete from permission_settings where owner_kind='user' and owner_id=$1`, [member.id]);
    await db.query(`delete from user_grants where user_id=$1`, [member.id]);
    await svc.auth.admin.deleteUser(member.id);
  });
  const after = await snapshot();
  const same = JSON.stringify(before) === JSON.stringify(after);
  console.log(same ? `restore: records ${after.records} and every module count exactly as before` : `⚠ RESTORE MISMATCH\nbefore ${JSON.stringify(before)}\nafter  ${JSON.stringify(after)}`);
  if (!same) fail.push('restore mismatch');
  await browser.close();
  await db.end();
}

for (const p of pass) console.log(' PASS  ' + p);
for (const f of fail) console.log('*FAIL  ' + f);
console.log(`\n=== ${pass.length}/${pass.length + fail.length} passed ===`);
process.exit(fail.length ? 1 : 0);
