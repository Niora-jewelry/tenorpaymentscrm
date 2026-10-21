/**
 * Graph push notifications end to end, against the mock Microsoft — which
 * runs the real validation handshake and POSTs real notifications at the
 * app whenever its mailbox changes.
 *
 *   subscriptions  created on first sync (handshake passes), mailbox healthy,
 *                  renewed by the tick when close to expiry
 *   changes        new / read / move / delete in Outlook land in seconds
 *                  WITHOUT a tick
 *   trust          forged clientState and unknown subscriptions are dropped;
 *                  validation echo is plain text
 *   lifecycle      missed → hot folders reconcile; reauthorizationRequired →
 *                  renewed; subscriptionRemoved → recreated
 *
 * Needs the dev server with MAIL_WEBHOOKS_ENABLED=true and
 * MAIL_WEBHOOK_BASE_URL=http://localhost:3221 on top of the mock env.
 *   CRON_SECRET=… node --env-file=.env scripts/verify-mail-notify.mjs
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const BASE = process.argv[2] || 'http://localhost:3221';
const MOCK = process.env.MAIL_MOCK_BASE_URL || 'http://127.0.0.1:4555';
const CRON = process.env.CRON_SECRET;
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ADMIN = 'admin@tapdash.test';
const OWNER = 'owner@mock.test';
if (!CRON) process.exit(1);

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

const mock = (path, body) => fetch(`${MOCK}${path}`, { method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(300);
  }
  return fn();
};

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
const cleanRate = () => db.query(`delete from rate_limit_counters where key like $1 or key like 'mail_tick:%' or key like 'mail_notify:%'`, [`mail_%:user:${me.id}`]);
await cleanRate();

const pass = [], fail = [];
const t = (n, ok, d = '') => (ok ? pass : fail).push(`${n}${d ? '  — ' + d : ''}`);
const tick = () => fetch(`${BASE}/api/mail/tick`, { headers: { Authorization: `Bearer ${CRON}` } });
async function tickAndWait(mbId, ms = 120000) {
  await tick();
  const end = Date.now() + ms;
  await sleep(1500);
  while (Date.now() < end) {
    const s = await one(
      `select (select count(*)::int from mail_sync_queue where mailbox_id=$1 and processed_at is null and not_before <= now()) due,
              (select coalesce(lease_until > now(), false) from mail_mailboxes where id=$1) leased`, [mbId]);
    if (s.due === 0 && !s.leased) return;
    if (s.due > 0 && !s.leased) await tick();
    await sleep(1000);
  }
  throw new Error('mailbox never went idle');
}

const browser = await chromium.launch();
const errors = [];
const page = await (await browser.newContext()).newPage();
await page.context().addCookies(cookies);
page.on('pageerror', (e) => errors.push(String(e)));
await page.route('**://*.posthog.com/**', (r) => r.abort());

try {
  // ── handshake + trust at the door ──────────────────────────────────────
  const echo = await fetch(`${BASE}/api/mail/graph/notifications?validationToken=${encodeURIComponent('Validation: Token <x>')}`, { method: 'POST' });
  t('validation token echoed verbatim as text/plain', echo.status === 200 && (await echo.text()) === 'Validation: Token <x>' && /text\/plain/.test(echo.headers.get('content-type') ?? ''));
  const unknown = await fetch(`${BASE}/api/mail/graph/notifications`, {
    method: 'POST',
    body: JSON.stringify({ value: [{ subscriptionId: 'sub-nope', clientState: 'x', changeType: 'created', resourceData: { id: 'm' } }] }),
  });
  t('unknown subscription → 202, nothing queued', unknown.status === 202 && (await one(`select count(*)::int n from mail_sync_queue where target='m'`)).n === 0);
  const junk = await fetch(`${BASE}/api/mail/graph/lifecycle`, { method: 'POST', body: '{"value": "not a list"' });
  t('malformed body → 202, no error', junk.status === 202);

  // ── connect + first sync creates the subscriptions ─────────────────────
  await mock('/__mock/reset', {});
  await mock('/__mock/message', { mailbox: OWNER, folder: 'inbox', subject: 'Before connect' });
  await page.goto(`${BASE}/email/settings`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.getByRole('button', { name: 'Connect Outlook' }).click();
  await page.waitForURL(/oauth2\/v2\.0\/authorize/);
  await page.click(`a[data-account="${OWNER}"]`);
  await page.waitForURL(/\/email\/settings/, { timeout: 90000 });
  const mb = await one(`select id from mail_mailboxes where address=$1`, [OWNER]);
  await tickAndWait(mb.id);

  const subs = await q(`select resource, status, graph_subscription_id, expires_at, length(client_state) cs from mail_subscriptions where mailbox_id=$1 order by resource`, [mb.id]);
  t('two subscriptions active, 43-char random clientState each', subs.length === 2 && subs.every((s) => s.status === 'active' && s.cs === 43), JSON.stringify(subs.map((s) => s.resource)));
  t('expiry ~7 days out', subs.every((s) => new Date(s.expires_at) - Date.now() > 6.9 * 86400000));
  t('mailbox marked subscription_healthy', (await one(`select subscription_healthy h from mail_mailboxes where id=$1`, [mb.id])).h === true);
  const mockSubs = (await mock('/__mock/state')).subscriptions;
  t('Microsoft side: handshake passed, notification URL points here', mockSubs.length === 2 && mockSubs.every((s) => s.notificationUrl === `${BASE}/api/mail/graph/notifications`));

  // ── changes arrive by push, no tick ────────────────────────────────────
  const t0 = Date.now();
  const fresh = (await mock('/__mock/message', { mailbox: OWNER, folder: 'inbox', subject: 'Pushed in' })).id;
  const arrived = await until(() => one(`select 1 x from mail_messages where graph_id=$1 and deleted_at is null`, [fresh]));
  t('new mail lands by push alone', !!arrived, `${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await mock('/__mock/update', { id: fresh, isRead: true });
  t('read in Outlook lands by push', !!(await until(() => one(`select 1 x from mail_messages where graph_id=$1 and is_read`, [fresh]))));
  await mock('/__mock/update', { id: fresh, folder: 'clients' });
  t('move lands by push (same row, new folder)', !!(await until(() =>
    one(`select 1 x from mail_messages m join mail_folders f on f.id=m.folder_id where m.graph_id=$1 and f.display_name='Clients' and m.deleted_at is null`, [fresh]))));
  await mock('/__mock/delete', { id: fresh });
  t('delete lands by push', !!(await until(() => one(`select 1 x from mail_messages where graph_id=$1 and deleted_at is not null`, [fresh]))));
  const runs = await one(`select count(*)::int n from mail_sync_runs where mailbox_id=$1 and trigger='notify' and status='ok'`, [mb.id]);
  t('handled by notify-triggered runs', runs.n > 0, String(runs.n));
  t('last_notification_at recorded', !!(await one(`select 1 x from mail_subscriptions where mailbox_id=$1 and resource='messages' and last_notification_at > now() - interval '1 minute'`, [mb.id])));

  // ── forged clientState is ignored ──────────────────────────────────────
  await mock('/__mock/fault', { notifyBadClientState: true });
  const forged = (await mock('/__mock/message', { mailbox: OWNER, folder: 'inbox', subject: 'Forged ping' })).id;
  await sleep(5000);
  t('forged clientState → not acted on', !(await one(`select 1 x from mail_sync_queue where target=$1`, [forged])) && !(await one(`select 1 x from mail_messages where graph_id=$1`, [forged])));
  await mock('/__mock/fault', {});

  // ── lifecycle ──────────────────────────────────────────────────────────
  await mock('/__mock/lifecycle', { mailbox: OWNER, event: 'missed' });
  // the missed message (sent with a forged state) is recovered by the hot reconciliation
  t('missed → hot folders reconciled, lost change recovered', !!(await until(() => one(`select 1 x from mail_messages where graph_id=$1 and deleted_at is null`, [forged]), 20000)));

  const msgSub = await one(`select graph_subscription_id g, expires_at e from mail_subscriptions where mailbox_id=$1 and resource='messages'`, [mb.id]);
  await mock('/__mock/lifecycle', { mailbox: OWNER, event: 'reauthorizationRequired' });
  const renewed = await until(async () => {
    const r = await one(`select graph_subscription_id g, expires_at e from mail_subscriptions where mailbox_id=$1 and resource='messages'`, [mb.id]);
    return r.g === msgSub.g && new Date(r.e) - Date.now() > 6.9 * 86400000 && (await mock('/__mock/state')).log.includes('renew') ? r : null;
  }, 20000);
  t('reauthorizationRequired → renewed in place (same id, PATCH)', !!renewed);

  await mock('/__mock/lifecycle', { mailbox: OWNER, event: 'subscriptionRemoved' });
  const recreated = await until(async () => {
    const r = await one(`select graph_subscription_id g, status from mail_subscriptions where mailbox_id=$1 and resource='messages'`, [mb.id]);
    const h = await one(`select subscription_healthy h from mail_mailboxes where id=$1`, [mb.id]);
    return r.g !== msgSub.g && r.status === 'active' && h.h ? r : null;
  }, 20000);
  t('subscriptionRemoved → recreated, healthy again', !!recreated);

  // ── tick renews when close to expiry ───────────────────────────────────
  await db.query(`update mail_subscriptions set expires_at = now() + interval '2 hours' where mailbox_id=$1 and resource='mailFolders'`, [mb.id]);
  await tickAndWait(mb.id);
  const fold = await one(`select expires_at e from mail_subscriptions where mailbox_id=$1 and resource='mailFolders'`, [mb.id]);
  t('tick renews a subscription inside its last day', new Date(fold.e) - Date.now() > 6.9 * 86400000);

  // ── disconnect → subscriptions pruned ──────────────────────────────────
  await page.goto(`${BASE}/email/settings`, { waitUntil: 'networkidle' });
  await page.locator('li', { hasText: OWNER }).getByRole('button', { name: 'Disconnect' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click();
  await sleep(2500);
  await tick();
  t('disconnect → subscription rows pruned', !!(await until(async () => (await one(`select count(*)::int n from mail_subscriptions where mailbox_id=$1`, [mb.id])).n === 0, 20000)));
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
  t('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
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
