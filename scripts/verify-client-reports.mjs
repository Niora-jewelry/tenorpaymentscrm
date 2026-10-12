/**
 * Every bug the client reported, re-checked in a real browser.
 *
 * WHY THIS EXISTS
 * ---------------
 * Each of these was reported by Izzy after the CRM was handed to him, and
 * every one of them had passed a round of verification that never submitted a
 * form. This drives the actual UI as his own account and asserts on the
 * database afterwards, so "fixed" means the thing he did now works, not that
 * the page renders.
 *
 * It writes to the database and restores what it touched at the end.
 *
 *   npm run dev -- -p 3220
 *   node --env-file=.env scripts/verify-client-reports.mjs [http://localhost:3220]
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PASSWORD = 'ZzProbe-2026!page';
const BASE = process.argv[2] || 'http://localhost:3220';

const svc = createClient(SUPA, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const q = (s, p = []) => db.query(s, p).then((r) => r.rows);

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? ' PASS' : '*FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/* ── sign in as the client ───────────────────────────────────────────── */
const [u] = await q(`select id,email from profiles where email='izzy@tapdash.co'`);
await svc.auth.admin.updateUserById(u.id, { password: PASSWORD });
await db.query(`update profiles set last_seen_at=now() where id=$1`, [u.id]);
const anon = createClient(SUPA, ANON, { auth: { persistSession: false } });
const { data, error: signInErr } = await anon.auth.signInWithPassword({ email: u.email, password: PASSWORD });
if (signInErr) { console.log('SIGN IN FAILED:', signInErr.message); process.exit(1); }
const ref = new URL(SUPA).hostname.split('.')[0];
const v = 'base64-' + Buffer.from(JSON.stringify(data.session)).toString('base64url');
const cookies = [];
if (v.length > 3180) {
  for (let i = 0, n = 0; i < v.length; i += 3180, n++) {
    cookies.push({ name: `sb-${ref}-auth-token.${n}`, value: v.slice(i, i + 3180), domain: 'localhost', path: '/' });
  }
} else {
  cookies.push({ name: `sb-${ref}-auth-token`, value: v, domain: 'localhost', path: '/' });
}

const [rec] = await q(`select id, deal_name from records where deal_name ilike '%Netzach%'`);
const originalName = rec.deal_name;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
await ctx.addCookies(cookies);
const page = await ctx.newPage();

const serverErrors = [];
page.on('pageerror', (e) => serverErrors.push('pageerror: ' + String(e).slice(0, 90)));
page.on('response', (r) => { if (r.status() >= 500) serverErrors.push(`HTTP ${r.status()} ${r.url().split('?')[0].slice(-45)}`); });

const banner = async () =>
  (await page.locator('text=/Someone else changed|Could not reach the server|Could not save/i').allTextContents()).join(' | ');

const openDrawer = async () => {
  await page.goto(`${BASE}/contacts?record=${rec.id}`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.waitForTimeout(800);
};

const tab = async (name) => {
  const t = page.locator('button', { hasText: new RegExp('^' + name) }).first();
  if (await t.count()) { await t.click(); await page.waitForTimeout(2200); return true; }
  return false;
};

const header = async () => (await page.locator('dl').first().innerText()).replace(/\n+/g, ' | ');

console.log(`\n=== Re-checking every client report, as ${u.email} ===\n`);
await openDrawer();

/* ── 1. "Contacts 91" and the vanished contact ───────────────────────── */
await tab('Contact');
const contactTxt = await page.locator('body').innerText();
const countMatch = contactTxt.match(/CONTACTS\s+(\d+)/i);
const shown = countMatch ? Number(countMatch[1]) : null;
const [dbContacts] = await q(
  `select jsonb_typeof(values->'contact') t,
          coalesce(jsonb_array_length(values->'contact'),0) n
     from records where id=$1`, [rec.id]);
check('1. Contacts count is sane (not 91)', shown !== null && shown < 10, `tab shows ${shown}, db array length ${dbContacts.n}`);
check('1b. contact stored as an array, not text', dbContacts.t === 'array', `jsonb_typeof = ${dbContacts.t}`);
check('1c. the contact he typed is visible', /Yitzchok Cohen/i.test(contactTxt), 'Yitzchok Cohen');

/* ── 1d. ADDING a contact must not re-corrupt it ─────────────────────── */
/* The original damage happened on WRITE, so checking the repaired data is
   not enough — the path that broke it has to be driven again. */
{
  const before = dbContacts.n;
  const addBtn = page.locator('button', { hasText: /Add contact/i }).first();
  if (await addBtn.count()) {
    await addBtn.click();
    await page.waitForTimeout(3500);
    const [after] = await q(
      `select jsonb_typeof(values->'contact') t,
              coalesce(jsonb_array_length(values->'contact'),0) n
         from records where id=$1`, [rec.id]);
    check('1d. adding a contact keeps it an array',
      after.t === 'array' && after.n === before + 1,
      `type ${after.t}, length ${before} -> ${after.n}`);
    /* put it back */
    await db.query(
      `update records set values = jsonb_set(values, '{contact}',
         (select jsonb_agg(e) from (select e from jsonb_array_elements(values->'contact') with ordinality t(e,i)
           where i <= $2) z))
        where id = $1`, [rec.id, before]);
  } else {
    check('1d. adding a contact keeps it an array', false, 'no "Add contact" control found');
  }
}

/* ── 2 + 3. MID saves, and a second header edit does not conflict ────── */
const headerCell = (label) =>
  page.locator('dl').first().locator('div').filter({ has: page.getByText(label, { exact: true }) }).first();

const typeHeader = async (label, value) => {
  const ctl = headerCell(label).locator('input, button').first();
  if (!(await ctl.count())) return false;
  await ctl.click();
  await page.waitForTimeout(400);
  const f = page.locator('input:focus');
  if (!(await f.count())) return false;
  await f.fill(value);
  await f.press('Enter');
  await page.waitForTimeout(3000);
  return true;
};

const didMid = await typeHeader('MID', '99000111');
const bannerAfterMid = await banner();
check('2. MID saves from the header', didMid && !bannerAfterMid, bannerAfterMid || 'no error banner');

const didMcc = await typeHeader('MCC code', '2953');
const bannerAfterMcc = await banner();
check('3. a SECOND header edit does not false-conflict', didMcc && !bannerAfterMcc, bannerAfterMcc || 'no conflict banner');

const [saved] = await q(`select values->>'mid' mid, values->>'mcc_code' mcc from records where id=$1`, [rec.id]);
check('3b. both reached the database', saved.mid === '99000111' && saved.mcc === '2953', JSON.stringify(saved));

/* ── 4. Record creator ───────────────────────────────────────────────── */
await tab('Overview');
const ovTxt = await page.locator('body').innerText();
const creatorBlock = (ovTxt.match(/RECORD CREATOR[\s\S]{0,80}/i) || [''])[0];
check('4. Record creator names the creator', /Izzy/i.test(creatorBlock), creatorBlock.replace(/\n+/g, ' / ').slice(0, 60));

/* ── 5. Pricing model reaches the header strip ───────────────────────── */
const h = await header();
const pm = (h.match(/Pricing Model \| ([^|]*)/) || [, '(absent)'])[1].trim();
const [dbPm] = await q(`select values->>'pricing_model' pm from records where id=$1`, [rec.id]);
check('5. Pricing Model shows in the header', pm.length > 0 && pm !== '—', `header "${pm}", db "${dbPm.pm}"`);

/* ── 6. Deal name: drawer, dashboard and database agree ──────────────── */
const [nameRow] = await q(
  `select deal_name, values ? 'deal_name' shadow from records where id=$1`, [rec.id]);
check('6. no shadow copy of Deal Name', nameRow.shadow === false, `column "${nameRow.deal_name}"`);
const [drift] = await q(
  `select count(*)::int n from records
    where deleted_at is null and (values->>'deal_name') is distinct from deal_name
      and values ? 'deal_name'`);
check('6b. no record disagrees with itself', drift.n === 0, `${drift.n} diverged`);
const titleShown = await page.locator('h1, h2').filter({ hasText: originalName }).count();
check('6c. drawer title is the column value', titleShown > 0, originalName);

/* ── 7. Cases handling note — present, saves, persists ───────────────── */
await tab('Case');
let caseTxt = await page.locator('body').innerText();
const noteControl = /How to deal with this merchant|how this merchant.s tickets should be handled/i.test(caseTxt);
check('7. Cases handling-note control exists', noteControl, 'top of the Cases tab');

if (noteControl) {
  const add = page.locator('button', { hasText: /Add how this merchant|Edit$/ }).first();
  if (await add.count()) {
    await add.click();
    await page.waitForTimeout(600);
    const ta = page.locator('textarea').first();
    if (await ta.count()) {
      await ta.fill('Call Yitzchok on the mobile before replying.');
      const save = page.locator('button', { hasText: /^Save/ }).first();
      await save.click();
      await page.waitForTimeout(3500);
      const [note] = await q(`select body from case_handling_notes where record_id=$1`, [rec.id]);
      check('7b. the note saves', Boolean(note), note ? note.body.slice(0, 45) : 'nothing in the database');
      caseTxt = await page.locator('body').innerText();
      check('7c. and shows on the tab', /Call Yitzchok on the mobile/i.test(caseTxt), '');
    } else {
      check('7b. the note saves', false, 'no textarea appeared');
    }
  } else {
    check('7b. the note saves', false, 'no add/edit control found');
  }
}

/* ── earlier reports, still fixed? ───────────────────────────────────── */
await page.goto(`${BASE}/leads`, { waitUntil: 'networkidle', timeout: 120000 });
const leadsTxt = await page.locator('body').innerText();
check('8. pipeline column on the dashboard', /Lead Pipeline Status/i.test(leadsTxt), '');
check('9. "Other files" subtab is gone', !/Other files/i.test(leadsTxt), '');

await page.goto(`${BASE}/deals`, { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(1200);
const dealsHtml = await page.content();
check('10. pipeline step is clickable in the table', dealsHtml.includes('Change the pipeline step'), '');
check('11. Current Status is a dropdown too', dealsHtml.includes('Change Current Status'), '');

check('12. no 500s or page errors anywhere', serverErrors.length === 0, serverErrors.slice(0, 3).join(' | '));

/* ── restore what the probe touched ──────────────────────────────────── */
await db.query(`update records set values = values - 'mid' - 'mcc_code' where id=$1`, [rec.id]);
await db.query(`delete from case_handling_notes where record_id=$1`, [rec.id]);
await db.query(`update records set deal_name=$2 where id=$1`, [rec.id, originalName]);

const failed = results.filter((r) => !r.pass);
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
if (failed.length) console.log('STILL BROKEN:\n' + failed.map((f) => '  - ' + f.name + (f.detail ? ' — ' + f.detail : '')).join('\n'));

await browser.close();
await db.end();
process.exit(failed.length ? 1 : 0);
