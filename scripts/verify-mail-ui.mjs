/**
 * The Email page in a real browser, against the mock Microsoft: two
 * connected mailboxes (one shared), threads, quoted history, remote and
 * inline images, attachments, search, filters, folders, keyboard, live
 * updates, the sidebar badge and a member's first-run screen.
 *
 * Screenshots go to MAIL_UI_SHOTS (a directory) when set.
 * Writes only *@mock.test mailboxes and the admin test account's mock
 * identities, and removes them; every mail_* count is compared before/after.
 *
 *   CRON_SECRET=… MAIL_UI_SHOTS=… node --env-file=.env scripts/verify-mail-ui.mjs
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const BASE = process.argv[2] || 'http://localhost:3221';
const MOCK = process.env.MAIL_MOCK_BASE_URL || 'http://127.0.0.1:4555';
const CRON = process.env.CRON_SECRET;
const SHOTS = process.env.MAIL_UI_SHOTS || '';
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ADMIN = 'admin@tapdash.test';
const MEMBER = 'demo.rep@tapdash.test';
const OWNER = 'owner@mock.test';
const TEAM = 'team@mock.test';
if (!CRON) process.exit(1);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const q = (s, p = []) => db.query(s, p).then((r) => r.rows);
const one = async (s, p = []) => (await q(s, p))[0];
const MAIL_TABLES = (await q(`select table_name t from information_schema.tables where table_schema='public' and table_name like 'mail\\_%' order by 1`)).map((r) => r.t);
const counts = async () => {
  const out = {};
  for (const t of MAIL_TABLES) out[t] = (await one(`select count(*)::int n from public.${t}`)).n;
  return out;
};
const before = await counts();
const healthBefore = await one(`select state, last_success_at, down_since, last_error_code from mail_provider_health where id=1`);

const seen = {};
for (const e of [ADMIN, MEMBER]) seen[e] = (await one(`select last_seen_at from profiles where email=$1`, [e])).last_seen_at;
await db.query(`update profiles set last_seen_at = now() where email = any($1)`, [[ADMIN, MEMBER]]);

const mock = (p, body) => fetch(`${MOCK}${p}`, { method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const svc = createClient(SUPA, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = createClient(SUPA, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const ref = new URL(SUPA).hostname.split('.')[0];
async function cookiesFor(email) {
  const u = await one(`select id from profiles where email=$1`, [email]);
  await svc.auth.admin.updateUserById(u.id, { password: 'ZzProbe-2026!mail' });
  const { data } = await anon.auth.signInWithPassword({ email, password: 'ZzProbe-2026!mail' });
  const v = 'base64-' + Buffer.from(JSON.stringify(data.session)).toString('base64url');
  const out = [];
  if (v.length > 3180) for (let i = 0, n = 0; i < v.length; i += 3180, n++) out.push({ name: `sb-${ref}-auth-token.${n}`, value: v.slice(i, i + 3180), domain: 'localhost', path: '/' });
  else out.push({ name: `sb-${ref}-auth-token`, value: v, domain: 'localhost', path: '/' });
  return { id: u.id, cookies: out };
}
const admin = await cookiesFor(ADMIN);
const cleanRate = () => db.query(`delete from rate_limit_counters where key like $1 or key like 'mail_tick:%'`, [`mail_%:user:${admin.id}`]);
await cleanRate();

const pass = [], fail = [];
const t = (n, ok, d = '') => (ok ? pass : fail).push(`${n}${d ? '  — ' + d : ''}`);
const tick = () => fetch(`${BASE}/api/mail/tick`, { headers: { Authorization: `Bearer ${CRON}` } });
async function syncAll(ms = 150000) {
  await tick();
  const end = Date.now() + ms;
  await sleep(1500);
  while (Date.now() < end) {
    const s = await one(`select count(*)::int due from mail_sync_queue q join mail_mailboxes m on m.id=q.mailbox_id
                          where m.address like '%@mock.test' and q.processed_at is null and q.not_before <= now()`);
    const l = await one(`select count(*)::int n from mail_mailboxes where address like '%@mock.test' and lease_until > now()`);
    if (s.due === 0 && l.n === 0) return;
    if (l.n === 0) await tick();
    await sleep(1200);
  }
  throw new Error('sync never went idle');
}

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const ann = { from: 'ann@client.example', fromName: 'Ann Client' };

process.on('unhandledRejection', (e) => fail.push(`unhandled: ${e}`));
const browser = await chromium.launch();
const errors = [];
const consoleErrors = [];
async function session(cookies) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/upgrade-insecure-requests|status of 403|status of 401|posthog/i.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });
  await page.route('**://*.posthog.com/**', (r) => r.abort());
  return page;
}
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(300);
  }
  return fn().catch(() => null);
}
const listSettled = (page) => page.waitForSelector('[aria-label="Loading conversations"]', { state: 'detached', timeout: 20000 }).catch(() => {});
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
const frameText = async (page, nth = 0) => {
  const f = page.frameLocator('article iframe').nth(nth);
  return (await f.locator('body').textContent({ timeout: 15000 }).catch(() => '')) ?? '';
};

try {
  await mock('/__mock/reset', {});
  // ── a believable inbox ────────────────────────────────────────────────
  await mock('/__mock/message', { mailbox: OWNER, ...ann, subject: 'Q4 pricing for Acme', conversationId: 'conv-q4', receivedDaysAgo: 2, isRead: true,
    body: '<p>Hi Olive, could you send the Q4 schedule for Acme?</p><p>Ann</p>' });
  await mock('/__mock/message', { mailbox: OWNER, folder: 'sentitems', from: OWNER, fromName: 'Olive Owner', to: [{ name: 'Ann Client', address: 'ann@client.example' }],
    subject: 'RE: Q4 pricing for Acme', conversationId: 'conv-q4', receivedDaysAgo: 1, isRead: true,
    body: '<p>Hi Ann, attached is the updated schedule.</p>', attachments: [{ name: 'Acme-pricing-Q4.pdf', size: 184000 }] });
  await mock('/__mock/message', { mailbox: OWNER, ...ann, subject: 'RE: Q4 pricing for Acme', conversationId: 'conv-q4', receivedDaysAgo: 0.05,
    cc: [{ name: 'Ben Ops', address: 'ben@client.example' }],
    body: '<p>Thanks — confirming the <b>2.4%</b> rate works for us. Signed copy to follow.</p><div id="appendonsend"></div><hr style="display:inline-block;width:98%"><div id="divRplyFwdMsg"><b>From:</b> Olive Owner<br><b>Sent:</b> Sunday</div><p>Hi Ann, attached is the updated schedule.</p>' });
  await mock('/__mock/message', { mailbox: OWNER, from: 'disputes@processor.example', fromName: 'Processor Disputes', importance: 'high', receivedDaysAgo: 0.02,
    subject: 'Chargeback dispute — response due Friday', body: '<p>A chargeback of <b>$412.00</b> was filed for merchant MID 4410. Respond by Friday.</p>' });
  await mock('/__mock/message', { mailbox: OWNER, from: 'news@saas.example', fromName: 'Payments Weekly', receivedDaysAgo: 0.2, isRead: true,
    subject: 'This week in payments: interchange changes',
    body: '<table width="600"><tr><td><img src="https://cdn.saas.example/hero.png" alt="Payments Weekly"><h1 style="font-family:Georgia">This week in payments</h1><p>Interchange updates land in April.</p><img src="https://t.saas.example/open.gif" width="1" height="1"></td></tr></table>' });
  await mock('/__mock/message', { mailbox: OWNER, from: 'design@studio.example', fromName: 'Studio Nine', receivedDaysAgo: 3,
    subject: 'Logo for the new statement header', body: '<p>Here is the logo inline:</p><p><img src="cid:logo@studio" alt="TapDash logo"></p>',
    attachments: [{ name: 'logo.png', isInline: true, contentId: 'logo@studio', contentType: 'image/png', bytes: PNG, size: 68 }] });
  const senders = [['Marcus Lee', 'marcus@northwind.example'], ['Priya Shah', 'priya@contoso.example'], ['Support', 'support@gateway.example'], ['Dana Ortiz', 'dana@fabrikam.example']];
  for (let i = 0; i < 12; i += 1) {
    const [n, a] = senders[i % senders.length];
    await mock('/__mock/message', { mailbox: OWNER, from: a, fromName: n, receivedDaysAgo: 1.2 + i * 0.9, isRead: i % 3 !== 0,
      subject: ['Statement question', 'Terminal swap', 'Residual report for September', 'Onboarding docs'][i % 4] + (i > 3 ? ` (${i})` : ''),
      body: `<p>Message ${i} from ${n}.</p>` });
  }
  await mock('/__mock/message', { mailbox: OWNER, folder: 'clients', from: 'ceo@acme.example', fromName: 'Acme CEO', receivedDaysAgo: 0.5, subject: 'Signed application' });
  await mock('/__mock/message', { mailbox: TEAM, from: 'webform@tapdash.example', fromName: 'Website lead', receivedDaysAgo: 0.1, subject: 'New lead: Corner Bakery (3 locations)' });
  await mock('/__mock/message', { mailbox: TEAM, from: 'webform@tapdash.example', fromName: 'Website lead', receivedDaysAgo: 1.5, isRead: true, subject: 'New lead: Riverside Auto' });

  // ── connect both mailboxes, sync ──────────────────────────────────────
  const page = await session(admin.cookies);
  for (const target of [null, TEAM]) {
    await page.goto(`${BASE}/email/settings`, { waitUntil: 'networkidle', timeout: 180000 });
    if (target) {
      await page.fill('#shared-address', target);
      await page.getByRole('button', { name: 'Connect', exact: true }).click();
    } else await page.getByRole('button', { name: 'Connect Outlook' }).click();
    await page.waitForURL(/oauth2\/v2\.0\/authorize/);
    await page.click(`a[data-account="${OWNER}"]`);
    await page.waitForURL(/\/email\/settings/, { timeout: 90000 });
  }
  await syncAll();

  // ── first paint ───────────────────────────────────────────────────────
  await page.goto(`${BASE}/email`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.waitForTimeout(800);
  await shot(page, '1-all-inboxes');
  const unreadDb = (await one(`select coalesce(sum(f.unread_count),0)::int n from mail_folders f join mail_mailboxes m on m.id=f.mailbox_id where m.address like '%@mock.test' and f.well_known='inbox'`)).n;
  const nav = page.locator('nav a[href="/email"]');
  t('sidebar: Email entry with the unread count', (await nav.count()) > 0 && (await nav.textContent()).includes(String(unreadDb)), `${await nav.textContent().catch(() => '')} vs ${unreadDb}`);
  t('two mailboxes → opens on All inboxes', await page.getByRole('heading', { name: 'All inboxes' }).isVisible());
  t('folder pane lists both mailboxes', (await page.getByText(OWNER).count()) > 0 && (await page.getByText(TEAM).count()) > 0);
  t('shared mailbox marked Shared', await page.locator('nav[aria-label="Mail folders"]').getByText('Shared', { exact: true }).isVisible());
  const groups = await page.locator('[role="group"]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  t('list grouped by day, Today first', groups[0] === 'Today' && groups.includes('Yesterday'), groups.join(' · '));
  t('All inboxes rows from both mailboxes',
    (await page.locator('[role="option"]', { hasText: 'New lead: Corner Bakery (3 locations)' }).count()) === 1 &&
      (await page.locator('[role="option"]', { hasText: 'Chargeback dispute — response due Friday' }).count()) === 1);
  t('high importance flagged', await page.locator('[role="option"]', { hasText: 'Chargeback dispute' }).locator('[title="High importance"]').isVisible());
  const q4 = page.locator('[role="option"]', { hasText: 'Q4 pricing for Acme' });
  // Counted within the folder, as Outlook does: 2 in Inbox (the third is in Sent Items).
  t('conversation shows its in-folder message count', /Q4 pricing for Acme\s*2/.test(await q4.textContent()));

  // ── reading a thread ──────────────────────────────────────────────────
  await q4.click();
  await page.waitForSelector('article iframe', { timeout: 20000 });
  await page.waitForTimeout(1200);
  await shot(page, '2-thread');
  t('URL carries the open conversation', /[?&]c=[0-9a-f-]{36}(~|%7E)conv-q4/.test(page.url()), page.url());
  const sandbox = await page.locator('article iframe').first().getAttribute('sandbox');
  t('body frame sandbox exact, no scripts', sandbox === 'allow-same-origin allow-popups allow-popups-to-escape-sandbox', sandbox ?? '');
  const newest = await frameText(page, 0);
  t('newest message expanded and rendered', newest.includes('confirming the 2.4% rate'));
  t('quoted history hidden by default', !newest.includes('updated schedule'));
  await page.getByRole('button', { name: 'Show quoted text' }).first().click();
  await page.waitForTimeout(600);
  t('quoted history on request', (await frameText(page, 0)).includes('attached is the updated schedule'));
  t('Cc shown in the recipient line', (await page.locator('article').textContent()).includes('Ben Ops'));
  t('message from Sent Items carries its folder chip', (await page.locator('article li', { hasText: 'Olive Owner' }).getByText('Sent Items').count()) > 0);
  await page.locator('article li', { hasText: 'Olive Owner' }).locator('button').first().click();
  await page.waitForTimeout(1500);
  const link = page.getByRole('link', { name: /Download Acme-pricing-Q4\.pdf/ });
  const href = await link.getAttribute('href', { timeout: 15000 }).catch(() => null);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }).catch(() => null),
    link.click({ timeout: 15000 }).catch(() => null),
  ]);
  const { readFileSync } = await import('node:fs');
  const dlPath = download ? await download.path().catch(() => null) : null;
  t('attachment downloads with its name, bytes from Outlook',
    !!download && download.suggestedFilename() === 'Acme-pricing-Q4.pdf' && !!dlPath && readFileSync(dlPath).toString().startsWith('%PDF'),
    download ? download.suggestedFilename() : `no download (href ${href})`);
  const head = await page.request.get(`${BASE}${href}`);
  t('download served as octet-stream attachment, nosniff', head.headers()['content-type'] === 'application/octet-stream' && /^attachment;/.test(head.headers()['content-disposition'] ?? '') && head.headers()['x-content-type-options'] === 'nosniff', `${head.status()} ${head.headers()['content-type']}`);

  // ── remote images blocked until asked ─────────────────────────────────
  await page.locator('[role="option"]', { hasText: 'This week in payments' }).click();
  await page.waitForSelector('article iframe');
  await page.waitForTimeout(1000);
  t('remote images blocked, reader told how many', await page.getByText('2 remote images are hidden').isVisible());
  const srcBefore = await page.frameLocator('article iframe').first().locator('img').evaluateAll((imgs) => imgs.map((i) => i.getAttribute('src')));
  t('no remote src in the frame before asking', srcBefore.every((s) => s === null), JSON.stringify(srcBefore));
  await shot(page, '3-images-blocked');
  await page.getByRole('button', { name: 'Show images' }).click();
  await page.waitForTimeout(800);
  const srcAfter = await page.frameLocator('article iframe').first().locator('img').evaluateAll((imgs) => imgs.map((i) => i.getAttribute('src')));
  t('after "Show images" they go through our proxy only', srcAfter.length === 2 && srcAfter.every((s) => /^\/api\/mail\/image\?m=[0-9a-f-]{36}&n=\d$/.test(s ?? '')), JSON.stringify(srcAfter));
  const proxied = await page.evaluate(async (u) => {
    const r = await fetch(u, { cache: 'no-store' });
    return { status: r.status, type: r.headers.get('content-type'), body: (await r.text()).slice(0, 60) };
  }, srcAfter[0]);
  t('proxy refuses a host that does not resolve publicly (SSRF guard)', proxied.status === 403, JSON.stringify(proxied));

  // ── inline cid image ──────────────────────────────────────────────────
  await page.locator('[role="option"]', { hasText: 'Logo for the new statement header' }).click();
  await page.waitForSelector('article iframe');
  const inline = (await until(async () => {
    const v = await page.frameLocator('article iframe').first().locator('img').evaluate((i) => ({ src: i.getAttribute('src'), w: i.naturalWidth }));
    return v.w > 0 ? v : null;
  }, 20000)) ?? (await page.frameLocator('article iframe').first().locator('img').evaluate((i) => ({ src: i.getAttribute('src'), w: i.naturalWidth })));
  t('inline cid: image served from our origin and loaded', /^\/api\/mail\/inline\/[0-9a-f-]{36}\?cid=logo%40studio$/.test(inline.src ?? '') && inline.w === 1, JSON.stringify(inline));

  // ── search, filters, folders, keyboard ────────────────────────────────
  await page.getByLabel('Search mail').fill('pricing acm');
  const found = await page.locator('[role="option"]', { hasText: 'Q4 pricing for Acme' }).first().waitFor({ timeout: 15000 }).then(() => true, () => false);
  t('search: prefix words find the thread', found && (await page.locator('[role="option"]').count()) === 1, String(await page.locator('[role="option"]').count()));
  await shot(page, '4-search');
  await page.getByLabel('Search mail').fill('zzqqxx');
  t('search: honest empty state', await page.getByText('Nothing matches “zzqqxx”.').waitFor({ timeout: 15000 }).then(() => true, () => false));
  await page.getByLabel('Search mail').press('Escape');
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Unread', exact: true }).click();
  await page.waitForTimeout(300);
  await listSettled(page);
  const unreadRows = await page.locator('[role="option"]').allTextContents();
  t('Unread filter: no fully-read conversation listed', unreadRows.length > 0 && !unreadRows.some((r) => r.includes('This week in payments')), String(unreadRows.length));
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.waitForTimeout(300);
  await listSettled(page);

  await page.locator('nav[aria-label="Mail folders"]').getByRole('button', { name: /^Clients(,|$)/ }).first().click();
  await page.waitForTimeout(1500);
  t('folder: Clients lists its mail, URL updated', (await page.getByText('Signed application').count()) > 0 && /[?&]f=[0-9a-f-]{36}/.test(page.url()));
  await page.locator('nav[aria-label="Mail folders"]').getByRole('button', { name: /^Inbox(,|$)/ }).first().click();
  await page.waitForTimeout(1500);
  const firstRow = page.locator('[role="option"]').first();
  await firstRow.click();
  await page.waitForTimeout(500);
  const sel1 = await page.locator('[role="option"][aria-selected="true"]').textContent();
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(800);
  const sel2 = await page.locator('[role="option"][aria-selected="true"]').textContent();
  t('↓ moves to the next conversation', !!sel1 && !!sel2 && sel1 !== sel2);
  await page.goBack();
  const backOk = await page.getByText('Signed application').first().waitFor({ timeout: 15000 }).then(() => true, () => false);
  t('Back returns to the previous folder', backOk,
    `${page.url().replace(BASE, '')} · heading ${await page.locator('section h2').first().textContent().catch(() => '?')} · rows ${await page.locator('[role="option"]').count()} · skeleton ${await page.locator('[aria-label="Loading conversations"]').count()}`);

  // ── stays current without a reload ────────────────────────────────────
  await page.locator('nav[aria-label="Mail folders"]').getByRole('button', { name: /^Inbox(,|$)/ }).first().click();
  await page.waitForTimeout(1000);
  await mock('/__mock/message', { mailbox: OWNER, from: 'marcus@northwind.example', fromName: 'Marcus Lee', subject: 'Arrived while you watched' });
  await db.query(`update mail_folders set delta_synced_at = now() - interval '2 hours' where mailbox_id in (select id from mail_mailboxes where address like '%@mock.test')`);
  await syncAll();
  let appeared = false;
  for (let i = 0; i < 40 && !appeared; i += 1) {
    await sleep(1000);
    appeared = (await page.getByText('Arrived while you watched').count()) > 0;
  }
  t('new mail appears on its own (poll, no reload)', appeared);
  await shot(page, '5-folder-inbox');

  // ── a member with no mailbox ──────────────────────────────────────────
  const member = await cookiesFor(MEMBER);
  const mp = await session(member.cookies);
  await mp.goto(`${BASE}/email`, { waitUntil: 'networkidle', timeout: 180000 });
  await shot(mp, '6-member-first-run');
  t('member without a mailbox: first-run screen', await mp.getByText('Bring your Outlook mail into TapDash').isVisible());
  t('member sees no one else’s mail', (await mp.getByText('Q4 pricing for Acme').count()) === 0);
  await db.query(`delete from rate_limit_counters where key like $1`, [`mail_%:user:${member.id}`]);
} catch (e) {
  fail.push(`threw: ${e.stack ?? e}`);
} finally {
  await browser.close();
  for (const e of [ADMIN, MEMBER]) await db.query(`update profiles set last_seen_at = $2 where email=$1`, [e, seen[e]]).catch(() => {});
  await db.query(`delete from mail_mailboxes where address like '%@mock.test'`);
  await db.query(`delete from mail_identities where user_id = $1 and microsoft_user_id like 'oid-%'`, [admin.id]);
  await db.query(`update mail_provider_health set state=$1, last_success_at=$2, down_since=$3, last_error_code=$4 where id=1`,
    [healthBefore.state, healthBefore.last_success_at, healthBefore.down_since, healthBefore.last_error_code]);
  await cleanRate();
  await mock('/__mock/reset', {}).catch(() => {});
  const after = await counts();
  const drift = MAIL_TABLES.filter((x) => after[x] !== before[x]);
  t('every mail_* table back to its starting count', drift.length === 0, drift.map((d) => `${d} ${before[d]}→${after[d]}`).join(', '));
  t('no page errors / 5xx', errors.length === 0, errors.join(' | ').slice(0, 400));
  t('no console errors', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 400));
  await db.end();
}

console.log(`\nPASS ${pass.length}`);
for (const p of pass) console.log('  ✓ ' + p);
console.log(`FAIL ${fail.length}`);
for (const f of fail) console.log('  ✗ ' + f);
process.exit(fail.length ? 1 : 0);
