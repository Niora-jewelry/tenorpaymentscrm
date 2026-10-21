/**
 * Rules, meeting invitations, Download all, Load older mail and Outlook
 * contacts — end to end against the mock Microsoft.
 *
 *   rules: Outlook's own appear (read-only marked), create with conditions
 *   and an action, validation, edit (unknown Outlook settings kept), on/off,
 *   reorder, Outlook's refusal shown, delete, a rule made in Outlook shows up
 *   on refresh. invites: accept / decline reach Outlook; not in the calendar
 *   says so. Download all: one zip with every file intact. Load older: the
 *   30 days before, an empty window skipped, then "that's everything".
 *   contacts: Outlook contacts suggested in To; a deleted one goes.
 *
 * Writes only *@mock.test mailboxes and the admin test account's mock
 * identities, and removes them; every mail_* count is compared before/after.
 *
 *   CRON_SECRET=… MAIL_UI_SHOTS=… node --env-file=.env scripts/verify-mail-extras.mjs
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { unzipSync, strFromU8 } from 'fflate';
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
const cleanRate = () => db.query(`delete from rate_limit_counters where key like $1 or key like 'mail_tick:%' or key like 'mail_backfill:%'`, [`mail_%:user:${me.id}`]);
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
const mockRules = async () => (await mock('/__mock/rules', { mailbox: OWNER })).rules;

const browser = await chromium.launch();
const errors = [];
const consoleErrors = [];
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
await ctx.addCookies(cookies);
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !/upgrade-insecure-requests|status of 40[13]|posthog/i.test(m.text())) consoleErrors.push(m.text().slice(0, 200)); });
page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });
await page.route('**://*.posthog.com/**', (r) => r.abort());
const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }); };
const row = (text) => page.locator('[role="option"]', { hasText: text });
const folderBtn = (name) => page.locator('nav[aria-label="Mail folders"]').getByRole('button', { name: new RegExp(`^${name}(,|$)`) }).first();
const rulesList = () => page.getByRole('list', { name: 'Rules, in the order Outlook runs them' });
const ruleItem = (name) => rulesList().locator('li', { hasText: name });
const editor = () => page.locator('section[aria-label="New rule"], section[aria-label="Edit rule"]').first();

try {
  await mock('/__mock/reset', {});
  const add = (subject, extra = {}) => mock('/__mock/message', { mailbox: OWNER, from: 'ann@client.example', fromName: 'Ann Client', subject, isRead: true, ...extra }).then((r) => r.id);
  const tomorrow = new Date(Date.now() + 86_400_000);
  tomorrow.setUTCHours(15, 0, 0, 0);
  await add('Team sync Thursday', {
    receivedDaysAgo: 0.01,
    meeting: { start: tomorrow.toISOString().replace('.000', ''), end: new Date(tomorrow.getTime() + 3_600_000).toISOString().replace('.000', ''), location: 'Room 4' },
  });
  await add('Board meeting moved', { receivedDaysAgo: 0.02, meeting: { start: tomorrow.toISOString(), end: tomorrow.toISOString(), notInCalendar: true } });
  const pdf = Buffer.from('%PDF-1.4 quarterly figures');
  const txt = Buffer.from('plain notes, line one\n');
  await add('Two files', {
    receivedDaysAgo: 0.03,
    attachments: [
      { name: 'figures.pdf', contentType: 'application/pdf', size: pdf.length, bytes: pdf.toString('base64') },
      { name: 'notes.txt', contentType: 'text/plain', size: txt.length, bytes: txt.toString('base64') },
    ],
  });
  await add('Old news', { receivedDaysAgo: 20 });
  await add('Older still', { receivedDaysAgo: 40 });
  await add('Ancient history', { receivedDaysAgo: 200 });
  await mock('/__mock/rule', {
    mailbox: OWNER,
    rule: {
      displayName: 'From boss',
      conditions: { fromAddresses: [{ emailAddress: { name: 'Boss', address: 'boss@client.example' } }], futurePredicate: ['kept'] },
      actions: { markAsRead: true },
    },
  });
  await mock('/__mock/rule', { mailbox: OWNER, rule: { displayName: 'Desktop rule', sequence: 10, isReadOnly: true, actions: { moveToFolder: `fld-${OWNER}-archive` } } });
  const zed = (await mock('/__mock/contact', { mailbox: OWNER, name: 'Zed Partner', addresses: ['zed@partner.example'] })).id;

  // connect + sync
  await page.goto(`${BASE}/email/settings`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.getByRole('button', { name: 'Connect Outlook' }).click();
  await page.waitForURL(/oauth2\/v2\.0\/authorize/);
  await page.click(`a[data-account="${OWNER}"]`);
  await page.waitForURL(/\/email\/settings/, { timeout: 90000 });
  await syncAll();
  const mbId = (await one(`select id from mail_mailboxes where address=$1`, [OWNER])).id;

  // ── contacts ───────────────────────────────────────────────────────────
  t('Outlook contacts reach the suggestions cache', !!(await until(async () => (await one(`select addresses from mail_contacts where mailbox_id=$1 and deleted_at is null`, [mbId]))?.addresses?.includes('zed@partner.example'), 30000)));
  await page.goto(`${BASE}/email`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.getByRole('button', { name: 'New mail', exact: true }).click();
  await page.locator('#rcpt-To').fill('zed');
  t('a contact is suggested in To', await page.getByRole('listbox', { name: 'Suggestions' }).getByText('zed@partner.example').waitFor({ timeout: 10000 }).then(() => true, () => false));
  await page.locator('#rcpt-To').fill('');
  await page.getByRole('button', { name: 'Close' }).click();
  await mock('/__mock/contact-delete', { mailbox: OWNER, id: zed });
  await db.query(`update mail_mailboxes set contacts_synced_at = now() - interval '1 hour' where id=$1`, [mbId]);
  await syncAll();
  t('a contact deleted in Outlook leaves the cache', !!(await until(async () => (await one(`select count(*)::int n from mail_contacts where mailbox_id=$1 and deleted_at is null`, [mbId])).n === 0, 30000)));

  // ── invitations ────────────────────────────────────────────────────────
  await page.goto(`${BASE}/email`, { waitUntil: 'networkidle', timeout: 180000 });
  await row('Team sync Thursday').click();
  const card = page.getByText('Room 4');
  t('invitation shows when and where', await card.waitFor({ timeout: 20000 }).then(() => true, () => false));
  await shot('p7-1-invite');
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  t('accept reaches Outlook', !!(await until(async () => (await mock('/__mock/events')).responses.some((r) => r.response === 'accepted'))));
  t('…and the card says so', await page.getByText('You accepted').waitFor({ timeout: 10000 }).then(() => true, () => false));
  t('…stored on the message', !!(await until(async () => (await one(`select event_response from mail_messages where subject='Team sync Thursday' and mailbox_id=$1`, [mbId]))?.event_response === 'accepted')));
  await page.getByRole('button', { name: 'Decline', exact: true }).click();
  t('decline reaches Outlook', !!(await until(async () => (await mock('/__mock/events')).responses.some((r) => r.response === 'declined'))));
  t('…and Outlook files the invitation under Deleted Items (synced back)', !!(await until(async () => {
    await tick();
    return (await one(`select f.well_known w from mail_messages m join mail_folders f on f.id=m.folder_id where m.subject='Team sync Thursday' and m.mailbox_id=$1`, [mbId]))?.w === 'deleteditems';
  }, 40000)));
  await page.goto(`${BASE}/email`, { waitUntil: 'networkidle', timeout: 180000 });
  await row('Board meeting moved').click();
  t('an invitation not in the calendar says to use Outlook', await page.getByText(/isn’t in the calendar here/).waitFor({ timeout: 20000 }).then(() => true, () => false));

  // ── Download all ───────────────────────────────────────────────────────
  await row('Two files').click();
  const all = page.getByRole('link', { name: 'Download all' });
  await all.waitFor({ timeout: 20000 });
  const href = await all.getAttribute('href');
  const res = await page.request.get(`${BASE}${href}`);
  t('Download all answers with a zip', res.status() === 200 && res.headers()['content-type'] === 'application/zip', `${res.status()} ${res.headers()['content-type']}`);
  t('…served as a download, never sniffed', /attachment;/.test(res.headers()['content-disposition'] ?? '') && res.headers()['x-content-type-options'] === 'nosniff');
  const files = unzipSync(new Uint8Array(await res.body()));
  t('…holding every file, byte for byte', strFromU8(files['figures.pdf'] ?? new Uint8Array()) === pdf.toString() && strFromU8(files['notes.txt'] ?? new Uint8Array()) === txt.toString(), Object.keys(files).join(', '));
  const other = await page.request.get(`${BASE}/api/mail/messages/00000000-0000-4000-8000-000000000000/attachments.zip`);
  t('…and 404 for a message that isn’t yours', other.status() === 404);

  // ── Load older mail ────────────────────────────────────────────────────
  t('older mail is not fetched up front', (await row('Old news').count()) === 0);
  const loadMore = page.getByRole('button', { name: 'Load 30 more days' });
  await loadMore.waitFor({ timeout: 20000 });
  t('the list says where its mail starts', await page.getByText(/Showing mail since/).isVisible());
  await loadMore.click();
  t('Load older: the 30 days before arrive', !!(await until(async () => (await row('Old news').count()) === 1 && (await row('Older still').count()) === 1, 45000)));
  await loadMore.waitFor({ timeout: 30000 });
  await loadMore.click();
  t('an empty window is skipped: much older mail arrives in one go', !!(await until(async () => (await row('Ancient history').count()) === 1, 45000)));
  t('then it says that’s everything', await page.getByText('That’s everything in Inbox.').waitFor({ timeout: 30000 }).then(() => true, () => false));
  await shot('p7-2-older');

  // ── rules ──────────────────────────────────────────────────────────────
  await page.locator('nav[aria-label="Mail folders"]').getByRole('link', { name: 'Rules' }).first().click();
  await page.waitForURL(/\/email\/rules\//, { timeout: 30000 });
  await rulesList().waitFor({ timeout: 20000 });
  t('Outlook’s rules are listed, in order', (await rulesList().locator('li').count()) === 2 && (await ruleItem('From boss').count()) === 1);
  t('…read-only ones marked and not editable', (await ruleItem('Desktop rule').getByText('Outlook only').count()) === 1 && (await ruleItem('Desktop rule').getByRole('button', { name: 'Edit' }).count()) === 0);
  t('…each summarised in a line', (await ruleItem('From boss').innerText()).includes('From Boss → Mark as read'));

  await page.getByRole('button', { name: 'New rule' }).click();
  await editor().waitFor();
  await page.getByLabel('Name').fill('Nothing to do');
  await editor().getByRole('button', { name: 'Create rule' }).click();
  t('a rule with no action is refused before Outlook', await editor().getByRole('alert').getByText('Add at least one action.').isVisible());
  await page.getByLabel('Name').fill('Invoices to Clients');
  await editor().getByLabel('Add a condition').selectOption({ label: 'Subject includes' });
  await editor().getByLabel('Subject includes', { exact: true }).fill('invoice');
  await editor().getByLabel('Subject includes', { exact: true }).press('Enter');
  await editor().getByLabel('Add a condition').selectOption({ label: 'From' });
  await editor().getByLabel('From', { exact: true }).fill('acct@vendor.example');
  await editor().getByLabel('From', { exact: true }).press('Enter');
  await editor().getByLabel('Add an action').selectOption({ label: 'Move to folder' });
  await editor().getByLabel('Move to folder', { exact: true }).selectOption(`fld-${OWNER}-clients`);
  await shot('p7-3-rule-editor');
  await editor().getByRole('button', { name: 'Create rule' }).click();
  const created = await until(async () => (await mockRules()).find((r) => r.displayName === 'Invoices to Clients'), 20000);
  t('create: the rule is in Outlook', !!created);
  t('…with its conditions and action', !!created && JSON.stringify(created.conditions.subjectContains) === '["invoice"]'
    && created.conditions.fromAddresses?.[0]?.emailAddress?.address === 'acct@vendor.example' && created.actions.moveToFolder === `fld-${OWNER}-clients`, JSON.stringify(created));
  t('…added last', !!created && created.sequence === 11, String(created?.sequence));
  t('…and listed here', await ruleItem('Invoices to Clients').waitFor({ timeout: 15000 }).then(() => true, () => false));

  await ruleItem('From boss').getByRole('button', { name: 'Edit' }).click();
  await editor().waitFor();
  t('edit: Outlook settings TapDash can’t show are announced', await editor().getByText(/1 setting from Outlook that TapDash can’t show/).isVisible());
  await editor().getByRole('button', { name: 'Remove “Mark as read”' }).click();
  await editor().getByLabel('Add an action').selectOption({ label: 'Assign categories' });
  await editor().getByLabel('Assign categories', { exact: true }).fill('Boss');
  await editor().getByLabel('Assign categories', { exact: true }).press('Enter');
  await editor().getByRole('button', { name: 'Save rule' }).click();
  const edited = await until(async () => {
    const r = (await mockRules()).find((x) => x.displayName === 'From boss');
    return r?.actions?.assignCategories ? r : null;
  });
  t('edit: Outlook has the new action, the removed one gone', !!edited && JSON.stringify(edited.actions) === '{"assignCategories":["Boss"]}', JSON.stringify(edited?.actions));
  t('…and the unknown setting kept as it was', !!edited && JSON.stringify(edited.conditions.futurePredicate) === '["kept"]');

  await ruleItem('Invoices to Clients').getByRole('switch').click();
  t('turn off: Outlook agrees', !!(await until(async () => (await mockRules()).find((r) => r.displayName === 'Invoices to Clients')?.isEnabled === false)));

  await page.getByRole('button', { name: 'Move “Invoices to Clients” up' }).click();
  t('reorder: Outlook runs it before the desktop rule', !!(await until(async () => {
    const rs = await mockRules();
    return rs.findIndex((r) => r.displayName === 'Invoices to Clients') < rs.findIndex((r) => r.displayName === 'Desktop rule');
  })));
  t('…and the list shows the new order', !!(await until(async () => (await rulesList().locator('li').nth(1).innerText()).includes('Invoices to Clients'))));

  await mock('/__mock/fault', { rejectRules: true });
  await page.getByRole('button', { name: 'New rule' }).click();
  await page.getByLabel('Name').fill('Will be refused');
  await editor().getByLabel('Add an action').selectOption({ label: 'Mark as read' });
  await editor().getByRole('button', { name: 'Create rule' }).click();
  t('Outlook’s refusal is shown in its own words', await editor().getByText(/Outlook rejected this rule: The rule contains a condition/).waitFor({ timeout: 15000 }).then(() => true, () => false));
  await mock('/__mock/fault', {});
  await editor().getByRole('button', { name: 'Cancel' }).click();

  await ruleItem('Invoices to Clients').getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete rule' }).click();
  t('delete: gone from Outlook', !!(await until(async () => !(await mockRules()).some((r) => r.displayName === 'Invoices to Clients'))));

  await mock('/__mock/rule', { mailbox: OWNER, rule: { displayName: 'Made in Outlook', actions: { markAsRead: true } } });
  await page.getByRole('button', { name: 'Refresh' }).click();
  t('a rule made in Outlook appears on refresh', await ruleItem('Made in Outlook').waitFor({ timeout: 15000 }).then(() => true, () => false));
  await shot('p7-4-rules');
} catch (e) {
  fail.push(`threw: ${e.stack ?? e}`);
} finally {
  await browser.close();
  await db.query(`update profiles set last_seen_at = $2 where email=$1`, [ADMIN, seenBefore]).catch(() => {});
  await db.query(`delete from mail_mailboxes where address like '%@mock.test'`);
  await db.query(`delete from mail_identities where user_id = $1 and microsoft_user_id like 'oid-%'`, [me.id]);
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
