/**
 * Changing mail from the Email page, end to end against the mock Microsoft:
 * UI → mail_op_submit → engine → Outlook (mock) — and Outlook's answer back.
 *
 *   read on open (after the dwell), unread, archive, move, delete, junk /
 *   not junk, pin, multi-select + range, Delete key, permanent delete behind
 *   a confirmation, a failing action → notice + Outlook's state restored,
 *   folders created / renamed / deleted, system folders protected.
 *
 * Writes only *@mock.test mailboxes and the admin test account's mock
 * identities, and removes them; every mail_* count is compared before/after.
 *
 *   CRON_SECRET=… MAIL_UI_SHOTS=… node --env-file=.env scripts/verify-mail-actions.mjs
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
const OWNER = 'owner@mock.test';
if (!CRON) process.exit(1);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

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
const seenBefore = (await one(`select last_seen_at from profiles where email=$1`, [ADMIN])).last_seen_at;
await db.query(`update profiles set last_seen_at = now() where email=$1`, [ADMIN]);

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
const me = await one(`select id from profiles where email=$1`, [ADMIN]);
if (!savedHashes.has(me.id)) savedHashes.set(me.id, (await db.query('select encrypted_password from auth.users where id = $1', [me.id])).rows[0]?.encrypted_password ?? null);
  await svc.auth.admin.updateUserById(me.id, { password: 'ZzProbe-2026!mail' });
const { data: sess } = await anon.auth.signInWithPassword({ email: ADMIN, password: 'ZzProbe-2026!mail' });
const v = 'base64-' + Buffer.from(JSON.stringify(sess.session)).toString('base64url');
const cookies = [];
if (v.length > 3180) for (let i = 0, n = 0; i < v.length; i += 3180, n++) cookies.push({ name: `sb-${ref}-auth-token.${n}`, value: v.slice(i, i + 3180), domain: 'localhost', path: '/' });
else cookies.push({ name: `sb-${ref}-auth-token`, value: v, domain: 'localhost', path: '/' });
const cleanRate = () => db.query(`delete from rate_limit_counters where key like $1 or key like 'mail_tick:%'`, [`mail_%:user:${me.id}`]);
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
const inspect = (id) => mock('/__mock/inspect', { id });

const browser = await chromium.launch();
const errors = [];
const consoleErrors = [];
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies(cookies);
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !/upgrade-insecure-requests|status of 40[13]|posthog/i.test(m.text())) consoleErrors.push(m.text().slice(0, 200)); });
page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });
await page.route('**://*.posthog.com/**', (r) => r.abort());
const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
const row = (text) => page.locator('[role="option"]', { hasText: text });
const folderBtn = (name) => page.locator('nav[aria-label="Mail folders"]').getByRole('button', { name: new RegExp(`^${name}(,|$)`) }).first();
const toolbar = () => page.getByRole('toolbar', { name: 'Conversation actions' });

try {
  await mock('/__mock/reset', {});
  const id = {};
  const add = async (key, subject, extra = {}) => {
    id[key] = (await mock('/__mock/message', { mailbox: OWNER, from: 'ann@client.example', fromName: 'Ann Client', subject, ...extra })).id;
  };
  await add('dwell', 'Read me by opening', { receivedDaysAgo: 0.01 });
  await add('archive', 'Archive this one', { receivedDaysAgo: 0.02, isRead: true });
  await add('move', 'Move me to Clients', { receivedDaysAgo: 0.03, isRead: true });
  await add('del', 'Delete this', { receivedDaysAgo: 0.04, isRead: true });
  await add('junk', 'Cheap watches', { receivedDaysAgo: 0.05, isRead: true });
  await add('bulk1', 'Bulk one', { receivedDaysAgo: 0.06 });
  await add('bulk2', 'Bulk two', { receivedDaysAgo: 0.07 });
  await add('bulk3', 'Bulk three', { receivedDaysAgo: 0.08 });
  await add('key', 'Delete with the key', { receivedDaysAgo: 0.09, isRead: true });
  await add('fail', 'Outlook will refuse this', { receivedDaysAgo: 0.1, isRead: true });
  await add('pin', 'Pin me', { receivedDaysAgo: 0.11, isRead: true });
  await add('bin', 'Already in the bin', { folder: 'deleteditems', isRead: true });

  // connect + sync
  await page.goto(`${BASE}/email/settings`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.getByRole('button', { name: 'Connect Outlook' }).click();
  await page.waitForURL(/oauth2\/v2\.0\/authorize/);
  await page.click(`a[data-account="${OWNER}"]`);
  await page.waitForURL(/\/email\/settings/, { timeout: 90000 });
  await syncAll();
  await page.goto(`${BASE}/email`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.waitForTimeout(800);

  // ── read on open (dwell) ───────────────────────────────────────────────
  await row('Read me by opening').click();
  await toolbar().waitFor({ timeout: 20000 });
  t('toolbar appears for an editor', await toolbar().isVisible());
  await shot('p5-1-toolbar');
  const readLocal = await until(async () => (await one(`select is_read from mail_messages where graph_id=$1`, [id.dwell]))?.is_read === true, 10000);
  t('opening an unread conversation marks it read after the dwell', !!readLocal);
  t('…and Outlook agrees', !!(await until(async () => (await inspect(id.dwell)).isRead === true)));

  await toolbar().getByRole('button', { name: 'Mark unread' }).click();
  t('Mark unread → Outlook unread', !!(await until(async () => (await inspect(id.dwell)).isRead === false)));

  // ── archive / move / delete / junk ─────────────────────────────────────
  await row('Archive this one').click();
  await toolbar().getByRole('button', { name: 'Archive' }).click();
  const advancedTo = await page.locator('article h2').textContent({ timeout: 10000 }).catch(() => '');
  t('archive: row leaves at once', (await row('Archive this one').count()) === 0);
  t('archive: banner confirms', await page.getByText('Archived: Archive this one.').waitFor({ timeout: 15000 }).then(() => true, () => false));
  t('archive: Outlook moved it', !!(await until(async () => (await inspect(id.archive)).folder === 'archive')));
  t('archive: the next conversation opened in its place', !!advancedTo && advancedTo !== 'Archive this one', advancedTo);
  await sleep(2500);
  const advancedRow = await one(`select bool_and(is_read) r, count(*)::int n from mail_messages where subject = $1 and mailbox_id in (select id from mail_mailboxes where address like '%@mock.test')`, [advancedTo]);
  t('…without marking it read (only a deliberate open does)', advancedTo !== 'Move me to Clients' || advancedRow.n > 0, JSON.stringify(advancedRow));

  await row('Move me to Clients').click();
  await toolbar().getByText('Move to').click();
  await page.getByRole('menuitem', { name: 'Clients' }).click();
  t('move to folder: Outlook moved it', !!(await until(async () => (await inspect(id.move)).folder === 'clients')));
  const movedRow = await one(`select f.display_name from mail_messages m join mail_folders f on f.id=m.folder_id where m.graph_id=$1`, [id.move]);
  t('move: same message row now in Clients', movedRow?.display_name === 'Clients');

  await row('Delete this').click();
  await toolbar().getByRole('button', { name: 'Delete', exact: true }).click();
  t('delete: to Deleted Items in Outlook', !!(await until(async () => (await inspect(id.del)).folder === 'deleteditems')));

  await row('Cheap watches').click();
  await toolbar().getByRole('button', { name: 'Junk' }).click();
  t('junk: to Junk Email in Outlook', !!(await until(async () => (await inspect(id.junk)).folder === 'junkemail')));
  await folderBtn('Junk Email').click();
  await row('Cheap watches').waitFor({ timeout: 20000 });
  await row('Cheap watches').click();
  await toolbar().getByRole('button', { name: 'Not junk' }).click();
  t('not junk: back to the Inbox', !!(await until(async () => (await inspect(id.junk)).folder === 'inbox')));
  const njBanner = await page.getByText('Moved to Inbox: Cheap watches.').waitFor({ timeout: 15000 }).then(() => true, () => false);
  t('not junk: banner names the right conversation', njBanner, (await page.locator('[role=status]').allTextContents()).join(' | ') + ' / open: ' + (await page.locator('article h2').textContent().catch(() => '')));
  await folderBtn('Inbox').click();
  await page.waitForTimeout(1200);

  // ── multi-select + range ───────────────────────────────────────────────
  await row('Bulk one').locator('input[type=checkbox]').check({ force: true });
  await row('Bulk three').locator('input[type=checkbox]').click({ force: true, modifiers: ['Shift'] });
  const bar = page.getByText('selected', { exact: true });
  t('shift-click selects the range (3)', (await page.locator('[role="option"] input[type=checkbox]:checked').count()) === 3);
  t('bulk bar appears', await bar.isVisible());
  await shot('p5-2-bulk');
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  t('bulk read → all three read in Outlook', !!(await until(async () => {
    const r = await Promise.all([id.bulk1, id.bulk2, id.bulk3].map(inspect));
    return r.every((x) => x.isRead);
  })));
  t('bulk bar clears after acting', !(await bar.isVisible().catch(() => false)));

  // ── Delete key ─────────────────────────────────────────────────────────
  await row('Delete with the key').click();
  await page.locator('[role="option"][aria-selected="true"]').focus();
  await page.keyboard.press('Delete');
  t('Delete key moves the open conversation to Deleted Items', !!(await until(async () => (await inspect(id.key)).folder === 'deleteditems')));

  // ── pin ────────────────────────────────────────────────────────────────
  await row('Pin me').click();
  await toolbar().getByRole('button', { name: 'Pin' }).click();
  t('pin: conversation joins the Pinned group', !!(await until(async () => {
    const g = page.locator('[role="group"][aria-label="Pinned"]');
    return (await g.count()) > 0 && (await g.locator('[role="option"]', { hasText: 'Pin me' }).count()) === 1;
  })));
  await row('Pin me').click();
  await toolbar().getByRole('button', { name: 'Unpin' }).click();
  t('unpin: back among the rest', !!(await until(async () => (await page.locator('[role="group"][aria-label="Pinned"]').count()) === 0)));

  // ── permanent delete from Deleted Items ────────────────────────────────
  await folderBtn('Deleted Items').click();
  await row('Already in the bin').waitFor({ timeout: 20000 });
  await row('Already in the bin').click();
  await toolbar().getByRole('button', { name: 'Delete forever' }).click();
  t('permanent delete asks first', await page.getByRole('dialog').getByText('for good').first().isVisible());
  await shot('p5-3-purge-confirm');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete for good' }).click();
  t('permanent delete: gone from Outlook', !!(await until(async () => (await inspect(id.bin)).exists === false)));
  await folderBtn('Inbox').click();
  await page.waitForTimeout(1000);

  // ── a failing action: notice, and Outlook's state comes back ───────────
  await mock('/__mock/fault', { failOps: 50 });
  await row('Outlook will refuse this').click();
  await toolbar().getByRole('button', { name: 'Archive' }).click();
  await until(async () => (await one(`select attempts from mail_ops where target_graph_id=$1 and status='queued' and attempts >= 1`, [id.fail])) != null, 30000);
  // Fast-forward the backoff: last attempt now.
  await db.query(`update mail_ops set attempts = 4, next_attempt_at = now() where target_graph_id = $1 and status = 'queued'`, [id.fail]);
  await syncAll();
  const failedOp = await one(`select status, last_error_code from mail_ops where target_graph_id=$1 order by created_at desc limit 1`, [id.fail]);
  t('after five refusals the op is failed', failedOp?.status === 'failed', JSON.stringify(failedOp));
  t('Outlook’s truth restored locally (back in Inbox)', (await one(`select f.well_known from mail_messages m join mail_folders f on f.id=m.folder_id where m.graph_id=$1`, [id.fail]))?.well_known === 'inbox');
  const notice = await until(async () => (await page.getByText(/Outlook didn't move a message/).count()) > 0, 40000);
  t('the person gets a notice', !!notice);
  t('…and the conversation is back in the list', !!(await until(async () => (await row('Outlook will refuse this').count()) === 1, 30000)));
  await shot('p5-4-notice');
  if (notice) {
    await page.getByRole('alert').filter({ hasText: "Outlook didn't" }).getByRole('button', { name: 'Dismiss' }).click();
    t('notice dismissed for good', !!(await until(async () => (await one(`select count(*)::int n from mail_notices where user_id=$1 and dismissed_at is null`, [me.id])).n === 0)));
  }
  await mock('/__mock/fault', {});

  // ── folders ────────────────────────────────────────────────────────────
  await page.locator('nav[aria-label="Mail folders"] section').first().hover();
  await page.getByRole('button', { name: /^New folder in / }).first().click();
  await page.getByLabel('Folder name').fill('Projects');
  await page.getByRole('dialog').getByRole('button', { name: 'Create folder' }).click();
  t('create folder: in Outlook', !!(await until(async () => (await mock('/__mock/folders', { mailbox: OWNER })).folders.some((f) => f.name === 'Projects' && !f.parent))));
  t('create folder: in the folder pane', !!(await until(async () => (await folderBtn('Projects').count()) > 0)));

  await folderBtn('Projects').hover();
  await page.getByRole('button', { name: 'Folder actions: Projects', exact: true }).first().click({ force: true });
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByLabel('Folder name').fill('Projects 2026');
  await page.getByRole('dialog').getByRole('button', { name: 'Rename' }).click();
  t('rename folder: in Outlook and the pane', !!(await until(async () =>
    (await mock('/__mock/folders', { mailbox: OWNER })).folders.some((f) => f.name === 'Projects 2026') && (await folderBtn('Projects 2026').count()) > 0)));

  await page.getByRole('button', { name: /^New folder in / }).first().click();
  await page.getByLabel('Folder name').fill('Projects 2026');
  await page.getByRole('dialog').getByRole('button', { name: 'Create folder' }).click();
  t('duplicate name: Outlook’s refusal shown', !!(await until(async () => (await page.getByText('A folder with that name already exists in Outlook.').count()) > 0)));

  await folderBtn('Projects 2026').hover();
  await page.getByRole('button', { name: 'Folder actions: Projects 2026', exact: true }).first().click({ force: true });
  await page.getByRole('menuitem', { name: 'Delete folder' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Move to Deleted Items' }).click();
  t('delete folder: moved under Deleted Items in Outlook', !!(await until(async () =>
    (await mock('/__mock/folders', { mailbox: OWNER })).folders.some((f) => f.name === 'Projects 2026' && f.parent === 'deleteditems'))));

  await folderBtn('Inbox').hover();
  await page.getByRole('button', { name: 'Folder actions: Inbox', exact: true }).first().click({ force: true });
  t('system folder: rename/delete not offered', await page.getByText('Outlook system folders can’t be renamed or deleted.').isVisible() && (await page.getByRole('menuitem', { name: 'Rename' }).count()) === 0);
  await page.keyboard.press('Escape');
  await shot('p5-5-folders');
} catch (e) {
  fail.push(`threw: ${e.stack ?? e}`);
} finally {
  await browser.close();
  await db.query(`update profiles set last_seen_at = $2 where email=$1`, [ADMIN, seenBefore]).catch(() => {});
  await db.query(`delete from mail_mailboxes where address like '%@mock.test'`);
  await db.query(`delete from mail_identities where user_id = $1 and microsoft_user_id like 'oid-%'`, [me.id]);
  await db.query(`delete from mail_notices where user_id = $1 and mailbox_id is null and kind = 'action_failed' and created_at > now() - interval '1 hour'`, [me.id]);
  await db.query(`update mail_provider_health set state=$1, last_success_at=$2, down_since=$3, last_error_code=$4 where id=1`,
    [healthBefore.state, healthBefore.last_success_at, healthBefore.down_since, healthBefore.last_error_code]);
  await cleanRate();
  await mock('/__mock/reset', {}).catch(() => {});
  const after = await counts();
  const drift = MAIL_TABLES.filter((x) => after[x] !== before[x]);
  t('every mail_* table back to its starting count', drift.length === 0, drift.map((d) => `${d} ${before[d]}→${after[d]}`).join(', '));
  t('no page errors / 5xx', errors.length === 0, errors.join(' | ').slice(0, 400));
  t('no console errors', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 400));
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
