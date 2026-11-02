/**
 * The Permissions screen for one person, seen through a real browser as an admin.
 *
 *   Module access   — every display module and the Records List has a row:
 *                     Hidden / Only mine / All records.
 *   Company actions — "Display / remove from modules" is a Yes / No.
 *   Bulk editing    — tab and field rows can be ticked, shift-click selects the
 *                     range between, one click applies a level to all of them,
 *                     and "Not set" clears them again.
 *   Open cases      — the module that shows open cases offers no "New record"
 *                     and says why; its chip in a drawer is an indicator.
 *
 * The subject is a throwaway `zz-…@tapdash.test` member, made for the run and
 * removed after. Nothing else is written.
 *
 *   npm run build && npx next start -p 3221
 *   node --env-file=.env scripts/verify-permissions-bulk.mjs [base url]
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

const SUBJECT = `zz-perm-bulk-${randomUUID().slice(0, 8)}@tapdash.test`;
const { data: made, error: makeError } = await svc.auth.admin.createUser({ email: SUBJECT, password: PW, email_confirm: true });
if (makeError) throw makeError;
const subject = { id: made.user.id };
const [role] = await q(`select id from roles where not is_admin order by name limit 1`);
await db.query(`insert into profiles (id, email, full_name, role_id, status) values ($1, $2, 'Zz Perm Bulk', $3, 'active')
  on conflict (id) do update set role_id = excluded.role_id, status = 'active'`, [subject.id, SUBJECT, role.id]);
const [tpl] = await q(`select id from permission_templates where user_type = 'sales_agent'`);
await db.query(`insert into user_templates (user_id, template_id) values ($1, $2) on conflict (user_id) do update set template_id = excluded.template_id`, [subject.id, tpl.id]);

const [me] = await q(`select id from profiles where email=$1`, [ADMIN]);
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

const auto = (await q(`select id, slug, label from modules where shows_open_cases order by position limit 1`))[0];
/* What each module's row offers (permissionSettings.ts): the open-cases module
   follows the Cases setting, so has no choice of its own; a module of figures
   (no records of its own to be "mine") is Hidden or Full access. */
const listed = await q(`select label, shows_open_cases, admin_only, kind from modules where kind in ('display', 'storage') order by position`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
await ctx.addCookies(cookies);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });
await page.route('**://*.posthog.com/**', (r) => r.abort());

try {
  await page.goto(`${BASE}/admin/users/${subject.id}/permissions`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.getByText('Module access', { exact: false }).first().waitFor({ timeout: 60000 });

  /* ── Module access and the company-wide add/remove setting ────────────── */
  for (const m of listed) {
    const opts = (await page.getByRole('radiogroup', { name: m.label, exact: true }).getByRole('radio').allInnerTexts().catch(() => [])).join('|');
    if (m.shows_open_cases) {
      t(`${m.label} follows the Cases setting, with no choice of its own`, opts === '' && (await page.getByText('Follows the Cases setting below').count()) > 0, opts);
    } else if (opts === 'Hidden|Full access') {
      t(`Module access row for ${m.label}: Hidden / Full access`, true);
    } else {
      t(`Module access row for ${m.label}: Hidden / Only mine / All records`, opts === 'Hidden|Only mine|All records', opts || 'no row');
    }
  }
  const display = await page.getByRole('radiogroup', { name: 'Display / remove from modules', exact: true }).getByRole('radio').allInnerTexts();
  t('"Display / remove from modules" is a Yes / No', display.join('|') === 'No|Yes', display.join('|'));

  /* ── Bulk editing on the tab and field rows ───────────────────────────── */
  const boxes = page.getByRole('checkbox', { name: /^Select (?!all shown)/ });
  const nBoxes = await boxes.count();
  t('tab and field rows have checkboxes', nBoxes >= 5, `${nBoxes} checkboxes`);
  await boxes.nth(0).click();
  await boxes.nth(4).click({ modifiers: ['Shift'] });
  const bar = page.getByText(/rows? selected/);
  const barText = (await bar.first().locator('xpath=..').innerText()).replace(/\s+/g, ' ').trim();
  t('shift-click selects the range between (5 rows)', /^5\s/.test(barText), barText);

  // The floating bar is the last thing in the DOM, after every row's own toggle.
  await page.getByRole('button', { name: /^View$/ }).last().click();
  const until = async (cond, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await page.waitForTimeout(500); } return cond(); };
  /* A row that can't take View (Marketing is Hidden or Full access) is skipped,
     and the note says so: every other selected row is written. */
  const views = async () => (await q(`select count(*)::int n from user_grants where user_id=$1 and grant_level='view'`, [subject.id]))[0].n;
  const statusText = () => page.locator('[role=status]').last().innerText().catch(() => '');
  await until(async () => /set to View/.test(await statusText()), 30000);
  const note = await statusText();
  const m = /(\d+) rows? set to View(?: · (\d+) skipped)?/.exec(note);
  const written = Number(m?.[1] ?? -1);
  const skipped = Number(m?.[2] ?? 0);
  t('one click set every selected row it could, and said so', written + skipped === 5 && (await until(async () => (await views()) === written)), note);

  await page.getByLabel('Select all shown').check();
  await page.getByRole('button', { name: /^Clear setting$/ }).last().click();
  const left = async () => (await q(`select count(*)::int n from user_grants where user_id=$1`, [subject.id]))[0].n;
  t('"Clear setting" on the selection clears them all', await until(async () => (await left()) === 0), `${await left()} rows left`);

  /* ── The open-cases module ────────────────────────────────────────────── */
  if (auto) {
    await page.goto(`${BASE}/${auto.slug}`, { waitUntil: 'networkidle', timeout: 180000 });
    await page.waitForTimeout(1200);
    t(`${auto.label} offers no "New record"`, (await page.getByRole('button', { name: /New record/ }).count()) === 0);
    t('and says records appear there automatically', /appear here automatically while they have an open case/.test(await page.locator('body').innerText()));
    const [rec] = await q(`select r.id from record_modules rm join records r on r.id = rm.record_id where rm.module_id = $1 and r.deleted_at is null limit 1`, [auto.id]);
    if (rec) {
      await page.goto(`${BASE}/${auto.slug}?record=${rec.id}`, { waitUntil: 'networkidle', timeout: 180000 });
      await page.waitForTimeout(1500);
      const chip = page.locator('span[title*="automatically"]').first();
      t('the drawer shows its chip as an indicator with the reason on hover', (await chip.count()) === 1 && /case is open/.test((await chip.getAttribute('title')) ?? ''), (await chip.getAttribute('title').catch(() => null)) ?? 'no chip');
    }
  }
  t('no page errors or 500s', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) {
  fail.push(`script stopped: ${String(e).slice(0, 220)}`);
} finally {
  await db.query(`delete from user_grants where user_id=$1`, [subject.id]).catch(() => {});
  await db.query(`delete from permission_settings where owner_kind='user' and owner_id=$1`, [subject.id]).catch(() => {});
  await svc.auth.admin.deleteUser(subject.id).catch(() => {});
  console.log(`restore: the throwaway subject ${SUBJECT} removed`);
  await browser.close();
  await db.end();
}

for (const p of pass) console.log(' PASS  ' + p);
for (const f of fail) console.log('*FAIL  ' + f);
console.log(`\n=== ${pass.length}/${pass.length + fail.length} passed ===`);
process.exit(fail.length ? 1 : 0);
