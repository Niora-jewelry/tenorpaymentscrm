/**
 * The client's 16 Oct 2026 additions, seen through a real browser as an admin.
 *
 *   Addition 2 — the Permissions screen shows an "Add / remove records" row
 *                under each module, with Yes / No / Not set.
 *   Addition 4 — rows can be ticked, shift-click selects the range between,
 *                and one click applies a level to all of them.
 *   Addition 3 — a module that shows open cases offers no "New record" and
 *                says why; its chip in a record drawer is an indicator.
 *
 * Probes the permissions of a TEST member (demo.rep@tapdash.test — never a
 * real person) and puts every row back to Not set at the end. Nothing else
 * is written.
 *
 *   npm run dev -- -p 3221
 *   npm run verify:bulk-permissions
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const BASE = process.argv[2] || 'http://localhost:3221';
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ADMIN = 'admin@tapdash.test';
const SUBJECT = 'demo.rep@tapdash.test';
/* Both sign-in and the probed subject are test accounts, never a real person. */
if (!/@([a-z0-9-]+\.)*test$/i.test(ADMIN) || !/@([a-z0-9-]+\.)*test$/i.test(SUBJECT)) process.exit(1);

const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const q = (s, p = []) => db.query(s, p).then((r) => r.rows);

const [me] = await q(`select id from profiles where email=$1`, [ADMIN]);
const [subject] = await q(`select id from profiles where email=$1`, [SUBJECT]);
if (!subject) { console.log(`${SUBJECT} is missing`); process.exit(1); }
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

const before = await q(`select scope_kind::text k, scope_id, grant_level::text l from user_grants where user_id=$1 order by 1,2`, [subject.id]);
const auto = (await q(`select id, slug, label from modules where shows_open_cases order by position limit 1`))[0];
const ordinary = await q(`select id, label from modules where kind='display' and not admin_only and not shows_open_cases order by position`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
await ctx.addCookies(cookies);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });
await page.route('**://*.posthog.com/**', (r) => r.abort());

try {
  /* ── Addition 2: the row exists, with Yes / No ────────────────────────── */
  await page.goto(`${BASE}/admin/users/${subject.id}/permissions`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.waitForTimeout(1500);
  const memRows = page.getByText('Add / remove records', { exact: true });
  t('an "Add / remove records" row is under each ordinary module', (await memRows.count()) === ordinary.length, `${await memRows.count()} rows for ${ordinary.length} modules`);
  const yesno = page.getByRole('group', { name: `Permission for Add / remove records` }).first();
  const labels = await yesno.locator('button').allInnerTexts();
  t('its control offers Not set / No / Yes, never Hidden', labels.join('|') === 'Not set|No|Yes', labels.join('|'));
  t('the open-cases module has no such row', !(await page.locator(`text=${auto.label}`).first().locator('xpath=..').getByText('Add / remove records').count()));

  /* ── Addition 4: tick, shift-tick, apply ──────────────────────────────── */
  // Row boxes only — the toolbar's "Select all shown" box also starts with "Select".
  const boxes = page.getByRole('checkbox', { name: /^Select (?!all shown)/ });
  const nBoxes = await boxes.count();
  t('every row has a checkbox', nBoxes >= ordinary.length * 2, `${nBoxes} checkboxes`);
  await boxes.nth(0).click();
  await boxes.nth(4).click({ modifiers: ['Shift'] });
  const bar = page.getByText(/rows? selected/);
  t('shift-click selects the range between (5 rows)', /^5\s/.test((await bar.first().locator('xpath=..').innerText()).trim()), (await bar.first().locator('xpath=..').innerText()).replace(/\s+/g, ' '));

  // The floating bar is the last thing in the DOM, after every row's own toggle.
  await page.getByRole('button', { name: /^View$/ }).last().click();
  await page.waitForTimeout(3500);
  const after = await q(`select scope_kind::text k, grant_level::text l from user_grants where user_id=$1`, [subject.id]);
  const views = after.filter((r) => r.l === 'view').length;
  t('one click set every selected row — 5 rows written as View', views === 5, `${views} view rows: ${after.map((r) => r.k + '=' + r.l).join(', ')}`);
  t('that included module rows AND add/remove rows', after.some((r) => r.k === 'module') && after.some((r) => r.k === 'membership'));
  const note = await page.locator('[role=status]').last().innerText().catch(() => '');
  t('and said so on screen', /5 rows set to View/.test(note), note);

  // Clear them again through the same bar.
  await page.getByLabel('Select all shown').check();
  await page.getByRole('button', { name: /^Not set$/ }).last().click();
  await page.waitForTimeout(3500);
  const cleared = (await q(`select count(*)::int n from user_grants where user_id=$1`, [subject.id]))[0].n;
  t('"Not set" on the selection clears them all', cleared === 0, `${cleared} rows left`);

  /* ── Addition 3: the open-cases module ────────────────────────────────── */
  await page.goto(`${BASE}/${auto.slug}`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.waitForTimeout(1200);
  t(`${auto.label} offers no "New record"`, (await page.getByRole('button', { name: /New record/ }).count()) === 0);
  t('and says records appear there automatically', /appear here automatically while they have an open case/.test(await page.locator('body').innerText()));
  const [rec] = await q(`select r.id from record_modules rm join records r on r.id = rm.record_id where rm.module_id = $1 limit 1`, [auto.id]);
  if (rec) {
    await page.goto(`${BASE}/${auto.slug}?record=${rec.id}`, { waitUntil: 'networkidle', timeout: 180000 });
    await page.waitForTimeout(1500);
    const chip = page.locator('span[title*="automatically"]').first();
    t('the drawer shows its chip as an indicator with the reason on hover', (await chip.count()) === 1 && /case is open/.test((await chip.getAttribute('title')) ?? ''), (await chip.getAttribute('title')) ?? 'no chip');
  }
  t('no page errors or 500s', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) {
  fail.push(`script stopped: ${String(e).slice(0, 220)}`);
} finally {
  /* Exactly as they were. */
  await db.query(`delete from user_grants where user_id=$1`, [subject.id]);
  for (const r of before) {
    await db.query(`insert into user_grants (user_id, scope_kind, scope_id, grant_level) values ($1, $2::grant_scope, $3, $4::permission_level) on conflict do nothing`, [subject.id, r.k, r.scope_id, r.l]);
  }
  const now = await q(`select scope_kind::text k, scope_id, grant_level::text l from user_grants where user_id=$1 order by 1,2`, [subject.id]);
  console.log(`restore: ${JSON.stringify(now) === JSON.stringify(before) ? `${SUBJECT}'s grants exactly as before (${before.length})` : '⚠ GRANTS DIFFER FROM BEFORE'}`);
  await browser.close();
  await db.end();
}

for (const p of pass) console.log(' PASS  ' + p);
for (const f of fail) console.log('*FAIL  ' + f);
console.log(`\n=== ${pass.length}/${pass.length + fail.length} passed ===`);
process.exit(fail.length ? 1 : 0);
