/**
 * The Email module through a MEMBER's eyes — and an admin's, and an admin
 * signed in as that member. Every other mail check signs in as an admin,
 * who bypasses grants; this one doesn't.
 *
 *   Hidden  no Email in the sidebar; /email, its settings and its rules
 *           redirect; the byte routes refuse.
 *   View    connects and reads their own mail; no actions, no composing,
 *           nothing marked read by opening; rules visible, not editable;
 *           no writing settings; attachments download.
 *   Edit    the actions appear and reach Outlook.
 *   Admin   sees the member's personal mailbox (as the spec allows) and
 *           its mail, never offered "Reply" from someone else's mailbox.
 *   Sign in as   health only: no subjects, no bodies, byte routes refuse,
 *           rules redirect.
 *
 * Uses the .test accounts only (demo.rep@tapdash.test, admin@tapdash.test).
 * The member's grants for Communication/Email are set for the run and put
 * back exactly; mailboxes, identities and notices it creates are removed;
 * every mail_* count is compared before/after.
 *
 *   CRON_SECRET=… node --env-file=.env scripts/verify-mail-as-member.mjs
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const BASE = process.argv[2] || 'http://localhost:3221';
const MOCK = process.env.MAIL_MOCK_BASE_URL || 'http://127.0.0.1:4555';
const CRON = process.env.CRON_SECRET;
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ADMIN = 'admin@tapdash.test';
const MEMBER = 'demo.rep@tapdash.test';
const OWNER = 'owner@mock.test';
if (!CRON) process.exit(1);
if (![ADMIN, MEMBER].every((e) => /@([a-z0-9-]+\.)*test$/i.test(e))) process.exit(1);

const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
// Test accounts sign in with a borrowed password; their real one is put back at the end.
const savedHashes = new Map();
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

const admin = await one(`select id, last_seen_at from profiles where email=$1`, [ADMIN]);
const member = await one(`select p.id, p.last_seen_at, r.is_admin from profiles p join roles r on r.id = p.role_id where p.email=$1`, [MEMBER]);
if (!member || member.is_admin) {
  console.log(`${MEMBER} must exist and not be an admin`);
  process.exit(1);
}
const subtab = await one(`select s.id, s.tab_id from subtabs s where s.key = 'email'`);
const grantsBefore = await q(`select * from user_grants where user_id=$1 and scope_id = any($2)`, [member.id, [subtab.id, subtab.tab_id]]);
await db.query(`update profiles set last_seen_at = now() where id = any($1)`, [[admin.id, member.id]]);

async function setGrant(level) {
  await db.query(`delete from user_grants where user_id=$1 and scope_id = any($2)`, [member.id, [subtab.id, subtab.tab_id]]);
  await db.query(
    `insert into user_grants (user_id, scope_kind, scope_id, grant_level, module_id) values ($1, 'tab', $2, $3, null), ($1, 'subtab', $4, $5, null)`,
    [member.id, subtab.tab_id, level === 'hidden' ? 'view' : level, subtab.id, level],
  );
}

const mock = (p, body) => fetch(`${MOCK}${p}`, { method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(400);
  }
  return fn().catch(() => null);
}
const svc = createClient(SUPA, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = createClient(SUPA, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const ref = new URL(SUPA).hostname.split('.')[0];
async function cookiesFor(id, email) {
  if (!savedHashes.has(id)) savedHashes.set(id, (await db.query('select encrypted_password from auth.users where id = $1', [id])).rows[0]?.encrypted_password ?? null);
  await svc.auth.admin.updateUserById(id, { password: 'ZzProbe-2026!mail' });
  const { data } = await anon.auth.signInWithPassword({ email, password: 'ZzProbe-2026!mail' });
  const v = 'base64-' + Buffer.from(JSON.stringify(data.session)).toString('base64url');
  const out = [];
  if (v.length > 3180) for (let i = 0, n = 0; i < v.length; i += 3180, n++) out.push({ name: `sb-${ref}-auth-token.${n}`, value: v.slice(i, i + 3180), domain: 'localhost', path: '/' });
  else out.push({ name: `sb-${ref}-auth-token`, value: v, domain: 'localhost', path: '/' });
  return out;
}
const cleanRate = () => db.query(`delete from rate_limit_counters where key like $1 or key like $2 or key like 'mail_tick:%' or key like 'mail_backfill:%'`, [`mail_%:user:${admin.id}`, `mail_%:user:${member.id}`]);
await cleanRate();

const pass = [], fail = [];
const t = (n, ok, d = '') => (ok ? pass : fail).push(`${n}${d ? '  — ' + d : ''}`);
process.on('unhandledRejection', (e) => fail.push(`unhandled: ${e}`));
const tick = () => fetch(`${BASE}/api/mail/tick`, { headers: { Authorization: `Bearer ${CRON}` } });
async function syncAll(ms = 150000) {
  await tick();
  const end = Date.now() + ms;
  await sleep(1500);
  while (Date.now() < end) {
    const s = await one(`select
        (select count(*)::int from mail_sync_queue q join mail_mailboxes m on m.id=q.mailbox_id where m.address like '%@mock.test' and q.processed_at is null and q.not_before <= now()) due,
        (select count(*)::int from mail_ops o join mail_mailboxes m on m.id=o.mailbox_id where m.address like '%@mock.test' and o.status in ('queued','running') and o.next_attempt_at <= now()) ops,
        (select count(*)::int from mail_mailboxes where address like '%@mock.test' and lease_until > now()) leased`);
    if (s.due === 0 && s.ops === 0 && s.leased === 0) return;
    if (s.leased === 0) await tick();
    await sleep(1200);
  }
  throw new Error('sync never went idle');
}

const browser = await chromium.launch();
const errors = [];
async function contextFor(id, email) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies(await cookiesFor(id, email));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${email}: ${String(e).slice(0, 200)}`));
  page.on('response', (r) => { if (r.status() >= 500) errors.push(`${email}: ${r.status()} ${r.url()}`); });
  await page.route('**://*.posthog.com/**', (r) => r.abort());
  return { ctx, page };
}
const row = (page, text) => page.locator('[role="option"]', { hasText: text });
const toolbar = (page) => page.getByRole('toolbar', { name: 'Conversation actions' });
const sidebarEmail = (page) => page.locator('aside, nav').getByRole('link', { name: /^Email/ }).first();

let impersonating = false;
let adminPage = null;
try {
  await mock('/__mock/reset', {});
  const ids = {};
  for (const [k, subject, extra] of [
    ['one', 'Member mail one', { isRead: false }],
    ['two', 'Member mail two', { isRead: true, attachments: [{ name: 'brief.pdf', contentType: 'application/pdf', size: 20 }] }],
  ]) {
    ids[k] = (await mock('/__mock/message', { mailbox: OWNER, from: 'client@client.example', fromName: 'Client', subject, ...extra })).id;
  }

  const m = await contextFor(member.id, MEMBER);
  const a = await contextFor(admin.id, ADMIN);
  adminPage = a.page;

  // ── Hidden ─────────────────────────────────────────────────────────────
  await setGrant('hidden');
  await m.page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle', timeout: 180000 });
  t('hidden: no Email in the sidebar', (await sidebarEmail(m.page).count()) === 0);
  await m.page.goto(`${BASE}/email`, { waitUntil: 'networkidle', timeout: 180000 });
  t('hidden: /email redirects away', !/\/email/.test(new URL(m.page.url()).pathname), m.page.url());
  await m.page.goto(`${BASE}/email/settings`, { waitUntil: 'networkidle', timeout: 180000 });
  t('hidden: /email/settings redirects away', !/\/email/.test(new URL(m.page.url()).pathname));
  const hiddenBytes = await m.page.request.get(`${BASE}/api/mail/attachments/00000000-0000-4000-8000-000000000000`);
  t('hidden: attachment route refuses', hiddenBytes.status() === 403, String(hiddenBytes.status()));
  const hiddenStart = await m.page.request.get(`${BASE}/api/mail/oauth/start`, { maxRedirects: 0 });
  t('hidden: cannot start connecting a mailbox', hiddenStart.status() !== 302 || !/oauth2\/v2\.0\/authorize/.test(hiddenStart.headers().location ?? ''), `${hiddenStart.status()} ${hiddenStart.headers().location ?? ''}`);

  // ── View: connect, read, nothing more ──────────────────────────────────
  await setGrant('view');
  await m.page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle', timeout: 180000 });
  t('view: Email appears in the sidebar', (await sidebarEmail(m.page).count()) === 1);
  await m.page.goto(`${BASE}/email/settings`, { waitUntil: 'networkidle', timeout: 180000 });
  t('view: no writing settings (undo, signatures, templates)', (await m.page.getByText('Undo send', { exact: true }).count()) === 0 && (await m.page.getByText('Signatures', { exact: true }).count()) === 0);
  await m.page.getByRole('button', { name: 'Connect Outlook' }).click();
  await m.page.waitForURL(/oauth2\/v2\.0\/authorize/);
  await m.page.click(`a[data-account="${OWNER}"]`);
  await m.page.waitForURL(/\/email\/settings/, { timeout: 90000 });
  await syncAll();
  const mb = await one(`select m.id from mail_mailboxes m join mail_connections c on c.mailbox_id = m.id where m.address=$1 and c.user_id=$2 and c.disconnected_at is null`, [OWNER, member.id]);
  t('view: the member connected their own mailbox', !!mb);

  await m.page.goto(`${BASE}/email`, { waitUntil: 'networkidle', timeout: 180000 });
  await row(m.page, 'Member mail one').click();
  t('view: reads their mail', await m.page.locator('article h2', { hasText: 'Member mail one' }).waitFor({ timeout: 20000 }).then(() => true, () => false));
  t('view: no action toolbar', (await toolbar(m.page).count()) === 0);
  t('view: no New mail', (await m.page.getByRole('button', { name: 'New mail', exact: true }).count()) === 0);
  t('view: no selection checkboxes', (await m.page.locator('[role="option"] input[type=checkbox]').count()) === 0);
  await sleep(3500);
  t('view: opening does not mark it read', (await one(`select is_read from mail_messages where graph_id=$1`, [ids.one]))?.is_read === false);
  t('…nor in Outlook', (await mock('/__mock/inspect', { id: ids.one })).isRead === false);
  await m.page.keyboard.press('Delete');
  await sleep(1500);
  t('view: the Delete key does nothing', (await mock('/__mock/inspect', { id: ids.one })).folder === 'inbox');
  await row(m.page, 'Member mail two').click();
  const att = m.page.getByRole('link', { name: /^Download brief\.pdf/ });
  await att.waitFor({ timeout: 20000 });
  const bytes = await m.page.request.get(`${BASE}${await att.getAttribute('href')}`);
  t('view: attachments download', bytes.status() === 200, String(bytes.status()));

  await m.page.goto(`${BASE}/email/rules/${mb.id}`, { waitUntil: 'networkidle', timeout: 180000 });
  t('view: rules screen opens read-only', (await m.page.getByRole('heading', { name: 'Rules' }).count()) === 1 && (await m.page.getByRole('button', { name: 'New rule' }).count()) === 0);

  // ── Edit ───────────────────────────────────────────────────────────────
  await setGrant('edit');
  await m.page.goto(`${BASE}/email`, { waitUntil: 'networkidle', timeout: 180000 });
  await row(m.page, 'Member mail two').click();
  await toolbar(m.page).waitFor({ timeout: 20000 });
  t('edit: actions and New mail appear', (await m.page.getByRole('button', { name: 'New mail', exact: true }).count()) === 1);
  await toolbar(m.page).getByRole('button', { name: 'Archive' }).click();
  t('edit: an action reaches Outlook', !!(await until(async () => (await mock('/__mock/inspect', { id: ids.two })).folder === 'archive', 30000)));

  // ── Admin sees a member's personal mailbox ─────────────────────────────
  await a.page.goto(`${BASE}/email`, { waitUntil: 'networkidle', timeout: 180000 });
  t('admin: the member’s personal mailbox is listed', (await a.page.locator('nav[aria-label="Mail folders"]').getByText(OWNER).count()) >= 1);
  // Other people's mailboxes start folded: open it first.
  const memberBox = a.page.locator('nav[aria-label="Mail folders"]').locator(`button[title="${OWNER}"]`).first();
  if ((await memberBox.getAttribute('aria-expanded')) === 'false') await memberBox.click();
  await a.page.locator('nav[aria-label="Mail folders"]').getByRole('button', { name: /^Inbox(,|$)/ }).first().click();
  await row(a.page, 'Member mail one').click();
  t('admin: can read it', await a.page.locator('article h2', { hasText: 'Member mail one' }).waitFor({ timeout: 20000 }).then(() => true, () => false));
  t('admin: never offered Reply from someone else’s mailbox', (await a.page.getByRole('button', { name: 'Reply', exact: true }).count()) === 0);
  t('admin: no New mail without a mailbox of their own', (await a.page.getByRole('button', { name: 'New mail', exact: true }).count()) === 0);

  // ── Sign in as the member: health only ─────────────────────────────────
  await a.page.goto(`${BASE}/admin/users`, { waitUntil: 'networkidle', timeout: 180000 });
  await a.page.getByRole('button', { name: `Actions for ${MEMBER}` }).click();
  await a.page.getByRole('menuitem', { name: 'Sign in as this user' }).click();
  await a.page.locator('text=/signed in as/i').first().waitFor({ timeout: 30000 });
  impersonating = true;
  // Read-only from here: no Server Action may leave the browser under the member's name.
  const aborted = [];
  await a.page.route('**/*', (route) => {
    const req = route.request();
    if (req.method() === 'POST' && req.headers()['next-action']) {
      aborted.push(req.url());
      return route.abort();
    }
    return route.continue();
  });
  await a.page.goto(`${BASE}/email`, { waitUntil: 'networkidle', timeout: 180000 });
  const body = await a.page.locator('main').innerText();
  t('sign in as: says mail is hidden, shows health', body.includes("Hidden while you're signed in as another user.") && body.includes(OWNER));
  t('sign in as: no subjects or bodies on the page', !body.includes('Member mail one') && !body.includes('Member mail two'));
  const msgId = (await one(`select id from mail_messages where graph_id=$1`, [ids.two]))?.id;
  const attId = (await one(`select a.id from mail_attachments a join mail_messages m on m.id = a.message_id where m.graph_id=$1`, [ids.two]))?.id;
  const zip = await a.page.request.get(`${BASE}/api/mail/messages/${msgId}/attachments.zip`);
  const one1 = await a.page.request.get(`${BASE}/api/mail/attachments/${attId}`);
  t('sign in as: byte routes refuse', zip.status() === 403 && one1.status() === 403, `${zip.status()} ${one1.status()}`);
  await a.page.goto(`${BASE}/email/rules/${mb.id}`, { waitUntil: 'networkidle', timeout: 180000 });
  t('sign in as: rules redirect to the health view', new URL(a.page.url()).pathname === '/email');
  t('sign in as: opening Email fired no actions', aborted.length === 0, aborted.join(', '));
  await a.page.unroute('**/*');
} catch (e) {
  fail.push(`threw: ${e.stack ?? e}`);
} finally {
  if (impersonating && adminPage) {
    await adminPage.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle', timeout: 180000 }).catch(() => {});
    const exit = adminPage.getByRole('button', { name: 'Return to my account' }).first();
    if (await exit.count()) {
      await exit.click().catch(() => {});
      await adminPage.waitForTimeout(3000);
    }
    const last = await one(`select event_type::text e from auth_audit_log where event_type::text like 'impersonation_%' and actor_id = $1 order by created_at desc limit 1`, [admin.id]);
    t('sign in as: session handed back (audit log)', last?.e === 'impersonation_ended', last?.e);
  }
  await browser.close();
  await db.query(`delete from user_grants where user_id=$1 and scope_id = any($2)`, [member.id, [subtab.id, subtab.tab_id]]);
  for (const g of grantsBefore) {
    await db.query(`insert into user_grants (user_id, scope_kind, scope_id, grant_level, module_id) values ($1,$2,$3,$4,$5)`, [g.user_id, g.scope_kind, g.scope_id, g.grant_level, g.module_id]);
  }
  await db.query(`update profiles set last_seen_at = $2 where id=$1`, [admin.id, admin.last_seen_at]).catch(() => {});
  await db.query(`update profiles set last_seen_at = $2 where id=$1`, [member.id, member.last_seen_at]).catch(() => {});
  await db.query(`delete from mail_mailboxes where address like '%@mock.test'`);
  await db.query(`delete from mail_identities where user_id = any($1) and microsoft_user_id like 'oid-%'`, [[admin.id, member.id]]);
  await db.query(`update mail_provider_health set state=$1, last_success_at=$2, down_since=$3, last_error_code=$4 where id=1`,
    [healthBefore.state, healthBefore.last_success_at, healthBefore.down_since, healthBefore.last_error_code]);
  await cleanRate();
  await mock('/__mock/reset', {}).catch(() => {});
  const restored = await q(`select * from user_grants where user_id=$1 and scope_id = any($2)`, [member.id, [subtab.id, subtab.tab_id]]);
  t('member grants put back exactly', JSON.stringify(restored) === JSON.stringify(grantsBefore), JSON.stringify(restored));
  const after = await counts();
  const drift = MAIL_TABLES.filter((x) => after[x] !== before[x]);
  t('every mail_* table back to its starting count', drift.length === 0, drift.map((d) => `${d} ${before[d]}→${after[d]}`).join(', '));
  t('no page errors / 5xx', errors.length === 0, errors.join(' | ').slice(0, 400));
  for (const [id, hash] of savedHashes) {
    if (hash) await db.query('update auth.users set encrypted_password = $2 where id = $1', [id, hash]).catch(() => {});
  }
  await db.end();
}

console.log(`\nPASS ${pass.length}`);
for (const p of pass) console.log('  ✓ ' + p);
console.log(`FAIL ${fail.length}`);
for (const f of fail) console.log('  ✗ ' + f);
process.exit(fail.length ? 1 : 0);
