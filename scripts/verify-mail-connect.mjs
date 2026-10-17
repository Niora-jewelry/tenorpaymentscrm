/**
 * Connecting and disconnecting mailboxes, end to end in a real browser,
 * against the mock Microsoft (`scripts/mail-mock-graph.mjs`).
 *
 * Exercises the real OAuth routes, the signed state cookie + PKCE, the code
 * exchange, tenant / mailbox / shared-access checks, `mail_connect_mailbox`,
 * token encryption, folder-tree discovery and the bootstrap queue, the
 * settings screen, and Disconnect. Plus the refusals: cancel, personal
 * account, wrong tenant, no mailbox, shared mailbox without access, forged
 * state, and a member's view of the gate.
 *
 * Writes only rows for *@mock.test mailboxes and the admin test account's
 * mock identities, and deletes them all at the end. Every mail_* table count
 * is compared before and after.
 *
 *   node scripts/mail-mock-graph.mjs
 *   MAIL_PROVIDER=mock MAIL_MOCK_BASE_URL=http://127.0.0.1:4555 \
 *   MAIL_STATE_SIGNING_SECRET=… MAIL_TOKEN_ENC_KEY=… MAIL_ALLOWED_TENANT_IDS=tid-tapdash \
 *   MAIL_REDIRECT_URI=http://localhost:3221/api/mail/oauth/callback npm run dev -- -p 3221
 *   MAIL_TOKEN_ENC_KEY=… node --env-file=.env scripts/verify-mail-connect.mjs
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { createDecipheriv } from 'node:crypto';
import pg from 'pg';

const BASE = process.argv[2] || 'http://localhost:3221';
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ADMIN = 'admin@tapdash.test';
const MEMBER = 'demo.rep@tapdash.test';
for (const e of [ADMIN, MEMBER]) if (!/@([a-z0-9-]+\.)*test$/i.test(e)) process.exit(1);
const KEY = Buffer.from(process.env.MAIL_TOKEN_ENC_KEY ?? '', 'base64');
if (KEY.length !== 32) {
  console.error('MAIL_TOKEN_ENC_KEY (the same one the dev server uses) is required.');
  process.exit(1);
}

const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const q = (s, p = []) => db.query(s, p).then((r) => r.rows);

const MAIL_TABLES = (await q(`select table_name t from information_schema.tables where table_schema='public' and table_name like 'mail\\_%' order by 1`)).map((r) => r.t);
const counts = async () => {
  const out = {};
  for (const t of MAIL_TABLES) out[t] = (await q(`select count(*)::int n from public.${t}`))[0].n;
  return out;
};
const before = await counts();
const otherCounts = async () => ({
  records: (await q(`select count(*)::int n from records`))[0].n,
  profiles: (await q(`select count(*)::int n, string_agg(role_id::text, ',' order by id) r from profiles`))[0],
});
const beforeOther = await otherCounts();

const svc = createClient(SUPA, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = createClient(SUPA, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const ref = new URL(SUPA).hostname.split('.')[0];
async function cookiesFor(email) {
  const [u] = await q(`select id from profiles where email=$1`, [email]);
  const PW = 'ZzProbe-2026!mail';
  await svc.auth.admin.updateUserById(u.id, { password: PW });
  const { data, error } = await anon.auth.signInWithPassword({ email, password: PW });
  if (error) throw error;
  const v = 'base64-' + Buffer.from(JSON.stringify(data.session)).toString('base64url');
  const out = [];
  if (v.length > 3180) for (let i = 0, n = 0; i < v.length; i += 3180, n++) out.push({ name: `sb-${ref}-auth-token.${n}`, value: v.slice(i, i + 3180), domain: 'localhost', path: '/' });
  else out.push({ name: `sb-${ref}-auth-token`, value: v, domain: 'localhost', path: '/' });
  return { id: u.id, cookies: out };
}

const pass = [], fail = [];
const t = (n, ok, d = '') => (ok ? pass : fail).push(`${n}${d ? '  — ' + d : ''}`);

const admin = await cookiesFor(ADMIN);
const cleanRate = () => db.query(`delete from rate_limit_counters where key in ($1, $2)`, [`mail_connect:user:${admin.id}`, `mail_action:user:${admin.id}`]);
await cleanRate();

let restoreSeen = async () => {};
const browser = await chromium.launch();
const errors = [];
async function session(cookies) {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 950 } });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });
  await page.route('**://*.posthog.com/**', (r) => r.abort());
  return { ctx, page };
}

const banner = async (page) => ((await page.locator('[role=status], [role=alert]').first().textContent({ timeout: 15000 }).catch(() => '')) ?? '').trim();

/** Start a connection from the settings page and pick an account on the mock. */
async function connectVia(page, { shared, account }) {
  await page.goto(`${BASE}/email/settings`, { waitUntil: 'networkidle', timeout: 180000 });
  if (shared) {
    await page.fill('#shared-address', shared);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
  } else {
    await page.getByRole('button', { name: 'Connect Outlook' }).click();
  }
  await page.waitForURL(/oauth2\/v2\.0\/authorize/, { timeout: 30000 });
  await page.click(`a[data-account="${account}"]`);
  await page.waitForURL(/\/email\/settings/, { timeout: 90000 });
  await page.waitForLoadState('networkidle');
  return { url: page.url(), text: await banner(page) };
}

try {
  const { page } = await session(admin.cookies);

  // 1. Personal mailbox.
  let r = await connectVia(page, { account: 'owner@mock.test' });
  t('personal: connected banner', /Connected owner@mock\.test/.test(r.text), r.text);
  const [mb] = await q(`select id, kind, graph_user_id, sync_identity_id, sync_status from mail_mailboxes where address='owner@mock.test'`);
  t('personal: one mailbox row, kind personal, driven by the new identity', mb?.kind === 'personal' && mb.graph_user_id === 'oid-owner' && !!mb.sync_identity_id);
  const folders = await q(`select f.graph_id, f.well_known, f.depth, p.graph_id parent from mail_folders f left join mail_folders p on p.id=f.parent_folder_id where f.mailbox_id=$1 and f.deleted_at is null order by f.graph_id`, [mb.id]);
  t('folders: all 9 (two delta pages) stored', folders.length === 9, String(folders.length));
  t('folders: well-known resolved by id', folders.filter((f) => f.well_known).length === 7);
  const acme = folders.find((f) => f.graph_id.endsWith('-acme'));
  t('folders: nested parent + depth', acme?.depth === 2 && acme.parent?.endsWith('-clients'), JSON.stringify(acme));
  const queue = await q(`select kind, count(*)::int n from mail_sync_queue where mailbox_id=$1 and processed_at is null group by kind order by kind`, [mb.id]);
  const qk = Object.fromEntries(queue.map((x) => [x.kind, x.n]));
  // inbox, drafts, sent (hot) + deleted, archive, clients, acme (non-empty); not junk (empty), not outbox
  t('bootstrap: seeds hot + non-empty folders, skips outbox/empty', qk.seed_folder === 7, JSON.stringify(qk));
  t('bootstrap: subscription, rules, contacts queued', qk.subscription_ensure === 1 && qk.rules_refresh === 1 && qk.contacts_delta === 1);

  const [sec] = await q(`select s.refresh_token_enc, s.refresh_token_iv, s.access_token_enc, i.user_id, i.microsoft_user_id
                            from mail_identity_secrets s join mail_identities i on i.id=s.identity_id where i.id=$1`, [mb.sync_identity_id]);
  t('tokens: stored encrypted, no plaintext in the row', sec && !sec.refresh_token_enc.toString('latin1').includes('mock-rt-') && !sec.access_token_enc.toString('latin1').includes('mock-at-'));
  const openTok = (ct, iv, aad) => {
    const d = createDecipheriv('aes-256-gcm', KEY, iv);
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(ct.subarray(ct.length - 16));
    return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString();
  };
  let plain = '';
  try { plain = openTok(sec.refresh_token_enc, sec.refresh_token_iv, `${sec.user_id}:${sec.microsoft_user_id}`); } catch { /* fails below */ }
  t('tokens: decrypt with key + AAD user:oid', plain.startsWith('mock-rt-'));
  let wrongAad = false;
  try { openTok(sec.refresh_token_enc, sec.refresh_token_iv, `someone-else:${sec.microsoft_user_id}`); } catch { wrongAad = true; }
  t('tokens: copying to another user fails decryption', wrongAad);
  const oauthCookie = (await page.context().cookies()).find((c) => c.name === 'mail_oauth');
  t('state cookie cleared after callback', !oauthCookie);

  const row = page.locator('li', { hasText: 'owner@mock.test' });
  t('settings row: Setting up pill', await row.getByText('Setting up').isVisible().catch(() => false));

  // 2. Reconnect the same mailbox → no duplicate.
  r = await connectVia(page, { account: 'owner@mock.test' });
  t('reconnect: banner', /Reconnected owner@mock\.test/.test(r.text), r.text);
  const dupes = await q(`select (select count(*)::int from mail_mailboxes where address='owner@mock.test') m,
                                (select count(*)::int from mail_connections where user_id=$1 and disconnected_at is null) c,
                                (select count(*)::int from mail_identities where user_id=$1 and microsoft_user_id='oid-owner' and deleted_at is null) i`, [admin.id]);
  t('reconnect: still one mailbox, one connection, one identity', dupes[0].m === 1 && dupes[0].c === 1 && dupes[0].i === 1, JSON.stringify(dupes[0]));

  // 3. Shared mailbox with access.
  r = await connectVia(page, { shared: 'team@mock.test', account: 'owner@mock.test' });
  t('shared: connected', /Connected team@mock\.test/.test(r.text), r.text);
  const [smb] = await q(`select kind, graph_user_id from mail_mailboxes where address='team@mock.test'`);
  t('shared: kind shared, addressed by address', smb?.kind === 'shared' && smb.graph_user_id === null);
  t('shared: Shared chip shown', await page.locator('li', { hasText: 'team@mock.test' }).getByText('Shared').isVisible().catch(() => false));

  // 4. Refusals.
  r = await connectVia(page, { shared: 'vault@mock.test', account: 'owner@mock.test' });
  t('shared without access: refused, nothing written', /didn.t let you open vault@mock\.test/.test(r.text) && (await q(`select count(*)::int n from mail_mailboxes where address='vault@mock.test'`))[0].n === 0, r.text);
  r = await connectVia(page, { account: 'cancel' });
  t('cancel: "cancelled" banner', /cancelled/i.test(r.text), r.text);
  r = await connectVia(page, { account: 'person@outlook.test' });
  t('personal Microsoft account: refused', /work or school/i.test(r.text), r.text);
  r = await connectVia(page, { account: 'other@mock.test' });
  t('other tenant: refused', /isn.t in a TapDash Microsoft tenant/i.test(r.text), r.text);
  r = await connectVia(page, { account: 'nobox@mock.test' });
  t('account without a mailbox: refused', /doesn.t have an Outlook mailbox/i.test(r.text), r.text);
  const strays = await q(`select count(*)::int n from mail_identities where microsoft_user_id in ('oid-other','oid-nobox','oid-person')`);
  t('refusals wrote no identities', strays[0].n === 0);

  // 5. Forged / replayed state.
  await page.goto(`${BASE}/api/mail/oauth/callback?code=x&state=forged`, { waitUntil: 'networkidle' });
  t('forged state: "expired" banner', /expired/i.test(await banner(page)));
  // Shared target swapped in the URL is impossible — it lives in the signed cookie — and an XSS-ish
  // `shared` param is never echoed unless it is a valid address.
  await page.goto(`${BASE}/email/settings?mail_error=shared_access_denied&shared=${encodeURIComponent('<b>pwn</b>')}`, { waitUntil: 'networkidle' });
  t('crafted shared param is not echoed', !(await banner(page)).includes('pwn'));
  await page.goto(`${BASE}/email/settings?mail_error=${encodeURIComponent('Your account is locked')}`, { waitUntil: 'networkidle' });
  t('arbitrary mail_error text is never shown', !(await page.getByText('Your account is locked').count()));

  // 6. Disconnect both, through the dialog.
  for (const address of ['team@mock.test', 'owner@mock.test']) {
    await page.goto(`${BASE}/email/settings`, { waitUntil: 'networkidle' });
    await page.locator('li', { hasText: address }).getByRole('button', { name: 'Disconnect' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click();
    await page.waitForTimeout(2500);
    t(`disconnect ${address}: banner`, (await banner(page)).includes(`Disconnected ${address}`));
  }
  const after = await q(`select (select count(*)::int from mail_connections where user_id=$1 and disconnected_at is null) live,
                                (select count(*)::int from mail_identity_secrets s join mail_identities i on i.id=s.identity_id where i.user_id=$1) secrets,
                                (select count(*)::int from mail_mailboxes where address like '%@mock.test' and deactivated_at is null) active`, [admin.id]);
  t('disconnect: no live connections, secrets deleted, mailboxes deactivated', after[0].live === 0 && after[0].secrets === 0 && after[0].active === 0, JSON.stringify(after[0]));

  // 7. A member: the page follows the communication/email grant (or redirects).
  // The 24h idle rule in proxy.ts signs a stale account straight out; the
  // demo member is rarely used, so freshen last_seen_at and restore it after.
  const [{ id: memberId, last_seen_at: seenBefore }] = await q(`select id, last_seen_at from profiles where email=$1`, [MEMBER]);
  restoreSeen = () => db.query(`update profiles set last_seen_at = $2 where id=$1`, [memberId, seenBefore]);
  await db.query(`update profiles set last_seen_at = now() where id=$1`, [memberId]);
  const member = await cookiesFor(MEMBER);
  const m = await session(member.cookies);
  const resp = await m.page.goto(`${BASE}/email/settings`, { waitUntil: 'networkidle', timeout: 180000 });
  const landed = new URL(m.page.url()).pathname;
  t('member: /email/settings answers without error', resp && resp.status() < 500 && (landed === '/email/settings' || landed === '/dashboard'), landed);
  const mResp = await m.page.request.get(`${BASE}/api/mail/oauth/start?kind=shared&address=team@mock.test`, { maxRedirects: 0 });
  const loc = mResp.headers().location ?? '';
  t('member: start either goes to Microsoft (granted) or is refused (not granted), never 5xx',
    mResp.status() === 303 && (landed === '/dashboard' ? /not_permitted/.test(loc) : /authorize/.test(loc)), `${mResp.status()} ${landed} ${loc.slice(0, 80)}`);
  const anonResp = await (await browser.newContext()).request.get(`${BASE}/api/mail/oauth/start`, { maxRedirects: 0 });
  t('signed out: start never reaches Microsoft', anonResp.status() !== 303 || !/authorize/.test(anonResp.headers().location ?? ''), String(anonResp.status()));
  await db.query(`delete from rate_limit_counters where key = $1`, [`mail_connect:user:${member.id}`]);
} catch (e) {
  fail.push(`threw: ${e.stack ?? e}`);
} finally {
  await browser.close();
  await restoreSeen().catch((e) => fail.push(`restore last_seen_at: ${e}`));
  // Remove everything the run created.
  await db.query(`delete from mail_mailboxes where address like '%@mock.test'`);
  await db.query(`delete from mail_identities where user_id = $1 and microsoft_user_id like 'oid-%'`, [admin.id]);
  await cleanRate();
  const afterCounts = await counts();
  const drift = MAIL_TABLES.filter((tname) => afterCounts[tname] !== before[tname]);
  t('every mail_* table back to its starting count', drift.length === 0, drift.map((d) => `${d} ${before[d]}→${afterCounts[d]}`).join(', '));
  const afterOther = await otherCounts();
  t('records and profiles/roles untouched', JSON.stringify(afterOther) === JSON.stringify(beforeOther));
  t('no page errors / 5xx', errors.length === 0, errors.join(' | ').slice(0, 400));
  await db.end();
}

console.log(`\nPASS ${pass.length}`);
for (const p of pass) console.log('  ✓ ' + p);
console.log(`FAIL ${fail.length}`);
for (const f of fail) console.log('  ✗ ' + f);
process.exit(fail.length ? 1 : 0);
