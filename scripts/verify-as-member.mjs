/**
 * Open every screen a NON-ADMIN can reach, as that person sees it, and report
 * anything that crashes.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 * Every other browser check here signs in as a Super Admin, and a Super Admin
 * bypasses every module, tab, subtab and field permission. So a page that
 * crashes only for a member — a query the permission rules refuse, a tab whose
 * data is fetched although the tab is hidden — can never show up in them. On
 * 15 Oct a member (Maylyn) hit "This page didn't load" repeatedly while doing
 * ordinary data entry, and no check had ever looked at the CRM through her eyes.
 *
 * ── HOW, AND WHY IT IS SAFE ON A LIVE DATABASE ───────────────────────────
 * It uses the app's own admin feature, Users → "Sign in as this user", which
 * is audit-logged under the admin who started it. Nothing about the target
 * account changes: no password reset, no email.
 *
 * And it is READ-ONLY by construction. Once the borrowed session starts, every
 * Server Action request (a POST carrying `next-action`) is aborted in the
 * browser before it leaves, so nothing can be saved under the target's name.
 * The aborted actions are listed, because a screen that fires one just by
 * opening is worth knowing about. The session is ended at the end, whatever
 * happened.
 *
 *   npm run dev -- -p 3221
 *   node --env-file=.env scripts/verify-as-member.mjs maylyn@tapdash.co [http://localhost:3221]
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const TARGET = process.argv[2];
const BASE = process.argv[3] || 'http://localhost:3221';
if (!TARGET) { console.log('usage: verify-as-member.mjs <member email> [base url]'); process.exit(1); }

const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ADMIN = 'admin@tapdash.test';
/* Signs in and resets this account's password — so never a real person. */
if (!/@([a-z0-9-]+\.)*test$/i.test(ADMIN)) process.exit(1);

const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const q = (s, p = []) => db.query(s, p).then((r) => r.rows);

const [target] = await q(
  `select p.id, p.email, r.is_admin from profiles p join roles r on r.id = p.role_id where p.email = $1`, [TARGET]);
if (!target) { console.log(`no such user: ${TARGET}`); process.exit(1); }
if (target.is_admin) { console.log(`${TARGET} is an admin — admins see everything already; nothing to learn.`); process.exit(1); }

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

/* What the target can see: module memberships of records they are on. */
const visible = await q(
  `select r.id, r.deal_name, (select m.slug from record_modules rm join modules m on m.id = rm.module_id
                               where rm.record_id = r.id and not m.admin_only order by m.slug limit 1) slug
     from records r
     join record_team_members t on t.record_id = r.id and t.user_id = $1
    where r.deleted_at is null`, [target.id]);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
await ctx.addCookies(cookies);
const page = await ctx.newPage();

const problems = [];   // { where, what }
const blocked = [];    // server actions refused while borrowed
let where = 'start';
let readOnly = false;

page.on('pageerror', (e) => problems.push({ where, what: `page error: ${String(e).slice(0, 200)}` }));
page.on('response', (r) => {
  if (r.status() >= 500) problems.push({ where, what: `${r.status()} ${r.request().method()} ${r.url().slice(0, 120)}` });
});
await page.route('**/*', (route) => {
  const req = route.request();
  if (/posthog\.com/.test(req.url())) return route.abort();
  if (readOnly && req.method() === 'POST' && req.headers()['next-action']) {
    blocked.push(where);
    return route.abort();
  }
  return route.continue();
});

const crashed = async () => {
  const txt = await page.locator('body').innerText().catch(() => '');
  const m = txt.match(/This page didn.t load[\s\S]{0,200}?Reference:\s*\S+|This page didn.t load|Something went wrong[^\n]*/);
  return m ? m[0].replace(/\s+/g, ' ').slice(0, 160) : null;
};

const look = async (label) => {
  where = label;
  await page.waitForTimeout(1500);
  const c = await crashed();
  if (c) problems.push({ where: label, what: c });
  return !c;
};

let started = false;
try {
  /* ── borrow the session through the app's own feature ──────────────── */
  await page.goto(`${BASE}/admin/users`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.getByRole('button', { name: `Actions for ${TARGET}` }).click();
  await page.getByRole('menuitem', { name: 'Sign in as this user' }).click();
  await page.locator('text=/You are signed in as|signed in as/i').first().waitFor({ timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);
  started = /signed in as/i.test(await page.locator('body').innerText());
  if (!started) throw new Error('impersonation did not start — the banner never appeared');
  readOnly = true;
  console.log(`Browsing as ${TARGET}, read-only. ${visible.length} record(s) visible to them.\n`);

  /* ── every module page in the sidebar ───────────────────────────────── */
  const slugs = (await q(`select slug from modules where not admin_only order by position`)).map((r) => r.slug);
  for (const slug of slugs) {
    await page.goto(`${BASE}/${slug}`, { waitUntil: 'networkidle', timeout: 180000 });
    await look(`/${slug}`);
  }

  /* ── every record, every tab, every subtab ──────────────────────────── */
  for (const rec of visible) {
    if (!rec.slug) continue;
    await page.goto(`${BASE}/${rec.slug}?record=${rec.id}`, { waitUntil: 'networkidle', timeout: 180000 });
    if (!(await look(`${rec.deal_name} (open)`))) continue;

    const strip = page.locator('nav').filter({ has: page.locator('button') }).nth(1);
    const tabNames = (await strip.locator('button').allInnerTexts()).map((t) => t.split('\n')[0].trim()).filter(Boolean);
    for (const name of tabNames) {
      const tabBtn = strip.locator('button').filter({ hasText: new RegExp('^\\s*' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first();
      if (!(await tabBtn.count())) continue;
      await tabBtn.click().catch(() => {});
      if (!(await look(`${rec.deal_name} › ${name}`))) {
        // A crash replaces the drawer; reopen it so the remaining tabs are still checked.
        await page.goto(`${BASE}/${rec.slug}?record=${rec.id}`, { waitUntil: 'networkidle', timeout: 180000 });
        continue;
      }
      // Subtabs, if this tab has a second strip.
      const subStrip = page.locator('nav').nth(2);
      const subs = (await subStrip.count()) ? (await subStrip.locator('button').allInnerTexts()).map((t) => t.split('\n')[0].trim()).filter(Boolean) : [];
      for (const sub of subs.slice(0, 12)) {
        const sb = subStrip.locator('button').filter({ hasText: sub }).first();
        if (!(await sb.count())) continue;
        await sb.click().catch(() => {});
        await look(`${rec.deal_name} › ${name} › ${sub}`);
      }
    }
  }
} catch (e) {
  problems.push({ where, what: `script stopped: ${String(e).slice(0, 200)}` });
} finally {
  /* Give the session back, whatever happened above. */
  readOnly = false;
  if (started) {
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle', timeout: 180000 }).catch(() => {});
    const exit = page.getByRole('button', { name: 'Return to my account' }).first();
    if (await exit.count()) { await exit.click().catch(() => {}); await page.waitForTimeout(3000); }
    /*
     * Asked of the audit log, not the page. Reading the banner text right
     * after the click reported "may still be active" every time — the page
     * had not finished navigating — while the log showed each session ended.
     * The log is the record that matters.
     */
    const [last] = await q(
      `select event_type::text e from auth_audit_log
        where event_type::text like 'impersonation_%' and actor_id = $1
        order by created_at desc limit 1`, [me.id]);
    console.log(last?.e === 'impersonation_ended'
      ? 'Session handed back (impersonation_ended is in the audit log).'
      : `⚠ the audit log's last impersonation event is ${last?.e ?? 'missing'} — check Users.`);
  }
  await browser.close();
  await db.end();
}

const uniqBlocked = [...new Set(blocked)];
console.log(`\n${uniqBlocked.length} screen(s) tried to save something just by being opened (blocked, read-only):`);
for (const b of uniqBlocked.slice(0, 20)) console.log('   · ' + b);

console.log(`\n${problems.length ? '*' : ' '}${problems.length} problem(s) seen as ${TARGET}:`);
for (const p of problems) console.log(`   ✗ ${p.where}\n       ${p.what}`);
process.exit(problems.length ? 1 : 0);
