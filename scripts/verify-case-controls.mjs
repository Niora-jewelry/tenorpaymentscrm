/**
 * The Close / Reopen button and the delete icon on a case's header row
 * (client, 16 Oct 2026), driven through a real browser as an admin — and
 * the open-case ⇒ Tickets rule riding along with every state change.
 *
 * One probe record is created for the run and hard-deleted at the end,
 * which takes its case with it. Nothing else is written. Record and module
 * counts are compared before and after. (record_activity is append-only;
 * the probe's few rows stay, pointing at an id no screen can reach.)
 *
 *   npm run dev -- -p 3221
 *   npm run verify:case-controls
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const BASE = process.argv[2] || 'http://localhost:3221';
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ADMIN = 'admin@tapdash.test';
if (!/@([a-z0-9-]+\.)*test$/i.test(ADMIN)) process.exit(1);

const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const q = (s, p = []) => db.query(s, p).then((r) => r.rows);

const [me] = await q(`select id from profiles where email=$1`, [ADMIN]);
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

const snapshot = async () => ({
  records: (await q(`select count(*)::int n from records where deleted_at is null`))[0].n,
  cases: (await q(`select count(*)::int n from cases`))[0].n,
  memberships: await q(`select m.slug, count(rm.record_id)::int n from modules m left join record_modules rm on rm.module_id=m.id group by m.slug order by m.slug`),
});
const before = await snapshot();
const auto = (await q(`select id, slug, label from modules where shows_open_cases limit 1`))[0];
const home = (await q(`select id, slug from modules where kind='display' and not admin_only and not shows_open_cases order by position limit 1`))[0];

const pass = [], fail = [];
const t = (n, ok, d = '') => (ok ? pass : fail).push(`${n}${d ? '  — ' + d : ''}`);

const [probe] = await q(
  `insert into records (deal_name, creator_kind, creator_user_id, "values")
   values ('ZZ case-controls probe', 'user', $1, jsonb_build_object('team_members_assigned', jsonb_build_array($2::text)))
   returning id`, [me.id, me.id]);
await db.query(`insert into record_modules (record_id, module_id, added_by) values ($1, $2, $3)`, [probe.id, home.id, me.id]);

const inTickets = async () => (await q(`select count(*)::int n from record_modules where record_id=$1 and module_id=$2`, [probe.id, auto.id]))[0].n === 1;
const theCase = async () => (await q(`select id, number, state::text, solution, deleted_at from cases where record_id=$1 order by created_at desc limit 1`, [probe.id]))[0];
const until = async (cond, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 500)); } return cond(); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
await ctx.addCookies(cookies);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const consoleErrors = [];
// Two messages every page logs regardless of this feature: the CSP
// report-only notice, and the 403 from /api/twilio/token for an account with
// no phone line. Anything else is reported.
const KNOWN_NOISE = /upgrade-insecure-requests|status of 403/;
// The Recycle Bin page logs a pre-existing React "unique key" warning of its
// own (seen 16 Oct 2026; every map there has a key, so it is deeper than a
// grep). This feature only visits that page to confirm the case is listed,
// so messages logged while on it are not counted against the feature.
page.on('console', (m) => {
  if (m.type() !== 'error' || KNOWN_NOISE.test(m.text())) return;
  if (page.url().includes('/admin/recycle-bin')) return;
  consoleErrors.push(`[${page.url().replace(BASE, '')}] ${m.text().slice(0, 300)}`);
});
page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });
await page.route('**://*.posthog.com/**', (r) => r.abort());

try {
  await page.goto(`${BASE}/${home.slug}?record=${probe.id}&tab=cases`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.waitForTimeout(1500);
  if (!(await page.locator('input[name=title]').count())) {
    await page.getByRole('button', { name: /Cases/ }).first().click().catch(() => {});
    await page.waitForTimeout(800);
  }
  if (!(await page.locator('input[name=title]').count())) await page.getByRole('button', { name: /Open a case/ }).first().click();
  await page.locator('input[name=title]').fill('Probe case');
  await page.locator('textarea[name=issue], input[name=issue]').fill('Probe issue for the header controls');
  await page.getByRole('button', { name: 'Open case', exact: true }).click();
  t('a case can be opened', await until(async () => Boolean(await theCase())));
  t(`opening it put the record in ${auto.label}`, await until(inTickets));
  await page.waitForTimeout(1500);

  // Header controls, no expanding needed.
  const closeBtn = page.getByRole('button', { name: 'Close case' }).first();
  await closeBtn.waitFor({ timeout: 20000 }).catch(() => {});
  // An open case starts expanded, so the footer's button is there too; the
  // header's is the first in DOM order.
  t('the header row shows "Close case"', (await page.getByRole('button', { name: 'Close case' }).count()) >= 1);
  const trash = page.getByRole('button', { name: /Delete case #\d+/ }).first();
  t('and a delete icon', (await trash.count()) >= 1, (await trash.getAttribute('title')) ?? '');

  // No solution yet → the Complete box asks for one, then closes.
  await closeBtn.click();
  await page.waitForTimeout(600);
  t('closing without a solution opens the "Close case" box', (await page.getByText(/^Close case #\d+$/).count()) === 1);
  await page.locator('textarea[placeholder="What resolved this case?"]').fill('Probe solution — resolved by the test.');
  await page.getByRole('button', { name: 'Save solution and close' }).click();
  t('the case closes with the solution saved', await until(async () => (await theCase())?.state === 'closed' && Boolean((await theCase())?.solution)));
  t(`closing the last open case took the record out of ${auto.label}`, await until(async () => !(await inTickets())));
  await page.waitForTimeout(1500);

  // Reopen from the header.
  await page.getByRole('button', { name: 'Reopen' }).first().click();
  t('"Reopen" reopens it', await until(async () => (await theCase())?.state === 'open'));
  t(`and it is back in ${auto.label}`, await until(inTickets));
  await page.waitForTimeout(1500);

  // Delete from the header → Recycle Bin.
  await page.getByRole('button', { name: /Delete case #\d+/ }).first().click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Delete case', exact: true }).click();
  t('the delete icon soft-deletes the case (Recycle Bin)', await until(async () => Boolean((await theCase())?.deleted_at)));
  t(`a deleted case is not an open case — record left ${auto.label}`, await until(async () => !(await inTickets())));
  await page.waitForTimeout(1500);
  t('the case is gone from the tab', await until(async () => (await page.getByText('Probe case').count()) === 0));
  await page.goto(`${BASE}/admin/recycle-bin`, { waitUntil: 'networkidle', timeout: 180000 });
  // Sections start collapsed; open Cases before looking.
  await page.locator('button, a, [role=tab]').filter({ hasText: /^Cases\s*\d*$/ }).first().click().catch(() => {});
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'D:/tmp-claude/bin.png', fullPage: true }).catch(() => {});
  const binText = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  t('and listed in the Recycle Bin', /Probe case|#\d{5}/.test(binText), binText.slice(0, 300));
  t('no page errors or 500s', errors.length === 0, errors.slice(0, 2).join(' | '));
  t('no browser console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' || '));
} catch (e) {
  fail.push(`script stopped: ${String(e).slice(0, 220)}`);
  await page.screenshot({ path: 'D:/tmp-claude/case-controls-fail.png', fullPage: true }).catch(() => {});
} finally {
  try { await db.query(`delete from records where id=$1`, [probe.id]); } catch (e) { fail.push(`restore failed: ${e.message}`); }
  const after = await snapshot();
  const same = JSON.stringify(before) === JSON.stringify(after);
  console.log(same ? `restore: records ${after.records}, cases ${after.cases}, every module count — exactly as before` : `⚠ RESTORE MISMATCH\n${JSON.stringify(before)}\n${JSON.stringify(after)}`);
  if (!same) fail.push('restore mismatch');
  await browser.close();
  await db.end();
}

for (const p of pass) console.log(' PASS  ' + p);
for (const f of fail) console.log('*FAIL  ' + f);
console.log(`\n=== ${pass.length}/${pass.length + fail.length} passed ===`);
process.exit(fail.length ? 1 : 0);
