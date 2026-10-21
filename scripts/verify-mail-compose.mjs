/**
 * Writing mail from the Email page, end to end against the mock Microsoft:
 * composer → server actions → mail_outbox → send engine → Outlook (mock).
 *
 *   settings (undo window, signature, template), new mail with formatting,
 *   a template, a small attachment and a 6 MB one (upload session, chunked),
 *   an invalid recipient blocking Send, undo send, reply (Outlook's quote
 *   kept exactly once), reply all, forward (original attachment carried),
 *   an autosaved draft that appears in Drafts and is finished later,
 *   scheduled send (cancel/edit, and one that fires), the empty-subject
 *   question, a refused send (notice) and a transient failure (retried,
 *   sent once).
 *
 * Writes only *@mock.test mailboxes, the admin test account's mock
 * identities, its own templates and storage objects, and removes them all;
 * the admin's Email settings are put back; every mail_* count is compared
 * before/after.
 *
 *   CRON_SECRET=… MAIL_UI_SHOTS=… node --env-file=.env scripts/verify-mail-compose.mjs
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
const settingsBefore = await one(`select * from mail_user_settings where user_id=$1`, [me.id]);
const templatesBefore = new Set((await q(`select id from mail_templates`)).map((r) => r.id));
const storageList = async () => {
  const out = [];
  const { data: dirs } = await svc.storage.from('mail-outbox').list(me.id, { limit: 1000 });
  for (const d of dirs ?? []) {
    const { data: files } = await svc.storage.from('mail-outbox').list(`${me.id}/${d.name}`, { limit: 100 });
    for (const f of files ?? []) out.push(`${me.id}/${d.name}/${f.name}`);
  }
  return out;
};
const storageBefore = new Set(await storageList());

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
        (select count(*)::int from mail_outbox o join mail_mailboxes m on m.id=o.mailbox_id where m.address like '%@mock.test' and (o.status in ('held','scheduled') and o.release_at <= now() or o.status = 'sending')) out,
        (select count(*)::int from mail_mailboxes where address like '%@mock.test' and lease_until > now()) leased`);
    if (s.due === 0 && s.ops === 0 && s.out === 0 && s.leased === 0) return;
    if (s.leased === 0) await tick();
    await sleep(1200);
  }
  throw new Error('sync never went idle');
}
const sent = async () => (await mock('/__mock/sent')).sent;
const sentWith = (subject) => until(async () => (await sent()).find((m) => m.subject === subject), 45000);
const drafts = async () => (await mock('/__mock/drafts', { mailbox: OWNER })).drafts;
const outbox = (subject) => one(`select o.* from mail_outbox o join mail_mailboxes m on m.id=o.mailbox_id where m.address=$1 and o.subject=$2 order by o.created_at desc limit 1`, [OWNER, subject]);

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
const composer = () => page.locator('section[aria-label="New message"], section[aria-label="Reply"], section[aria-label="Reply all"], section[aria-label="Forward"]').first();
const editorBox = () => composer().locator('.ProseMirror').first();
const sendBtn = () => composer().getByRole('button', { name: 'Send', exact: true });
const undoBar = () => page.getByText(/^Sending “/);

async function addRecipient(label, text) {
  const input = composer().locator(`#rcpt-${label}`);
  await input.click();
  await input.fill(text);
  await input.press('Enter');
}
async function newMail() {
  await page.getByRole('button', { name: 'New mail', exact: true }).click();
  await composer().waitFor({ timeout: 20000 });
  await editorBox().waitFor({ timeout: 20000 });
}
async function waitSent(subject) {
  // The undo window passes in the browser, which then releases it; the tick is the fallback.
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const o = await outbox(subject);
    if (o && ['sent', 'failed'].includes(o.status)) return o;
    if (o && o.status === 'held' && Date.parse(o.release_at) < Date.now() - 8000) await tick();
    await sleep(700);
  }
  return outbox(subject);
}

try {
  await mock('/__mock/reset', {});
  const id = {};
  const add = async (key, subject, extra = {}) => {
    id[key] = (await mock('/__mock/message', { mailbox: OWNER, from: 'ann@client.example', fromName: 'Ann Client', subject, isRead: true, ...extra })).id;
  };
  await add('quarter', 'Quarterly numbers', {
    receivedDaysAgo: 0.01,
    body: '<p>Numbers attached in the deck.</p>',
    to: [{ name: 'Olive Owner', address: OWNER }, { name: 'Carol', address: 'carol@client.example' }],
    cc: [{ name: 'Bob', address: 'bob@client.example' }],
  });
  await add('contract', 'Contract attached', {
    receivedDaysAgo: 0.02,
    attachments: [{ name: 'contract.pdf', contentType: 'application/pdf', size: 2048 }],
  });

  // connect + sync
  await page.goto(`${BASE}/email/settings`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.getByRole('button', { name: 'Connect Outlook' }).click();
  await page.waitForURL(/oauth2\/v2\.0\/authorize/);
  await page.click(`a[data-account="${OWNER}"]`);
  await page.waitForURL(/\/email\/settings/, { timeout: 90000 });
  await syncAll();

  // ── settings ───────────────────────────────────────────────────────────
  await page.goto(`${BASE}/email/settings`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.getByText('Undo send', { exact: true }).waitFor({ timeout: 20000 });
  await page.locator('select').filter({ has: page.locator('option', { hasText: '10 seconds' }) }).selectOption('4');
  t('undo window saved', !!(await until(async () => (await one(`select undo_send_seconds s from mail_user_settings where user_id=$1`, [me.id]))?.s === 4)));
  const sigBox = page.locator('div.rounded-xl', { hasText: OWNER }).filter({ has: page.locator('.ProseMirror') }).first();
  await sigBox.locator('.ProseMirror').click();
  await page.keyboard.type('Olive Owner — TapDash Sales');
  await sigBox.getByRole('button', { name: 'Save signature' }).click();
  t('signature saved for the mailbox', !!(await until(async () =>
    (await one(`select s.body_html from mail_signatures s join mail_mailboxes m on m.id=s.mailbox_id where m.address=$1`, [OWNER]))?.body_html?.includes('Olive Owner — TapDash Sales'))));
  await page.getByRole('button', { name: 'New template' }).click();
  await page.getByLabel('Template name').fill('Follow-up');
  await page.getByRole('dialog').locator('.ProseMirror').click();
  await page.keyboard.type('Just following up on this.');
  await page.getByRole('dialog').getByRole('button', { name: 'Save template' }).click();
  t('template saved (personal)', !!(await until(async () => (await one(`select owner_id from mail_templates where name='Follow-up' and created_by_id=$1`, [me.id]))?.owner_id === me.id)));
  t('template listed in settings', await page.getByText('Follow-up', { exact: true }).isVisible());
  await shot('p6-1-settings');

  await page.goto(`${BASE}/email`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.waitForTimeout(800);

  // ── new mail: formatting, template, signature, invalid chip, attachments ─
  await newMail();
  t('composer replaces the reading pane', await composer().isVisible());
  await addRecipient('To', 'dave@client.example');
  await addRecipient('To', 'not-an-address');
  t('an invalid address stays as a red chip', await composer().getByTitle('Not an email address').isVisible());
  await composer().locator('#compose-subject').fill('Hello from TapDash');
  await editorBox().click();
  await page.keyboard.type('Body text ');
  await page.keyboard.press('Control+b');
  await page.keyboard.type('bold');
  await page.keyboard.press('Control+b');
  await page.keyboard.press('Enter');
  await composer().getByRole('button', { name: 'Templates' }).click();
  await page.getByRole('button', { name: 'Follow-up' }).click();
  t('template inserted into the editor', (await editorBox().innerText()).includes('Just following up on this.'));
  t('signature previewed under the editor', await composer().locator('iframe[title="Message: Signature"]').isVisible());
  await sendBtn().click();
  t('invalid address blocks Send', await composer().getByRole('alert').getByText('One of the addresses isn’t valid').isVisible());
  await composer().getByRole('button', { name: 'Remove not-an-address' }).click();
  const small = Buffer.alloc(20 * 1024, 'n');
  const large = Buffer.alloc(6 * 1024 * 1024 + 12345, 7);
  await composer().locator('input[type=file]').setInputFiles([
    { name: 'notes.txt', mimeType: 'text/plain', buffer: small },
    { name: 'deck.pdf', mimeType: 'application/pdf', buffer: large },
  ]);
  t('attachments upload with progress, then show their size', !!(await until(async () => (await composer().getByText(/Uploading…/).count()) === 0 && (await composer().getByText('deck.pdf').count()) === 1, 60000)));
  await shot('p6-2-composer');
  await sendBtn().click();
  t('undo bar counts down', await undoBar().waitFor({ timeout: 10000 }).then(() => true, () => false));
  await shot('p6-3-undo');
  const first = await sentWith('Hello from TapDash');
  t('new mail reaches Outlook', !!first);
  if (first) {
    t('…to the right person', first.to.length === 1 && first.to[0].address === 'dave@client.example', JSON.stringify(first.to));
    t('…with the formatting', /<strong>bold<\/strong>/.test(first.body), first.body.slice(0, 200));
    t('…the template text', first.body.includes('Just following up on this.'));
    t('…and the signature, once', first.body.split('Olive Owner — TapDash Sales').length === 2);
    const att = Object.fromEntries(first.attachments.map((a) => [a.name, a.size]));
    t('small attachment sent intact', att['notes.txt'] === small.length, JSON.stringify(att));
    t('6 MB attachment sent intact (upload session)', att['deck.pdf'] === large.length, JSON.stringify(att));
    const ups = (await mock('/__mock/state')).log.filter((l) => l.startsWith('upload '));
    t('…in 320 KiB-multiple chunks ≤ 4 MB', ups.length >= 2 && ups.every((l) => {
      const [a, b] = l.split(' ')[1].split('/')[0].split('-').map(Number);
      return b - a + 1 <= 4 * 1024 * 1024;
    }), ups.join(', '));
  }
  const firstRow = await waitSent('Hello from TapDash');
  t('outbox row marked sent', firstRow?.status === 'sent', firstRow?.status);
  t('staged attachments removed from storage', !!(await until(async () => (await storageList()).filter((p) => !storageBefore.has(p)).length === 0, 15000)));
  t('banner confirms the send', await page.getByText('Sent “Hello from TapDash”.').waitFor({ timeout: 20000 }).then(() => true, () => false));

  // ── undo send ──────────────────────────────────────────────────────────
  await newMail();
  await addRecipient('To', 'dave@client.example');
  await composer().locator('#compose-subject').fill('Undo me');
  await editorBox().click();
  await page.keyboard.type('Second thoughts.');
  await page.keyboard.press('Control+Enter');
  await undoBar().waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'Undo' }).click();
  t('undo brings the message back into the composer', await composer().locator('#compose-subject').waitFor({ timeout: 10000 }).then(async () => (await composer().locator('#compose-subject').inputValue()) === 'Undo me', () => false));
  t('…with its recipient and words', (await composer().getByText('dave@client.example').count()) === 1 && (await editorBox().innerText()).includes('Second thoughts.'));
  t('undone message never reached Outlook', (await sleep(5000), !(await sent()).some((m) => m.subject === 'Undo me')));
  t('outbox row cancelled', (await outbox('Undo me'))?.status === 'cancelled');
  await composer().getByRole('button', { name: 'Discard' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click();
  t('discard leaves no draft in Outlook', !!(await until(async () => !(await drafts()).some((d) => d.subject === 'Undo me'), 15000)));

  // ── a draft deleted in Outlook before it goes: failed, never "sent" ─────
  await newMail();
  await addRecipient('To', 'dave@client.example');
  await composer().locator('#compose-subject').fill('Deleted in Outlook');
  await editorBox().click();
  await page.keyboard.type('This draft disappears.');
  await composer().getByText(/Draft saved/).waitFor({ timeout: 20000 });
  await sendBtn().click();
  await undoBar().waitFor({ timeout: 10000 });
  const doomed = (await drafts()).find((d) => d.subject === 'Deleted in Outlook');
  await mock('/__mock/delete', { id: doomed?.id });
  const gone = await waitSent('Deleted in Outlook');
  t('a draft deleted in Outlook during the undo window is NOT reported sent', gone?.status === 'failed' && gone?.last_error_code === 'draft_gone', JSON.stringify({ s: gone?.status, c: gone?.last_error_code }));
  t('…nothing reached anyone', !(await sent()).some((m) => m.subject === 'Deleted in Outlook'));
  t('…and the person is told why', !!(await until(async () => (await page.getByRole('alert').filter({ hasText: 'deleted in Outlook before it could go' }).count()) > 0, 40000)));
  await page.getByRole('alert').filter({ hasText: 'deleted in Outlook' }).getByRole('button', { name: 'Dismiss' }).click().catch(() => {});

  // ── reply (autosaved first, quote exactly once) ────────────────────────
  await row('Quarterly numbers').click();
  await toolbar().waitFor({ timeout: 20000 });
  await toolbar().getByRole('button', { name: 'Reply', exact: true }).click();
  await composer().waitFor({ timeout: 20000 });
  t('reply addressed to the sender', (await composer().getByText('Ann Client').count()) >= 1);
  t('reply subject prefixed', (await composer().locator('#compose-subject').inputValue()) === 'RE: Quarterly numbers');
  await editorBox().click();
  await page.keyboard.type('Thanks Ann, looks good.');
  t('autosave: "Draft saved"', await composer().getByText(/Draft saved/).waitFor({ timeout: 20000 }).then(() => true, () => false));
  const replyDraft = await until(async () => (await drafts()).find((d) => d.subject === 'RE: Quarterly numbers' && d.body.includes('Thanks Ann')), 15000);
  t('…the draft is in Outlook’s Drafts with the words', !!replyDraft);
  t('…and Outlook’s quote under them', !!replyDraft && replyDraft.body.includes('divRplyFwdMsg') && replyDraft.body.includes('Numbers attached in the deck.'));
  await composer().getByRole('button', { name: /^Original message/ }).click();
  t('original message preview opens', await composer().locator('iframe[title="Message: Original message"]').waitFor({ timeout: 10000 }).then(() => true, () => false));
  await shot('p6-4-reply');
  await sendBtn().click();
  const reply = await sentWith('RE: Quarterly numbers');
  t('reply sent', !!reply);
  if (reply) {
    t('…to Ann only', reply.to.map((a) => a.address).join() === 'ann@client.example' && reply.cc.length === 0, JSON.stringify([reply.to, reply.cc]));
    t('…quote present exactly once', reply.body.split('divRplyFwdMsg').length === 2);
    t('…the autosaved draft itself was sent (no duplicate draft left)', !(await drafts()).some((d) => d.subject === 'RE: Quarterly numbers'));
  }
  await waitSent('RE: Quarterly numbers');

  // ── reply all ──────────────────────────────────────────────────────────
  await row('Quarterly numbers').click();
  await toolbar().getByRole('button', { name: 'Reply all' }).click();
  await composer().waitFor({ timeout: 20000 });
  await editorBox().click();
  await page.keyboard.type('Adding everyone.');
  await page.keyboard.press('Control+Enter');
  const all = await until(async () => (await sent()).find((m) => m.subject === 'RE: Quarterly numbers' && m.body.includes('Adding everyone.')), 45000);
  t('reply all sent', !!all);
  if (all) {
    const to = all.to.map((a) => a.address).sort().join();
    t('…to the sender and the other recipient, not me', to === 'ann@client.example,carol@client.example', to);
    t('…Cc kept', all.cc.map((a) => a.address).join() === 'bob@client.example', JSON.stringify(all.cc));
  }

  // ── forward (original attachment carried) ──────────────────────────────
  await row('Contract attached').click();
  await toolbar().getByRole('button', { name: 'Forward' }).click();
  await composer().waitFor({ timeout: 20000 });
  await addRecipient('To', 'erin@partner.example');
  await page.keyboard.press('Control+Enter');
  const fwd = await sentWith('FW: Contract attached');
  t('forward sent', !!fwd);
  t('…with the original attachment', !!fwd && fwd.attachments.some((a) => a.name === 'contract.pdf'), JSON.stringify(fwd?.attachments));

  // ── a draft finished later, from Drafts ────────────────────────────────
  await newMail();
  await addRecipient('To', 'frank@client.example');
  await composer().locator('#compose-subject').fill('Draft to finish');
  await editorBox().click();
  await page.keyboard.type('Half a thought');
  await composer().getByText(/Draft saved/).waitFor({ timeout: 20000 });
  await composer().getByRole('button', { name: 'Close' }).click();
  t('closing keeps the draft', await page.getByText('Saved to Drafts.').waitFor({ timeout: 10000 }).then(() => true, () => false));
  await syncAll();
  await folderBtn('Drafts').click();
  t('the draft shows in Drafts', await row('Draft to finish').waitFor({ timeout: 30000 }).then(() => true, () => false));
  await row('Draft to finish').click();
  await toolbar().getByRole('button', { name: 'Continue draft' }).click();
  await composer().waitFor({ timeout: 20000 });
  t('continuing restores subject and words', (await composer().locator('#compose-subject').inputValue()) === 'Draft to finish' && (await editorBox().innerText()).trim() === 'Half a thought', await editorBox().innerText());
  t('…with the signature kept out of the editor, previewed below', await composer().locator('iframe[title="Message: Signature"]').isVisible());
  await editorBox().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(', finished.');
  await page.keyboard.press('Control+Enter');
  const finished = await sentWith('Draft to finish');
  t('finished draft sent', !!finished && finished.body.includes('finished.'));
  t('…signature once, after the words', !!finished && finished.body.split('Olive Owner — TapDash Sales').length === 2 && finished.body.indexOf('finished.') < finished.body.indexOf('Olive Owner'), finished?.body.slice(-300));
  await waitSent('Draft to finish');
  await syncAll();
  t('…and gone from Drafts', !!(await until(async () => (await row('Draft to finish').count()) === 0, 30000)));
  await folderBtn('Inbox').click();

  // ── a reply draft changed in Outlook meanwhile: Outlook's version wins ──
  await row('Contract attached').click();
  await toolbar().getByRole('button', { name: 'Reply', exact: true }).click();
  await composer().waitFor({ timeout: 20000 });
  await editorBox().click();
  await page.keyboard.type('Draft reply');
  await composer().getByText(/Draft saved/).waitFor({ timeout: 20000 });
  await composer().getByRole('button', { name: 'Close' }).click();
  const rd = await until(async () => (await drafts()).find((d) => d.subject === 'RE: Contract attached'), 15000);
  await mock('/__mock/update', { id: rd?.id, subject: 'RE: Contract attached (edited in Outlook)' });
  await syncAll();
  await folderBtn('Drafts').click();
  await row('edited in Outlook').waitFor({ timeout: 30000 });
  await row('edited in Outlook').click();
  await toolbar().getByRole('button', { name: 'Continue draft' }).click();
  await composer().waitFor({ timeout: 20000 });
  t('Outlook-edited draft opens with Outlook’s version', (await composer().locator('#compose-subject').inputValue()) === 'RE: Contract attached (edited in Outlook)');
  await page.keyboard.press('Control+Enter');
  const edited = await sentWith('RE: Contract attached (edited in Outlook)');
  t('…sent with words, signature and quote each exactly once', !!edited
    && edited.body.split('Draft reply').length === 2 && edited.body.split('Olive Owner — TapDash Sales').length === 2 && edited.body.split('Subject:').length === 2 && edited.body.includes('ann@client.example'),
    edited?.body.slice(0, 300));
  await waitSent('RE: Contract attached (edited in Outlook)');
  await folderBtn('Inbox').click();

  // ── scheduled send ─────────────────────────────────────────────────────
  const schedule = async (subject) => {
    await newMail();
    await addRecipient('To', 'dave@client.example');
    await composer().locator('#compose-subject').fill(subject);
    await editorBox().click();
    await page.keyboard.type('Later.');
    await composer().getByRole('button', { name: 'More send options' }).click();
    await page.getByRole('button', { name: 'Schedule send…' }).click();
    const when = new Date(Date.now() + 2 * 3600_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    await page.getByRole('dialog').locator('input[type=datetime-local]').fill(when);
    await page.getByRole('dialog').getByRole('button', { name: /^Send / }).click();
  };
  await schedule('Scheduled hello');
  t('schedule confirmed in a banner', await page.getByText(/Scheduled “Scheduled hello” for/).waitFor({ timeout: 15000 }).then(() => true, () => false));
  t('outbox row scheduled ~2 h ahead', !!(await until(async () => {
    const o = await outbox('Scheduled hello');
    return o?.status === 'scheduled' && Math.abs(Date.parse(o.release_at) - (Date.now() + 2 * 3600_000)) < 5 * 60_000;
  })));
  t('Scheduled folder appears with a count', !!(await until(async () => (await folderBtn('Scheduled').count()) > 0, 30000)));
  await folderBtn('Scheduled').click();
  t('scheduled list shows it', await page.getByRole('list', { name: 'Scheduled messages' }).getByText('Scheduled hello').waitFor({ timeout: 15000 }).then(() => true, () => false));
  await shot('p6-5-scheduled');
  await page.getByRole('button', { name: 'Edit or cancel' }).first().click();
  t('edit brings it back to the composer', await composer().locator('#compose-subject').waitFor({ timeout: 10000 }).then(async () => (await composer().locator('#compose-subject').inputValue()) === 'Scheduled hello', () => false));
  t('…and the schedule is cancelled', (await outbox('Scheduled hello'))?.status === 'cancelled');
  await composer().getByRole('button', { name: 'Discard' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click();

  await folderBtn('Inbox').click();
  await schedule('Fires on time');
  await until(async () => (await outbox('Fires on time'))?.status === 'scheduled');
  await db.query(`update mail_outbox set release_at = now() - interval '1 second' where subject = 'Fires on time' and status = 'scheduled'`);
  await syncAll();
  t('a due scheduled message is sent by the scheduler', !!(await sentWith('Fires on time')));
  t('Outlook never saw "Scheduled hello"', !(await sent()).some((m) => m.subject === 'Scheduled hello'));

  // ── empty subject asks first ───────────────────────────────────────────
  await newMail();
  await addRecipient('To', 'dave@client.example');
  await editorBox().click();
  await page.keyboard.type('No subject here.');
  await sendBtn().click();
  t('empty subject: asks before sending', await page.getByRole('dialog').getByText('Send without a subject?').isVisible());
  await page.getByRole('dialog').getByRole('button', { name: 'Send anyway' }).click();
  t('…and sends when told to', !!(await until(async () => (await sent()).some((m) => m.subject === '' && m.body.includes('No subject here.')), 45000)));

  // ── refused send → notice ──────────────────────────────────────────────
  await mock('/__mock/fault', { sendFail: 'ErrorSendAsDenied' });
  await newMail();
  await addRecipient('To', 'dave@client.example');
  await composer().locator('#compose-subject').fill('Will be refused');
  await page.keyboard.press('Control+Enter');
  const refused = await waitSent('Will be refused');
  t('a refused send fails at once (no retries)', refused?.status === 'failed' && refused?.attempts === 1, JSON.stringify({ s: refused?.status, a: refused?.attempts, c: refused?.last_error_code }));
  t('…recording why', refused?.last_error_code === 'send_as_denied');
  const notice = await until(async () => (await page.getByRole('alert').filter({ hasText: 'didn’t send' }).count()) + (await page.getByRole('alert').filter({ hasText: "didn't send" }).count()) > 0, 40000);
  t('…and the person gets a notice', !!notice);
  await shot('p6-6-refused');
  if (notice) {
    await page.getByRole('alert').filter({ hasText: /didn.t send/ }).getByRole('button', { name: 'Dismiss' }).click();
    t('notice dismissed', !!(await until(async () => (await one(`select count(*)::int n from mail_notices where user_id=$1 and kind='send_failed' and dismissed_at is null`, [me.id])).n === 0)));
  }

  // ── transient failure → retried, sent once ─────────────────────────────
  await mock('/__mock/fault', { failSend: 1 });
  await newMail();
  await addRecipient('To', 'dave@client.example');
  await composer().locator('#compose-subject').fill('Second try works');
  await page.keyboard.press('Control+Enter');
  const retried = await until(async () => {
    const o = await outbox('Second try works');
    return o?.status === 'held' && o.attempts === 1 && o.last_error_code ? o : null;
  }, 40000);
  t('a transient failure is put back for a retry', !!retried, JSON.stringify(await outbox('Second try works')));
  await db.query(`update mail_outbox set release_at = now() where subject = 'Second try works' and status = 'held'`);
  await syncAll();
  const secondTry = (await sent()).filter((m) => m.subject === 'Second try works');
  t('…and the retry sends it exactly once', secondTry.length === 1, String(secondTry.length));
  await mock('/__mock/fault', {});

  // ── suggestions learned from sent mail ─────────────────────────────────
  await newMail();
  await composer().locator('#rcpt-To').fill('car');
  t('recipient suggestions from past mail', await page.getByRole('listbox', { name: 'Suggestions' }).getByText('carol@client.example').waitFor({ timeout: 10000 }).then(() => true, () => false));
  await composer().locator('#rcpt-To').fill('');
  await composer().getByRole('button', { name: 'Discard' }).click();
} catch (e) {
  fail.push(`threw: ${e.stack ?? e}`);
} finally {
  await browser.close();
  await db.query(`update profiles set last_seen_at = $2 where email=$1`, [ADMIN, seenBefore]).catch(() => {});
  await db.query(`delete from mail_mailboxes where address like '%@mock.test'`);
  await db.query(`delete from mail_identities where user_id = $1 and microsoft_user_id like 'oid-%'`, [me.id]);
  for (const r of await q(`select id from mail_templates`)) if (!templatesBefore.has(r.id)) await db.query(`delete from mail_templates where id=$1`, [r.id]);
  if (settingsBefore) {
    await db.query(`update mail_user_settings set undo_send_seconds=$2, hide_my_mailboxes_from_admins=$3, default_from_mailbox_id=$4 where user_id=$1`,
      [me.id, settingsBefore.undo_send_seconds, settingsBefore.hide_my_mailboxes_from_admins, settingsBefore.default_from_mailbox_id]);
  } else {
    await db.query(`delete from mail_user_settings where user_id=$1`, [me.id]);
  }
  const strays = (await storageList()).filter((p) => !storageBefore.has(p));
  if (strays.length) await svc.storage.from('mail-outbox').remove(strays);
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
