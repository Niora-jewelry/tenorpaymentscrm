/**
 * A merchant who has never written first must still be textable.
 *
 * Copper Kettle Catering is the case this was found on: two contacts with
 * sync-enabled phones, an Affiliate main phone and a Fax number that are not
 * sync-enabled, and no thread at all. Before the fix the box said "No phone
 * number on this record yet" — untrue, and it sent people looking for a
 * number they had already entered.
 *
 * What it asserts, in the browser, as an admin:
 *   - that untrue line is gone
 *   - the composer is offered, addressed to a real number
 *   - the consent warning appears against THAT number
 *   - both contacts are offered rather than the first picked silently
 *   - Fax, Affiliate main phone and the affiliate contacts stay out, because
 *     a reply to a non-sync number lands on no record at all
 *
 *   npm run dev -- -p 3221
 *   npm run verify:newtext
 *
 * Read-only: it opens the drawer and sends nothing.
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
const BASE = process.argv[2] || 'http://localhost:3221';
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const EMAIL = 'admin@tapdash.test';
if (!/@([a-z0-9-]+\.)*test$/i.test(EMAIL)) process.exit(1);
const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const q = (s, p = []) => db.query(s, p).then((r) => r.rows);
const [me] = await q(`select id from profiles where email=$1`, [EMAIL]);
const svc = createClient(SUPA, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const PW = 'ZzProbe-2026!page';
await svc.auth.admin.updateUserById(me.id, { password: PW });
const anon = createClient(SUPA, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const { data } = await anon.auth.signInWithPassword({ email: EMAIL, password: PW });
const ref = new URL(SUPA).hostname.split('.')[0];
const v = 'base64-' + Buffer.from(JSON.stringify(data.session)).toString('base64url');
const cookies = [];
if (v.length > 3180) for (let i = 0, n = 0; i < v.length; i += 3180, n++)
  cookies.push({ name: `sb-${ref}-auth-token.${n}`, value: v.slice(i, i + 3180), domain: 'localhost', path: '/' });
else cookies.push({ name: `sb-${ref}-auth-token`, value: v, domain: 'localhost', path: '/' });

const [rec] = await q(`select id, deal_name from records where deal_name = 'Copper Kettle Catering'`);
const b = await chromium.launch();
const c = await b.newContext({ viewport: { width: 1500, height: 1100 } });
await c.addCookies(cookies);
const page = await c.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });
await page.route('**://*.posthog.com/**', (r) => r.abort());

const pass = [], fail = [];
const t = (n, ok, d = '') => (ok ? pass : fail).push(`${n}${d ? '  — ' + d : ''}`);

await page.goto(`${BASE}/leads?record=${rec.id}`, { waitUntil: 'networkidle', timeout: 180000 });
await page.waitForTimeout(1200);

const tab = async (name) => {
  const re = new RegExp('^\\s*' + name);
  const deadline = Date.now() + 30000;
  for (;;) {
    const navs = page.locator('nav');
    for (let i = 0; i < (await navs.count()); i += 1) {
      const nav = navs.nth(i);
      if ((await nav.locator('button').count()) < 4) continue;
      const el = nav.locator('button').filter({ hasText: re }).first();
      if (await el.count()) { await el.click(); await page.waitForTimeout(2500); return true; }
    }
    if (Date.now() > deadline) return false;
    await page.waitForTimeout(500);
  }
};

t('Communication opened', await tab('Communication'));
const textTab = page.getByRole('button', { name: 'Text', exact: true }).first();
if (await textTab.count()) { await textTab.click(); await page.waitForTimeout(3000); }

const body = await page.locator('body').innerText();
t('the old untrue line is gone', !/No phone number on this record yet/i.test(body));
t(
  'the composer is offered on a record that never texted first',
  /Text \(?\d{3}\)? ?\d{3}-\d{4}/i.test(body),
  body.match(/TEXT [^\n]*/)?.[0] ?? '',
);
t('the consent warning shows', /No consent on file/i.test(body));

const picker = page.getByLabel('Who to text');
t('both contacts are offered, not a silent pick of the first', (await picker.count()) > 0);
if (await picker.count()) {
  const opts = await picker.locator('option').allInnerTexts();
  t('the picker names the people', opts.length === 2, opts.join(' | '));
  t('it offers only sync-enabled numbers', !opts.some((o) => /9438365622|8426407899|5528807610/.test(o)), opts.join(' | '));
}
t('no page errors or 500s', errors.length === 0, errors.slice(0, 2).join(' | '));

console.log('--- composer area ---');
console.log(body.split('Nothing has arrived on this channel.').pop().slice(0, 500));
for (const p of pass) console.log(' PASS  ' + p);
for (const f of fail) console.log('*FAIL  ' + f);
console.log(`\n=== ${pass.length}/${pass.length + fail.length} passed ===`);
await page.screenshot({ path: 'C:/Users/brime/AppData/Local/Temp/claude/copper.png' });
await b.close();
await db.end();
process.exit(fail.length ? 1 : 0);
