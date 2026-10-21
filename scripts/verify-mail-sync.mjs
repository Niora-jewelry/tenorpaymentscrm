/**
 * The sync engine end to end: real cron route, real leases and queue, real
 * Graph client, against the mock Microsoft (`scripts/mail-mock-graph.mjs`).
 *
 *   seed      14-day window, two delta pages, sanitised bodies, attachments,
 *             folder counts, "Setting up" → syncing
 *   changes   read flag, move (same row, new folder — not a delete), delete,
 *             new mail — all picked up by the scheduler on its own
 *   faults    expired delta cursor → reseed without duplicates; 429 →
 *             mailbox waits; revoked sign-in → connection broken, Reconnect
 *             heals it; the cron route refuses without its secret
 *
 * Writes only *@mock.test mailboxes and the admin test account's mock
 * identities, and removes them; every mail_* count is compared before/after.
 *
 *   node scripts/mail-mock-graph.mjs
 *   (dev server with the MAIL_* mock env + CRON_SECRET, port 3221)
 *   CRON_SECRET=… node --env-file=.env scripts/verify-mail-sync.mjs
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const BASE = process.argv[2] || 'http://localhost:3221';
const MOCK = process.env.MAIL_MOCK_BASE_URL || 'http://127.0.0.1:4555';
const CRON = process.env.CRON_SECRET;
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ADMIN = 'admin@tapdash.test';
if (!CRON) {
  console.error('CRON_SECRET (the dev server’s) is required.');
  process.exit(1);
}

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
const recordsBefore = (await one(`select count(*)::int n from records`)).n;

const mock = (path, body) =>
  fetch(`${MOCK}${path}`, { method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json());

// The 24h idle rule in proxy.ts signs a stale test account straight out:
// freshen the admin's last_seen_at for the run and restore it afterwards.
const adminSeenBefore = (await db.query(`select last_seen_at from profiles where email=$1`, [ADMIN])).rows[0].last_seen_at;
await db.query(`update profiles set last_seen_at = now() where email=$1`, [ADMIN]);

const svc = createClient(SUPA, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = createClient(SUPA, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const ref = new URL(SUPA).hostname.split('.')[0];
const [me] = await q(`select id from profiles where email=$1`, [ADMIN]);
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tick = (headers = { Authorization: `Bearer ${CRON}` }, qs = '') => fetch(`${BASE}/api/mail/tick${qs}`, { headers });
/** Fires the cron route and waits until the mailbox has no due work and no lease. */
async function tickAndWait(mbId, ms = 120000) {
  const r = await tick();
  if (r.status !== 202) throw new Error(`tick answered ${r.status}`);
  const end = Date.now() + ms;
  await sleep(1500);
  while (Date.now() < end) {
    const s = await one(
      `select (select count(*)::int from mail_sync_queue where mailbox_id=$1 and processed_at is null and not_before <= now()) due,
              (select coalesce(lease_until > now(), false) from mail_mailboxes where id=$1) leased`,
      [mbId],
    );
    if (s.due === 0 && !s.leased) return;
    if (s.due > 0 && !s.leased) await tick(); // more work queued after the first pass
    await sleep(1500);
  }
  throw new Error('mailbox never went idle');
}
/** Pretend the hot folders were last reconciled two minutes ago, so the scheduler picks them up. */
const ageFolders = (mbId) => db.query(`update mail_folders set delta_synced_at = now() - interval '2 hours' where mailbox_id=$1 and seeded_at is not null`, [mbId]);

const browser = await chromium.launch();
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1300, height: 950 } });
await ctx.addCookies(cookies);
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });
await page.route('**://*.posthog.com/**', (r) => r.abort());

async function connectOwner() {
  await page.goto(`${BASE}/email/settings`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.getByRole('button', { name: 'Connect Outlook' }).click();
  await page.waitForURL(/oauth2\/v2\.0\/authorize/, { timeout: 30000 });
  await page.click('a[data-account="owner@mock.test"]');
  await page.waitForURL(/\/email\/settings/, { timeout: 90000 });
  return (async (page) => {
  // Success is a dialog ("Outlook connected" + address); refusals stay a banner.
  const dlg = page.getByRole('dialog');
  if (await dlg.waitFor({ timeout: 6000 }).then(() => true, () => false)) {
    const text = `${(await dlg.locator('h2').textContent()) ?? ''} ${(await dlg.locator('h2 + p').textContent()) ?? ''}`.trim();
    await dlg.getByRole('button', { name: 'Done' }).click();
    return text;
  }
  return ((await page.locator('[role=status], [role=alert]').first().textContent({ timeout: 15000 }).catch(() => '')) ?? '').trim();
})(page);
}

try {
  await mock('/__mock/reset', {});
  const OWNER = 'owner@mock.test';
  const ids = {};
  for (let i = 0; i < 60; i += 1) await mock('/__mock/message', { mailbox: OWNER, folder: 'inbox', subject: `Bulk ${i}`, receivedDaysAgo: i * 0.2, isRead: i % 3 === 0 });
  ids.old = (await mock('/__mock/message', { mailbox: OWNER, folder: 'inbox', subject: 'Old news', receivedDaysAgo: 20 })).id;
  ids.hostile = (await mock('/__mock/message', {
    mailbox: OWNER,
    folder: 'inbox',
    subject: 'Invoice attached',
    body: '<p>Pay <b>now</b></p><img src="https://track.example/p.gif"><script>steal()</script><a href="javascript:x()">x</a>',
    attachments: [{ name: 'Invoice.pdf', size: 52000 }],
  })).id;
  ids.toMove = (await mock('/__mock/message', { mailbox: OWNER, folder: 'inbox', subject: 'Move me' })).id;
  ids.toDelete = (await mock('/__mock/message', { mailbox: OWNER, folder: 'inbox', subject: 'Delete me' })).id;
  ids.toRead = (await mock('/__mock/message', { mailbox: OWNER, folder: 'inbox', subject: 'Read me' })).id;
  await mock('/__mock/message', { mailbox: OWNER, folder: 'sentitems', subject: 'Sent one', from: OWNER });
  await mock('/__mock/message', { mailbox: OWNER, folder: 'clients', subject: 'Client thread' });

  // ── cron route refuses without its secret ──────────────────────────────
  t('tick: no secret → 401', (await tick({})).status === 401);
  t('tick: wrong secret → 401', (await tick({ Authorization: 'Bearer nope' })).status === 401);
  t('tick: malformed mailbox → 400', (await tick(undefined, '?mailbox=../../x')).status === 400);

  // ── connect + first sync ───────────────────────────────────────────────
  const banner = await connectOwner();
  t('connected', /connected owner@mock\.test/i.test(banner), banner);
  const mb = await one(`select id from mail_mailboxes where address=$1`, [OWNER]);
  await tickAndWait(mb.id);

  const inbox = await one(`select id, seeded_at, delta_link, unread_count, total_count, oldest_loaded_at from mail_folders where mailbox_id=$1 and well_known='inbox'`, [mb.id]);
  const inboxMsgs = (await one(`select count(*)::int n from mail_messages where folder_id=$1 and deleted_at is null`, [inbox.id])).n;
  t('seed: 64 recent inbox messages over two delta pages, the 20-day-old one excluded', inboxMsgs === 64, String(inboxMsgs));
  t('seed: "Old news" outside the 14-day window', !(await one(`select 1 x from mail_messages where graph_id=$1`, [ids.old])));
  t('seed: cursor saved as a deltaLink, folder seeded, window recorded', !!inbox.seeded_at && /\$deltatoken=/.test(inbox.delta_link ?? '') && !!inbox.oldest_loaded_at);
  const sent = await one(`select m.direction from mail_messages m join mail_folders f on f.id=m.folder_id where f.mailbox_id=$1 and f.well_known='sentitems'`, [mb.id]);
  t('seed: Sent Items mail is outbound', sent?.direction === 'outbound');
  const client = await one(`select count(*)::int n from mail_messages m join mail_folders f on f.id=m.folder_id where f.mailbox_id=$1 and f.display_name='Clients'`, [mb.id]);
  t('seed: custom folder seeded too', client.n === 1);

  const h = await one(`select id, body_html, body_text, external_images, has_attachments, attachment_names from mail_messages where graph_id=$1`, [ids.hostile]);
  t('sanitised: no script, no javascript: link, image blocked', !/<script|steal\(|javascript:/i.test(h.body_html) && h.body_html.includes('data-mail-img="0"'));
  t('sanitised: blocked image remembered for "Load images"', JSON.stringify(h.external_images) === JSON.stringify(['https://track.example/p.gif']));
  t('search text derived', /Pay now/.test(h.body_text));
  const att = await q(`select name, size_bytes, is_inline from mail_attachments where message_id=$1`, [h.id]);
  t('attachment metadata listed (no bytes stored)', att.length === 1 && att[0].name === 'Invoice.pdf' && Number(att[0].size_bytes) === 52000 && h.attachment_names === 'Invoice.pdf');
  t('folder counts from Graph', inbox.total_count === 65 && inbox.unread_count === (await one(`select count(*)::int n from mail_messages where folder_id=$1 and not is_read and deleted_at is null`, [inbox.id])).n + 1,
    `${inbox.total_count}/${inbox.unread_count}`);

  const box = await one(`select sync_status, seeded_at, change_seq, last_graph_ok_at from mail_mailboxes where id=$1`, [mb.id]);
  t('mailbox: syncing, seeded, change_seq advanced', box.sync_status === 'ok' && !!box.seeded_at && Number(box.change_seq) > 0, JSON.stringify(box));
  const runs = await q(`select status from mail_sync_runs where mailbox_id=$1`, [mb.id]);
  t('sync runs recorded ok', runs.length > 0 && runs.every((r) => r.status === 'ok'));
  await page.goto(`${BASE}/email/settings`, { waitUntil: 'networkidle' });
  t('settings: "Syncing" pill', await page.locator('li', { hasText: OWNER }).getByText('Syncing').isVisible().catch(() => false));

  // ── changes made in Outlook arrive on their own ────────────────────────
  const movedRowBefore = await one(`select id from mail_messages where graph_id=$1`, [ids.toMove]);
  await mock('/__mock/update', { id: ids.toRead, isRead: true });
  await mock('/__mock/update', { id: ids.toMove, folder: 'clients' });
  await mock('/__mock/delete', { id: ids.toDelete });
  ids.fresh = (await mock('/__mock/message', { mailbox: OWNER, folder: 'inbox', subject: 'Brand new' })).id;
  const seqBefore = Number(box.change_seq);
  await ageFolders(mb.id);
  await tickAndWait(mb.id);
  const r1 = await one(`select is_read from mail_messages where graph_id=$1`, [ids.toRead]);
  t('read in Outlook → read here', r1?.is_read === true);
  const moved = await one(`select m.id, m.deleted_at, f.display_name from mail_messages m join mail_folders f on f.id=m.folder_id where m.graph_id=$1`, [ids.toMove]);
  t('moved in Outlook → same row, new folder, not deleted', moved?.id === movedRowBefore.id && moved.display_name === 'Clients' && moved.deleted_at === null, JSON.stringify(moved));
  const del = await one(`select deleted_at from mail_messages where graph_id=$1`, [ids.toDelete]);
  t('deleted in Outlook → tombstoned', !!del?.deleted_at);
  t('new mail arrives', !!(await one(`select 1 x from mail_messages where graph_id=$1 and deleted_at is null`, [ids.fresh])));
  t('change_seq advanced again', Number((await one(`select change_seq from mail_mailboxes where id=$1`, [mb.id])).change_seq) > seqBefore);

  // ── expired cursor → reseed, no duplicates ─────────────────────────────
  const inboxBefore = (await one(`select count(*)::int n from mail_messages where folder_id=$1 and deleted_at is null`, [inbox.id])).n;
  await mock('/__mock/fault', { expireDelta: true });
  await ageFolders(mb.id);
  await tickAndWait(mb.id);
  const dupes = await one(`select count(*)::int n, count(distinct graph_id)::int d from mail_messages where mailbox_id=$1`, [mb.id]);
  const inboxAfter = (await one(`select count(*)::int n from mail_messages where folder_id=$1 and deleted_at is null`, [inbox.id])).n;
  t('expired cursor: reseeded, no duplicate rows, inbox intact', dupes.n === dupes.d && inboxAfter === inboxBefore && inboxBefore === 63, `${dupes.n}/${dupes.d} inbox ${inboxBefore}→${inboxAfter}`);

  // ── throttling → the mailbox waits, then carries on ────────────────────
  await mock('/__mock/fault', { throttle: 1 });
  await ageFolders(mb.id);
  await tick();
  let thr = null;
  for (let i = 0; i < 40 && !thr; i += 1) {
    await sleep(500);
    thr = await one(`select sync_status, throttled_until from mail_mailboxes where id=$1 and throttled_until is not null and sync_status='throttled'`, [mb.id]);
  }
  t('429 → mailbox throttled with Retry-After', !!thr);
  await sleep(2500);
  await tickAndWait(mb.id);
  t('after Retry-After → syncing again', (await one(`select sync_status from mail_mailboxes where id=$1`, [mb.id])).sync_status === 'ok');

  // ── revoked sign-in → broken → Reconnect heals ─────────────────────────
  await mock('/__mock/fault', { refresh: 'invalid_grant', revokeAccess: true });
  await ageFolders(mb.id);
  await tick();
  let broke = null;
  for (let i = 0; i < 60 && !broke; i += 1) {
    await sleep(500);
    broke = await one(
      `select i.status ist, c.status cst, m.sync_status mst,
              (select count(*)::int from mail_identity_secrets s where s.identity_id=i.id) secrets
         from mail_connections c join mail_identities i on i.id=c.identity_id join mail_mailboxes m on m.id=c.mailbox_id
        where c.mailbox_id=$1 and c.disconnected_at is null and i.status='broken'`,
      [mb.id],
    );
  }
  t('invalid_grant → identity + connection broken, secret deleted, sole mailbox broken',
    broke?.ist === 'broken' && broke.cst === 'broken' && broke.mst === 'broken' && broke.secrets === 0, JSON.stringify(broke));
  await page.goto(`${BASE}/email/settings`, { waitUntil: 'networkidle' });
  const row = page.locator('li', { hasText: OWNER });
  t('settings: "Needs reconnect" + Reconnect link', (await row.getByText('Needs reconnect').isVisible().catch(() => false)) && (await row.getByRole('link', { name: 'Reconnect' }).isVisible().catch(() => false)));
  await mock('/__mock/fault', {});
  await row.getByRole('link', { name: 'Reconnect' }).click();
  await page.waitForURL(/oauth2\/v2\.0\/authorize/, { timeout: 30000 });
  await page.click('a[data-account="owner@mock.test"]');
  await page.waitForURL(/\/email\/settings/, { timeout: 90000 });
  const healed = await one(`select c.status cst, m.sync_status mst from mail_connections c join mail_mailboxes m on m.id=c.mailbox_id where c.mailbox_id=$1 and c.disconnected_at is null`, [mb.id]);
  t('reconnect: connection ok, mailbox back to pending', healed?.cst === 'ok' && healed.mst === 'pending', JSON.stringify(healed));
  await ageFolders(mb.id);
  await tickAndWait(mb.id);
  t('reconnect: syncing again', (await one(`select sync_status from mail_mailboxes where id=$1`, [mb.id])).sync_status === 'ok');
} catch (e) {
  fail.push(`threw: ${e.stack ?? e}`);
} finally {
  await browser.close();
  await db.query(`update profiles set last_seen_at = $2 where email=$1`, [ADMIN, adminSeenBefore]).catch((e) => fail.push(`restore admin last_seen_at: ${e}`));
  await db.query(`delete from mail_mailboxes where address like '%@mock.test'`);
  await db.query(`delete from mail_identities where user_id = $1 and microsoft_user_id like 'oid-%'`, [me.id]);
  await db.query(`update mail_provider_health set state=$1, last_success_at=$2, down_since=$3, last_error_code=$4 where id=1`,
    [healthBefore.state, healthBefore.last_success_at, healthBefore.down_since, healthBefore.last_error_code]);
  await cleanRate();
  await mock('/__mock/reset', {}).catch(() => {});
  const after = await counts();
  const drift = MAIL_TABLES.filter((x) => after[x] !== before[x]);
  t('every mail_* table back to its starting count', drift.length === 0, drift.map((d) => `${d} ${before[d]}→${after[d]}`).join(', '));
  t('records untouched', (await one(`select count(*)::int n from records`)).n === recordsBefore);
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
